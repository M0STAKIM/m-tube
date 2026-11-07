// Provider-by-provider diagnostics:  RAPIDAPI_KEY=... npm run diagnose -- https://www.youtube.com/watch?v=...
import { diagnose } from '../data/core/Diagnostics.js';
import { ensureReady } from '../data/core/bootstrap.js';

await ensureReady();
const testUrl = process.argv[2] || '';
const report = await diagnose({ probe: true, testUrl });
console.log(JSON.stringify(report, null, 2));
const bad = report.providers.filter((p) => p.enabled && (!p.configured || p.mcp?.ok === false || p.resolve?.ok === false));
console.error(bad.length ? `\n${bad.length} provider(s) need attention: ${bad.map((p) => p.id).join(', ')}` : '\nAll probed providers responded.');
process.exit(0);
