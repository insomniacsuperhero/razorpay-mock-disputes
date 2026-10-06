// Vercel serverless entry. vercel.json rewrites every path here, so the URLs stay
// identical to Razorpay's: https://<your-mock>.vercel.app/v1/disputes/...
import { handle } from '../lib/core.mjs';
import { getStore } from '../lib/store.mjs';

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
});

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const u = new URL(req.url, 'http://x');
    // The rewrite passes the original path as ?path=...; fall back to req.url if it is already the original path
    const pathname = u.searchParams.get('path') ?? u.pathname;
    u.searchParams.delete('path');
    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
      try { body = req.body !== undefined ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) : await readBody(req); }
      catch { body = null; }
    }
    const out = await handle({ method: req.method, pathname, query: u.searchParams, body, headers: req.headers, store: getStore() });
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', description: e.message } });
  }
}
