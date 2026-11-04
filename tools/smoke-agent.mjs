#!/usr/bin/env node
// End-to-end smoke test against a running Hawkerline (local `npm run dev` or a staging deployment):
// owner creates an agent key → agent (over MCP) imports a menu, previews, publishes → the public menu shows it
// → a counter sale appears on the kitchen board → the agent advances it → the key is revoked.
//
// Usage: ADMIN_TOKEN=... node tools/smoke-agent.mjs http://localhost:8787
// Never point this at a production store: it creates products, a sale and an agent key there.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
let ADMIN = process.env.ADMIN_TOKEN || '';
if (!ADMIN && existsSync('.dev.vars')) ADMIN = (readFileSync('.dev.vars', 'utf8').match(/^ADMIN_TOKEN=(.+)$/m) || [])[1] || '';
if (!ADMIN) { console.error('Set ADMIN_TOKEN (or run from a folder with .dev.vars)'); process.exit(2); }

const step = (name) => console.log(`• ${name}`);
async function http(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}
let id = 0;
async function mcp(key, method, params) {
  const r = await http('/mcp', { method: 'POST', token: key, body: { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) } });
  assert.equal(r.status, 200, `${method}: ${r.text}`);
  if (r.json.error) throw new Error(`${method}: ${JSON.stringify(r.json.error)}`);
  return r.json.result;
}
async function tool(key, name, args = {}) {
  const res = await mcp(key, 'tools/call', { name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return res.structuredContent;
}

const stamp = Date.now().toString(36).toUpperCase().slice(-4);
step('owner creates an agent key');
const created = await http('/api/admin/agent-keys', { method: 'POST', token: ADMIN,
  body: { name: `smoke ${stamp}`, scopes: ['menu:read', 'menu:write', 'menu:publish', 'orders:read', 'orders:write', 'reports:read'] } });
assert.equal(created.status, 200, created.text);
const key = created.json.key;

step('MCP initialize + tools/list');
const init = await mcp(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
assert.equal(init.serverInfo.name, 'hawkerline');
const tools = (await mcp(key, 'tools/list')).tools.map(t => t.name);
assert.ok(tools.includes('bulk_upsert_products') && !tools.includes('set_store_open'), tools.join(','));

step('agent reads the store and adds categories + products');
const overview = await tool(key, 'get_store_overview');
assert.ok(overview.publication.live_release_id, 'a live release must exist (run the scheduled job once after deploying)');
const cats = overview.categories.map(c => c.key);
const next = [...overview.categories];
if (!cats.includes('smoke')) next.push({ key: 'smoke', cn: '测试', en: 'Smoke test' });
if (!cats.includes('drink')) next.push({ key: 'drink', cn: '饮品', en: 'Drinks' });
await tool(key, 'set_categories', { categories: next });
const sku = `SM${stamp}`;
const bulk = await tool(key, 'bulk_upsert_products', { products: [
  { sku, name_en: `Smoke Laksa ${stamp}`, name_cn: `测试叻沙 ${stamp}`, price: 7.5, category: 'smoke', active: true },
  { sku: `${sku}S`, name_en: `Smoke Set ${stamp}`, price: 9.9, category: 'smoke', active: true, components: [{ sku, qty: 1 }] },
] });
assert.equal(bulk.saved, 2, JSON.stringify(bulk));

step('preview → publish exactly the previewed draft');
const preview = await tool(key, 'preview_menu');
assert.ok(preview.products_added.some(p => p.sku === sku), JSON.stringify(preview.products_added));
const pub = await tool(key, 'publish_menu', { draft_checksum: preview.draft_checksum, live_release_id: preview.live_release_id });
assert.equal(pub.published, true);
// the release-specific catalog is immutable, so it is visible at once
const released = await http(`/public/releases/${pub.release_id}/catalog.json`);
assert.equal(released.json.products.find(p => p.sku === sku).price_cents, 750);
// public HTML pages are edge-cached for up to 60 seconds by design
let menu;
for (const started = Date.now(); Date.now() - started < 75000;) {
  menu = await http('/menu');
  if (menu.text.includes(`Smoke Laksa ${stamp}`)) break;
  await new Promise(r => setTimeout(r, 5000));
}
assert.match(menu.text, new RegExp(`Smoke Laksa ${stamp}`), '/menu shows the new product within the cache window');
assert.match(menu.text, /测试 Smoke test/);

step('counter sale → kitchen board → agent advances the order');
const m = (await http('/api/menu')).json;
const sale = await http('/api/admin/offline-sale', { method: 'POST', token: ADMIN,
  body: { items: [{ sku, qty: 1 }], pay_method: 'cash', menu_revision: m.menu_revision, client_token: `smoke-${stamp}` } });
assert.equal(sale.status, 200, sale.text);
const board = await tool(key, 'get_kitchen_board');
const order = board.orders.find(o => o.items.some(i => String(i.name).includes(stamp)));
assert.ok(order, 'sale is on the kitchen board');
const moved = await tool(key, 'advance_order', { order_id: order.id });
assert.equal(moved.status, 'preparing');
const summary = await tool(key, 'get_sales_summary');
assert.ok(summary.paid_orders >= 1);

step('audit shows the calls; revoke the key');
const audit = await http('/api/admin/agent-audit?limit=50', { token: ADMIN });
assert.ok(audit.json.entries.some(e => e.tool === 'publish_menu' && e.ok === 1));
const keyId = (await http('/api/admin/agent-keys', { token: ADMIN })).json.keys.find(k => k.name === `smoke ${stamp}`).id;
assert.equal((await http('/api/admin/agent-keys/revoke', { method: 'POST', token: ADMIN, body: { id: keyId } })).status, 200);
assert.equal((await http('/mcp', { method: 'POST', token: key, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);

console.log(`OK — ${BASE}: agent imported, published and served ${sku}; kitchen flow and audit verified.`);
