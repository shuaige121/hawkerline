# Architecture

## Topology

```
                      ┌──────────────── one Cloudflare Worker (worker/index.js) ────────────────┐
 customers ──────────▶│ public pages /, /menu, /menu/<slug>, /locations, /offers, sitemap, robots │──▶ Cache API (60 s)
 owner  /admin ──────▶│ /api/admin/*     (ADMIN_TOKEN bearer)                                     │
 cashier /pos ───────▶│ /api/pos/*       (PIN login → signed staff token)                         │──▶ D1 (SQLite)
 kitchen /kitchen ───▶│ /api/kitchen/*, /api/print/*  (kitchen session or device print token)     │
 AI agents ──────────▶│ /mcp, /api/agent/v1/*  (hlk_ agent key → scope check → internal dispatch) │──▶ Stripe, Lalamove (quotes),
 Stripe / Telegram ──▶│ /api/webhook/stripe, /api/telegram/webhook                                │    Telegram, WhatsApp, OneMap
 cron triggers ─────▶│ scheduled(): per-expression jobs (releases, sweeps, summaries)           │
                      └───────────────────────────────────────────────────────────────────────────┘
                        static files in web/ served by Workers Assets (run_worker_first)
```

## Modules

| File | Role |
|---|---|
| `worker/index.js` | Router and business logic: ordering, payments (PayNow QR, Stripe), wallet, promos, members, POS, kitchen board and printing, delivery, refunds, admin API, cron |
| `worker/publication.js` | Draft → immutable release pipeline: revision compare-and-swap for every content write, snapshots, checksums, scheduling, rollback, transaction rules |
| `worker/public-render.js` | Renders a release snapshot into crawlable HTML, JSON-LD, sitemap and robots (no D1 reads) |
| `worker/public-cache.js`, `worker/public-media.js` | Edge cache for public pages and content-addressed media |
| `worker/product-components.js` | Set/combo components shared by the menu, checkout, kitchen tickets and prep lists |
| `worker/menu-categories.js` | Owner-configurable categories (published with the menu) |
| `worker/agent.js`, `worker/agent-context.js` | Agent keys, tools, MCP (Streamable HTTP), REST, OpenAPI, llms.txt |
| `web/` | Storefront (`index.html`, `storefront.js`), `admin.html`, `pos.html`, `kitchen.html`, policy templates |
| `migrations/` | D1 schema (`0001_schema.sql` baseline, `0002_agent_api.sql`) |
| `seed/demo.sql` | Fictional demo menu used by the tests and `npm run demo:seed` |

## Content model: draft, release, live

- The owner (or an agent) edits **draft** tables: `products`, tags, posters, categories and public settings. Every write is a D1 batch whose first statement advances `public_content_state.draft_revision` only if the caller's expected revision is still current; every other statement is guarded on the new revision, so a stale write changes nothing.
- **Publishing** materialises the draft into an immutable snapshot (`public_content_releases`, one row per product in `public_content_release_products`), renders all public pages once, and switches the live pointer in the same batch. `publish-exact` also requires the checksum the publisher reviewed.
- **Checkout and POS price from the live release**, never from the draft. If the menu changes while a customer is checking out, the order is rejected with `409 menu_changed` and the customer confirms the new prices.
- A rollback creates a new release from an older one; history is never rewritten.

## Agent layer

1. `Authorization: Bearer hlk_…` → SHA-256 → `agent_keys` (not revoked).
2. Tool lookup → scope check → rate limit (120/min/key) → argument validation against the tool's JSON Schema.
3. The tool calls the existing admin handlers through `worker.fetch` with an elevated env (`Object.create(env)` carrying module-private Symbols). `isAdmin` accepts that env; the admin gate then allows only the routes in `AGENT_ADMIN_ROUTES`.
4. Result and arguments (truncated, no image bytes) go to `agent_audit`; content events record `agent:<key name>` as the actor.

Because agents run through the owner's handlers, they get the same validation, compare-and-swap protection and publication guards — there is no second implementation of the business rules.

## Money and safety invariants

- Stripe webhooks are signature-verified and recorded in `payment_events` keyed by the Stripe event id, so a redelivered event is not applied twice.
- Wallet balance changes are written as ledger events with unique references; refunds accumulate in `orders.refunded_total` and cannot exceed the order total.
- Order submission is idempotent per `client_token`; a promo code's global usage limit is claimed with a single conditional update.
- POS PINs and agent keys are stored only as hashes (PBKDF2 for PINs, SHA-256 for 160-bit random keys). No PIN or key ships with the system.

## Time and money

Business dates and hours use Singapore time (UTC+8). Prices are SGD; release snapshots store integer cents.
