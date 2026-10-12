# Proof Bridge: Mock Razorpay Disputes API (razorpay-mock-disputes)

Razorpay **test mode cannot create disputes**, so this service mirrors the documented [Razorpay Disputes API](https://razorpay.com/docs/api/disputes/). It uses the same routes, the same request and response shapes, the same validation messages and the same signed webhooks. That way the Proof Bridge API works with it exactly as it would with Razorpay. Payments and Documents stay on the **real** Razorpay test API.

**Hosted:** https://razorpay-mock-disputes.vercel.app (`GET /` → `{"service":"proof-bridge-mock-disputes","ok":true}`)

**Step-by-step demo guide** (payment → mock dispute → proof → submit): [END_TO_END_GUIDE.md](https://github.com/insomniacsuperhero/razorpay-frontend/blob/main/docs/END_TO_END_GUIDE.md)

## How it connects to the other two services

| Service | Repo | Hosted | Connection |
| --- | --- | --- | --- |
| **Proof Bridge API** | [razorpay-api-py](https://github.com/insomniacsuperhero/razorpay-api-py) | https://proof-bridge-api.onrender.com | **API → mock:** the API's `MOCK_DISPUTES_BASE_URL` points here and calls it with Basic auth (`RZP_KEY:RZP_SECRET`). **Mock → API:** every status change sends a signed webhook to `WEBHOOK_URL` (`…/api/v1/webhooks/disputes`). |
| **Frontend** | [razorpay-frontend](https://github.com/insomniacsuperhero/razorpay-frontend) | https://razorpay-frontend-ashy.vercel.app | None directly. The app only talks to the API, and the API talks to the mock. |
| **Razorpay test API** (real) | n/a | https://api.razorpay.com/v1 | The mock fetches the payment when a dispute is created (amount, currency, customer). On every status change it writes `mock_dispute_id`, `mock_dispute_status` and `mock_dispute_reason` into the real payment's notes, so the state shows in the Razorpay dashboard. |

```
Proof Bridge API ──Basic auth (rzp_test key:secret)──► Mock ──fetch payment / PATCH notes──► Razorpay test API
        ▲                                               │
        └────── signed webhooks (X-Razorpay-Signature) ──┘
```

## Tech stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 18+, plain ES modules, **zero npm dependencies** (`fetch`, `crypto`, `http` built in) |
| Hosting | Vercel serverless function (`api/index.mjs`); `vercel.json` rewrites every path to it, so URLs match Razorpay's |
| Storage | Upstash Redis over its REST API on Vercel (serverless disk isn't persistent); a `disputes.json` file on localhost |
| Auth | HTTP Basic with your Razorpay test key and secret, compared in constant time; required when deployed, optional on localhost |
| Webhooks | HMAC-SHA256 of the raw body with `WEBHOOK_SECRET` in `X-Razorpay-Signature`, plus `X-Razorpay-Event-Id`, as Razorpay does |

```
lib/core.mjs        every route, validation and webhook (shared by both runners)
lib/store.mjs       Upstash Redis if configured, else disputes.json
api/index.mjs       Vercel function
server.mjs          localhost runner (port 4010)
create_dispute.mjs  CLI to raise a dispute against a test payment
test.mjs            offline lifecycle test (node test.mjs)
```

## Spin it up

### Locally

```bash
git clone https://github.com/insomniacsuperhero/razorpay-mock-disputes.git && cd razorpay-mock-disputes
RZP_KEY=rzp_test_xxx RZP_SECRET=xxx node server.mjs          # http://localhost:4010
node test.mjs                                                 # offline lifecycle test
```

Optional: add `WEBHOOK_URL=http://localhost:8000/api/v1/webhooks/disputes WEBHOOK_SECRET=…` to send webhooks to a local API. Set the Upstash variables (below) to share one dispute list with the deployed mock.

To make a local API use the local mock, set the API's `MOCK_DISPUTES_BASE_URL=http://localhost:4010`.

### On Vercel (about 10 minutes)

1. Import this repo in Vercel. Framework preset: **Other**, no build command.
2. Project → **Storage / Marketplace** → add **Upstash Redis** (free) and connect it. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Project → **Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `RZP_KEY` | your `rzp_test_…` key |
| `RZP_SECRET` | its secret |
| `WEBHOOK_URL` | `https://proof-bridge-api.onrender.com/api/v1/webhooks/disputes` |
| `WEBHOOK_SECRET` | the same value as the API's `MOCK_DISPUTES_WEBHOOK_SECRET` |
| `ALLOWED_ORIGIN` | optional, only if a browser calls the mock directly |
| `MOCK_REQUIRE_AUTH` | optional: `true` / `false` to force Basic auth on or off (default: on when deployed) |

4. **Redeploy** (environment variables apply to new deployments), then open the URL: you should see `{"ok":true}`.

## Endpoints

Same as Razorpay:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/disputes?count=10` | List, newest first |
| GET | `/v1/disputes/:id` | One dispute |
| PATCH | `/v1/disputes/:id/contest` | `action: draft \| submit`, evidence fields as lists of `doc_` IDs, `summary` ≤ 1,000 characters, `amount` ≤ the disputed amount. Rejected after the deadline or once under review |
| POST | `/v1/disputes/:id/accept` | Status → `lost`, amount deducted |

Mock-only (to drive the demo):

| Method | Path | Body |
| --- | --- | --- |
| POST | `/v1/disputes` | `{payment_id, reason_code?, respond_in_hours?, amount?}`: create a dispute on a real captured test payment |
| POST | `/mock/disputes/:id/resolve` | `{"outcome":"won" \| "lost"}`: the bank's decision |
| POST | `/mock/disputes/:id/action-required` | `{"field":"shipping_proof","reason":"…","respond_in_hours":48}`: only from `under_review`; reopens the dispute |
| POST | `/mock/disputes/:id/close` | Concludes it; keeps the verdict in `_mock.final_status` |
| POST | `/mock/reset` | Deletes every mock dispute |

Reason codes: `goods_not_received`, `not_as_described`, `unauthorized`, `duplicate`, `refund_not_processed`. These are readable demo labels; real disputes carry card-network or UPI codes.

All six webhook events are emulated and signed: `payment.dispute.created`, `.under_review`, `.action_required`, `.won`, `.lost`, `.closed`. On Vercel they are sent before the response returns, so none are dropped.

## Raise a dispute

You need a **captured** Razorpay test payment (`pay_…`). Make one with a test Payment Link paid with UPI `success@razorpay`. The [end-to-end guide](https://github.com/insomniacsuperhero/razorpay-frontend/blob/main/docs/END_TO_END_GUIDE.md#3-make-a-test-payment) has the steps.

```bash
# CLI (deployed mock)
MOCK_URL=https://razorpay-mock-disputes.vercel.app RZP_KEY=rzp_test_xxx RZP_SECRET=xxx \
  node create_dispute.mjs pay_XXXXXXXX goods_not_received 72

# curl
curl -s -X POST https://razorpay-mock-disputes.vercel.app/v1/disputes \
  -u 'rzp_test_xxx:YOUR_TEST_SECRET' -H 'Content-Type: application/json' \
  -d '{"payment_id":"pay_XXXXXXXX","reason_code":"goods_not_received","respond_in_hours":72}'
```

Raising it here sends `payment.dispute.created` to the API, which sends the seller's alerts. The other way to raise one is the API's `POST /api/v1/demo/seed`, which creates the dispute here and returns a ready alert link.

**Postman:** the Proof Bridge Postman collection includes the mock routes. Set the environment's `mock_base` to `https://razorpay-mock-disputes.vercel.app` (or `http://localhost:4010`).

## Going live

Set the API's `DISPUTES_PROVIDER=razorpay`, which points it at `https://api.razorpay.com`, and stop using the create call. Nothing else changes.
