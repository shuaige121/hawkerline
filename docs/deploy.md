# Deploying to your Cloudflare account

Hawkerline is one Worker plus one D1 database. Static pages (`web/`) are served by Workers Assets from the same Worker.

## 1. Prepare

```bash
npm ci
npx wrangler login
npx wrangler d1 create hawkerline
```

Copy the `database_id` printed by the last command into `wrangler.toml` (`[[d1_databases]]`). In the same file set:

- `SHOP_DOMAIN` — your store's host name without `https://`, for example `order.example.com.sg`
- `PAY_MODE` — `manual` (PayNow QR, confirm payments in `/admin`) or `stripe`
- `PAYNOW_UEN` — your PayNow UEN or mobile number, if you use PayNow
- `MERCHANT`, `INVOICE_PREFIX`, and optionally `BOSS_PHONE` and the Apple sign-in values

## 2. Database and secrets

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put ADMIN_TOKEN      # owner password for /admin, 32+ random characters
npx wrangler secret put AUTH_SECRET      # signing key for sessions and tokens, 32+ random characters
```

Optional secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (these two can also be saved in `/admin` → 支付设置), `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `ADMIN_TOKEN_SECONDARY`.

## 3. Deploy

```bash
npm test          # optional but recommended
npx wrangler deploy
```

Attach your domain to the Worker in the Cloudflare dashboard (Workers → hawkerline → Settings → Domains & Routes). The paths `/admin`, `/pos` and `/kitchen` work on the main domain. If you also attach host names starting with `boss.`, `pos.` or `kitchen.`, their `/` redirects to the matching surface; `www.<SHOP_DOMAIN>` redirects to `SHOP_DOMAIN`.

The every-minute cron trigger in `wrangler.toml` activates scheduled releases and, on a fresh database, creates the first (empty) menu release within about a minute of the first deploy. Publishing — and agent menu edits — work after that. The other cron entries send the morning and evening summaries, check courier status and expire abandoned wallet-balance orders.

## 4. First-time setup in /admin

1. Log in at `https://your-domain/admin` with `ADMIN_TOKEN`.
2. **🎨 品牌设置** — store name in Chinese and English, slogan, logo and colours. Until you save one, `BRAND` from `wrangler.toml` is shown.
3. **⚙️ 营业/自取/配送设置** — contact phone, pickup point name and address, business hours, delivery rules, GST and service charge. If you charge delivery by distance or use courier quotes, set the shop's pickup postal code under **🚚 配送收费**; there is no default.
4. **🗂️ 菜单分类** and **🏷️ 商品详情** — or let an agent do it (next step).
5. **🤖 AI 接入** — create an agent key and connect your agent ([agents.md](agents.md)).
6. **🚀 内容发布** — preview and publish the menu (or let the agent publish).
7. **🔐 收银员 PIN** — set PINs for `pos1`–`pos3`. No PIN ships with the system, so the POS cannot be used until you set one.
8. **💳 支付设置** — Stripe keys and the webhook URL shown there, if you use Stripe.
9. **🖨️ 厨房打印** and **🔔 来单提醒** — kitchen printer and Telegram alerts, if you use them.

Before going live, review the customer-facing pages `/about`, `/terms` and `/privacy` (`web/about.html`, `web/terms.html`, `web/privacy.html`). They are generic templates that show your store name and contact number automatically; your own policies — refunds, data protection, stored value — are your responsibility.

## Running costs

Cloudflare bills Workers and D1 by usage; check Cloudflare's current pricing for your plan. Stripe, Lalamove, WhatsApp and Telegram are separate services with their own terms.

## Updating

```bash
git pull
npx wrangler d1 migrations apply DB --remote   # applies only new migrations
npx wrangler deploy
```
