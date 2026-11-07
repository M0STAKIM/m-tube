/**
 * Adapter contract (every provider adapter implements these):
 *   id(), name(), priority(), isEnabled(), isConfigured(), capabilities()
 *   supports(operation: 'search'|'resolve', platform): boolean
 *   async search(query)  -> [{title, artist, duration, thumbnail, platform, url}]
 *   async resolve(url)   -> {title, artist, duration, thumbnail, platform, url, formats:[{type,ext,quality,quality_label,size,url}]}
 *   async directUrl(format, media) -> string   (server side only)
 */
export class ProviderException extends Error {
  /** kind: timeout|network|rate_limit|quota_exceeded|auth|not_found|server_error|invalid_response|unsupported|no_media|not_configured|all_failed|expired|bad_format|too_large */
  constructor(kind, message = '') {
    super(message || kind);
    this.kind = kind;
    this.attempts = [];
  }

  retryable() {
    return ['timeout', 'network', 'server_error'].includes(this.kind);
  }
}

const METHODS = ['id', 'name', 'priority', 'isEnabled', 'isConfigured', 'capabilities', 'supports', 'search', 'resolve', 'directUrl'];
export function isAdapter(o) {
  return !!o && METHODS.every((m) => typeof o[m] === 'function');
}
