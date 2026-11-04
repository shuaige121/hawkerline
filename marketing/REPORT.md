# Marketing and site report

## Files created
- marketing: `POSITIONING.md`, `SEO-GEO.md`, `GITHUB.md`, `LAUNCH.md`, `SOURCES.md`, `REPORT.md`, `qa/*.png` (screenshots at 390 and 1280 px, light; home pages also dark)
- site source: `index.html`, `agents.html`, `license.html`, `showcase/poxiaoman.html`, the same four under `zh/`, `404.html`, `sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`, `site.config.json`, `build.mjs`, `assets/style.css`, `assets/favicon.svg`, `assets/poxiaoman-storefront-desktop.webp` (44 KB), `assets/poxiaoman-storefront-mobile.webp` (47 KB)
- site build output: `site/dist/` (17 files)

## Checks run (actual results)
- `node site/build.mjs`: pass. "Built 17 files to dist/ with origin https://shuaige121.github.io/hawkerline"
- `grep -rn "{{" site/dist`: pass, 0 matches.
- JSON-LD parse and internal link check (node script): pass. "JSON-LD blocks parsed: 12; links checked: 167; problems: 0"
- Invented-number grep (`\d+%`, `\d+\+ restaurants/merchants/orders`, rating, testimonial, award, TBD, bracket placeholders): pass. Only hits were CSS percentages, markdown link brackets in llms.txt, and the word "rating" inside a POSITIONING.md instruction not to invent ratings.
- Playwright (headless Chromium), 8 pages x light/dark x 390/1280 px: no horizontal overflow on any page (scrollWidth equals viewport width). Home pages in both languages were viewed; layout reads correctly. I fixed one issue: the card grid left a single orphan card, now 2 columns on desktop and 1 on mobile. Other pages were checked for overflow only, not inspected visually.
- Repository description length: 260 characters (limit 350).
- Showcase screenshots: public storefront only, popup closed, scrolled past the promo banner; no login, no admin/pos/kitchen subdomain visited.

## Dropped because no allowed fact supported it
- Scope-to-tool mapping (which scope each tool needs) and tool identifiers: FACTS lists only scope names and tool descriptions.
- Competitor comparison and any competitor or price statement; the home page has a facts-at-a-glance table instead. No web research was done, so `SOURCES.md` lists no sources.
- `og:image`, Organization schema, `offers`, `aggregateRating`, curl examples, any contact email, any cost figure.
- Search-volume claims: keyword map is editorial judgement, not data.

## Open questions for the maintainer
1. Does the repository contain a license file under a known name, and does its text match the summary? The site says "the license text in the repository governs" without naming a file.
2. Confirm that audit-log viewing and key revocation happen in `/admin` (FACTS says keys are created and revoked there; the audit log is stated only as "visible to the owner").
3. Is `GitHub issues` acceptable as the commercial-license contact (as instructed), given issues are public?
4. Allow AI crawlers? `robots.txt` allows all.
5. Provide a 1200x630 social image, then add `og:image` and `twitter:card summary_large_image`.
6. The storefront screenshots show the shop's own prices and promotions; the page text does not cite them. Confirm the shop is happy to have them shown.
7. Site sources were produced by a one-off generator kept outside the repo; edit the HTML in `site/` directly from now on.

---

# Round 2 (aligned to "Verified implementation facts")

Questions 1 and 2 above are now answered by FACTS (LICENSE file; audit log and revocation in `/admin`) and are closed.

## Files changed
- site source (regenerated): `index.html`, `agents.html`, `license.html`, `showcase/poxiaoman.html` and the four `zh/` equivalents, `llms.txt`, `llms-full.txt`, `assets/style.css`; `site/dist/` rebuilt.
- marketing: `POSITIONING.md`, `LAUNCH.md`, `GITHUB.md`, `REPORT.md`; new `qa/agents-390.png` and `qa/agents-1280.png` (plus refreshed qa screenshots).

## What changed
- agents pages: 16-row tool table with exact identifiers and scopes (from `docs/agent-tools.md`), scope table, `claude mcp add` command, JSON config, curl REST example, transport (JSON over POST, three protocol versions), key format and 120 calls per minute, OAuth not implemented, compatibility stated as "any MCP client that can send a bearer header, for example Claude Code". All "works with Claude / other MCP agents" wording removed everywhere.
- license pages: `LICENSE` file named and linked, licensor Leonard Chow Yi Ding, affiliates rule, contractor rule, 90-day period; "the LICENSE file governs; this page is a summary" kept.
- home pages: "Try it locally" block with the four npm commands and links to `docs/deploy.md` and `docs/agents.md` on GitHub.
- CSS: table cells with code no longer break mid-word; tables stack as rows at 640 px and below.

## Checks (actual output)
- `node site/build.mjs`: "Built 17 files to dist/ with origin https://shuaige121.github.io/hawkerline"
- `grep -rn "{{" site/dist | wc -l`: 0
- JSON-LD and internal links: "JSON-LD blocks parsed: 12; links checked: 179; problems: 0"
- Invented-number grep: only the word "rating" in a POSITIONING.md instruction remains; CSS percentages excluded.
- `grep Claude site/dist` outside "Claude Code": none.
- Playwright, 8 pages x light/dark x 390/1280: 0 horizontal overflows. `agents.html` viewed at 390 and 1280 px; the first 390 render showed a clipped tools table and mid-word breaks, which the CSS change above fixed and was re-viewed.

## Remaining open questions
1. Allow AI crawlers? `robots.txt` allows all.
2. Provide a 1200x630 social image, then add `og:image` and `summary_large_image`.
3. Confirm the shop is happy with storefront screenshots (they show its own prices and promotions).
4. Public GitHub issues are the only commercial-license contact; confirm that is acceptable.
5. Site sources came from a one-off generator kept outside the repo; edit the HTML in `site/` directly from now on.
6. The admin page is labelled in Chinese ("AI 接入"); the English pages call it "the AI access page". Confirm the wording.
