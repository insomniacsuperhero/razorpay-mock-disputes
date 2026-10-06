// Offline test: runs the Vercel handler against a fake Upstash REST server and walks the full lifecycle.
// No network or real keys needed:  node test.mjs
import http from 'node:http';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

// --- fake Upstash REST (HGET/HSET/HVALS/DEL only) ---
const hash = new Map();
const fake = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const [cmd, , field, value] = JSON.parse(raw);
  const result = { HGET: () => hash.get(field) ?? null, HSET: () => (hash.set(field, value), 1),
    HVALS: () => [...hash.values()], DEL: () => (hash.clear(), 1) }[cmd]();
  res.end(JSON.stringify({ result }));
});
await new Promise((r) => fake.listen(0, r));

Object.assign(process.env, { VERCEL: '1', RZP_KEY: 'key_local_test', RZP_SECRET: 'secret_local_test',
  KV_REST_API_URL: `http://127.0.0.1:${fake.address().port}`, KV_REST_API_TOKEN: 't' });
delete process.env.WEBHOOK_URL;
const { default: handler } = await import('./api/index.mjs');
const AUTH = 'Basic ' + Buffer.from('key_local_test:secret_local_test').toString('base64');

async function call(method, path, body, auth = AUTH) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url: `/api/index?path=${path.split('?')[0]}${path.includes('?') ? '&' + path.split('?')[1] : ''}`,
    headers: auth ? { authorization: auth } : {} });
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); }, end() { resolve({ status: this.statusCode }); } };
    handler(req, res);
  });
}

let r = await call('GET', '/v1/disputes', null, null);
assert.equal(r.status, 401, 'no auth → 401');
r = await call('GET', '/v1/disputes', null, 'Basic bad');
assert.equal(r.status, 401, 'wrong auth → 401');

r = await call('POST', '/v1/disputes', { payment_id: 'pay_TEST123', amount: 249900 });
assert.equal(r.status, 200); const id = r.body.id;
assert.match(id, /^disp_\w{14}$/); assert.equal(r.body.status, 'open');

await call('POST', '/v1/disputes', { payment_id: 'pay_TEST456', amount: 99900 });
r = await call('GET', '/v1/disputes?count=1');
assert.equal(r.body.items.length, 1, 'count query param respected');

r = await call('GET', `/v1/disputes/${id}`); assert.equal(r.body.amount, 249900);
r = await call('PATCH', `/v1/disputes/${id}/contest`, { action: 'submit' });
assert.equal(r.status, 400, 'submit without documents rejected');
r = await call('PATCH', `/v1/disputes/${id}/contest`, { shipping_proof: ['bad_id'] });
assert.equal(r.status, 400, 'invalid doc id rejected');
r = await call('PATCH', `/v1/disputes/${id}/contest`, { amount: 999999 });
assert.equal(r.status, 400, 'amount above dispute rejected');
r = await call('PATCH', `/v1/disputes/${id}/contest`, { foo: 1 });
assert.equal(r.status, 400, 'unknown key rejected');

r = await call('PATCH', `/v1/disputes/${id}/contest`, { shipping_proof: ['doc_ABC'], summary: 'Delivered 2 Oct', action: 'draft' });
assert.equal(r.body.status, 'open'); assert.deepEqual(r.body.evidence.shipping_proof, ['doc_ABC']);
r = await call('PATCH', `/v1/disputes/${id}/contest`, { action: 'submit' });
assert.equal(r.body.status, 'under_review'); assert.ok(r.body.evidence.submitted_at);

r = await call('POST', `/mock/disputes/${id}/action-required`, { field: 'shipping_proof' });
assert.equal(r.body.status, 'open'); assert.equal(r.body._mock.action_required.field, 'shipping_proof');
r = await call('PATCH', `/v1/disputes/${id}/contest`, { shipping_proof: ['doc_ABC', 'doc_DEF'], action: 'submit' });
assert.equal(r.body.status, 'under_review'); assert.equal(r.body._mock.action_required, undefined);

r = await call('POST', `/mock/disputes/${id}/resolve`, { outcome: 'won' }); assert.equal(r.body.status, 'won');
r = await call('POST', `/mock/disputes/${id}/close`); assert.equal(r.body.status, 'closed');
assert.equal(r.body._mock.final_status, 'won', 'close keeps the verdict');

r = await call('POST', `/v1/disputes/disp_unknown/accept`); assert.equal(r.status, 400);
r = await call('POST', '/mock/reset'); r = await call('GET', '/v1/disputes'); assert.equal(r.body.count, 0);

console.log('All mock-dispute tests passed ✔');
fake.close();
