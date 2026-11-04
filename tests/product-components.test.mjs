// 「组成」是顾客菜单与厨房出餐的唯一来源：后台改了组成并发布，顾客看到的「含：…」和
// 厨房看板 / 备货单必须一起变；没发布之前两边都不变；已下的单按下单时的组成出餐。
// 全程走真实 Worker 路由 + 真实 migrations（node:sqlite）。数据和凭据都是测试用的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import worker, { kitchenLines } from '../worker/index.js';
import { checksumSnapshot } from '../worker/publication.js';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';
import { createSqliteD1 } from './sqlite-d1.mjs';

const OWNER = 'components-test-owner-token';
const SECRET = 'components-test-auth-secret';
const PRINT = 'components-test-print-token';
const ORIGIN = 'https://shop.example';

async function site(t) {
  const d1 = createSqliteD1();
  t.after(() => d1.sqlite.close());
  const pending = [];
  const env = { DB: d1, ADMIN_TOKEN: OWNER, AUTH_SECRET: SECRET };
  const ctx = { waitUntil: promise => { pending.push(Promise.resolve(promise).catch(() => {})); } };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const set = d1.sqlite.prepare('INSERT INTO app_settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  set.run('store_open', '1');
  set.run('print_token', PRINT);
  set.run('business_hours', JSON.stringify(Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, ['00:00', '23:59']]))));
  const add = d1.sqlite.prepare(`INSERT INTO products(sku,name_cn,name_en,price,category,active,sort,components) VALUES(?,?,?,?,?,?,?,?)`);
  add.run('P39', '豆奶', 'Soy milk', 1.6, 'drink', 1, 90, '');
  add.run('P40', '牛奶', 'Milk', 1.6, 'drink', 1, 91, '');
  add.run('P06', '鲜肉青菜单人餐', 'Pork & Veg Combo', 5.9, 'meal', 1, 50,
    '[{"sku":"S01","qty":1},{"sku":"S07","qty":1},{"sku":"DRINK","qty":1}]');
  add.run('P15', '鲜肉包 (3粒装)', 'Juicy Pork Bun (3pcs)', 6.9, 'protein', 1, 60, '[{"sku":"S01","qty":3}]');
  add.run('MB5', '经典上海生煎包 (4粒装)', 'Shanghai Pan-Fried Buns (4pcs)', 6.9, 'protein', 1, 70, '');
  await worker.scheduled({ cron: '* * * * *' }, env, ctx);
  const settle = async () => { while (pending.length) await pending.shift(); };
  await settle();

  const call = async (pathname, { method = 'GET', body, auth = OWNER } = {}) => {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await worker.fetch(new Request(ORIGIN + pathname,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    await settle();
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  };
  const staffPayload = Buffer.from(JSON.stringify({ c: 'components-test-cashier', r: 'staff', exp: Date.now() + 600000 })).toString('base64');
  const staff = `${staffPayload}.${createHmac('sha256', SECRET).update(staffPayload).digest('hex')}`;

  const catalog = async () => (await call('/public/catalog.json', { auth: null })).json;
  const product = async sku => (await catalog()).products.find(p => p.sku === sku);
  const rows = async () => (await call('/api/admin/products')).json;
  const save = async (sku, patch) => {
    const read = await rows();
    return call('/api/admin/product-save', { method: 'POST', body: { ...read.products.find(p => p.sku === sku), ...patch, base_revision: read.draft_revision } });
  };
  const publish = async () => {
    const read = (await call('/api/admin/publication/draft-snapshot')).json;
    const r = await call('/api/admin/publication/publish-now', { method: 'POST', body: {
      base_revision: read.draft_revision, expected_active_release_id: read.active.release_id, expected_draft_checksum: read.draft.checksum } });
    assert.equal(r.status, 200, r.text);
  };
  const menuRevision = async () => (await call('/api/menu', { auth: null })).json.menu_revision;
  const posSaleRaw = async (items, revision) => call('/api/pos/sale', { method: 'POST', auth: staff, body: { items,
    menu_revision: revision || await menuRevision(), pay_method: 'cash', client_token: `components-test-${Math.random()}` } });
  const posSale = async items => {
    const r = await posSaleRaw(items);
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  const orderItems = id => JSON.parse(d1.query('SELECT items_json FROM orders WHERE id=?', id)[0].items_json);
  const board = async () => (await call(`/api/kitchen/board?t=${PRINT}`, { auth: null })).json;
  const boardSub = async (orderId, sku) => {
    const order = (await board()).orders.find(o => o.id === orderId);
    assert.ok(order, 'order is on the kitchen board');
    const names = Object.fromEntries((await rows()).products.map(p => [p.name_cn, p.sku]));
    const item = order.items.find(i => names[i.name] === sku);
    return item.sub.map(s => `${s.name}×${s.qty}`).join(' · ');
  };
  const production = async () => (await call('/api/admin/production')).json;
  const tryPublish = async () => {
    const snap = await call('/api/admin/publication/draft-snapshot');
    if (snap.status !== 200) return snap;
    const read = snap.json;
    return call('/api/admin/publication/publish-now', { method: 'POST', body: {
      base_revision: read.draft_revision, expected_active_release_id: read.active.release_id, expected_draft_checksum: read.draft.checksum } });
  };
  return { d1, call, catalog, product, rows, save, publish, tryPublish, posSale, posSaleRaw, menuRevision, orderItems, board, boardSub, production, staff };
}

test('后台改组成并发布：顾客菜单的「含：…」和厨房看板、备货单一起变；未发布前都不变；旧单不受影响', async t => {
  const s = await site(t);
  const before = await s.product('C1');
  assert.equal(before.contents_cn, '鲜肉包×1 · 牛肉包×1 · 茄子包×1 · 青菜香菇包×1');
  const oldOrder = await s.posSale([{ sku: 'C1', qty: 1 }]);
  assert.equal(await s.boardSub(oldOrder, 'C1'), before.contents_cn, '厨房看板 = 顾客菜单');

  // 老板在后台改组成：保存到草稿，但还没发布
  const saved = await s.save('C1', { components: [{ sku: 'S01', qty: 2 }, { sku: 'S07', qty: 2 }] });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await s.product('C1')).contents_cn, before.contents_cn, '未发布：顾客菜单不变');
  const draftOrder = await s.posSale([{ sku: 'C1', qty: 1 }]);
  assert.equal(await s.boardSub(draftOrder, 'C1'), before.contents_cn, '未发布：厨房也不变');

  await s.publish();
  const after = await s.product('C1');
  assert.equal(after.contents_cn, '鲜肉包×2 · 青菜香菇包×2');
  assert.equal(after.contents_en, 'Pork Bun×2 · Vegetable & Mushroom Bun×2');
  const newOrder = await s.posSale([{ sku: 'C1', qty: 3 }]);
  assert.equal(await s.boardSub(newOrder, 'C1'), '鲜肉包×6 · 青菜香菇包×6', '发布后：厨房跟着菜单变（3 份）');
  assert.equal(await s.boardSub(oldOrder, 'C1'), before.contents_cn, '已下的单按下单时的组成出餐');

  // 备货单：两张旧组成的单 + 一张新组成 ×3
  const plan = Object.fromEntries((await s.production()).buns.map(b => [b.sku, b.qty]));
  assert.deepEqual(plan, { S01: 2 + 6, S02: 2, S06: 2, S07: 2 + 6 });
});

test('单人餐的任选饮品：菜单列出在售饮品，厨房看到同样的选项，备货单单独计饮品', async t => {
  const s = await site(t);
  const meal = await s.product('P06');
  assert.equal(meal.contents_cn, '鲜肉包×1 · 青菜香菇包×1 · 任选饮品×1（豆奶 / 牛奶）');
  const id = await s.posSale([{ sku: 'P06', qty: 2 }, { sku: 'P39', qty: 1 }]);
  assert.equal(await s.boardSub(id, 'P06'), '鲜肉包×2 · 青菜香菇包×2 · 任选饮品（豆奶 / 牛奶）×2');
  const plan = await s.production();
  assert.equal(plan.drinks, 3, '2 份单人餐的饮品 + 1 瓶单点豆奶');
  assert.equal(plan.total, 4, '「今日需备包子」不含饮品');
});

test('组成输入校验：不存在的商品、包含自己、数量越界都拒收；只改别的字段时组成保持不变', async t => {
  const s = await site(t);
  for (const components of [[{ sku: 'NOPE', qty: 1 }], [{ sku: 'C1', qty: 1 }], [{ sku: 'S01', qty: 100 }],
    [{ sku: 'S01', qty: 1 }, { sku: 'S01', qty: 2 }], [{ sku: 'S01', qty: 1.5 }]]) {
    const r = await s.save('C1', { components });
    assert.equal(r.status, 400, JSON.stringify(components));
  }
  const before = (await s.rows()).products.find(p => p.sku === 'C1').components;
  const read = await s.rows();
  const partial = await s.call('/api/admin/product-save', { method: 'POST', body: { sku: 'C1', name_cn: '只改名称', base_revision: read.draft_revision } });
  assert.equal(partial.status, 200, partial.text);
  assert.deepEqual((await s.rows()).products.find(p => p.sku === 'C1').components, before);
});

// ── Codex 第一轮核查指出的边界情况（2026-11-03），每条先按原问题构造场景 ─────────────

test('只有一种成分的 N 粒装也显示组成；改了组成而名称粒数不符时拒绝发布', async t => {
  const s = await site(t);
  const p15 = await s.product('P15');
  assert.equal(p15.contents_cn, '鲜肉包×3');
  assert.equal(p15.contents_en, 'Pork Bun×3');
  assert.equal((await s.save('P15', { components: [{ sku: 'S02', qty: 4 }] })).status, 200);
  const refused = await s.tryPublish();
  assert.notEqual(refused.status, 200, '名称写 3 粒、组成 4 粒，不能发布');
  assert.match(refused.text, /3 粒.*4 粒/);
  assert.equal((await s.product('P15')).contents_cn, '鲜肉包×3', '拒绝发布：顾客菜单不变');
  assert.equal((await s.save('P15', { name_cn: '牛肉包 (4粒装)', components: [{ sku: 'S02', qty: 4 }] })).status, 200);
  const enRefused = await s.tryPublish();
  assert.notEqual(enRefused.status, 200, '英文名仍写 3pcs，不能发布');
  assert.match(enRefused.text, /3 pcs.*4 粒/);
  assert.equal((await s.save('P15', { name_en: 'Juicy Beef Bun (4pcs)' })).status, 200);
  await s.publish();
  assert.equal((await s.product('P15')).contents_cn, '牛肉包×4');
  const id = await s.posSale([{ sku: 'P15', qty: 1 }]);
  assert.equal(await s.boardSub(id, 'P15'), '牛肉包×4');
});

test('清空组成并发布后，新订单明确不展开，不会退回旧配方表', async t => {
  const s = await site(t);
  assert.equal((await s.save('C1', { components: [] })).status, 200);
  await s.publish();
  assert.deepEqual((await s.product('C1')).components, []);
  assert.equal((await s.product('C1')).contents_cn, undefined);
  const id = await s.posSale([{ sku: 'C1', qty: 2 }]);
  assert.deepEqual(s.orderItems(id)[0].components, [], '订单行明确记下「无组成」');
  assert.equal(await s.boardSub(id, 'C1'), '', '厨房不再按旧配方表展开 C1');
  const plan = Object.fromEntries((await s.production()).buns.map(b => [b.sku, b.qty]));
  assert.deepEqual(plan, { C1: 2 }, '备货单按商品本身计数');
});

test('顾客/店员拿旧菜单下单时组成已变：409 列出新组成，确认后才按新组成成交', async t => {
  const s = await site(t);
  const stale = await s.menuRevision();
  assert.equal((await s.save('C1', { components: [{ sku: 'S01', qty: 2 }, { sku: 'S07', qty: 2 }] })).status, 200);
  await s.publish();
  const r = await s.posSaleRaw([{ sku: 'C1', qty: 1 }], stale);
  assert.equal(r.status, 409, r.text);
  const change = r.json.changes.find(c => c.sku === 'C1' && c.reason === 'contents');
  assert.ok(change, JSON.stringify(r.json.changes));
  assert.equal(change.old_contents_cn, '鲜肉包×1 · 牛肉包×1 · 茄子包×1 · 青菜香菇包×1');
  assert.equal(change.new_contents_cn, '鲜肉包×2 · 青菜香菇包×2');
  assert.equal(r.json.lines[0].contents_cn, '鲜肉包×2 · 青菜香菇包×2', '前端拿它刷新卡片上的「含：…」');
  const ok = await s.posSaleRaw([{ sku: 'C1', qty: 1 }], r.json.active_revision);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await s.boardSub(ok.json.id, 'C1'), '鲜肉包×2 · 青菜香菇包×2');
});

test('前台与 POS 都把组成变化摆给人看（静态核对处理分支存在）', () => {
  const store = readFileSync(new URL('../web/storefront.js', import.meta.url), 'utf8');
  const pos = readFileSync(new URL('../web/pos.html', import.meta.url), 'utf8');
  assert.match(store, /change\.reason === 'contents'/);
  assert.match(store, /Array\.isArray\(line\.components\)\) for \(const key of \['contents_cn', 'contents_en'\]\)/);
  assert.match(pos, /c\.reason === 'contents'/);
});

test('后台补录按已发布菜单作价和出餐，未发布的草稿改动不进厨房', async t => {
  const s = await site(t);
  assert.equal((await s.save('C1', { price: 12.3, components: [{ sku: 'S02', qty: 4 }] })).status, 200);
  const r = await s.call('/api/admin/offline-sale', { method: 'POST', body: { items: [{ sku: 'C1', qty: 1 }], pay_method: 'cash',
    menu_revision: await s.menuRevision(), client_token: `components-offline-${Math.random()}` } });
  assert.equal(r.status, 200, r.text);
  const line = s.orderItems(r.json.id)[0];
  assert.equal(line.unit_price, (await s.product('C1')).price_cents / 100, '按已发布价格');
  assert.equal(await s.boardSub(r.json.id, 'C1'), '鲜肉包×1 · 牛肉包×1 · 茄子包×1 · 青菜香菇包×1', '按已发布组成');
});

test('备货单用订单下单时的名称和分类，发布前改草稿不影响已售订单', async t => {
  const s = await site(t);
  await s.posSale([{ sku: 'P15', qty: 1 }, { sku: 'P39', qty: 1 }]);
  const before = await s.production();
  assert.equal((await s.save('S01', { name_cn: '草稿改名', category: 'drink' })).status, 200);
  const after = await s.production();
  assert.deepEqual(after, before);
  assert.equal(after.total, 3);
  assert.equal(after.drinks, 1);
  assert.equal(after.buns.find(b => b.sku === 'S01').name, '鲜肉包');
});

test('组成只能一层：不能把套餐放进套餐，也不能给已被引用的单品设组成', async t => {
  const s = await site(t);
  const nested = await s.save('C2', { components: [{ sku: 'C1', qty: 1 }] });
  assert.equal(nested.status, 400); assert.match(nested.text, /本身是套餐/);
  const parent = await s.save('S01', { components: [{ sku: 'S02', qty: 2 }] });
  assert.equal(parent.status, 400); assert.match(parent.text, /已是 .*C1.* 的组成/);
  // 绕过表单直接改库：发布时同样拦下
  s.d1.sqlite.prepare("UPDATE products SET components='[{\"sku\":\"S02\",\"qty\":2}]' WHERE sku='S01'").run();
  const refused = await s.tryPublish();
  assert.notEqual(refused.status, 200); assert.match(refused.text, /组成只能一层/);
});

test('库里的坏组成数据阻断发布，不被静默丢项', async t => {
  for (const bad of ['[{"sku":"S01","qty":1},{"sku":"S02","qty":"2"}]', 'not-json', '{"sku":"S01"}']) {
    const s = await site(t);
    s.d1.sqlite.prepare('UPDATE products SET components=? WHERE sku=?').run(bad, 'C1');
    const refused = await s.tryPublish();
    assert.notEqual(refused.status, 200, bad);
    assert.match(refused.text, /组成/, bad);
  }
});

// ── Codex 第二轮核查指出的问题（2026-11-03） ─────────────────────────────────

test('N4：成分自身写了粒数的按它计——两份 4 粒装生煎组成的 8 粒分享盒可以发布，写错粒数仍会被拒', async t => {
  const s = await site(t);
  const read = await s.rows();
  const create = name => s.call('/api/admin/product-save', { method: 'POST', body: { sku: 'G8', name_cn: name, name_en: 'Pan-Fried Share Box',
    price: 13.8, category: 'combo', active: 1, components: [{ sku: 'MB5', qty: 2 }], base_revision: read.draft_revision } });
  assert.equal((await create('生煎 6粒分享盒')).status, 200);
  const refused = await s.tryPublish();
  assert.notEqual(refused.status, 200); assert.match(refused.text, /6 粒.*8 粒/);
  assert.equal((await s.save('G8', { name_cn: '生煎 8粒分享盒' })).status, 200);
  await s.publish();
  assert.equal((await s.product('G8')).contents_cn, '经典上海生煎包 (4粒装)×2');
});

test('N5：同一 SKU 在两次发布之间改了名，备货单分两行，不并成某一批的名称', async t => {
  const s = await site(t);
  await s.posSale([{ sku: 'P15', qty: 1 }]);
  assert.equal((await s.save('S01', { name_cn: '测试新馅包' })).status, 200);
  await s.publish();
  await s.posSale([{ sku: 'P15', qty: 1 }]);
  const rows = (await s.production()).buns.filter(b => b.sku === 'S01').map(b => `${b.name}×${b.qty}`).sort();
  assert.deepEqual(rows, ['测试新馅包×3', '鲜肉包×3']);
});

test('N6：第一版订单（成分没记分类）里的饮品成分仍按饮品计', async t => {
  const s = await site(t);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  s.d1.sqlite.prepare(`INSERT INTO orders(id,invoice_no,created_at,customer_name,phone,items_json,subtotal,total,fulfilment,pay_status,deliver_at)
    VALUES('legacy-r1','HL-TEST-R1',?,'TEST','',?,5.9,5.9,'pickup','PAID',?)`).run(new Date().toISOString(),
    JSON.stringify([{ sku: 'X1', qty: 1, name: '旧格式套餐', unit_price: 5.9, components: [{ sku: 'S01', qty: 1, name: '鲜肉包' }, { sku: 'P39', qty: 1, name: '豆奶' }] }]), today);
  const plan = await s.production();
  assert.equal(plan.drinks, 1, JSON.stringify(plan));
  assert.equal(plan.total, 1);
});

test('N7：后台补录必须按页面上那份菜单成交；菜单已重新发布就拒收，带上当前版本才记账', async t => {
  const s = await site(t);
  const seen = await s.menuRevision();
  assert.equal((await s.save('C1', { price: 12.3, components: [{ sku: 'S02', qty: 4 }] })).status, 200);
  await s.publish();
  const sale = revision => s.call('/api/admin/offline-sale', { method: 'POST', body: { items: [{ sku: 'C1', qty: 1 }], pay_method: 'cash',
    ...(revision === undefined ? {} : { menu_revision: revision }), client_token: `components-offline-${Math.random()}` } });
  for (const stale of [seen, undefined]) {
    const r = await sale(stale);
    assert.equal(r.status, 409, r.text); assert.equal(r.json.code, 'menu_changed');
  }
  assert.equal(s.d1.query("SELECT COUNT(*) n FROM orders WHERE cashier='boss'")[0].n, 0, '拒收时不写订单');
  const ok = await sale(await s.menuRevision());
  assert.equal(ok.status, 200, ok.text);
  assert.equal(s.orderItems(ok.json.id)[0].unit_price, 12.3);
  assert.equal(await s.boardSub(ok.json.id, 'C1'), '牛肉包×4');
});

async function insertHistoricalRelease(s, id, mutate) {
  const active = (await s.call('/api/admin/publication/draft-snapshot')).json.active;
  const snapshot = JSON.parse(s.d1.query('SELECT snapshot_json FROM public_content_releases WHERE id=?', active.release_id)[0].snapshot_json);
  mutate(snapshot);
  s.d1.sqlite.prepare(`INSERT INTO public_content_releases(id,status,effective_at,created_at,source_revision,checksum,snapshot_json)
    VALUES(?,'superseded','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z','historical',?,?)`).run(id, await checksumSnapshot(snapshot), JSON.stringify(snapshot));
  return active.release_id;
}
const rollback = (s, id, expected) => s.call('/api/admin/publication/rollback-exact', { method: 'POST', body: { release_id: id, expected_active_release_id: expected } });

test('N2：当前菜单已有组成时，拒绝回滚到「组成」功能之前的菜单，并说明原因', async t => {
  const s = await site(t);
  const live = await insertHistoricalRelease(s, 'pre-components', snap => { for (const p of snap.products) { delete p.components; delete p.contents_cn; delete p.contents_en; } });
  const r = await rollback(s, 'pre-components', live);
  assert.equal(r.status, 422, r.text);
  assert.equal(r.json.code, 'snapshot_predates_components');
  assert.match(r.json.error, /早于「组成」功能/);
  assert.equal((await s.call('/api/admin/publication/draft-snapshot')).json.active.release_id, live, '未回滚');
});

test('N3：本功能第一版格式的历史菜单（单一成分不生成文字、单品没有组成字段）可以回滚，厨房仍按组成出餐', async t => {
  const s = await site(t);
  const live = await insertHistoricalRelease(s, 'first-format', snap => {
    for (const p of snap.products) {
      if (!p.components.length) delete p.components;
      else if (p.components.length === 1) { delete p.contents_cn; delete p.contents_en; }
      for (const c of p.components || []) delete c.category;
    }
  });
  const r = await rollback(s, 'first-format', live);
  assert.equal(r.status, 200, r.text);
  const id = await s.posSale([{ sku: 'P15', qty: 1 }, { sku: 'C1', qty: 1 }]);
  assert.equal(await s.boardSub(id, 'P15'), '鲜肉包×3');
  assert.equal(await s.boardSub(id, 'C1'), '鲜肉包×1 · 牛肉包×1 · 茄子包×1 · 青菜香菇包×1');
});

for (const failReload of [false, true]) test(`Chrome N1（POS）：菜单在收银期间重新发布${failReload ? '且重新载入失败一次' : ''}，下一单的价格和屏幕上一致`, { timeout: 30000 }, async t => {
  const s = await site(t);
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/pos') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync(new URL('../web/pos.html', import.meta.url))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], sales = [];
  let failNextMenu = false;
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.evaluateOnNewDocument(token => { sessionStorage.setItem('hl_staff', token); sessionStorage.setItem('hl_cashier', 'pos1'); }, s.staff);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.pathname === '/pos') return request.continue();
    if (url.pathname === '/api/menu' && failNextMenu) { failNextMenu = false; return request.abort(); }
    if (url.pathname === '/api/menu' || url.pathname === '/api/config') {
      const r = await s.call(url.pathname, { auth: null });
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    if (url.pathname === '/api/pos/sale') {
      const r = await s.call('/api/pos/sale', { method: 'POST', auth: s.staff, body: JSON.parse(request.postData()) });
      sales.push({ status: r.status, body: r.json });
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/pos`, { waitUntil: 'load' });
  await page.waitForSelector('#t-C1');
  const tilePrice = sku => page.$eval(`#t-${sku} .pr`, el => el.textContent);
  const checkout = async () => {
    const before = sales.length;
    await page.evaluate(() => window.checkout());
    for (let i = 0; i < 50 && sales.length === before; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    return sales.at(-1);
  };
  const shownBefore = await tilePrice('C2');
  assert.notEqual(shownBefore, 'S$ 15.00');

  // 收银期间老板改价并发布
  assert.equal((await s.save('C1', { price: 12.3 })).status, 200);
  assert.equal((await s.save('C2', { price: 15, components: [{ sku: 'S07', qty: 4 }] })).status, 200);
  await s.publish();

  failNextMenu = failReload;
  await page.evaluate(() => window.add('C1'));
  assert.equal((await checkout()).status, 409);
  assert.match(await page.$eval('#toast', el => el.textContent), /菜单已更新/);
  assert.equal(await page.$eval('#amt', el => el.textContent), '12.30', '这单的金额按新价显示');
  assert.equal(await tilePrice('C2'), failReload ? shownBefore : 'S$ 15.00', failReload ? '载入失败：C2 仍是旧显示' : '409 后整份菜单重新载入');
  if (failReload) {
    // 确认前往同一单里再加一件没核对过的 C2（屏幕还是旧价）：不能借 C1 的确认按新价成交
    await page.evaluate(() => window.add('C2'));
    const blocked = await checkout();
    assert.equal(blocked.status, 409, '屏幕上 C2 还是旧价：必须再核对一次');
    assert.ok(blocked.body.changes.some(c => c.sku === 'C2'), JSON.stringify(blocked.body.changes));
    assert.equal(await tilePrice('C2'), 'S$ 15.00', '这次重新载入成功，屏幕换成新菜单');
    assert.equal(await page.$eval('#amt', el => el.textContent), '27.30');
    const both = await checkout();
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual(s.orderItems(both.body.id).map(i => `${i.sku}@${i.unit_price}`), ['C1@12.3', 'C2@15']);
    // 下一单：C2，屏幕已是新价，直接按新价成交
    await page.evaluate(() => window.add('C2'));
  } else {
    assert.equal((await checkout()).status, 200, '店员确认后这单按新价成交');
    await page.evaluate(() => window.add('C2'));
  }
  assert.equal(await page.$eval('#amt', el => el.textContent), '15.00');
  const ok = await checkout();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(s.orderItems(ok.body.id)[0].unit_price, 15);
  assert.equal(await s.boardSub(ok.body.id, 'C2'), '青菜香菇包×4');
  assert.deepEqual(errors, []);
});

test('A2：后台补录所选商品在页面打开后被下架，拒收，不按草稿价或旧配方表记账', async t => {
  const s = await site(t);
  const seen = await s.menuRevision();
  const read = await s.rows();
  assert.equal((await s.call('/api/admin/product-toggle', { method: 'POST', body: { sku: 'C1', active: 0, base_revision: read.draft_revision } })).status, 200);
  await s.publish();
  assert.equal((await s.save('C1', { price: 12.3, components: [{ sku: 'S07', qty: 4 }] })).status, 200);
  for (const revision of [seen, await s.menuRevision()]) {
    const r = await s.call('/api/admin/offline-sale', { method: 'POST', body: { items: [{ sku: 'C1', qty: 1 }], pay_method: 'cash',
      menu_revision: revision, client_token: `components-offline-${Math.random()}` } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'menu_changed');
  }
  assert.match((await s.call('/api/admin/offline-sale', { method: 'POST', body: { items: [{ sku: 'C1', qty: 1 }], pay_method: 'cash',
    menu_revision: await s.menuRevision(), client_token: 'x' } })).text, /已不在当前菜单上：C1/);
  assert.equal(s.d1.query("SELECT COUNT(*) n FROM orders WHERE cashier='boss'")[0].n, 0, '拒收时不写订单');
});

test('备货单：旧单（回查得名）和新单（冻结名）同 SKU 同名时合并成一行', async t => {
  const s = await site(t);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  s.d1.sqlite.prepare(`INSERT INTO orders(id,invoice_no,created_at,customer_name,phone,items_json,subtotal,total,fulfilment,pay_status,deliver_at)
    VALUES('legacy-s01','HL-TEST-L1',?,'TEST','',?,7.2,7.2,'pickup','PAID',?)`).run(new Date().toISOString(),
    JSON.stringify([{ sku: 'S01', qty: 2, name: '鲜肉包', unit_price: 3.6 }]), today);
  await s.posSale([{ sku: 'S01', qty: 1 }]);
  const rows = (await s.production()).buns.filter(b => b.sku === 'S01');
  assert.deepEqual(rows.map(b => `${b.name}×${b.qty}`), ['鲜肉包×3']);
});

test('Chrome R4-A3（POS）：已用百分比优惠券时菜单改价，409 后优惠券作废，重新应用后屏幕应收 = 实际记账', { timeout: 30000 }, async t => {
  const s = await site(t);
  s.d1.sqlite.prepare('INSERT INTO promo_codes(code,kind,value) VALUES(?,?,?)').run('TEST-TEN', 'percent', 10);
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/pos') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync(new URL('../web/pos.html', import.meta.url))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], sales = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('TEST-TEN') : d.accept());
  await page.evaluateOnNewDocument(token => { sessionStorage.setItem('hl_staff', token); sessionStorage.setItem('hl_cashier', 'pos1'); }, s.staff);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.pathname === '/pos') return request.continue();
    if (['/api/menu', '/api/config'].includes(url.pathname)) {
      const r = await s.call(url.pathname, { auth: null });
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    if (url.pathname === '/api/promo/check' || url.pathname === '/api/pos/sale') {
      const r = await s.call(url.pathname, { method: 'POST', auth: url.pathname === '/api/pos/sale' ? s.staff : null, body: JSON.parse(request.postData()) });
      if (url.pathname === '/api/pos/sale') sales.push({ status: r.status, body: r.json });
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/pos`, { waitUntil: 'load' });
  await page.waitForSelector('#t-C1');
  const amt = () => page.$eval('#amt', el => el.textContent);
  const checkout = async () => {
    const before = sales.length;
    await page.evaluate(() => window.checkout());
    for (let i = 0; i < 50 && sales.length === before; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    return sales.at(-1);
  };
  const price = (await s.product('C1')).price_cents / 100;
  await page.evaluate(() => window.add('C1'));
  await page.evaluate(() => window.applyCoupon());
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('优惠券'));
  assert.equal(await amt(), (price - Math.round(price * 10) / 100).toFixed(2), '旧价九折');

  assert.equal((await s.save('C1', { price: 12.3 })).status, 200);
  await s.publish();
  assert.equal((await checkout()).status, 409);
  assert.equal(await amt(), '12.30', '409 后旧折扣作废，屏幕按新价显示，不显示按旧小计算的应收');
  assert.match(await page.$eval('#toast', el => el.textContent), /优惠券\/余额已取消/);

  await page.evaluate(() => window.applyCoupon());
  await page.waitForFunction(() => document.getElementById('amt').textContent === '11.07');
  const shown = await amt();
  const ok = await checkout();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.total.toFixed(2), shown, '屏幕应收 = 实际记账');
  assert.deepEqual(errors, []);
});

test('Chrome R5-A1（POS）：会员余额查询还没回来时菜单改价，迟到的查询结果不能恢复余额收款或旧应付', { timeout: 30000 }, async t => {
  const s = await site(t);
  s.d1.sqlite.prepare('INSERT INTO members(phone,name,balance) VALUES(?,?,?)').run('91234567', '测试会员', 110);
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/pos') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync(new URL('../web/pos.html', import.meta.url))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], sales = [];
  let holdMember = null, memberSeen = 0;
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('91234567') : d.accept());
  await page.evaluateOnNewDocument(token => { sessionStorage.setItem('hl_staff', token); sessionStorage.setItem('hl_cashier', 'pos1'); }, s.staff);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.pathname === '/pos') return request.continue();
    if (['/api/menu', '/api/config'].includes(url.pathname)) {
      const r = await s.call(url.pathname, { auth: null });
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    if (url.pathname === '/api/pos/member') {
      memberSeen++;
      const r = await s.call(url.pathname + url.search, { auth: s.staff });
      if (holdMember) await holdMember;   // 模拟慢网络：这次查询的回应迟到
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    if (url.pathname === '/api/pos/sale') {
      const r = await s.call('/api/pos/sale', { method: 'POST', auth: s.staff, body: JSON.parse(request.postData()) });
      sales.push({ status: r.status, body: r.json });
      return request.respond({ status: r.status, contentType: 'application/json', body: r.text });
    }
    return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/pos`, { waitUntil: 'load' });
  await page.waitForSelector('#t-C1');
  await page.evaluate(() => window.add('C1'));
  let release; holdMember = new Promise(r => { release = r; });
  const lookup = page.evaluate(() => window.payBalance());          // 店员查会员，回应迟迟不到
  for (let i = 0; i < 50 && !memberSeen; i++) await new Promise(r => setTimeout(r, 50));

  assert.equal((await s.save('C1', { price: 12.3 })).status, 200);
  await s.publish();
  await page.evaluate(() => window.checkout());
  for (let i = 0; i < 50 && !sales.length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(sales[0].status, 409);

  holdMember = null; release();                                      // 旧查询这时才回来
  await lookup;
  assert.deepEqual(await page.evaluate(() => [PAY, BALPHONE]), ['cash', null], '迟到的查询不能恢复余额收款');
  assert.match(await page.$eval('#toast', el => el.textContent), /请重新查会员/);
  assert.doesNotMatch(await page.$eval('#toast', el => el.textContent), /本单扣 S\$8\.90/);

  await page.evaluate(() => window.payBalance());                    // 重新查：按当前应付核对
  assert.match(await page.$eval('#toast', el => el.textContent), /本单扣 S\$12\.30/);
  assert.equal(await page.$eval('#amt', el => el.textContent), '12.30');
  assert.deepEqual(errors, []);
});
