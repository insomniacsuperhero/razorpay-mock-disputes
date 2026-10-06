// Raise a mock dispute against a real Razorpay test payment — on localhost or the Vercel deploy.
// Usage:
//   node create_dispute.mjs pay_XXXXXXXX                      (defaults: goods_not_received, 72h)
//   node create_dispute.mjs pay_XXXXXXXX not_as_described 24
//   node create_dispute.mjs pay_XXXXXXXX goods_not_received 72 249900   (amount in paise, if payment can't be fetched)
// Deployed mock:
//   MOCK_URL=https://your-mock.vercel.app RZP_KEY=rzp_test_xxx RZP_SECRET=xxx node create_dispute.mjs pay_XXXX
// Reasons: goods_not_received | not_as_described | unauthorized | duplicate | refund_not_processed

const [payment_id, reason_code = 'goods_not_received', hours = '72', amount] = process.argv.slice(2);
if (!payment_id) { console.error('Usage: node create_dispute.mjs pay_XXXX [reason] [hours] [amount_paise]'); process.exit(1); }
const base = (process.env.MOCK_URL || 'http://localhost:4010').replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json' };
if (process.env.RZP_KEY && process.env.RZP_SECRET)
  headers.Authorization = 'Basic ' + Buffer.from(`${process.env.RZP_KEY}:${process.env.RZP_SECRET}`).toString('base64');

const res = await fetch(`${base}/v1/disputes`, {
  method: 'POST', headers,
  body: JSON.stringify({ payment_id, reason_code, respond_in_hours: Number(hours), ...(amount ? { amount: Number(amount) } : {}) }),
});
const d = await res.json();
if (!res.ok) { console.error('Error:', d.error?.description); process.exit(1); }
console.log(`Created ${d.id}  on ${base}`);
console.log(`  payment   ${d.payment_id}   ₹${d.amount / 100}`);
console.log(`  reason    ${d.reason_description}`);
console.log(`  respond by ${new Date(d.respond_by * 1000).toLocaleString('en-IN')}`);
