// Storage for mock disputes.
//  - Upstash Redis (REST) when its env vars exist → use on Vercel (serverless disk is not persistent)
//  - disputes.json next to this folder otherwise → localhost
// Zero dependencies: Upstash is called over its REST API with fetch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = 'proofbridge:disputes';

function upstashStore(url, token) {
  const cmd = async (...args) => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
    const j = await r.json();
    if (j.error) throw new Error(`Upstash: ${j.error}`);
    return j.result;
  };
  return {
    kind: 'upstash',
    get: async (id) => { const v = await cmd('HGET', KEY, id); return v ? JSON.parse(v) : null; },
    put: async (d) => { await cmd('HSET', KEY, d.id, JSON.stringify(d)); },
    all: async () => ((await cmd('HVALS', KEY)) || []).map((v) => JSON.parse(v)),
    reset: async () => { await cmd('DEL', KEY); },
  };
}

function fileStore(file) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const save = (db) => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  return {
    kind: 'file',
    get: async (id) => load()[id] || null,
    put: async (d) => { const db = load(); db[d.id] = d; save(db); },
    all: async () => Object.values(load()),
    reset: async () => save({}),
  };
}

export function getStore() {
  // Vercel's Upstash integration sets KV_REST_API_*; a direct Upstash database gives UPSTASH_REDIS_REST_*
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return upstashStore(url, token);
  if (process.env.VERCEL) throw new Error('No Upstash Redis configured. Add it from Vercel → Storage / Marketplace.');
  return fileStore(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'disputes.json'));
}
