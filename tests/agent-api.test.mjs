// The AI agent layer (worker/agent.js) end to end on the real Worker routes and real migrations (node:sqlite):
// key lifecycle, MCP protocol, scopes, the draft → preview → exact publish flow, orders/kitchen tools, REST,
// OpenAPI, llms.txt, audit and the guard that keeps agents away from owner-only admin routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import worker from '../worker/index.js';
import { elevatedAgentEnv } from '../worker/agent-context.js';
import { TOOLS } from '../worker/agent.js';
import { createSqliteD1 } from './sqlite-d1.mjs';

const OWNER = 'agent-test-owner-token-0123456789abcdef';
const SECRET = 'agent-test-auth-secret';
const ORIGIN = 'https://shop.example';
// 1×1 transparent PNG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function store(t, { seed = true } = {}) {
  const d1 = createSqliteD1({ seed });
  t.after(() => d1.sqlite.close());
  const pending = [];
  const env = { DB: d1, ADMIN_TOKEN: OWNER, AUTH_SECRET: SECRET };
  const ctx = { waitUntil: promise => { pending.push(Promise.resolve(promise).catch(() => {})); } };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  d1.sqlite.prepare("INSERT INTO app_settings(k,v) VALUES('store_open','1') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
  d1.sqlite.prepare("INSERT INTO app_settings(k,v) VALUES('business_hours',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(JSON.stringify(Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, ['00:00', '23:59']]))));
  await worker.scheduled({ cron: '* * * * *' }, env, ctx);   // the first (bootstrap) release
  const settle = async () => { while (pending.length) await pending.shift(); };
  await settle();
  const http = async (pathname, { method = 'GET', body, auth, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${auth}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(ORIGIN + pathname, { method, headers: h,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    await settle();
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const owner = (p, o = {}) => http(p, { ...o, auth: OWNER });
  const newKey = async (scopes, name = 'test agent') => {
    const r = await owner('/api/admin/agent-keys', { method: 'POST', body: { name, scopes } });
    assert.equal(r.status, 200, r.text);
    return r.json.key;
  };
  let rpcId = 0;
  const mcp = async (key, method, params, extra = {}) => http('/mcp', { method: 'POST', auth: key, ...extra,
    body: { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) } });
  const tool = async (key, name, args = {}) => {
    const r = await mcp(key, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200, r.text);
    const result = r.json.result;
    return { isError: result.isError, data: result.isError ? JSON.parse(result.content[0].text) : result.structuredContent };
  };
  return { d1, env, ctx, http, owner, newKey, mcp, tool };
}

const ALL = ['menu:read', 'menu:write', 'menu:publish', 'orders:read', 'orders:write', 'store:write', 'reports:read'];

test('keys: shown once, stored as a hash, listed without secrets, revocable', async t => {
  const s = await store(t);
  const key = await s.newKey(['menu:read']);
  assert.match(key, /^hlk_[0-9a-f]{40}$/);
  const row = s.d1.query('SELECT key_hash, key_prefix FROM agent_keys')[0];
  assert.notEqual(row.key_hash, key);
  assert.equal(row.key_prefix, key.slice(0, 12));
  const list = await s.owner('/api/admin/agent-keys');
  assert.ok(!list.text.includes(key) && !list.text.includes(row.key_hash), 'list must not contain the key or its hash');
  assert.equal((await s.mcp(key, 'ping')).status, 200);
  const id = list.json.keys[0].id;
  assert.equal((await s.owner('/api/admin/agent-keys/revoke', { method: 'POST', body: { id } })).status, 200);
  const after = await s.mcp(key, 'ping');
  assert.equal(after.status, 401);
  assert.match(after.headers.get('www-authenticate') || '', /^Bearer /);
  assert.equal((await s.owner('/api/admin/agent-keys', { method: 'POST', body: { name: 'x', scopes: ['menu:everything'] } })).status, 400);
  assert.equal((await s.owner('/api/admin/agent-keys', { method: 'POST', body: { name: '', scopes: ['menu:read'] } })).status, 400);
});

test('MCP protocol: initialize, notifications, tools/list by scope, errors, transport rules', async t => {
  const s = await store(t);
  const reader = await s.newKey(['menu:read']);
  const init = await s.mcp(reader, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
  assert.match(init.json.result.instructions, /publish_menu/);
  const unknownVersion = await s.mcp(reader, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknownVersion.json.result.protocolVersion, '2025-11-25');
  const note = await s.http('/mcp', { method: 'POST', auth: reader, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  const names = (await s.mcp(reader, 'tools/list')).json.result.tools.map(x => x.name).sort();
  assert.deepEqual(names, TOOLS.filter(x => x.scope === 'menu:read').map(x => x.name).sort());
  assert.equal((await s.mcp(reader, 'resources/list')).json.error.code, -32601);
  assert.equal((await s.mcp(reader, 'tools/call', { name: 'nope' })).json.error.code, -32602);
  assert.equal((await s.http('/mcp', { method: 'POST', auth: reader, raw: '{not json', headers: { 'content-type': 'application/json' } })).json.error.code, -32700);
  assert.equal((await s.http('/mcp', { auth: reader })).status, 405);
  assert.equal((await s.mcp(reader, 'ping', null, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.mcp(OWNER, 'ping')).status, 401, 'the owner password is not an agent key');
  for (const t2 of (await s.mcp(await s.newKey(ALL), 'tools/list')).json.result.tools) {
    assert.ok(t2.inputSchema && t2.inputSchema.type === 'object', t2.name);
    assert.match(t2.description, /\[scope: [a-z]+:[a-z]+\]$/);
  }
});

test('scopes are enforced per tool and invalid arguments come back as tool errors', async t => {
  const s = await store(t);
  const reader = await s.newKey(['menu:read']);
  const denied = await s.tool(reader, 'upsert_product', { sku: 'X1', name_en: 'X', price: 1, category: 'drink' });
  assert.equal(denied.isError, true);
  assert.equal(denied.data.code, 'insufficient_scope');
  assert.equal(s.d1.query("SELECT COUNT(*) n FROM products WHERE sku='X1'")[0].n, 0);
  const writer = await s.newKey(['menu:read', 'menu:write']);
  const bad = await s.tool(writer, 'upsert_product', { sku: 'X1', price: 'cheap', colour: 'red' });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'invalid_arguments');
  assert.match(bad.data.error, /price must be number/);
  assert.match(bad.data.error, /colour is not a known field/);
});

test('fresh store: an agent builds the menu from nothing, previews, and publishes exactly what it previewed', async t => {
  const s = await store(t, { seed: false });
  const key = await s.newKey(['menu:read', 'menu:write', 'menu:publish'], 'menu importer');
  const overview = await s.tool(key, 'get_store_overview');
  assert.equal(overview.isError, false, JSON.stringify(overview.data));
  assert.equal(overview.data.products.total, 0);
  assert.ok(overview.data.publication.live_release_id, 'bootstrap release exists even with an empty menu');

  const cats = await s.tool(key, 'set_categories', { categories: [
    { key: 'noodles', cn: '面', en: 'Noodles' }, { key: 'rice', cn: '饭', en: 'Rice' }, { key: 'drink', cn: '饮品', en: 'Drinks' }] });
  assert.equal(cats.isError, false, JSON.stringify(cats.data));

  const bulk = await s.tool(key, 'bulk_upsert_products', { products: [
    { sku: 'N01', name_en: 'Laksa', name_cn: '叻沙', price: 7.5, category: 'noodles', active: true },
    { sku: 'R01', name_en: 'Chicken Rice', price: 6, category: 'rice', active: true },
    { sku: 'D01', name_en: 'Iced Tea', price: 2, category: 'drink', active: true },
    { sku: 'SET1', name_en: 'Laksa Set', price: 8.9, category: 'noodles', active: true, components: [{ sku: 'N01', qty: 1 }, { sku: 'DRINK', qty: 1 }] },
    { sku: 'BAD', name_en: 'Mystery', price: 3, category: 'pizza' },
  ] });
  assert.equal(bulk.isError, false, JSON.stringify(bulk.data));
  assert.equal(bulk.data.saved, 4);
  assert.equal(bulk.data.failed, 1);
  assert.match(bulk.data.results.find(r => r.sku === 'BAD').error, /分类无效|category/i);
  assert.equal(s.d1.query("SELECT name_cn FROM products WHERE sku='R01'")[0].name_cn, 'Chicken Rice', 'English-only names are accepted');

  // nothing is public before publishing
  assert.equal((await s.http('/public/catalog.json')).json.products.length, 0);

  const preview = await s.tool(key, 'preview_menu');
  assert.equal(preview.isError, false, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.products_added.map(p => p.sku).sort(), ['D01', 'N01', 'R01', 'SET1']);
  assert.ok(preview.data.settings_changed.includes('menu_categories'));
  assert.match(preview.data.preview.url, /^https:\/\/shop\.example\/preview\//);

  const wrong = await s.tool(key, 'publish_menu', { draft_checksum: 'not-the-checksum', live_release_id: preview.data.live_release_id });
  assert.equal(wrong.isError, true);
  assert.equal((await s.http('/public/catalog.json')).json.products.length, 0, 'a wrong checksum publishes nothing');

  // a change after the preview invalidates it
  await s.tool(key, 'upsert_product', { sku: 'D01', price: 2.2 });
  const stale = await s.tool(key, 'publish_menu', { draft_checksum: preview.data.draft_checksum, live_release_id: preview.data.live_release_id });
  assert.equal(stale.isError, true);

  const fresh = await s.tool(key, 'preview_menu');
  const done = await s.tool(key, 'publish_menu', { draft_checksum: fresh.data.draft_checksum, live_release_id: fresh.data.live_release_id });
  assert.equal(done.isError, false, JSON.stringify(done.data));
  const catalog = (await s.http('/public/catalog.json')).json;
  assert.deepEqual(catalog.products.map(p => p.sku).sort(), ['D01', 'N01', 'R01', 'SET1']);
  assert.equal(catalog.products.find(p => p.sku === 'D01').price_cents, 220);
  assert.deepEqual(catalog.settings.menu_categories.map(c => c.key), ['noodles', 'rice', 'drink']);
  const menuHtml = (await s.http('/menu')).text;
  assert.match(menuHtml, /<h2>面 Noodles<\/h2>/);
  assert.ok(s.d1.query("SELECT COUNT(*) n FROM public_content_events WHERE actor='agent:menu importer'")[0].n > 0, 'content events name the agent');

  // categories in use cannot be removed
  const removal = await s.tool(key, 'set_categories', { categories: [{ key: 'drink', cn: '饮品', en: 'Drinks' }] });
  assert.equal(removal.isError, true);
  assert.match(removal.data.error, /noodles/);
});

test('images: base64 PNG accepted, non-images and http URLs rejected', async t => {
  const s = await store(t);
  const key = await s.newKey(['menu:read', 'menu:write']);
  const ok = await s.tool(key, 'set_product_image', { sku: 'S01', image_base64: PNG_1PX });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.match(s.d1.query("SELECT img FROM products WHERE sku='S01'")[0].img, /^data:image\/png;base64,/);
  const notImage = await s.tool(key, 'set_product_image', { sku: 'S01', image_base64: Buffer.from('hello world, not an image').toString('base64') });
  assert.equal(notImage.data.code, 'invalid_image');
  const http = await s.tool(key, 'set_product_image', { sku: 'S01', image_url: 'http://example.com/a.png' });
  assert.equal(http.data.code, 'invalid_image');
  const missing = await s.tool(key, 'set_product_image', { sku: 'NOPE', image_base64: PNG_1PX });
  assert.equal(missing.data.code, 'not_found');
  const listed = await s.tool(key, 'list_products', { category: 'protein' });
  assert.equal(listed.data.products.find(p => p.sku === 'S01').image, 'uploaded', 'image bytes are never sent back to the agent');
});

test('orders, kitchen and store tools; phones masked unless asked; owner-only routes stay closed to agents', async t => {
  const s = await store(t);
  // a paid counter sale (owner offline sale), so the kitchen board has something
  const menu = (await s.http('/api/menu')).json;
  const sale = await s.owner('/api/admin/offline-sale', { method: 'POST', body: { items: [{ sku: 'S01', qty: 2 }],
    pay_method: 'cash', phone: '+6591234567', menu_revision: menu.menu_revision, client_token: 'agent-test-sale-1' } });
  assert.equal(sale.status, 200, sale.text);
  const ops = await s.newKey(['orders:read', 'orders:write', 'store:write', 'reports:read']);
  const orders = await s.tool(ops, 'list_orders', { limit: 5 });
  assert.equal(orders.isError, false, JSON.stringify(orders.data));
  const order = orders.data.orders[0];
  assert.equal(order.phone, '•••4567');
  assert.equal((await s.tool(ops, 'list_orders', { include_contact: true })).data.orders[0].phone.replace(/\D/g, '').slice(-8), '91234567');
  const board = await s.tool(ops, 'get_kitchen_board');
  assert.ok(board.data.orders.some(o => o.id === order.id), JSON.stringify(board.data));
  const moved = await s.tool(ops, 'advance_order', { order_id: order.id });
  assert.equal(moved.isError, false, JSON.stringify(moved.data));
  assert.equal(moved.data.status, 'preparing');
  const summary = await s.tool(ops, 'get_sales_summary');
  assert.equal(summary.data.paid_orders, 1);
  assert.equal(summary.data.top_items[0].sku, 'S01');
  assert.equal((await s.tool(ops, 'set_store_open', { open: false })).isError, false);
  assert.equal(s.d1.query("SELECT v FROM app_settings WHERE k='store_open'")[0].v, '0');

  const elevated = elevatedAgentEnv(s.env, { name: 'probe' });
  for (const [method, path] of [['GET', '/api/admin/agent-keys'], ['POST', '/api/admin/agent-keys'], ['GET', '/api/admin/stripe-config'],
    ['GET', '/api/admin/members'], ['POST', '/api/admin/order-refund'], ['POST', '/api/admin/pos-pins'], ['POST', '/api/admin/settings'], ['GET', '/api/admin/settings']]) {
    const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined }), elevated, s.ctx);
    assert.equal(r.status, 403, `${method} ${path} must be closed to agents`);
  }
});

test('REST mirror, OpenAPI, llms.txt, audit log and rate limit', async t => {
  const s = await store(t);
  const key = await s.newKey(['menu:read']);
  const r = await s.http('/api/agent/v1/tools/list_products', { method: 'POST', auth: key, body: { only_on_sale: true } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.result.count > 0);
  assert.equal((await s.http('/api/agent/v1/tools/upsert_product', { method: 'POST', auth: key, body: { sku: 'Z1' } })).status, 403);
  assert.equal((await s.http('/api/agent/v1/tools/list_products', { method: 'POST', body: {} })).status, 401);
  const spec = (await s.http('/api/agent/v1/openapi.json')).json;
  assert.equal(spec.openapi, '3.1.0');
  for (const x of TOOLS) assert.ok(spec.paths[`/api/agent/v1/tools/${x.name}`], x.name);
  assert.equal(spec.servers[0].url, ORIGIN);
  const llms = await s.http('/llms.txt');
  assert.equal(llms.status, 200);
  assert.match(llms.text, /^# /);
  assert.match(llms.text, /https:\/\/shop\.example\/mcp/);
  assert.match(llms.text, /publish_menu/);
  const audit = (await s.owner('/api/admin/agent-audit')).json.entries;
  assert.ok(audit.some(e => e.tool === 'list_products' && e.ok === 1 && e.channel === 'rest'));
  assert.ok(audit.some(e => e.tool === 'upsert_product' && e.ok === 0 && e.status === 403));
  // the limit is reserved atomically before a call runs, so concurrent calls cannot all slip through
  const burst = await s.newKey(['menu:read'], 'burst');
  const results = await Promise.all(Array.from({ length: 130 }, () =>
    s.http('/api/agent/v1/tools/list_categories', { method: 'POST', auth: burst, body: {} })));
  assert.equal(results.filter(r => r.status === 200).length, 120);
  assert.equal(results.filter(r => r.status === 429).length, 10);
});

test('Codex round 1 regressions: names, protocol header, invalid messages, bootstrap, audit redaction, escaping', async t => {
  const s = await store(t);
  const key = await s.newKey(['menu:read', 'menu:write']);
  await s.tool(key, 'upsert_product', { sku: 'T1', name_cn: '茶', name_en: 'Tea', price: 2, category: 'drink' });
  await s.tool(key, 'upsert_product', { sku: 'T1', name_en: 'Green tea' });
  const row = s.d1.query("SELECT name_cn, name_en FROM products WHERE sku='T1'")[0];
  assert.deepEqual([row.name_cn, row.name_en], ['茶', 'Green tea'], 'updating name_en keeps name_cn');

  assert.equal((await s.mcp(key, 'ping', null, { headers: { 'mcp-protocol-version': '1999-01-01' } })).status, 400);
  assert.equal((await s.mcp(key, 'ping', null, { headers: { 'mcp-protocol-version': '2025-06-18' } })).status, 200);
  assert.equal((await s.http('/mcp', { method: 'POST', auth: key, body: { foo: 'bar' } })).status, 400);
  assert.equal((await s.http('/mcp', { method: 'POST', auth: key, body: [] })).status, 400);
  // malformed JSON-RPC never reaches a tool: object ids, non-object params, ambiguous responses
  const before = s.d1.query("SELECT price FROM products WHERE sku='T1'")[0].price;
  for (const bad of [
    { jsonrpc: '2.0', id: { bad: true }, method: 'tools/call', params: { name: 'upsert_product', arguments: { sku: 'T1', price: 7 } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: 1 },
    { jsonrpc: '2.0', id: [], result: true, error: 'bad' },
    { jsonrpc: '2.0', id: 1.5, method: 'ping' },
  ]) assert.equal((await s.http('/mcp', { method: 'POST', auth: key, body: bad })).status, 400, JSON.stringify(bad));
  assert.equal(s.d1.query("SELECT price FROM products WHERE sku='T1'")[0].price, before, 'an invalid id must not run the tool');
  assert.equal((await s.http('/mcp', { method: 'POST', auth: key, body: { jsonrpc: '2.0', id: 'r1', result: {} } })).status, 202, 'client responses are accepted');
  assert.equal((await s.tool(key, 'preview_menu', { effective_at_sgt: '2026-99-99T99:99' })).data.code, 'invalid_time');
  assert.equal((await s.tool(key, 'preview_menu', { effective_at_sgt: '2026-02-30T10:00' })).data.code, 'invalid_time');

  // a 24-character category key works for products
  const long = 'abcdefghijklmnopqrstuvwx';
  const cats = (await s.tool(key, 'list_categories')).data.categories.map(({ key: k, cn, en }) => ({ key: k, cn, en }));
  assert.equal((await s.tool(key, 'set_categories', { categories: [...cats, { key: long, en: 'Long' }] })).isError, false);
  assert.equal((await s.tool(key, 'upsert_product', { sku: 'L1', name_en: 'Long cat item', price: 3, category: long })).isError, false);

  // image URLs are reduced to their host in the audit log (signed links carry credentials in path or query)
  for (const image_url of ['https://images.example/p.png?token=SECRET123#frag', ' https://images.example/f.png?token=SECRET456',
    'https://images.example/SECRET789/p.png']) await s.tool(key, 'set_product_image', { sku: 'T1', image_url });
  const audit = s.d1.query("SELECT summary FROM agent_audit WHERE tool='set_product_image'").map(r => r.summary).join('\n');
  assert.ok(audit.includes('images.example'), audit);
  for (const secret of ['SECRET123', 'SECRET456', 'SECRET789', 'frag']) assert.ok(!audit.includes(secret), `${secret} leaked: ${audit}`);

  // category labels are escaped wherever admin and POS render them
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const [file, pattern] of [['web/admin.html', /\$\{cats\[(?:k|p\.category)\]/], ['web/pos.html', /\$\{CATS\[k\]\}/]]) {
    assert.doesNotMatch(read(file), pattern, `${file} inserts a category label without esc()`);
  }
});

test('before the first release exists, agent menu writes wait instead of being auto-published', async t => {
  const d1 = createSqliteD1({ seed: false });
  t.after(() => d1.sqlite.close());
  const env = { DB: d1, ADMIN_TOKEN: OWNER, AUTH_SECRET: SECRET };
  const pending = [];
  const ctx = { waitUntil: p => { pending.push(Promise.resolve(p).catch(() => {})); } };
  const call = async (path, body, auth) => {
    const r = await worker.fetch(new Request(ORIGIN + path, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, ctx);
    return { status: r.status, json: await r.json() };
  };
  const key = (await call('/api/admin/agent-keys', { name: 'early', scopes: ['menu:read', 'menu:write'] }, OWNER)).json.key;
  const early = await call('/api/agent/v1/tools/upsert_product', { sku: 'E1', name_en: 'Early', price: 1, category: 'main' }, key);
  assert.equal(early.status, 409);
  assert.equal(early.json.code, 'bootstrap_pending');
  assert.equal(d1.query("SELECT COUNT(*) n FROM products")[0].n, 0);
  // the owner cannot slip unreviewed content into the bootstrap release either
  const state = d1.query('SELECT draft_revision FROM public_content_state')[0];
  const ownerEarly = await call('/api/admin/product-save', { sku: 'E2', name_en: 'Unreviewed', price: 1, category: 'main', base_revision: state.draft_revision }, OWNER);
  assert.equal(ownerEarly.status, 409);
  assert.equal(ownerEarly.json.code, 'bootstrap_pending');
  assert.equal(d1.query("SELECT COUNT(*) n FROM products")[0].n, 0);
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  await worker.scheduled({ cron: '* * * * *' }, env, ctx);
  while (pending.length) await pending.shift();
  assert.ok(d1.query('SELECT active_release_id FROM public_content_state')[0].active_release_id, 'bootstrap release exists');
  assert.equal(d1.query('SELECT COUNT(*) n FROM public_content_release_products')[0].n, 0, 'bootstrap release is empty');
  const rev = d1.query('SELECT draft_revision FROM public_content_state')[0].draft_revision;
  assert.equal((await call('/api/admin/product-save', { sku: 'E2', name_en: 'Reviewed later', price: 1, category: 'main', base_revision: rev }, OWNER)).status, 200);
});

test('POS PINs: no PIN ships with the system; the owner sets one and the cashier can log in', async t => {
  const s = await store(t);
  assert.equal(s.d1.query('SELECT COUNT(*) n FROM pos_pins')[0].n, 0, 'no default PINs');
  assert.equal((await s.http('/api/pos/login', { method: 'POST', body: { cashier: 'pos1', pin: '123456' } })).status, 401);
  assert.equal((await s.owner('/api/admin/pos-pins', { method: 'POST', body: { cashier: 'pos1', pin: '12' } })).status, 400);
  assert.equal((await s.owner('/api/admin/pos-pins', { method: 'POST', body: { cashier: 'root', pin: '123456' } })).status, 400);
  assert.equal((await s.owner('/api/admin/pos-pins', { method: 'POST', body: { cashier: 'pos1', pin: '482913' } })).status, 200);
  const list = await s.owner('/api/admin/pos-pins');
  assert.ok(!list.text.includes('482913') && !list.text.includes('pin_hash'));
  assert.equal(list.json.cashiers.find(c => c.cashier === 'pos1').has_pin, true);
  const login = await s.http('/api/pos/login', { method: 'POST', body: { cashier: 'pos1', pin: '482913' } });
  assert.equal(login.status, 200, login.text);
  assert.ok(login.json.token);
  // the staff token is an HMAC over the payload with AUTH_SECRET
  const [payload, sig] = login.json.token.split('.');
  assert.equal(createHmac('sha256', SECRET).update(payload).digest('hex'), sig);
});

test('docs/agent-tools.md matches the tool definitions', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL('../tools/gen-agent-docs.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
