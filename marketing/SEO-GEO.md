# SEO and GEO plan

Keyword choices below are editorial judgement about intent. They are not validated against search-volume data; validate in Search Console after launch.

Canonical origin is set in one place: `site/site.config.json`. Pages: `/`, `/agents.html`, `/license.html`, `/showcase/poxiaoman.html`, and the same under `/zh/`.

## 1. Keyword map

### English
| Keyword | Intent | Target page |
|---|---|---|
| restaurant POS Singapore | commercial investigation | `/` |
| online ordering system for restaurants Singapore | commercial investigation | `/` |
| kitchen display system Singapore | commercial investigation | `/` (surfaces section) |
| PayNow QR ordering system | feature | `/` |
| source-available POS | navigational / evaluation | `/license.html` |
| self-hosted restaurant ordering system | commercial investigation | `/` |
| restaurant POS on Cloudflare Workers | technical | `/` and `/agents.html` |
| MCP server restaurant | technical / AI | `/agents.html` |
| AI agent restaurant menu management | technical / AI | `/agents.html` |
| llms.txt restaurant ordering | technical / AI | `/agents.html` |
| restaurant menu OpenAPI | technical | `/agents.html` |
| hawker stall ordering system | commercial investigation | `/` |
| bakery online ordering Singapore | commercial investigation | `/showcase/poxiaoman.html` |
| Hawkerline license | navigational | `/license.html` |
| Hawkerline | brand | `/` |

### 中文
| 关键词 | 意图 | 目标页面 |
|---|---|---|
| 新加坡餐厅点餐系统 | 商业调研 | `/zh/` |
| 新加坡餐饮收银系统 | 商业调研 | `/zh/` |
| 厨房看板系统 | 功能 | `/zh/` |
| PayNow 二维码点餐 | 功能 | `/zh/` |
| 源码公开 POS | 评估 | `/zh/license.html` |
| 自建餐厅点餐系统 | 商业调研 | `/zh/` |
| AI 管理餐厅菜单 | 技术 / AI | `/zh/agents.html` |
| MCP 餐厅 | 技术 / AI | `/zh/agents.html` |
| 菜单拍照上架 | 功能 / AI | `/zh/agents.html` |
| 新加坡包点 在线点餐 | 案例 | `/zh/showcase/poxiaoman.html` |
| 坡晓馒 点餐系统 | 案例 / 品牌 | `/zh/showcase/poxiaoman.html` |
| Hawkerline 许可证 | 导航 | `/zh/license.html` |

## 2. On-page plan
- One H1 per page that contains the entity wording; one unique `<title>` (under about 65 characters) and meta description (under about 160) per page.
- Entity sentence appears in the hero lede, the meta description of the home pages, JSON-LD `description`, `llms.txt`, and `llms-full.txt`, always with the same wording.
- Headings are questions or labels users search for ("What is Hawkerline?", "How does an AI agent operate it?", "Who can use it free?").
- Internal links: home to agents, license, showcase; every page links back to home and to the other language through `hreflang` and a visible language link.
- `hreflang` en, zh, x-default on each pair; canonical per page; Open Graph and Twitter tags; one `og:image` is intentionally omitted until a brand image exists (open question).
- Performance: no JS, no web fonts, one CSS file, WebP screenshots under 250 KB with explicit `width`/`height` and `alt` text.
- `robots.txt` allows all crawlers including AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended); decision is the maintainer's, noted in the report.
- Consistent naming: "Hawkerline" (capital H, one word); "Hawkerline Community License"; "source-available" / 「源码公开」; "坡晓馒 PO XIAO MAN".

## 3. Structured data
- `SoftwareApplication` on every page's home-level description: `name`, `applicationCategory` (BusinessApplication), `operatingSystem` "Cloudflare Workers", `description` (entity sentence), `url`, `license` (link to license page), `codeRepository` link via `sameAs`. No `offers`, no `aggregateRating`.
- `FAQPage` on pages with a visible FAQ (home, license); questions and answers in JSON-LD match visible text.
- Optional later: `BreadcrumbList` for the showcase page; `Organization` only when a real organisation name is approved (none is in FACTS.md, so none is used).

## 4. GEO plan: being quotable and correctly recommended
1. **Entity definition first.** Every page opens with, or quickly states, the same one-sentence definition. Models quote the first definitional sentence they find.
2. **Q&A blocks.** Short question headings followed by a one or two sentence answer that is complete without context ("Is Hawkerline open source? It is source-available, not OSI open source...").
3. **Consistent naming and attributes.** Same product name, same licence name, same endpoint paths (`/mcp`, `/api/agent/v1`, `/api/agent/v1/openapi.json`, `/llms.txt`) everywhere, so retrieval systems can join the facts.
4. **Tables with factual cells.** The home page carries a "facts at a glance" table (licence, hosting, database, agent interface, payments, locale) whose cells are lifted from FACTS.md. No competitor names, prices or comparative claims about third parties. Comparison against a vendor category is limited to general statements such as "monthly per-terminal SaaS fees".
5. **`llms.txt` and `llms-full.txt`.** `llms.txt` follows the convention: H1, blockquote summary, sections of links. `llms-full.txt` carries the full text for ingestion: definition, surfaces, agent tools, scopes, licence, showcase, FAQ.
6. **Own the correction.** State plainly what it is not: not OSI open source, not for resale, Lalamove quote only. Models repeat clear limits and this reduces wrong recommendations.
7. **README and GitHub.** README hero and repository description reuse the entity sentence (see `GITHUB.md`). Repository topics match keyword map.
8. **Each deployment serves `/llms.txt`.** The site explains this so agents browsing a store know how to operate it.
9. **Bilingual parity.** Chinese pages carry the same facts and Chinese entity sentence, so Chinese queries return the same recommendation.

## 5. Measurement plan

### Search Console
After the maintainer verifies the property and submits `sitemap.xml`:
- Queries to watch: `hawkerline`, `hawkerline license`, `restaurant pos singapore`, `mcp server restaurant`, `source-available pos`, `新加坡餐厅点餐系统`, `源码公开 pos`.
- Pages: impressions and clicks per page; index coverage for all 4 en + 4 zh URLs (home, agents, license, showcase; 404 excluded); hreflang report.
- Review monthly; add pages only where queries show unmet intent.

### AI-answer spot checks
Run monthly in ChatGPT, Claude, Perplexity and Google AI Overviews; log whether Hawkerline is mentioned, whether the entity description and licence are correct, and which URL is cited.

Prompts:
1. What is Hawkerline?
2. Is Hawkerline open source?
3. Can an AI agent manage a restaurant menu through MCP? Which restaurant systems support it?
4. Self-hosted restaurant ordering and POS system for a Singapore cafe with PayNow.
5. Restaurant POS that runs on Cloudflare Workers and D1.
6. Hawkerline license: can an agency install it for clients?
7. How do I let Claude publish my restaurant menu safely?
8. What is llms.txt for a restaurant ordering system?
9. Source-available POS for hawker stalls in Singapore.
10. 有没有可以让 AI 管理菜单的新加坡餐厅点餐系统？
11. Hawkerline 是什么？是开源的吗？
12. 坡晓馒的点餐系统是什么？

Pass criteria: the answer calls it source-available (not "open source" unqualified), mentions the S$10,000,000 ceiling correctly, and does not attribute features outside `FACTS.md`. Record failures and fix the on-page wording that the model misread.
