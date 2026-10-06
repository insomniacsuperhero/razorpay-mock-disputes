// Proof Bridge — Mock Razorpay Disputes API (core logic, framework-agnostic)
// Mirrors the documented Razorpay Disputes API because test mode cannot create disputes.
// Payments + Documents stay on the REAL Razorpay test API.
// Used by both server.mjs (localhost) and api/index.mjs (Vercel).

import crypto from 'node:crypto';

const RZP = 'https://api.razorpay.com/v1';
const env = () => ({
  KEY: process.env.RZP_KEY || '',
  SECRET: process.env.RZP_SECRET || '',
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
});
const basic = (k, s) => 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64');

// Reason codes are illustrative labels for the demo (Razorpay returns network-specific codes).
export const REASONS = {
  goods_not_received:   'Customer says the order was never delivered',
  not_as_described:     'Customer says the item was damaged or not as described',
  unauthorized:         'Customer says they did not authorise this payment',
  duplicate:            'Customer says they were charged twice',
  refund_not_processed: 'Customer says a promised refund was not received',
};
export const EVIDENCE_FIELDS = ['shipping_proof', 'billing_proof', 'cancellation_proof', 'customer_communication',
  'proof_of_service', 'explanation_letter', 'refund_confirmation', 'access_activity_log',
  'refund_cancellation_policy', 'term_and_conditions'];

const now = () => Math.floor(Date.now() / 1000);
const id = (p) => p + crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').slice(0, 14);
const ok = (body) => ({ status: 200, body });
const err = (status, description, reason = 'input_validation_failed') =>
  ({ status, body: { error: { code: 'BAD_REQUEST_ERROR', description, source: 'business', step: 'NA', reason, metadata: {} } } });
const emptyEvidence = () => ({ amount: null, summary: null, ...Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, null])), others: null, submitted_at: null });

async function rzp(pathname) {
  const { KEY, SECRET } = env();
  if (!KEY.startsWith('rzp_test_')) return null;
  try { const r = await fetch(RZP + pathname, { headers: { Authorization: basic(KEY, SECRET) } }); return r.ok ? r.json() : null; } catch { return null; }
}

// Tag the REAL test payment with the mock dispute state so it shows in the Razorpay dashboard.
// PATCH /v1/payments/:id only allows `notes` (max 15 keys, scalar values); existing notes are kept.
async function tagPayment(d) {
  const { KEY, SECRET } = env();
  if (!KEY.startsWith('rzp_test_') || !d.payment_id?.startsWith('pay_')) return;
  const notes = { ...(d._mock?.original_notes || {}), mock_dispute_id: d.id, mock_dispute_status: d.status, mock_dispute_reason: d.reason_code };
  if (Object.keys(notes).length > 15) return console.log('skip tag: payment already has 15 notes');
  try {
    const r = await fetch(`${RZP}/payments/${d.payment_id}`, { method: 'PATCH',
      headers: { Authorization: basic(KEY, SECRET), 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
    console.log(r.ok ? `tagged ${d.payment_id} → ${d.status}` : `tag failed (${r.status}) for ${d.payment_id}`);
  } catch (e) { console.log(`tag failed: ${e.message}`); }
}

// Signed like real Razorpay: X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret)
async function webhook(event, dispute) {
  const { WEBHOOK_URL, WEBHOOK_SECRET } = env();
  if (!WEBHOOK_URL) return;
  const payload = JSON.stringify({ entity: 'event', account_id: 'acc_mock', event, contains: ['dispute'],
    payload: { dispute: { entity: dispute } }, created_at: now() });
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  try {
    const r = await fetch(WEBHOOK_URL, { method: 'POST', body: payload,
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': id('evt_') } });
    console.log(`webhook → ${event} (${dispute.id}) ${r.status}`);
  } catch (e) { console.log(`webhook failed: ${e.message}`); }
}

// Same Basic auth as Razorpay (key:secret). Required when deployed, optional on localhost.
function authorised(headers) {
  const required = process.env.MOCK_REQUIRE_AUTH ? process.env.MOCK_REQUIRE_AUTH === 'true' : Boolean(process.env.VERCEL);
  if (!required) return true;
  const { KEY, SECRET } = env();
  if (!KEY) return false;
  const given = String(headers.authorization || '');
  const a = Buffer.from(given), b = Buffer.from(basic(KEY, SECRET));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Handlers ---
async function create(store, b) {
  if (!String(b.payment_id || '').startsWith('pay_')) return err(400, 'payment_id (pay_...) is required');
  const reason = b.reason_code || 'goods_not_received';
  if (!REASONS[reason]) return err(400, `reason_code must be one of: ${Object.keys(REASONS).join(', ')}`);
  const payment = await rzp(`/payments/${b.payment_id}`);
  const amount = Number(b.amount ?? payment?.amount);
  if (!amount) return err(400, 'Could not fetch the payment from Razorpay; pass "amount" in paise');
  const hours = Number(b.respond_in_hours ?? 72);
  const d = {
    id: id('disp_'), entity: 'dispute', payment_id: b.payment_id, amount, currency: payment?.currency || 'INR',
    amount_deducted: 0, reason_code: reason, reason_description: REASONS[reason],
    respond_by: now() + Math.round(hours * 3600), status: 'open', phase: b.phase || 'chargeback',
    created_at: now(), evidence: emptyEvidence(),
    _mock: { customer: payment ? { contact: payment.contact, email: payment.email, method: payment.method } : null,
             original_notes: Array.isArray(payment?.notes) ? {} : (payment?.notes || {}) },
  };
  await store.put(d);
  console.log(`created ${d.id} for ${b.payment_id} ₹${amount / 100}, respond in ${hours}h`);
  await tagPayment(d); await webhook('payment.dispute.created', d);
  return ok(d);
}

async function contest(store, d, b) {
  if (['lost', 'won', 'closed', 'under_review'].includes(d.status)) return err(400, `Action not allowed when dispute is in ${d.status} status.`);
  if (now() > d.respond_by) return err(400, 'Action not allowed as deadline to respond has elapsed.');
  const action = b.action ?? 'draft';
  if (!['draft', 'submit'].includes(action)) return err(400, 'The selected action is invalid.');
  if (b.amount != null && b.amount > d.amount) return err(400, 'contest amount cannot be greater than dispute amount.');
  if (b.summary && String(b.summary).length > 1000) return err(400, 'summary may not be greater than 1000 characters.');
  const allowed = new Set(['amount', 'summary', 'action', 'others', ...EVIDENCE_FIELDS]);
  const bad = Object.keys(b).filter((k) => !allowed.has(k));
  if (bad.length) return err(400, `${bad.join(', ')} is/are not required and should not be sent.`);

  const ev = d.evidence;
  for (const f of EVIDENCE_FIELDS) if (b[f] !== undefined) {
    if (!Array.isArray(b[f]) || b[f].some((x) => !String(x).startsWith('doc_')))
      return err(400, 'Invalid file id provided or merchant is unauthorized to access the fileId(s) provided');
    ev[f] = b[f];
  }
  if (b.others !== undefined) ev.others = b.others;
  if (b.summary !== undefined) ev.summary = b.summary;
  ev.amount = b.amount ?? ev.amount ?? d.amount;

  if (action === 'submit') {
    const docs = [...EVIDENCE_FIELDS.flatMap((f) => ev[f] || []), ...((ev.others || []).flatMap((o) => o.document_ids || []))];
    if (!docs.length) return err(400, 'At least one document is required to submit the dispute');
    d.status = 'under_review'; ev.submitted_at = now();
    if (d._mock) delete d._mock.action_required;
  }
  await store.put(d);
  if (action === 'submit') { await tagPayment(d); await webhook('payment.dispute.under_review', d); }
  return ok(d);
}

async function transition(store, d, status, event, extra = () => {}) {
  extra(d); d.status = status; await store.put(d);   // extra runs first so it can read the previous status
  await tagPayment(d); await webhook(event, d); return ok(d);
}

// --- Router: returns { status, body } ---
export async function handle({ method, pathname, query, body, headers, store }) {
  const p = pathname.replace(/\/$/, '') || '/';
  let m;
  if (method === 'GET' && p === '/') return ok({ service: 'proof-bridge-mock-disputes', ok: true });
  if (!authorised(headers)) return { status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The api key provided is invalid' } } };
  if (body === null) return err(400, 'Invalid JSON');
  const b = body || {};
  const find = async (did) => (await store.get(did)) || null;
  const missing = err(400, 'The id provided does not exist');

  if (method === 'GET' && p === '/v1/disputes') {
    const items = (await store.all()).sort((x, y) => y.created_at - x.created_at);
    const count = Number(query.get('count') || 10);
    return ok({ entity: 'collection', count: Math.min(count, items.length), items: items.slice(0, count) });
  }
  if (method === 'GET' && (m = p.match(/^\/v1\/disputes\/(disp_\w+)$/))) return (await find(m[1])) ? ok(await find(m[1])) : missing;
  if (method === 'POST' && p === '/v1/disputes') return create(store, b);   // mock-only
  if (method === 'POST' && p === '/mock/reset') { await store.reset(); return ok({ ok: true }); }

  if ((m = p.match(/^\/(?:v1|mock)\/disputes\/(disp_\w+)\/([\w-]+)$/))) {
    const d = await find(m[1]); if (!d) return missing;
    const action = `${method} ${p.split('/')[1]}/${m[2]}`;
    switch (action) {
      case 'PATCH v1/contest': return contest(store, d, b);
      case 'POST v1/accept':
        if (d.status !== 'open') return err(400, `Action not allowed when dispute is in ${d.status} status.`);
        return transition(store, d, 'lost', 'payment.dispute.lost', (x) => { x.amount_deducted = x.amount; });
      case 'POST mock/resolve': {
        if (!['won', 'lost'].includes(b.outcome)) return err(400, 'outcome must be won or lost');
        return transition(store, d, b.outcome, `payment.dispute.${b.outcome}`, (x) => { x.amount_deducted = b.outcome === 'lost' ? x.amount : 0; });
      }
      case 'POST mock/action-required': {
        if (d.status !== 'under_review') return err(400, 'Only a dispute under review can be sent back for more evidence');
        const hours = Number(b.respond_in_hours ?? 48);
        return transition(store, d, 'open', 'payment.dispute.action_required', (x) => {
          x.evidence.submitted_at = null; x.respond_by = now() + Math.round(hours * 3600);
          x._mock = { ...(x._mock || {}), action_required: {
            reason: b.reason || 'The evidence submitted is insufficient or unreadable. Please upload clearer proof.',
            field: b.field || null, at: now() } };
        });
      }
      case 'POST mock/close':
        if (d.status === 'closed') return err(400, 'Action not allowed when dispute is in closed status.');
        return transition(store, d, 'closed', 'payment.dispute.closed', (x) => { x._mock = { ...(x._mock || {}), final_status: x.status }; });
    }
  }
  return { status: 404, body: { error: { code: 'NOT_FOUND', description: 'Unknown route' } } };
}
