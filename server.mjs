// Proof Bridge — Mock Razorpay Disputes API, localhost runner (same logic as the Vercel deploy).
// Run:  RZP_KEY=rzp_test_xxx RZP_SECRET=xxx node server.mjs
// Optional: WEBHOOK_URL=... WEBHOOK_SECRET=... PORT=4010
// Stores in disputes.json, or in Upstash Redis if UPSTASH_REDIS_REST_URL/TOKEN are set
// (handy for sharing one dispute list between localhost and the deployed mock).
import http from 'node:http';
import { handle } from './lib/core.mjs';
import { getStore } from './lib/store.mjs';

const PORT = Number(process.env.PORT || 4010);
const store = getStore();

http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    const u = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = null; }
    const out = await handle({ method: req.method, pathname: u.pathname, query: u.searchParams, body, headers: req.headers, store });
    send(out.status, out.body);
  } catch (e) { send(500, { error: { code: 'SERVER_ERROR', description: e.message } }); }
}).listen(PORT, () => console.log(
  `Mock disputes API on http://localhost:${PORT}/v1/disputes  (store: ${store.kind}; Razorpay payments: ${
    (process.env.RZP_KEY || '').startsWith('rzp_test_') ? 'real test API' : 'not configured'})`));
