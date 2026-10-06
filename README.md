# Mock Razorpay Disputes API (Proof Bridge)

Razorpay test mode can't create disputes, so this mirrors the documented Disputes API.
Payments and Documents stay on the real Razorpay test API.
One codebase runs in two places: **localhost** (`server.mjs`, stores in `disputes.json`) and
**Vercel** (`api/index.mjs`, stores in Upstash Redis). Zero npm dependencies.

```
lib/core.mjs     all routes + validation (shared)
lib/store.mjs    Upstash Redis if configured, else disputes.json
api/index.mjs    Vercel function; vercel.json sends every path here
server.mjs       localhost runner
test.mjs         offline lifecycle test (node test.mjs)
```

## Deploy to Vercel (≈10 min)
1. Push this folder to GitHub (own repo, or `apps/mock-disputes` in your monorepo).
2. Vercel → **Add New → Project** → import the repo. If it's in a monorepo, set **Root Directory** to this folder.
   Framework preset: **Other**. No build command.
3. In the project → **Storage** (Marketplace) → add **Upstash Redis** (free) → connect it to the project.
   This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
4. Project → **Settings → Environment Variables**:
   | Name | Value |
   |---|---|
   | `RZP_KEY` | your `rzp_test_...` key |
   | `RZP_SECRET` | its secret |
   | `WEBHOOK_URL` | optional — your API's webhook endpoint, e.g. `https://proof-bridge-api.vercel.app/webhooks/razorpay` |
   | `WEBHOOK_SECRET` | optional — same secret your API verifies with |
   | `ALLOWED_ORIGIN` | optional — only if a browser calls the mock directly |
5. **Redeploy** (env vars apply to new deployments). Open `https://<project>.vercel.app/` → `{"ok":true}`.

**Auth:** when deployed, every route needs the same Basic auth as Razorpay (`RZP_KEY:RZP_SECRET`), so the
public URL can't be used by strangers. Localhost stays open (force it with `MOCK_REQUIRE_AUTH=true|false`).

## Create a dispute
```
# deployed
MOCK_URL=https://<project>.vercel.app RZP_KEY=rzp_test_xxx RZP_SECRET=xxx node create_dispute.mjs pay_XXXX
# localhost
RZP_KEY=rzp_test_xxx RZP_SECRET=xxx node server.mjs          # terminal 1
node create_dispute.mjs pay_XXXX not_as_described 24          # terminal 2
```
Postman: set the environment's `mock_base` to `https://<project>.vercel.app` (or keep `http://localhost:4010`).
The mock folders now send `{{rzp_key}}` / `{{rzp_secret}}` as Basic auth, same as the Razorpay folder.

Tip: set the Upstash env vars locally too (`UPSTASH_REDIS_REST_URL`/`TOKEN` or `KV_REST_API_URL`/`TOKEN`)
and localhost + Vercel share one dispute list.

## Same endpoints as Razorpay
| Method | Path | Notes |
|---|---|---|
| GET | /v1/disputes?count=10 | list |
| GET | /v1/disputes/:id | one dispute |
| PATCH | /v1/disputes/:id/contest | `action: draft` or `submit`; same validation as the docs |
| POST | /v1/disputes/:id/accept | status → lost |

Mock-only:
- `POST /v1/disputes` `{payment_id, reason_code?, respond_in_hours?, amount?}` — create
- `POST /mock/disputes/:id/resolve` `{"outcome":"won"|"lost"}` — bank verdict
- `POST /mock/disputes/:id/action-required` `{"field":"shipping_proof","reason":"..."}` — only from `under_review`; reopens
- `POST /mock/disputes/:id/close` — concludes, keeps the verdict in `_mock.final_status`
- `POST /mock/reset`

All six webhook events are emulated and signed (`X-Razorpay-Signature`): created, under_review,
action_required, won, lost, closed. On Vercel they're sent before the response returns, so nothing is dropped.

## Shows up in your Razorpay dashboard
Every status change writes `mock_dispute_id`, `mock_dispute_status`, `mock_dispute_reason` into the REAL test
payment's notes (`PATCH /v1/payments/:id`, existing notes kept). Needs `RZP_KEY`/`RZP_SECRET`.

## Going live later
Point the app's disputes base URL at `https://api.razorpay.com` and drop the create call.
Reason codes here are readable demo labels; real disputes carry network-specific codes.
