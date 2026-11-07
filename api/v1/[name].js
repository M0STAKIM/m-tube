// Vercel Function for every /api/v1/<name> request (dynamic route). The Express app in the root index.js
// does the routing, so URLs like /api/v1/search reach it unchanged (no rewrites needed).
export { default } from '../../index.js';
