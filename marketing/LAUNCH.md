# Launch posts (for the maintainer to adapt; nothing here has been posted)

## English

**Hawkerline: a source-available restaurant ordering and POS system that an AI agent can operate**

Hawkerline is a source-available restaurant ordering, kitchen display, menu and POS system that an AI agent can operate, built for Singapore food businesses and running on one Cloudflare Worker and one D1 database.

It was extracted from the production system behind 坡晓馒 PO XIAO MAN, a Singapore bun shop (https://poxiaoman.com).

Any MCP client that can send a bearer header (for example Claude Code) can connect to `/mcp`; REST (`/api/agent/v1`, OpenAPI 3.1) and `/llms.txt` are also available. OAuth is not implemented. What an agent can do: read the store, create and update products, bulk-load a whole menu, set images from URLs, preview the draft against the live menu, publish exactly the previewed draft, list orders, read the kitchen board and advance orders. A typical flow is a photo of a menu, then products, then preview, then publish.

Safety: the agent can only publish the draft it previewed (checksum must match), keys are scoped, every call is audit-logged, and the owner can revoke a key instantly.

Licence: Hawkerline Community License 1.0 (LICENSE file; licensor Leonard Chow Yi Ding). Free for a food and beverage business's own outlets up to S$10,000,000 annual revenue; vendors and resellers need a commercial licence. It is source-available, not OSI open source. Provided as-is, without warranty.

Try it locally: `npm ci`, `npm run db:migrate:local`, `npm run demo:seed`, `npm run dev`.

Repository: https://github.com/shuaige121/hawkerline

## 中文

**Hawkerline：AI 智能体可以操作的餐饮点餐与收银系统，源码公开**

Hawkerline 是一套 AI 智能体可以直接操作的餐饮点餐、厨房看板、菜单与收银系统，源码公开，面向新加坡餐饮商户，运行在一个 Cloudflare Worker 和一个 D1 数据库上。

它由新加坡包点店 坡晓馒 PO XIAO MAN（https://poxiaoman.com）的生产系统抽取而成。

任何能发送 bearer 请求头的 MCP 客户端（例如 Claude Code）都可以接入 `/mcp`；也提供 REST（`/api/agent/v1`，OpenAPI 3.1）与 `/llms.txt`。系统未实现 OAuth。智能体可以：读取店铺状态、创建与更新商品、整份菜单批量写入、按图片链接设置商品图、对照线上菜单预览草稿、只发布已预览的草稿、查看订单、读取厨房看板并推进订单。典型流程是：菜单照片，生成商品，预览，发布。

安全机制：智能体只能发布它预览过的草稿（校验码必须一致），密钥按权限划分，每次调用写入审计日志，店主可随时吊销密钥。

许可：Hawkerline Community License 1.0（见 LICENSE 文件；许可方 Leonard Chow Yi Ding）。餐饮商户在年营业额不超过 1,000 万新元时可免费用于自家门店；系统商与转售方需另行取得商业许可。本项目为源码公开，不是 OSI 开源，按现状提供，不附带担保。

本机试用：`npm ci`、`npm run db:migrate:local`、`npm run demo:seed`、`npm run dev`。

仓库：https://github.com/shuaige121/hawkerline
