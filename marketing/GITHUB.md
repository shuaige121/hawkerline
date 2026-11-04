# GitHub copy (for the maintainer to paste)

## Repository description (<= 350 characters)
Source-available restaurant ordering, kitchen display, menu and POS system that an AI agent can operate via MCP, REST and llms.txt. One Cloudflare Worker + one D1 database. Singapore-first: SGD, GST, PayNow, SGT. Extracted from a production Singapore bun shop.

(Length check is in REPORT.md.)

## Topics (19)
`restaurant-pos`, `online-ordering`, `kitchen-display-system`, `pos`, `mcp`, `model-context-protocol`, `mcp-server`, `ai-agents`, `llms-txt`, `cloudflare-workers`, `cloudflare-d1`, `openapi`, `singapore`, `paynow`, `stripe`, `food-and-beverage`, `self-hosted`, `source-available`, `sqlite`

## README hero: English

# Hawkerline

**Hawkerline is a source-available restaurant ordering, kitchen display, menu and POS system that an AI agent can operate, built for Singapore food businesses and running on one Cloudflare Worker and one D1 database.**

Give an AI agent a photo or PDF of your menu. It creates the products and categories, previews the draft against the live menu, and publishes exactly what it previewed. Then it can watch orders and move them through the kitchen.

- Four surfaces on one Worker: customer storefront, `/admin` back office, `/pos` cashier, `/kitchen` board.
- Agent interface: MCP at `/mcp` (any MCP client that can send a bearer header, for example Claude Code), REST at `/api/agent/v1` with OpenAPI 3.1, and `/llms.txt`. OAuth is not implemented.
- Safety rails: preview checksum, scoped keys, audit log, instant revocation.
- Singapore defaults: SGT, SGD, GST and service charge, PayNow QR, Stripe.
- Free for a food and beverage business's own outlets up to S$10,000,000 annual revenue under the Hawkerline Community License 1.0 (`LICENSE` file; source-available, not OSI open source).
- Production-proven: extracted from the system behind [坡晓馒 PO XIAO MAN](https://poxiaoman.com).

## README hero: 中文

# Hawkerline

**Hawkerline 是一套 AI 智能体可以直接操作的餐饮点餐、厨房看板、菜单与收银系统，源码公开，面向新加坡餐饮商户，运行在一个 Cloudflare Worker 和一个 D1 数据库上。**

把菜单照片或 PDF 交给 AI 智能体，它会建立商品与分类，对照线上菜单预览草稿，并只发布它预览过的那一版。之后它还能关注订单，并推进厨房流程。

- 同一个 Worker 上的四个界面：顾客点餐页、`/admin` 后台、`/pos` 收银、`/kitchen` 厨房看板。
- 智能体接口：`/mcp`（MCP，任何能发送 bearer 请求头的客户端均可，例如 Claude Code）、`/api/agent/v1`（REST，附 OpenAPI 3.1）、`/llms.txt`。系统未实现 OAuth。
- 安全机制：预览校验码、分权限密钥、审计日志、即时吊销。
- 新加坡默认设置：新加坡时间、新元、GST 与服务费、PayNow 二维码、Stripe。
- 在 Hawkerline Community License 下，上一财年年营业额不超过 1,000 万新元的餐饮商户，可免费用于自家门店（源码公开，不是 OSI 开源）。
- 已在生产环境验证：由 [坡晓馒 PO XIAO MAN](https://poxiaoman.com) 背后的系统抽取而成。

## Social preview text
- Title: Hawkerline: restaurant ordering and POS that an AI agent can operate
- Subtitle: Source-available. One Cloudflare Worker + one D1 database. Singapore-first.
- 中文：Hawkerline：AI 智能体可以操作的餐饮点餐与收银系统，源码公开。

(Social preview image: 1280x640 PNG, to be designed by the maintainer; no image is supplied.)
