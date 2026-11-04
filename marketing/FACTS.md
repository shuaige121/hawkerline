# Allowed facts (single source of truth for all marketing, SEO and GEO copy)

Any claim in marketing copy, the landing site, README hero text, structured data or llms.txt
must be traceable to a line in this file. Anything not listed here is not claimed: no invented
numbers, customer counts, revenue, ratings, testimonials, awards, partner logos, prices, dates,
team names, company names or contact addresses.

## Product

- Name: **Hawkerline**. One-line: a restaurant ordering, kitchen display, menu and POS system that an AI agent can operate.
- Source-available (the source code is public), not OSI "open source". Use "source-available" in English copy; in Chinese use 「源码公开」. Never call it "free open source software" or "OSI-approved".
- Runs as **one Cloudflare Worker + one Cloudflare D1 (SQLite) database**; static files served by Workers Assets. No separate server to maintain.
- Singapore-first defaults: Singapore time (SGT), SGD prices, GST and service-charge settings, PayNow QR, Singapore postal-sector delivery zones.
- Bilingual customer storefront and menu: Chinese and English.
- Extracted from the production system of a Singapore food business (see Showcase).

### Surfaces (same Worker, separated by path or subdomain)
- Customer storefront: menu, product pages (`/menu/<slug>`), cart, checkout, pickup or delivery, scheduled (pre-order) time slots within business hours, order invoice page.
- Owner back office `/admin`: products, prices, images, sort order, combo/set components, tags, homepage posters, promo codes, delivery zones, business hours, GST/service charge, payment settings, members, orders, refunds, sales summary, kitchen-printer settings.
- POS cashier `/pos`: cashier login with PIN, counter sales, member lookup, wallet top-up at the counter, staff clock-in/clock-out.
- Kitchen `/kitchen`: kitchen board with order status flow new → preparing → ready → done; kitchen ticket printing (Star CloudPRNT endpoint, plus a small print agent for macOS and Windows).

### Menu publishing
- Edits go to a draft. Customers only see a published release.
- Releases are immutable snapshots; publishing can be immediate or scheduled (Singapore time); a 10-minute signed preview link shows the draft before it goes live; rollback creates a new release from an older one.
- Concurrent edits are protected by revision checks (compare-and-swap): a stale edit is rejected instead of overwriting.
- Public menu pages are server-rendered HTML with a short shared cache (60 seconds); `sitemap.xml` and `robots.txt` are generated.
- Combos/sets list their components on the customer menu and on kitchen tickets.
- CSV export of the menu for delivery-platform listing, with a configurable commission markup on prices.

### Payments, members, promotions
- Stripe online payments with signed webhooks; Stripe refunds (full order or delivery fee only).
- PayNow dynamic QR (SGQR / EMVCo payload) for manual-confirmation payment.
- Member accounts with Google sign-in and Sign in with Apple; guest checkout with a phone number.
- Stored-value wallet with configurable top-up bonus tiers; member points and tiers.
- Promo codes with rules such as per-account limits, first-order only, pickup only and batches.

### Delivery and notifications
- Delivery fee by zone, minimum order and free-delivery threshold; courier price quotes from Lalamove (quote only — the system does not book couriers automatically).
- Telegram new-order alerts to subscribed staff chats.

### AI agent layer (the main differentiator)
- **Agent API keys** with scopes, created and revoked by the owner in `/admin`. Keys are shown once and stored only as a hash. Scopes: `menu:read`, `menu:write`, `menu:publish`, `orders:read`, `orders:write`, `store:write`, `reports:read`.
- **MCP server** at `/mcp` (Model Context Protocol, Streamable HTTP transport, bearer-key auth). Works with MCP clients such as Claude and other MCP-capable agents.
- **REST API** at `/api/agent/v1/...` with an **OpenAPI 3.1** document at `/api/agent/v1/openapi.json`.
- **`/llms.txt`** served by every deployment, explaining to an AI agent how to operate the store.
- Agent tools: read store status; list products; create or update products (names, prices, descriptions, category, components); bulk create/update a whole menu in one call; set a product image from an image URL; put items on or off sale; reorder the menu; manage menu categories; preview the draft against the live menu; publish exactly the previewed draft; list orders; read the kitchen board; advance an order through the kitchen flow; open or close the store; read a sales summary.
- Safety rails: an agent can only publish the exact draft it previewed (checksum must match); every agent call is written to an audit log visible to the owner; scopes limit what each key can do; the owner can revoke a key instantly.
- Typical flow: give an agent a photo or PDF of a menu → it creates the products and categories → previews → publishes; then the same agent can watch orders and move them through the kitchen.

### Menu categories
- Categories are configurable by the owner (or an agent): key, Chinese label, English label.

## License (Hawkerline Community License)

- Free for a food & beverage business to run for **its own outlets**, if the business together with its affiliates had **annual revenue of not more than S$10,000,000** in the previous financial year.
- Allowed for that business: install, modify, self-host, and have an IT contractor set it up for the business's own use.
- Not allowed without a separate commercial license: system vendors, POS/SaaS providers, agencies or integrators selling, reselling, sublicensing, hosting it as a service for other businesses, or bundling it into a commercial product.
- Businesses above S$10,000,000 annual revenue need a commercial license.
- Personal, evaluation, educational and non-commercial use is allowed.
- Provided as-is, without warranty.

## Showcase: 坡晓馒 PO XIAO MAN

- 坡晓馒 PO XIAO MAN is a Singapore bun (包点) shop. Website: https://poxiaoman.com
- Its online ordering storefront, owner back office, POS and kitchen run on the system Hawkerline was extracted from.
- It runs on Cloudflare Workers + D1 and accepts live Stripe payments.
- The storefront is at poxiaoman.com; the back office, POS and kitchen use their own subdomains of the same Worker.
- Bilingual Chinese/English menu, with combos, family boxes and drinks.
- Not allowed in copy: order volumes, revenue, customer numbers, ratings, quotes from the owner, launch dates, staff names.

## Verified implementation facts (added after the build; these override anything above that conflicts)

- Tool identifiers and their scopes are exactly the table in `docs/agent-tools.md` (generated from the code): get_store_overview, list_categories, list_products, preview_menu (menu:read); set_categories, upsert_product, bulk_upsert_products, set_product_availability, set_product_image, reorder_products (menu:write); publish_menu (menu:publish); list_orders, get_kitchen_board (orders:read); advance_order (orders:write); set_store_open (store:write); get_sales_summary (reports:read).
- `preview_menu` needs `menu:read`; `publish_menu` needs `menu:publish` and the `draft_checksum` + `live_release_id` returned by `preview_menu`.
- MCP clients: any MCP client that can send an `Authorization: Bearer` header over Streamable HTTP, for example Claude Code (`claude mcp add --transport http my-store https://your-store.example/mcp --header "Authorization: Bearer hlk_…"`). OAuth is not implemented, so connectors that only support OAuth cannot connect directly. Do not claim support for ChatGPT, Claude.ai web connectors or any other named client.
- MCP transport: JSON responses over POST (no server-sent events), protocol versions 2025-11-25, 2025-06-18, 2025-03-26.
- Keys look like `hlk_` + 40 hex characters; 120 calls per minute per key; phone numbers in order data are masked unless the agent asks for contact details (`include_contact`).
- Agents can reach only the admin functions their tools use; agent keys, payments, members, refunds and store settings stay owner-only.
- The audit log and key revocation are in `/admin` → 🤖 AI 接入.
- Bulk import: up to 100 products per call; images PNG/JPEG/WebP up to 640 KB from an https URL or base64.
- Repository: https://github.com/shuaige121/hawkerline ; license file `LICENSE` ("Hawkerline Community License 1.0", © 2026 Leonard Chow Yi Ding). Licensor: Leonard Chow Yi Ding.
- License details that may be stated: revenue counts the business together with its affiliates, previous financial year, S$10,000,000 or less; contractors may be paid to set it up for one eligible merchant but may not sell the software or run one deployment for several businesses; after exceeding the threshold there are 90 days to obtain a commercial license; commercial-license contact is an issue in the repository.
- Local trial: `npm ci`, `npm run db:migrate:local`, `npm run demo:seed`, `npm run dev`; deployment guide `docs/deploy.md`; agent guide `docs/agents.md`.
- Tests: about 180 automated node:test cases run against real SQL (do not state an exact number).
