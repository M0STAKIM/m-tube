import { ProviderException } from './AdapterInterface.js';
import { FileManager } from '../backend/FileManager.js';
import { env, log } from '../core/helpers.js';

const TOOLS_TTL = 6 * 3600;

export function classifyMessage(m) {
  const s = String(m || '');
  if (/\b429\b|rate.?limit|too many/i.test(s)) return 'rate_limit';
  if (/quota|exceed|subscri|\b402\b/i.test(s)) return 'quota_exceeded';
  if (/\b401\b|\b403\b|unauthor|forbidden|api key|invalid key/i.test(s)) return 'auth';
  if (/timeout|timed out|ETIMEDOUT|abort/i.test(s)) return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network/i.test(s)) return 'network';
  if (/\b5\d\d\b/.test(s)) return 'server_error';
  return 'invalid_response';
}
const wrap = (e) => (e instanceof ProviderException ? e : new ProviderException(classifyMessage(e?.message), 'MCP: ' + String(e?.message || e).slice(0, 200)));

/** Convert a tool call result to a JS value (structuredContent > JSON text > plain text + extracted URLs). */
export function parseToolResult(res) {
  const text = (res.content || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
  if (res.isError) throw new ProviderException(classifyMessage(text), 'MCP tool error: ' + text.slice(0, 200));
  if (res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return j;
  } catch { /* plain text */ }
  const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>)]+/gi) || [])];
  return { text, urls };
}

/* ---------------- official SDK session ---------------- */
class SdkSession {
  constructor(o) { this.o = o; this.client = null; }

  async connect() {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(this.o.server), {
      requestInit: { headers: { 'x-api-host': this.o.host, 'x-api-key': this.o.key } },
    });
    this.client = new Client({ name: 'M-TUBE', version: '2.0.0' });
    await this.client.connect(transport);
  }

  async listTools() {
    const out = [];
    let cursor;
    for (let i = 0; i < 3; i++) {
      const r = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: this.o.timeout });
      out.push(...(r.tools || []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name, args) {
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: this.o.timeout });
  }

  async close() { try { await this.client?.close(); } catch { /* ignore */ } }
}

/* ------------- built-in Streamable-HTTP JSON-RPC session (no dependencies) ------------- */
class BuiltinSession {
  constructor(o) { this.o = o; this.sid = null; this.rid = 0; }

  async #rpc(method, params, notify = false) {
    const msg = { jsonrpc: '2.0', method, params: params ?? {} };
    if (!notify) msg.id = ++this.rid;
    const headers = {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'x-api-host': this.o.host, 'x-api-key': this.o.key,
    };
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    let res;
    try {
      res = await fetch(this.o.server, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(this.o.timeout) });
    } catch (e) {
      throw new ProviderException(e.name === 'TimeoutError' ? 'timeout' : 'network', 'MCP request failed: ' + (e?.cause?.code || e.message));
    }
    const text = await res.text();
    if (res.status >= 400) throw new ProviderException(classifyMessage(`HTTP ${res.status} ${text}`), `MCP HTTP ${res.status}`);
    this.sid = res.headers.get('mcp-session-id') || this.sid;
    if (notify) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let payload = null;
    if (ct.includes('text/event-stream') || /^\s*(event|data):/.test(text)) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j && (j.result !== undefined || j.error)) { payload = j; if (j.id === msg.id) break; }
        } catch { /* skip */ }
      }
    } else {
      try { payload = JSON.parse(text); } catch { /* handled below */ }
    }
    if (!payload) throw new ProviderException('invalid_response', 'MCP server returned no JSON-RPC payload.');
    if (payload.error) throw new ProviderException(classifyMessage(payload.error.message), 'MCP error: ' + String(payload.error.message || '').slice(0, 200));
    return payload.result;
  }

  async connect() {
    await this.#rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'M-TUBE', version: '2.0.0' } });
    await this.#rpc('notifications/initialized', {}, true);
  }

  async listTools() {
    const out = [];
    let cursor;
    for (let i = 0; i < 3; i++) {
      const r = await this.#rpc('tools/list', cursor ? { cursor } : {});
      out.push(...(r.tools || []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name, args) { return this.#rpc('tools/call', { name, arguments: args }); }

  async close() {
    if (!this.sid) return;
    try { await fetch(this.o.server, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sid, 'x-api-host': this.o.host, 'x-api-key': this.o.key }, signal: AbortSignal.timeout(2000) }); } catch { /* ignore */ }
  }
}

/**
 * MCP client for https://mcp.rapidapi.com. Uses the official @modelcontextprotocol/sdk
 * (Streamable HTTP transport); falls back to the built-in JSON-RPC client if the SDK cannot
 * be loaded/connected. Force with MCP_CLIENT=sdk|builtin. Sessions are per request (stateless).
 */
export class MCPClient {
  constructor({ server, host, key, label, timeout = 20000 }) {
    this.o = { server, host, key, label, timeout };
    this.session = null;
    this.kind = null;
  }

  async #open() {
    if (this.session) return this.session;
    const mode = env('MCP_CLIENT', 'sdk');
    if (mode !== 'builtin') {
      const s = new SdkSession(this.o);
      try {
        await s.connect();
        this.session = s; this.kind = 'sdk';
        return s;
      } catch (e) {
        const kind = classifyMessage(e?.message);
        if (['rate_limit', 'quota_exceeded', 'auth'].includes(kind) || mode === 'sdk-only') throw wrap(e);
        log('mcp', `SDK session failed for ${this.o.label} (${String(e?.message).slice(0, 120)}); using built-in client`);
        await s.close();
      }
    }
    const b = new BuiltinSession(this.o);
    try { await b.connect(); } catch (e) { throw wrap(e); }
    this.session = b; this.kind = 'builtin';
    return b;
  }

  /** Discover the provider's real tools + input schemas (cached 6h). */
  async tools() {
    const ck = 'mcp:tools:' + this.o.label;
    const cached = await FileManager.cacheGet(ck);
    if (Array.isArray(cached) && cached.length) return cached;
    try {
      const s = await this.#open();
      const tools = (await s.listTools()).filter((t) => t && t.name);
      if (!tools.length) throw new ProviderException('invalid_response', 'MCP server exposes no tools.');
      await FileManager.cachePut(ck, tools, TOOLS_TTL);
      return tools;
    } catch (e) { throw wrap(e); }
  }

  async call(name, args) {
    try {
      const s = await this.#open();
      return parseToolResult(await s.callTool(name, args));
    } catch (e) { throw wrap(e); }
  }

  async close() {
    if (this.session) await this.session.close();
    this.session = null;
  }
}
