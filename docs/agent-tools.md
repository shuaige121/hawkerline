# Agent tool reference

Generated from `worker/agent.js` by `npm run docs:agent`. Do not edit by hand.

Every tool is available over MCP (`tools/call` at `/mcp`) and REST (`POST /api/agent/v1/tools/<name>`).

## Scopes

| Scope | Allows |
|---|---|
| `menu:read` | Read products, categories, publication status and preview the draft |
| `menu:write` | Create and edit draft products, images, order and categories |
| `menu:publish` | Publish the previewed draft menu to customers (now or scheduled) |
| `orders:read` | Read orders and the kitchen board |
| `orders:write` | Move orders through the kitchen flow (new → preparing → ready → done) |
| `store:write` | Open or close the store for new orders |
| `reports:read` | Read sales summaries |

## `get_store_overview` — Store overview

Scope: `menu:read` · read-only

Start here. Returns the store name, whether it is accepting orders, menu categories, product counts, the live release and the current draft revision.

No arguments.

## `list_categories` — List menu categories

Scope: `menu:read` · read-only

Menu categories (key, Chinese label, English label) and how many draft products use each.

No arguments.

## `set_categories` — Replace menu categories

Scope: `menu:write`

Replace the whole category list (order = display order). A category still used by a product cannot be removed; move those products first. Takes effect for customers after publish_menu.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `categories` | array of object | yes |  |
| `base_revision` | string |  | Optional draft revision for strict compare-and-swap |

## `list_products` — List products

Scope: `menu:read` · read-only

All draft products (including ones not on sale) with price in SGD, category, components and image status. The draft is what the next publish will show.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `category` | string |  | Only this category |
| `only_on_sale` | boolean |  | Only products marked active |

## `upsert_product` — Create or update a product

Scope: `menu:write`

Create a product, or update only the fields you pass on an existing one (matched by sku). Changes go to the draft. New products need name, price and category.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | yes | Stable product code, 2–16 chars A–Z 0–9 _ -. Creates the product if it does not exist yet. |
| `name_cn` | string |  | Chinese name (falls back to name_en) |
| `name_en` | string |  | English name (falls back to name_cn) |
| `price` | number |  | Price in SGD, e.g. 6.5 |
| `category` | string |  | A category key from list_categories |
| `description_cn` | string |  |  |
| `description_en` | string |  |  |
| `detail_cn` | string |  |  |
| `detail_en` | string |  |  |
| `kcal` | integer \| null |  |  |
| `active` | boolean |  | true = on sale after the next publish |
| `sort` | integer |  |  |
| `components` | array of object |  | Items included in a set/combo, e.g. [{"sku":"S01","qty":2}]. Use sku "DRINK" for "any drink" (customer picks an on-sale item of category drink). Empty array = sold as a single item. Omit to keep unchanged. |
| `image_url` | string |  | Optional https URL of a PNG/JPEG/WebP photo (≤ 640 KB) to use as the product image |
| `base_revision` | string |  | Optional draft revision for strict compare-and-swap; omitted = use the current draft |

## `bulk_upsert_products` — Create or update many products

Scope: `menu:write`

Create/update up to 100 products in one call, e.g. a whole menu read from a photo or PDF. Processed in order: put single items before the sets whose components reference them. Each item has the same fields as upsert_product. Returns a result per sku; failed items do not stop the rest unless stop_on_error is true.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `products` | array of object | yes |  |
| `stop_on_error` | boolean |  |  |

## `set_product_availability` — Put a product on or off sale

Scope: `menu:write`

Mark a product on sale (active=true) or off sale in the draft. Customers see it after publish_menu.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | yes |  |
| `active` | boolean | yes |  |

## `set_product_image` — Set a product photo

Scope: `menu:write`

Set the product image from an https image URL or base64 data (PNG, JPEG or WebP, ≤ 640 KB).

| Argument | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | yes |  |
| `image_url` | string |  |  |
| `image_base64` | string |  | Raw base64 or a data:image/...;base64, URL |

## `reorder_products` — Reorder the menu

Scope: `menu:write`

Set the display order: pass skus in the order they should appear (positions 1..N). Products not listed keep their current position number.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `order` | array of string | yes |  |

## `preview_menu` — Preview the draft menu

Scope: `menu:read` · read-only

Compare the draft with the live menu and get a 10-minute preview link. Returns draft_checksum and live_release_id, which publish_menu requires. To schedule a release, pass the same effective_at_sgt here and to publish_menu (date-limited posters depend on it). Show the changes to the owner before publishing when in doubt.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `effective_at_sgt` | string |  | Optional YYYY-MM-DDTHH:MM (Singapore time) the release will take effect |

## `publish_menu` — Publish the previewed draft

Scope: `menu:publish`

Publish exactly the draft you previewed: pass draft_checksum and live_release_id from preview_menu. If anything changed since the preview, nothing is published and you must preview again. Optional effective_at_sgt (YYYY-MM-DDTHH:MM, Singapore time) schedules the release instead; preview with the same effective_at_sgt first.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `draft_checksum` | string | yes |  |
| `live_release_id` | string \| null | yes |  |
| `effective_at_sgt` | string |  | Optional, e.g. 2026-12-01T09:00 |

## `list_orders` — List orders

Scope: `orders:read` · read-only

Recent orders, newest first (or by fulfilment time). Phone numbers are masked unless include_contact is true.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `pay_status` | `PAID` \| `UNPAID` \| `CANCELLED` \| `REFUNDED` |  |  |
| `source` | `online` \| `offline` |  |  |
| `sort` | `recent` \| `fulfilment` |  |  |
| `limit` | integer |  |  |
| `include_contact` | boolean |  | Include full phone and delivery address |

## `get_kitchen_board` — Kitchen board

Scope: `orders:read` · read-only

Today's paid orders that are not done yet, with set components expanded, in kitchen priority order.

No arguments.

## `advance_order` — Advance an order in the kitchen

Scope: `orders:write`

Move a paid order to the next kitchen status (new → preparing → ready → done), or to a specific later status with "to".

| Argument | Type | Required | Notes |
|---|---|---|---|
| `order_id` | string | yes |  |
| `to` | `preparing` \| `ready` \| `done` |  |  |

## `set_store_open` — Open or close the store

Scope: `store:write`

Pause (open=false) or resume (open=true) new online orders immediately. This is not part of the menu draft.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `open` | boolean | yes |  |

## `get_sales_summary` — Sales summary

Scope: `reports:read` · read-only

Paid orders, revenue (SGD), GST, service charge and top items for a Singapore-time date range (default: today).

| Argument | Type | Required | Notes |
|---|---|---|---|
| `from` | string |  | YYYY-MM-DD (SGT), default today |
| `to` | string |  | YYYY-MM-DD (SGT), default = from |

