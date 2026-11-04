# Hawkerline

**Hawkerline is a source-available restaurant ordering, kitchen display, menu and POS system that an AI agent can operate, built for Singapore food businesses and running on one Cloudflare Worker and one D1 database.**

Give an AI agent a photo or PDF of your menu. It creates the products and categories, previews the draft against the live menu, and publishes exactly what it previewed. Then it can watch orders and move them through the kitchen.

- **Four surfaces on one Worker:** customer storefront, `/admin` back office, `/pos` cashier, `/kitchen` board.
- **Agent interface:** MCP at `/mcp`, REST at `/api/agent/v1` with OpenAPI 3.1, and `/llms.txt`.
- **Safety rails:** edits go to a draft; publishing needs the preview checksum; scoped keys; audit log; instant revocation.
- **Singapore defaults:** SGT, SGD, GST and service charge, PayNow QR, Stripe, postal-sector delivery zones.
- **License:** free for a food and beverage business's own outlets up to S$10,000,000 annual revenue under the [Hawkerline Community License](LICENSE). Source-available, not OSI open source. System vendors and resellers need a commercial license.
- **Production-proven:** extracted from the system behind [坡晓馒 PO XIAO MAN](https://poxiaoman.com).

[中文说明](#中文说明) · [Deploy](docs/deploy.md) · [Connect an AI agent](docs/agents.md) · [Tool reference](docs/agent-tools.md) · [Architecture](ARCHITECTURE.md)

## What is in the box

| Surface | Path | Who uses it |
|---|---|---|
| Storefront | `/`, `/menu`, `/menu/<item>`, `/locations`, `/offers` | Customers: bilingual menu, cart, pickup or delivery, pre-order time slots, PayNow or Stripe, member wallet and points, promo codes |
| Back office | `/admin` | Owner: products, prices, photos, sets, categories, tags, posters, promo codes, delivery zones, hours, GST/service charge, payments, members, orders, refunds, reports, AI agent keys |
| POS | `/pos` | Cashiers: PIN login, counter sales, member lookup, wallet top-up, clock-in/out |
| Kitchen | `/kitchen` | Kitchen: board with new → preparing → ready → done, ticket printing (Star CloudPRNT or the bundled print agent) |
| Agent API | `/mcp`, `/api/agent/v1`, `/llms.txt` | AI agents with an owner-issued key |

Menu changes never go live by accident: everything is edited as a draft, published as an immutable release (now or scheduled), previewable through a 10-minute signed link, and reversible by rolling back to an earlier release.

## Quick start (local)

Requirements: Node.js 22.13 or newer (tested on Node 24) and npm. No Cloudflare account is needed to try it locally.

```bash
git clone https://github.com/shuaige121/hawkerline.git
cd hawkerline
npm ci
cp .dev.vars.example .dev.vars          # then put two long random strings in it
npm run db:migrate:local                # create the local D1 database
npm run demo:seed                       # optional: a fictional dim-sum menu to play with
npm run dev                             # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # creates the first menu release
```

Open `http://localhost:8787/admin` and log in with the `ADMIN_TOKEN` from `.dev.vars`. Set cashier PINs under **🔐 收银员 PIN**, then open `/pos`. Create an agent key under **🤖 AI 接入**.

To deploy to your own Cloudflare account, follow [docs/deploy.md](docs/deploy.md).

## Let an AI agent run the menu

1. In `/admin` → **🤖 AI 接入**, create a key and tick the scopes it needs (for menu work: `menu:read`, `menu:write`, `menu:publish`). The key is shown once.
2. Connect your agent. For Claude Code:
   ```bash
   claude mcp add --transport http my-store https://your-store.example/mcp \
     --header "Authorization: Bearer hlk_…"
   ```
   Other MCP clients use the same URL and header. Agents without MCP can call `POST /api/agent/v1/tools/<tool>`; the OpenAPI document is at `/api/agent/v1/openapi.json`.
3. Ask it, for example: *"Here is a photo of our menu. Create the categories and items, show me the preview, and publish when I say yes."*

The agent will call `get_store_overview`, `set_categories`, `bulk_upsert_products`, `preview_menu` and then `publish_menu` with the checksum from the preview. If anything changes between preview and publish, nothing is published. Every call appears in the audit list in `/admin`. Full guide: [docs/agents.md](docs/agents.md).

## Tests

```bash
npm test                                    # syntax check, Worker bundle, about 185 node:test cases on real SQL
node tools/smoke-agent.mjs http://localhost:8787   # end-to-end over HTTP against `npm run dev`
node tools/ui-smoke.mjs http://localhost:8787      # clicks through storefront, admin, POS and kitchen in headless Chrome
```

The test-suite runs the real Worker routes against the real migrations on `node:sqlite`, including the agent layer (key lifecycle, MCP protocol, scopes, preview-checksum publishing, the guard that keeps agents away from owner-only routes).

## License

[Hawkerline Community License 1.0](LICENSE) © 2026 Leonard Chow Yi Ding.

- Free: food and beverage businesses (with their affiliates) at or below **S$10,000,000** annual revenue, for their own outlets — including hiring a contractor to set it up for them; personal, evaluation, educational and non-profit use.
- Needs a commercial license: selling, reselling, sublicensing, hosting it as SaaS or white-label for other businesses, bundling it into a commercial product, or use by businesses above the threshold.

For a commercial license, open an issue in this repository.

---

## 中文说明

**Hawkerline 是一套源码公开的餐饮点餐、厨房看板、菜单与收银系统，AI 智能体可以直接操作；面向新加坡餐饮商户，运行在一个 Cloudflare Worker 和一个 D1 数据库上。**

把菜单照片或 PDF 交给 AI 智能体，它会建立分类和商品，对照线上菜单预览草稿，并且只发布它预览过的那一版；之后还能查看订单、推进厨房出餐流程。

- **同一个 Worker 上的四个界面：** 顾客点餐页、`/admin` 店主后台、`/pos` 收银台、`/kitchen` 厨房看板。
- **智能体接口：** `/mcp`（MCP）、`/api/agent/v1`（REST，附 OpenAPI 3.1）、`/llms.txt`。
- **安全机制：** 所有改动先进草稿；发布必须带预览给出的校验值；密钥按权限划分；每次调用留审计记录；密钥可随时撤销。
- **新加坡默认设置：** 新加坡时间、新元、GST 与服务费、PayNow 二维码、Stripe、按邮区划分的配送区域。
- **许可证：** 依据 [Hawkerline Community License](LICENSE)，年营业额（含关联公司）不超过 1,000 万新元的餐饮商户可免费用于自家门店。源码公开，但不是 OSI 定义的开源；系统商、经销商、托管服务商商用需另行取得商业授权。
- **生产环境验证：** 由 [坡晓馒 PO XIAO MAN](https://poxiaoman.com) 正在使用的系统整理而来。

### 本地试用

需要 Node.js 22.13 或更新版本（已在 Node 24 上测试）。

```bash
npm ci
cp .dev.vars.example .dev.vars      # 填入两段足够长的随机字符串
npm run db:migrate:local
npm run demo:seed                   # 可选：一份虚构的点心铺演示菜单
npm run dev
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # 生成第一个菜单发布
```

打开 `http://localhost:8787/admin`，用 `.dev.vars` 里的 `ADMIN_TOKEN` 登录。在「🔐 收银员 PIN」设置收银员密码后即可使用 `/pos`；在「🤖 AI 接入」生成 agent key。部署到自己的 Cloudflare 账号见 [docs/deploy.md](docs/deploy.md)。

### 交给 AI 上架菜单

1. 后台「🤖 AI 接入」新建 key，勾选需要的权限（菜单工作勾 `menu:read`、`menu:write`、`menu:publish`）。key 只显示一次。
2. 在 Claude Code 中接入：`claude mcp add --transport http my-store https://你的域名/mcp --header "Authorization: Bearer hlk_…"`。其他 MCP 客户端使用同一地址和请求头；不支持 MCP 的 agent 可调用 REST 接口。
3. 对它说：「这是我们的菜单照片，请建好分类和商品，给我看预览，我确认后再发布。」

预览之后草稿若有任何变化，发布会被拒绝，需要重新预览。所有调用都记录在后台。详见 [docs/agents.md](docs/agents.md)。

### 授权

[Hawkerline Community License 1.0](LICENSE)，© 2026 Leonard Chow Yi Ding。

- 免费：年营业额（含关联公司）不超过 1,000 万新元的餐饮商户，用于自家门店，包括请外包技术人员替自己部署；个人、评估、教学和非营利用途。
- 需要商业授权：出售、转售、再授权、作为 SaaS 或白标服务提供给其他商家、打包进商业产品，以及年营业额超过门槛的商户使用。

商业授权请在本仓库提交 issue 联系。
