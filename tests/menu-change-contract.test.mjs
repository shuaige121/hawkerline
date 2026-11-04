// Real Worker routes + real SQLite reads + Chrome. All data and credentials are synthetic;
// the request binding rejects every SQL mutation, and Chrome cannot reach external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import worker from '../worker/index.js';
import { extractTransactionRules } from '../worker/publication.js';
import { renderProductPage } from '../worker/public-render.js';
import { createSqliteD1 } from './sqlite-d1.mjs';
import { findChrome } from './find-chrome.mjs';

const oldRelease = JSON.parse(readFileSync(new URL('./fixtures/storefront-ux-release.json', import.meta.url)));
oldRelease.products.push({ ...structuredClone(oldRelease.products.find(p => p.sku === 'S01')), sku: 'S05', slug: 's05', name_cn: '旧名称测试商品', name_en: 'Old fixture product' });
const activeRelease = structuredClone(oldRelease);
activeRelease.release_id = 'fixture-menu-change-contract';
activeRelease.products.find(p => p.sku === 'S01').price_cents = 490;
activeRelease.settings.gst_registered = '1';
activeRelease.settings.business_hours_schedule = null;
const expectedRules = extractTransactionRules(activeRelease.settings);

function fixture(t, { publishedSettings = {}, draftSettings = {}, renamedProduct = false, changedContents = false } = {}) {
  const DB = createSqliteD1();
  const old = structuredClone(oldRelease);
  const published = structuredClone(activeRelease);
  if (changedContents) {
    // 只改组成，名称价格不变：顾客页面上是旧组成，活动发布是新组成
    Object.assign(old.products.find(p => p.sku === 'S05'), { components: [{ sku: 'S01', qty: 1, name_cn: '旧组成包', name_en: 'Old part bun', category: 'protein' }],
      contents_cn: '旧组成包×1', contents_en: 'Old part bun×1' });
    Object.assign(published.products.find(p => p.sku === 'S05'), { components: [{ sku: 'S01', qty: 2, name_cn: '新组成包', name_en: 'New part bun', category: 'protein' }],
      contents_cn: '新组成包×2', contents_en: 'New part bun×2' });
  }
  Object.assign(published.settings, publishedSettings);
  if (renamedProduct) Object.assign(published.products.find(p => p.sku === 'S05'), { name_cn: '新名称测试商品', name_en: 'Renamed fixture product' });
  t.after(() => DB.sqlite.close());
  const insertRelease = DB.sqlite.prepare(`INSERT INTO public_content_releases
    (id,status,effective_at,created_at,source_revision,checksum,snapshot_json)
    VALUES (?,?,?,?,?,?,?)`);
  const insertProduct = DB.sqlite.prepare(`INSERT INTO public_content_release_products
    (release_id,sku,name_cn,name_en,price_cents,category,active,components_json) VALUES (?,?,?,?,?,?,?,?)`);
  for (const release of [old, published]) {
    insertRelease.run(release.release_id, release === published ? 'published' : 'superseded', '2026-09-12T00:00:00Z',
      '2026-09-12T00:00:00Z', 'fixture-revision', 'fixture-checksum', JSON.stringify(release));
    for (const p of release.products) insertProduct.run(release.release_id, p.sku, p.name_cn, p.name_en, p.price_cents, p.category, p.active,
      Array.isArray(p.components) ? JSON.stringify(p.components) : null);
  }
  DB.sqlite.prepare('UPDATE public_content_state SET active_release_id=? WHERE singleton=1').run(activeRelease.release_id);
  const set = DB.sqlite.prepare('INSERT INTO app_settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  set.run('store_open', '1');
  set.run('business_hours', JSON.stringify(Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, ['00:00', '23:59']]))));
  // Deliberately disagree with the published GST rule: the 409 must carry the immutable release's rule.
  set.run('gst_registered', '0'); set.run('gst_rate', '7');
  for (const [key, value] of Object.entries(draftSettings)) set.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  DB.sqlite.prepare('INSERT INTO promo_codes(code,kind,value) VALUES(?,?,?)').run('TEST-FIXTURE-TEN', 'percent', 10);
  const before = DB.query('SELECT total_changes() n')[0].n;
  const forbiddenWrites = [], settingReads = [];
  const readOnlyDB = {
    prepare(sql) {
      if (!/^\s*SELECT\b/i.test(sql)) { forbiddenWrites.push(sql); throw new Error('Fixture rejects SQL writes'); }
      const stmt = DB.prepare(sql);
      if (sql.includes('app_settings')) return { bind(...params) { settingReads.push(...params); return stmt.bind(...params); } };
      return stmt;
    },
    batch() { forbiddenWrites.push('batch'); throw new Error('Fixture rejects SQL batches'); },
  };
  const env = { DB: readOnlyDB, AUTH_SECRET: 'TEST-FIXTURE-MENU-CONTRACT-SECRET' };
  const ctx = { waitUntil() { assert.fail('A rejected order must not enqueue side effects'); } };
  const payload = { phone: '00000000', fulfilment: 'pickup', items: [{ sku: 'S01', qty: 2 }],
    menu_revision: oldRelease.release_id, client_token: 'TEST-FIXTURE-NO-ORDER' };
  const post = (endpoint, body = payload, headers = {}) => worker.fetch(new Request('https://shop.example' + endpoint,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, ctx);
  const unchanged = () => {
    assert.deepEqual(forbiddenWrites, []);
    assert.equal(DB.query('SELECT total_changes() n')[0].n, before, 'Worker requests wrote zero rows');
  };
  return { env, post, payload, unchanged, settingReads, published, old };
}

const openHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, ['00:00', '23:59']]));
const closedHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, null]));
const publishedPickup = { id: 'published-only', active: 1, name: 'Published pickup point', name_en: 'Published pickup point', address: 'Published address', postal: '570001', detail: 'Published collection instructions' };
const scheduledDelivery = { same_day_cutoff: '16:00', anytime: { fee: 0 }, zones: [{ id: 'fixture', name_cn: 'Fixture zone', name_en: 'Fixture zone', sectors: ['57'], weekdays: [0, 1, 2, 3, 4, 5, 6], fee: 4, free_over: 0, block_below: 0 }] };
const stopBeforeWrite = { menu_revision: activeRelease.release_id, deliver_at: '2099-01-02', deliver_time: '12:00', pickup_point_id: 'published-only', promo_code: 'TEST-FIXTURE-INVALID-PROMO' };

test('unpublished hours cannot preempt a menu_changed response', async t => {
  const f = fixture(t, { publishedSettings: { business_hours_schedule: openHours }, draftSettings: { business_hours: closedHours } });
  const response = await f.post('/api/order');
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).code, 'menu_changed'); f.unchanged();
});

test('published pickup name, availability, hours and preparation survive conflicting unpublished settings', async t => {
  const f = fixture(t, { publishedSettings: { business_hours_schedule: openHours, prep_time_min: '0', pickup_display: [publishedPickup] },
    draftSettings: { business_hours: closedHours, prep_time_min: '180', pickup_enabled: '0', pickup_points: '[]', shop_name: 'UNPUBLISHED NAME' } });
  const response = await f.post('/api/order', { ...f.payload, ...stopBeforeWrite });
  const body = await response.json(); assert.equal(response.status, 400); assert.match(body.error, /Invalid code/, JSON.stringify(body));
  assert.deepEqual(f.settingReads, ['store_open', 'store_closed_msg'], 'published fulfilment must not read mutable settings');
  const stale = await (await f.post('/api/order')).json();
  assert.deepEqual(stale.release_rules.pickup_display, [publishedPickup]);
  assert.equal(stale.release_rules.pickup_enabled, true); assert.equal(stale.release_rules.prep_time_min, 0);
  f.unchanged();
});

test('published closure and disabled pickup cannot be bypassed by an open draft', async t => {
  for (const [settings, message] of [[{ business_hours_schedule: closedHours }, /休息/], [{ business_hours_schedule: openHours, pickup_display: [] }, /Pickup is currently unavailable/]]) {
    const f = fixture(t, { publishedSettings: settings, draftSettings: { business_hours: openHours, pickup_enabled: '1' } });
    const response = await f.post('/api/order', { ...f.payload, ...stopBeforeWrite });
    assert.match((await response.json()).error, message); f.unchanged();
  }
});

test('scheduled delivery uses the published enable flag and zones, without mutable fallback', async t => {
  for (const [enabled, mutableEnabled, expected] of [['1', '0', /Invalid code/], ['0', '1', /优惠配送暂未开放/]]) {
    const f = fixture(t, { publishedSettings: { delivery: scheduledDelivery, delivery_enabled: enabled, business_hours_schedule: openHours },
      draftSettings: { delivery_enabled: mutableEnabled, DELIVERY_ZONES: '[]' } });
    const response = await f.post('/api/order', { ...f.payload, ...stopBeforeWrite, fulfilment: 'discount', postal: '570001', address: 'TEST FIXTURE ADDRESS', quoted_fee: 4 });
    assert.equal(response.status, 400); assert.match((await response.json()).error, expected);
    assert.deepEqual(f.settingReads, ['store_open', 'store_closed_msg']); f.unchanged();
  }
});

test('old snapshots without pickup or zone data fail closed instead of using unpublished settings', async t => {
  for (const fulfilment of ['pickup', 'discount']) {
    const f = fixture(t, { publishedSettings: { pickup_display: undefined, delivery: null, business_hours_schedule: openHours },
      draftSettings: { pickup_enabled: '1', DELIVERY_ZONES: JSON.stringify(scheduledDelivery.zones) } });
    const response = await f.post('/api/order', { ...f.payload, ...stopBeforeWrite, fulfilment, postal: '570001', address: 'TEST FIXTURE ADDRESS' });
    const body = await response.json(); assert.equal(response.status, 400);
    assert.match(body.error, fulfilment === 'pickup' ? /Pickup is currently unavailable/ : /配送规则.*不可用|Delivery rules unavailable/);
    assert.deepEqual(f.settingReads, ['store_open', 'store_closed_msg']); f.unchanged();
  }
});

test('same-price bilingual S05 rename is explicit in the real Worker menu_changed contract', async t => {
  const f = fixture(t, { renamedProduct: true });
  const response = await f.post('/api/order', { ...f.payload, items: [{ sku: 'S05', qty: 2 }] });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.deepEqual(body.changes, [{ sku: 'S05', reason: 'name', old_name_cn: '旧名称测试商品', old_name_en: 'Old fixture product', new_name_cn: '新名称测试商品', new_name_en: 'Renamed fixture product' }]);
  assert.equal(body.lines[0].unit_price_cents, 360);
  assert.equal(body.lines[0].name_cn, '新名称测试商品');
  assert.equal(body.lines[0].name_en, 'Renamed fixture product');
  f.unchanged();
});

for (const endpoint of ['/api/order', '/api/pos/sale']) {
  test(`${endpoint}: menu_changed returns the exact published transaction rules before any write`, async t => {
    const f = fixture(t), headers = {};
    if (endpoint === '/api/pos/sale') {
      const payload = Buffer.from(JSON.stringify({ c: 'fixture-cashier', r: 'staff', exp: Date.now() + 60000 })).toString('base64');
      headers.authorization = `Bearer ${payload}.${createHmac('sha256', f.env.AUTH_SECRET).update(payload).digest('hex')}`;
    }
    const response = await f.post(endpoint, undefined, headers), body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'menu_changed');
    assert.equal(body.active_revision, activeRelease.release_id);
    assert.deepEqual(body.changes, [{ sku: 'S01', reason: 'price', old_price_cents: 360, new_price_cents: 490 }]);
    assert.equal(body.lines[0].line_total_cents, 980);
    f.unchanged();
    assert.deepEqual(body.release_rules, expectedRules, 'actual Worker 409 must provide the rules consumed by storefront.applyMenuChanges');
    if (endpoint === '/api/order') assert.deepEqual(body.current_total, {
      subtotal_cents: 980, delivery_fee_cents: 0, discount_cents: 0, service_charge_cents: 0, gst_cents: 88, total_cents: 1068,
    });
  });
}

for (const { removePickup, pendingPromo, renamedProduct, changedContents } of [{ removePickup: false }, { removePickup: true }, { removePickup: false, pendingPromo: true }, { removePickup: false, renamedProduct: true }, { removePickup: false, changedContents: true }]) test(`Chrome applies actual Worker 409 rules and requires review when ${changedContents ? 'only S05 contents change' : renamedProduct ? 'S05 is renamed at the same price' : pendingPromo ? 'an old promo response is pending' : `pickup is ${removePickup ? 'disabled' : 'changed'}`}`, { timeout: 30000 }, async t => {
  const sku = renamedProduct || changedContents ? 'S05' : 'S01';
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, ['11:00', '17:00']]));
  const f = fixture(t, { renamedProduct, changedContents, publishedSettings: { pickup_display: removePickup ? [] : [publishedPickup], delivery_enabled: '0', prep_time_min: '0', business_hours_schedule: hours } });
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (path === '/menu/' + sku.toLowerCase()) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderProductPage(f.old, f.old.products.find(p => p.sku === sku))); return;
    }
    if (['/storefront.js', '/storefront.css'].includes(path)) {
      res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(readFileSync(new URL('../web' + path, import.meta.url))); return;
    }
    if (path === '/api/store-status') { res.setHeader('content-type', 'application/json'); res.end('{"store_open":true}'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], unexpected = [], responses = [], promoRequests = [];
  page.setDefaultTimeout(5000);
  let releaseOldPromo, oldPromoReady;
  const oldPromoStarted = new Promise(resolve => { oldPromoReady = resolve; });
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('hl_lang', 'en'));
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.protocol === 'data:') return request.continue();
    if (url.hostname === '127.0.0.1' && url.pathname === '/api/promo/check' && request.method() === 'POST') {
      const payload = JSON.parse(request.postData()); promoRequests.push(payload);
      const response = await f.post('/api/promo/check', payload), body = await response.json();
      if (pendingPromo && promoRequests.length === 1) await new Promise(resolve => { releaseOldPromo = resolve; oldPromoReady(); });
      return request.respond({ status: response.status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.hostname === '127.0.0.1' && url.pathname === '/api/order' && request.method() === 'POST') {
      const response = await f.post('/api/order', JSON.parse(request.postData()));
      const body = await response.json(); responses.push(body);
      return request.respond({ status: response.status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.hostname !== '127.0.0.1' || request.method() !== 'GET') { unexpected.push(request.method() + ' ' + request.url()); return request.abort(); }
    return request.continue();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/menu/${sku.toLowerCase()}`, { waitUntil: 'load' });
  const tap = async selector => { await page.$eval(selector, el => el.scrollIntoView({ block: 'center' })); await page.click(selector); };
  if (changedContents) assert.equal(await page.$eval('.product-detail .contents', el => el.textContent), 'Incl: Old part bun×1');
  await tap('.product-detail [data-add-sku]'); await tap('.product-detail [data-a="inc"]');
  await tap('#checkout'); await page.type('#phone', '00000000');
  await page.type('#name', 'TEST FIXTURE CUSTOMER');
  await page.$eval('#date', el => { el.value = '2099-01-02'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.$eval('#time', el => { el.value = '12:00'; });
  if (pendingPromo) {
    await page.type('#promo', 'TEST-FIXTURE-TEN');
    assert.equal(await page.$eval('#promo', el => el.value), 'TEST-FIXTURE-TEN');
    await tap('#applyPromo'); await oldPromoStarted;
    assert.equal(promoRequests[0].subtotal, 7.2);
    assert.equal(await page.$eval('#promoMsg', el => el.textContent), 'Checking…');
  }
  assert.equal(await page.$eval('#sheetSummary', el => el.innerText.includes('GST')), false);
  await tap('#submit'); await page.waitForSelector('#submit.reconfirm');
  assert.equal(responses.length, 1, 'the browser must not automatically retry the rejected order');
  const summary = await page.$eval('#sheetSummary', el => el.innerText);
  assert.match(summary, /GST 9\.0%/);
  assert.match(summary, renamedProduct || changedContents ? /S\$ 7\.85/ : /S\$ 10\.68/);
  assert.deepEqual(responses[0].release_rules, extractTransactionRules(f.published.settings));
  assert.equal(await page.$eval('#coLines', (el, amount) => el.innerText.includes(amount), renamedProduct || changedContents ? '7.20' : '9.80'), true);
  assert.equal(await page.$eval('#submit', el => el.textContent), 'Confirm new prices and continue');
  assert.equal(await page.$eval('#submit', el => el.disabled), true, 'invalid previous pickup must block confirmation');
  assert.equal(await page.$eval('[name=ff][value=discount]', el => el.disabled), true, 'new published delivery switch disables scheduled delivery');
  assert.equal(await page.$eval('#pickupPoint', el => el.value), '', 'do not silently choose a different location');
  assert.equal(await page.$eval('#date', el => el.value), '2099-01-02');
  assert.equal(await page.$eval('#time', el => el.value), '12:00');
  assert.equal(await page.$eval('#name', el => el.value), 'TEST FIXTURE CUSTOMER');
  assert.match(await page.$eval('#timeHint', el => el.textContent), /11:00–17:00/);
  if (removePickup) assert.equal(await page.$eval('[name=ff][value=pickup]', el => el.disabled), true);
  else {
    await page.select('#pickupPoint', 'published-only');
    assert.equal(await page.$eval('#submit', el => el.disabled), false);
    const pickup = await page.$eval('#pickupInfo', el => el.textContent);
    assert.match(pickup, /Published pickup point/); assert.match(pickup, /Published address/); assert.match(pickup, /0 minutes/);
  }
  if (pendingPromo) {
    const oldArrived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/promo/check');
    releaseOldPromo(); await oldArrived.catch(error => { throw new Error('Delayed promo response was not received', { cause: error }); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await page.$eval('#sheetSummary', el => el.innerText), /S\$ 10\.68/, 'late old subtotal promo response must not change the reviewed total');
    assert.match(await page.$eval('#promoMsg', el => el.textContent), /Apply the promo code again/, 'pending promo must be cleared with a review instruction');
    const freshArrived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/promo/check');
    await tap('#applyPromo'); await freshArrived.catch(error => { throw new Error('Fresh promo response was not received', { cause: error }); });
    await page.waitForFunction(() => document.getElementById('promoMsg').textContent.includes('0.98'));
    assert.equal(promoRequests.length, 2); assert.equal(promoRequests[1].subtotal, 9.8);
    assert.match(await page.$eval('#sheetSummary', el => el.innerText), /S\$ 9\.61/, 'explicit fresh promo quote uses the new subtotal and GST');
    assert.equal(responses.length, 1, 'checking a promo must not retry the order');
  }
  if (changedContents) {
    const change = responses[0].changes.find(c => c.sku === 'S05' && c.reason === 'contents');
    assert.ok(change, 'actual Worker 409 reports the contents change');
    assert.match(await page.$eval('#menuChanges', el => el.innerText), /now includes New part bun×2/, 'customer sees the new contents before confirming');
    assert.equal(await page.$eval('.product-detail .contents', el => el.textContent), 'Incl: New part bun×2', 'the product page shows what the kitchen will make');
    assert.equal(responses.length, 1, 'reviewing the new contents must not retry the order');
    // N1：确认新版本后再加一件没核对过的商品（S01 页面仍是旧价），不能直接按新版本成交，必须再走一次差异核对
    await page.evaluate(() => { cart.S01 = { p: { ...PRODUCTS.find(p => p.sku === 'S01') }, qty: 1 }; saveCart(); });
    await page.select('#pickupPoint', 'published-only');
    await tap('#submit');
    for (let i = 0; i < 50 && responses.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(responses.length, 2, 'the extended cart was submitted once more');
    assert.equal(responses[1].code, 'menu_changed', 'an item the customer has not reviewed is never accepted silently');
    assert.ok(responses[1].changes.some(c => c.sku === 'S01' && c.reason === 'price'), 'the S01 price change is shown');
  }
  if (renamedProduct) {
    assert.match(await page.$eval('#coLines', el => el.innerText), /Renamed fixture product/);
    assert.match(await page.$eval('#menuChanges', el => el.innerText), /Old fixture product.*Renamed fixture product/);
    assert.match(await page.$eval('.product-detail h1', el => el.textContent), /Renamed fixture product/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hl_cart_context')).products.S05);
    assert.equal(saved.name_cn, '新名称测试商品'); assert.equal(saved.name_en, 'Renamed fixture product');
    await page.mouse.click(10, 10);
    assert.equal(await page.$eval('#sheet', el => el.classList.contains('show')), false);
    await tap('#langBtn');
    assert.match(await page.$eval('.product-detail h1', el => el.textContent), /新名称测试商品/);
    await tap('#checkout');
    assert.match(await page.$eval('#coLines', el => el.innerText), /新名称测试商品/);
    assert.equal(responses.length, 1, 'reviewing the renamed item must not retry the order');
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); f.unchanged();
});
