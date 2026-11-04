# Connecting an AI agent

Hawkerline exposes the same set of tools three ways:

| Interface | Address | Use it when |
|---|---|---|
| MCP (Streamable HTTP) | `https://your-store.example/mcp` | Your agent speaks MCP and can send a bearer header (for example Claude Code) |
| REST | `POST https://your-store.example/api/agent/v1/tools/<tool>` | Any HTTP-capable agent, workflow tool or script |
| OpenAPI 3.1 | `https://your-store.example/api/agent/v1/openapi.json` | Tool-calling frameworks that import OpenAPI |
| `llms.txt` | `https://your-store.example/llms.txt` | Telling any LLM what the store offers and how to operate it |

Replace `your-store.example` with your store's domain. The per-tool reference is in [agent-tools.md](agent-tools.md).

## 1. Create a key

In `/admin` → **🤖 AI 接入**: name the key, tick its scopes, press **生成 key**. The key (`hlk_` + 40 hex characters) is shown once; the server keeps only its SHA-256 hash. Revoke it from the same page at any time — the agent loses access immediately.

| Scope | Allows |
|---|---|
| `menu:read` | Read products, categories, publication status; preview the draft |
| `menu:write` | Create and edit draft products, images, display order and categories |
| `menu:publish` | Publish the previewed draft (now or scheduled) |
| `orders:read` | Read orders and the kitchen board |
| `orders:write` | Move orders through the kitchen flow |
| `store:write` | Pause or resume online ordering |
| `reports:read` | Sales summaries |

Give each agent only what it needs. A key for a menu assistant does not need `orders:*`; a kitchen assistant does not need `menu:publish`.

## 2. Connect

**Claude Code**

```bash
claude mcp add --transport http my-store https://your-store.example/mcp \
  --header "Authorization: Bearer hlk_…"
```

**MCP clients with a JSON config**

```json
{
  "mcpServers": {
    "my-store": {
      "type": "http",
      "url": "https://your-store.example/mcp",
      "headers": { "Authorization": "Bearer hlk_…" }
    }
  }
}
```

**REST**

```bash
curl -s https://your-store.example/api/agent/v1/tools/list_products \
  -H "Authorization: Bearer hlk_…" -H "content-type: application/json" -d '{"only_on_sale":true}'
```

Responses are `{"ok":true,"result":{…}}` or `{"ok":false,"error":"…","code":"…"}` with an HTTP status (400 invalid arguments, 401 bad key, 403 missing scope, 404, 409 conflict, 429 rate limit).

## 3. The menu workflow

1. `get_store_overview` — store name, categories, product counts, live release.
2. `set_categories` (optional) — the full list, in display order.
3. `bulk_upsert_products` — up to 100 items per call. List single items before sets that use them in `components`.
4. `preview_menu` — what will change compared with the live menu, plus `draft_checksum`, `live_release_id` and a 10-minute preview link.
5. `publish_menu` — with that `draft_checksum` and `live_release_id`. To schedule instead, call `preview_menu` and `publish_menu` with the same `effective_at_sgt`.

If anything changes between steps 4 and 5 (another edit, a scheduled release), `publish_menu` refuses and the agent must preview again. Public pages are cached for up to 60 seconds after a publish.

A prompt that works well:

> Here is a photo of our menu. Create categories and products exactly as written — do not invent prices or items. Show me the preview_menu result before publishing, and publish only after I confirm.

## 4. Orders and the kitchen

- `list_orders` — newest first or by fulfilment time; phone numbers are masked unless `include_contact` is true.
- `get_kitchen_board` — today's paid orders that are not done, with set components expanded.
- `advance_order` — next kitchen status, or `to: "ready"` etc.
- `set_store_open` — pause or resume online ordering immediately.
- `get_sales_summary` — paid orders, revenue, GST, service charge and top items for a date range (Singapore time).

## Limits and guarantees

- 120 calls per minute per key, reserved atomically before each call; MCP batches are limited to 20 messages and run in order.
- Agent menu edits are refused (`bootstrap_pending`) until the store's first release exists, so nothing an agent writes can go live without `publish_menu`.
- Agents reach only the admin handlers their tools use; keys, payments, members, refunds and settings stay owner-only, enforced on the server.
- Every call (tool, arguments without image data, outcome) is recorded and visible in **🤖 AI 接入**; menu content events record the key name as the actor.
- Images: PNG, JPEG or WebP up to 640 KB, from an https URL (every redirect must stay on https; 10-second timeout) or base64. Query strings of image URLs are not stored in the audit log.
- MCP transport: JSON responses over POST (no server-sent event stream); protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. Authentication is a bearer key; OAuth is not implemented, so MCP clients that require OAuth cannot connect directly.
