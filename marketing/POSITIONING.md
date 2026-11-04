# Hawkerline positioning

Entity sentence (use verbatim wherever a one-sentence definition is needed):

> **Hawkerline is a source-available restaurant ordering, kitchen display, menu and POS system that an AI agent can operate, built for Singapore food businesses and running on one Cloudflare Worker and one D1 database.**

Chinese entity sentence:

> **Hawkerline 是一套 AI 智能体可以直接操作的餐饮点餐、厨房看板、菜单与收银系统，源码公开，面向新加坡餐饮商户，运行在一个 Cloudflare Worker 和一个 D1 数据库上。**

All claims trace to `FACTS.md`. No numbers beyond those in that file.

## 1. Ideal customer profile

| Segment | Who they are | Why Hawkerline fits |
|---|---|---|
| Independent restaurants, cafés, bakeries | Owner-operated food businesses in Singapore, within the licence ceiling of S$10,000,000 annual revenue (with affiliates) | Storefront, back office, POS and kitchen board in one system; Singapore defaults (SGD, GST, service charge, PayNow, SGT) already set |
| Hawker and stall operators | Small counters that need pickup, pre-order slots and a kitchen ticket | Pickup or delivery, scheduled time slots, kitchen ticket printing, Telegram order alerts |
| Small chains | A few outlets under one business | Own the system across outlets without per-terminal SaaS fees; the licence covers "its own outlets" |
| Technical owners and their IT contractors | People who can deploy a Worker, or hire someone who can | Contractor setup for the business's own use is explicitly allowed |
| AI-forward operators | Owners who already use an AI agent such as Claude Code for daily work | The agent can list the menu, publish, and watch orders through MCP, REST and `/llms.txt` |

Out of scope as customers (licence): system vendors, POS/SaaS providers, agencies and integrators who want to resell, sublicense or host it for other businesses; businesses above S$10,000,000 (these need a commercial licence; they are a conversation, not the target of the free community licence).

## 2. The problem

- Running an online menu means repeated manual work: typing products, prices, descriptions and categories into a back office whenever the menu changes.
- Ordering, kitchen and POS tools are often separate subscriptions, so the owner does not control the data or the cost structure.
- Letting software act on the live menu raises a fair worry: what if a mistake goes public?

## 3. Value proposition

Hand an AI agent a photo or PDF of your menu. It creates the products and categories, shows you a preview of the draft against the live menu, and publishes exactly what you previewed. The same agent can then watch incoming orders and move them through the kitchen. You run all of it yourself, from source you can read, on one Worker and one database.

## 4. Messaging pillars

### Pillar 1: AI-operable by design
- MCP server at `/mcp` (Streamable HTTP, JSON over POST, bearer-key auth; hlk_ keys, 120 calls per minute per key), REST at `/api/agent/v1` with an OpenAPI 3.1 document, and `/llms.txt` on every deployment.
- 16 tools cover the full loop, for example `bulk_upsert_products` (up to 100 products per call), `preview_menu`, `publish_menu`, `get_kitchen_board`, `advance_order`; each has exactly one scope (see site agents page).
- Proof line: "photo of a menu → products → preview → publish".

### Pillar 2: Own your system
- Source-available; self-host; modify. No per-terminal SaaS subscription model to be locked into (state this generally; never name or price a competitor).
- Free for an F&B business's own outlets up to S$10,000,000 annual revenue; IT contractors may set it up.
- Honest boundary: it is source-available, not OSI open source, and vendors cannot resell it.

### Pillar 3: One Worker, one database
- One Cloudflare Worker + one D1 (SQLite) database; static files via Workers Assets; no separate server to maintain.
- Do not quote a running-cost figure. Say "low running cost" only as a consequence of the architecture, without a number.

### Pillar 4: Production-proven
- Extracted from the production system of 坡晓馒 PO XIAO MAN, a Singapore bun shop with live Stripe payments, a bilingual menu, back office, POS and kitchen on the same Worker.
- Do not add order volumes, revenue, ratings, quotes or dates.

## 5. Proof points allowed
Singapore defaults (SGT, SGD, GST/service charge, PayNow QR, postal-sector zones); bilingual storefront; draft/publish with immutable releases, scheduled publishing, 10-minute signed preview, rollback; compare-and-swap edit protection; Stripe with signed webhooks and refunds; wallet, points, promo codes; Lalamove quote only; Telegram alerts; CSV export for delivery platforms.

## 6. Objections and answers

**"What licence is this? Is it open source?"**
Source-available under the Hawkerline Community License. The code is public, but it is not OSI open source. A food and beverage business with annual revenue (with affiliates) of not more than S$10,000,000 in the previous financial year can run it free for its own outlets. Personal, evaluation, educational and non-commercial use is also allowed.

**"I am an agency or POS vendor. Can I install it for clients?"**
Setting it up for a client's own use is permitted when the client is an eligible business and you act as that business's IT contractor. Selling, reselling, sublicensing, hosting it as a service for other businesses, or bundling it in a commercial product needs a separate commercial licence. Ask through the GitHub repository issues.

**"We are above S$10,000,000."**
A commercial licence is required; after crossing the threshold there are 90 days to obtain one. Open an issue on the GitHub repository to contact the licensor.

**"Who supports it?"**
It is provided as-is, without warranty. There is no support contract in the community licence. Do not promise SLAs. Suggest an IT contractor for setup and the GitHub repository for issues. Licensor: Leonard Chow Yi Ding; the `LICENSE` file governs.

**"Is it safe to let an AI publish my menu?"**
Four layers: (1) the agent can only publish the exact draft it previewed; `publish_menu` needs the `draft_checksum` and `live_release_id` from `preview_menu`; (2) scopes limit each key, for example `menu:read` without `menu:publish`; (3) every agent call lands in an audit log the owner can read in `/admin`; (4) the owner can revoke a key instantly. Keys are shown once and stored only as a hash. Edits go to a draft, customers only see a published release, and rollback creates a new release from an older one.

**"Do I need a server?"**
No separate server. One Cloudflare Worker and one D1 database.

**"Does it work with my AI assistant?"**
Any MCP client that can send an `Authorization: Bearer` header over Streamable HTTP can connect to `/mcp`, for example Claude Code. OAuth is not implemented, so connectors that only support OAuth cannot connect directly; those agents can use the REST API (`POST /api/agent/v1/tools/<tool>`) and the OpenAPI document. Do not claim support for any other named client.

**"Does it book couriers or take card payments?"**
Stripe online payments and PayNow QR (manual confirmation) are supported. Lalamove is quote only; the system does not book couriers automatically.

## 7. Tone
- English: plain, concrete, confident. No buzzword soup.
- Chinese: professional and restrained; no slang, no exclamation-heavy hype. Use 「源码公开」, never "开源" alone.
- Always "source-available". Never "free open source" or "OSI-approved".
