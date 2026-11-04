import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import worker from '../worker/index.js';
import { ensureActiveRelease, activateDueRelease, rollbackPublicRelease } from '../worker/publication.js';
import { renderPublicReleasePages } from '../worker/public-render.js';
import { createSqliteD1 } from './sqlite-d1.mjs';
import { findChrome } from './find-chrome.mjs';

const OWNER = 'synthetic-admin-content-owner';
const PRODUCT = { sku: 'TEST1', name_cn: '测试包', name_en: 'Test Bun', price: 3.6, category: 'protein',
  kcal: 200, img: 'img/01.png', description_cn: '', description_en: '', detail_cn: '', detail_en: '', active: 1, sort: 1 };
async function site(t) {
  const DB = createSqliteD1();
  t.after(() => DB.sqlite.close());
  DB.sqlite.exec('DELETE FROM product_tag_assignments; DELETE FROM products; DELETE FROM homepage_posters;');
  const columns = Object.keys(PRODUCT);
  DB.sqlite.prepare(`INSERT INTO products (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(PRODUCT));
  const env = { DB, ADMIN_TOKEN: OWNER, AUTH_SECRET: 'synthetic-admin-content-secret' };
  const ctx = { waitUntil: promise => promise.catch(() => {}) };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  await ensureActiveRelease(env, { allowBootstrap: true, pageBuilder: renderPublicReleasePages });
  const request = (pathname, options = {}) => worker.fetch(new Request('https://shop.example' + pathname,
    { ...options, headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json', ...options.headers } }), env, ctx);
  const call = async (pathname, body) => {
    const response = await request(pathname, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const revision = () => DB.query('SELECT draft_revision FROM public_content_state WHERE singleton=1')[0].draft_revision;
  const state = () => ({ products: DB.query('SELECT * FROM products ORDER BY sku'), settings: DB.query('SELECT k,v FROM app_settings ORDER BY k'),
    posters: DB.query('SELECT * FROM homepage_posters'), revision: revision(), events: DB.query('SELECT * FROM public_content_events ORDER BY id'),
    settingsState: DB.query('SELECT * FROM store_settings_state'), posterState: DB.query('SELECT * FROM homepage_poster_state') });
  return { DB, call, request, revision, state };
}

for (const [name, endpoint, body] of [
  ['product form', '/api/admin/product-save', { ...PRODUCT, name_cn: '旧窗口修改' }],
  ['availability', '/api/admin/product-toggle', { sku: PRODUCT.sku, active: 0 }],
  ['sort', '/api/admin/product-sort', { order: [PRODUCT.sku] }],
  ['image', '/api/admin/product-image', { sku: PRODUCT.sku, dataurl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==' }],
  ['brand', '/api/admin/brand-config', { name_cn: '旧窗口店名' }],
  ['delivery zones', '/api/admin/delivery-zones', { zones: [{ name_cn: '测试区', sectors: '12', weekdays: [1], fee: 4 }], same_day_cutoff: '16:00' }],
]) {
  test(`${name}: missing/stale baseline writes zero; fresh baseline commits and advances revision`, async t => {
    const s = await site(t), old = s.revision(), before = s.state();
    assert.equal((await s.call(endpoint, body)).status, 409, 'missing baseline must not silently bypass CAS');
    assert.deepEqual(s.state(), before);
    assert.equal((await s.call('/api/admin/product-toggle', { sku: PRODUCT.sku, active: 0, base_revision: old })).status, 200);
    const changed = s.state();
    assert.equal((await s.call(endpoint, { ...body, base_revision: old })).status, 409);
    assert.deepEqual(s.state(), changed, 'stale request writes no product, settings, event or revision');
    const saved = await s.call(endpoint, { ...body, base_revision: s.revision() });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.body.draft_revision, old);
  });
}

test('a partial product edit preserves omitted photo, availability and other fields', async t => {
  const s = await site(t);
  const saved = await s.call('/api/admin/product-save', { sku: PRODUCT.sku, name_cn: '只改名称', base_revision: s.revision() });
  assert.equal(saved.status, 200);
  const row = (await s.call('/api/admin/products')).body.products[0];
  assert.deepEqual(row, { ...PRODUCT, name_cn: '只改名称', components: [] });
});

test('brand logo accepts an actual image but invalid input cannot partially save other brand fields', async t => {
  const s = await site(t);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  assert.equal((await s.call('/api/admin/brand-config', { logo: png, base_revision: s.revision() })).status, 200);
  for (const logo of ['javascript:alert(1)', 'data:text/html;base64,SGVsbG8=', 'data:image/png;base64,', '/img/logo.png" onerror="alert(1)', 'data:image/png;base64,AAAA', '//outside.invalid/logo.png']) {
    const before = s.state();
    const result = await s.call('/api/admin/brand-config', { name_cn: '不应部分写入', logo, base_revision: s.revision() });
    assert.equal(result.status, 400, logo);
    assert.deepEqual(s.state(), before);
  }
});

test('settings and posters couple collection and global revision in one transaction', async t => {
  for (const kind of ['settings', 'posters']) {
    const s = await site(t), loaded = (await s.call(`/api/admin/${kind}`)).body;
    assert.equal(loaded.draft_revision, s.revision(), 'GET returns the draft baseline with the collection');
    const body = kind === 'settings' ? { shop_name: '新店名', settings_revision: loaded.settings_revision }
      : { posters: [{ id: 'test', title_cn: '测试海报', action_type: 'none' }], collection_revision: loaded.collection_revision };
    const before = s.state();
    assert.equal((await s.call(`/api/admin/${kind}`, body)).status, 409);
    assert.deepEqual(s.state(), before);
    s.DB.beforeBatch(/UPDATE public_content_state SET draft_revision/, async () => {
      assert.equal((await s.call('/api/admin/product-toggle', { sku: PRODUCT.sku, active: 0, base_revision: s.revision() })).status, 200);
    });
    assert.equal((await s.call(`/api/admin/${kind}`, { ...body, base_revision: loaded.draft_revision })).status, 409);
    assert.equal(s.DB.pendingHooks(), 0);
    assert.deepEqual(s.state().settings, before.settings);
    assert.deepEqual(s.state().posters, before.posters);
    assert.deepEqual(s.state().settingsState, before.settingsState);
    assert.deepEqual(s.state().posterState, before.posterState);
    assert.equal((await s.call(`/api/admin/${kind}`, { ...body, base_revision: s.revision() })).status, 200);
  }
});

test('schedule binds the reviewed snapshot, active release and future content date', async t => {
  const s = await site(t);
  const when = '2099-01-01T10:00';
  const reviewed = (await s.call('/api/admin/publication/draft-snapshot?effective_at_sgt=' + when)).body;
  assert.equal(reviewed.content_at, '2099-01-01T02:00:00.000Z');
  const body = { base_revision: reviewed.draft_revision, expected_active_release_id: reviewed.active.release_id,
    expected_draft_checksum: reviewed.draft.checksum, effective_at_sgt: when };
  const count = () => s.DB.query('SELECT COUNT(*) n FROM public_content_releases')[0].n;
  const before = count();
  assert.equal((await s.call('/api/admin/publication/schedule', { ...body, expected_draft_checksum: '0'.repeat(64) })).status, 409);
  assert.equal(count(), before, 'wrong reviewed content creates no release');
  s.DB.beforeBatch(/INSERT INTO public_content_releases/, async () => {
    assert.equal((await s.call('/api/admin/publication/publish-exact', body)).status, 200);
  });
  assert.equal((await s.call('/api/admin/publication/schedule', body)).status, 409, 'active publication changes after the read');
  assert.equal(count(), before + 1, 'only the competing publication exists');
  const latest = (await s.call('/api/admin/publication/draft-snapshot?effective_at_sgt=' + when)).body;
  const scheduled = await s.call('/api/admin/publication/schedule', { ...body, base_revision: latest.draft_revision,
    expected_active_release_id: latest.active.release_id, expected_draft_checksum: latest.draft.checksum });
  assert.equal(scheduled.status, 200);
});

test('a scheduled exact snapshot activates when due, but cannot replace a later publication', async t => {
  for (const changedActive of [false, true]) {
    const s = await site(t), env = { DB: s.DB };
    const reviewed = (await s.call('/api/admin/publication/draft-snapshot?effective_at_sgt=2099-01-01T10:00')).body;
    const result = await s.call('/api/admin/publication/schedule', { base_revision: reviewed.draft_revision,
      expected_active_release_id: reviewed.active.release_id, expected_draft_checksum: reviewed.draft.checksum,
      effective_at_sgt: '2099-01-01T10:00' });
    assert.equal(result.status, 200);
    assert.equal((await activateDueRelease(env, { now: new Date('2099-01-01T01:59:59Z') })).activated, false);
    let expectedActive = reviewed.active.release_id;
    if (changedActive) {
      // Simulate the existing historical rollback operation after scheduling; the future job must not undo it.
      const rollback = await rollbackPublicRelease(env, { sourceReleaseId: reviewed.active.release_id, pageBuilder: renderPublicReleasePages });
      assert.equal(rollback.ok, true); expectedActive = rollback.release_id;
    }
    const due = await activateDueRelease(env, { now: new Date('2099-01-01T02:00:00Z') });
    assert.equal(due.activated, !changedActive);
    assert.equal(s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id,
      changedActive ? expectedActive : result.body.release_id);
    if (!changedActive) assert.equal(s.DB.query('SELECT checksum FROM public_content_releases WHERE id=?', result.body.release_id)[0].checksum, reviewed.draft.checksum);
  }
});

test('publication status contains the active release and actual superseded history for rollback', async t => {
  const s = await site(t), original = (await s.call('/api/admin/publication/status')).body.active_release_id;
  await s.call('/api/admin/product-save', { sku: PRODUCT.sku, name_cn: '新发布名称', base_revision: s.revision() });
  const reviewed = (await s.call('/api/admin/publication/draft-snapshot')).body;
  const published = await s.call('/api/admin/publication/publish-exact', { base_revision: reviewed.draft_revision,
    expected_active_release_id: reviewed.active.release_id, expected_draft_checksum: reviewed.draft.checksum });
  assert.equal(published.status, 200);
  const status = (await s.call('/api/admin/publication/status')).body;
  assert.equal(status.releases.find(row => row.id === original)?.status, 'superseded');
  assert.equal(status.releases[0].id, published.body.release_id, 'active release is not hidden by history');
});

test('public HEAD agrees with GET and role-domain roots redirect before the storefront', async t => {
  const s = await site(t);
  for (const pathname of ['/menu/test1', '/public/catalog.json', '/menu/missing-product']) {
    const get = await s.request(pathname), head = await s.request(pathname, { method: 'HEAD' });
    assert.equal(head.status, get.status, pathname);
    if (get.status === 200) assert.ok(get.headers.get('x-public-release'), 'GET must identify the published release');
    for (const key of ['cache-control', 'x-public-release', 'content-type']) assert.equal(head.headers.get(key), get.headers.get(key), key);
    assert.equal(await head.text(), '');
  }
  for (const [host, location] of [['boss.shop.example', '/admin'], ['pos.shop.example', '/pos'], ['kitchen.shop.example', '/kitchen']]) {
    const response = await worker.fetch(new Request('https://' + host + '/'), { DB: s.DB }, { waitUntil() {} });
    assert.equal(response.status, 302, host);
    assert.equal(new URL(response.headers.get('location'), 'https://' + host).pathname, location);
  }
});

test('Chrome two windows load → edit → save preserves the stale form and refuses a second blind retry', { timeout: 45000 }, async t => {
  const s = await site(t);
  const html = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
  let losePublicationResponse = false;
  let loseRollbackResponse = false;
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/admin') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
      if (!req.url.startsWith('/api/admin/') && !req.url.startsWith('/preview/')) { res.statusCode = 404; res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await s.request(req.url, { method: req.method, headers: req.headers,
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks).toString() }) });
      if (losePublicationResponse && req.url === '/api/admin/publication/publish-exact') { losePublicationResponse = false; req.socket.destroy(); return; }
      if (loseRollbackResponse && req.url === '/api/admin/publication/rollback-exact') { loseRollbackResponse = false; req.socket.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pages = [await browser.newPage(), await browser.newPage()];
  t.diagnostic('Browser pages opened');
  for (const page of pages) {
    await page.bringToFront();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + '/admin', { waitUntil: 'domcontentloaded' });
    t.diagnostic('Admin document loaded');
    await page.evaluate(token => { TOKEN = token; }, OWNER);
    await page.evaluate(() => productsView());
    t.diagnostic('Product editor loaded');
    await page.click(`[onclick="fillProductForm('${PRODUCT.sku}')"]`);
  }
  await pages[0].bringToFront();
  await pages[0].$eval('#prodNameCn', el => { el.value = '窗口A已保存'; });
  await pages[0].$eval('#prodDetailCn', el => { el.value = '用于核对的长文案。'.repeat(80); });
  await pages[0].evaluate(() => saveProduct());
  assert.equal(s.DB.query('SELECT name_cn FROM products WHERE sku=?', PRODUCT.sku)[0].name_cn, '窗口A已保存');
  await pages[1].bringToFront();
  await pages[1].$eval('#prodNameCn', el => { el.value = '窗口B未保存'; });
  await pages[1].evaluate(() => saveProduct());
  assert.match(await pages[1].$eval('#prodMsg', el => el.textContent), /重新核对/);
  assert.equal(await pages[1].$eval('#prodNameCn', el => el.value), '窗口B未保存');
  await pages[1].evaluate(() => saveProduct());
  assert.equal(s.DB.query('SELECT name_cn FROM products WHERE sku=?', PRODUCT.sku)[0].name_cn, '窗口A已保存');

  // Real settings form, not a hand-built request: unrelated content changed since both reads.
  for (const page of pages) { await page.bringToFront(); await page.evaluate(() => settingsView()); }
  await pages[0].bringToFront();
  await pages[0].$eval('#stShopName', el => { el.value = '窗口A店名'; });
  await pages[0].evaluate(() => saveSettings());
  assert.equal(s.DB.query("SELECT v FROM app_settings WHERE k='shop_name'")[0].v, '窗口A店名');
  await pages[1].bringToFront();
  await pages[1].$eval('#stShopName', el => { el.value = '窗口B店名'; });
  await pages[1].evaluate(() => saveSettings());
  assert.equal(await pages[1].$eval('#stShopName', el => el.value), '窗口B店名');
  assert.match(await pages[1].evaluate(() => document.body.innerText), /重新核对/);
  await pages[1].evaluate(() => saveSettings());
  assert.equal(s.DB.query("SELECT v FROM app_settings WHERE k='shop_name'")[0].v, '窗口A店名');

  for (const page of pages) { await page.bringToFront(); await page.evaluate(() => brandView()); }
  await pages[0].bringToFront(); await pages[0].$eval('#b-name-cn', el => { el.value = '窗口A品牌'; });
  const uploadLogo = async (page, color) => {
    await page.evaluate(async color => {
      const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 3;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 3, 3);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'brand-logo.png', { type: 'image/png' }));
      const input = document.querySelector('input[onchange="brandLogoUpload(this)"]');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    }, color);
    await page.waitForFunction(() => window.BRAND_LOGO?.startsWith('data:image/png;base64,'));
    return page.evaluate(() => window.BRAND_LOGO);
  };
  const logoA = await uploadLogo(pages[0], '#ff0000');
  await pages[0].evaluate(() => saveBrand());
  assert.equal(s.DB.query("SELECT v FROM app_settings WHERE k='brand_logo'")[0]?.v, logoA, 'actual input → FileReader → canvas → API upload succeeds');
  await pages[1].bringToFront(); await pages[1].$eval('#b-name-cn', el => { el.value = '窗口B品牌'; });
  const logoB = await uploadLogo(pages[1], '#0000ff');
  await pages[1].evaluate(() => saveBrand()); await pages[1].evaluate(() => saveBrand());
  assert.equal(await pages[1].$eval('#b-name-cn', el => el.value), '窗口B品牌');
  assert.equal(await pages[1].evaluate(() => window.BRAND_LOGO), logoB, 'stale upload remains available for manual reconciliation');
  assert.equal(await pages[1].$eval('#brandLogoPrev', el => el.src), logoB);
  assert.equal(s.DB.query("SELECT v FROM app_settings WHERE k='brand_logo'")[0].v, logoA);
  assert.equal(s.DB.query("SELECT v FROM app_settings WHERE k='brand_name_cn'")[0].v, '窗口A品牌');

  for (const page of pages) {
    await page.bringToFront(); await page.evaluate(() => tagsView());
    await page.$eval('[data-tag-input-id]', el => { el.value = 'shared-test'; });
  }
  await pages[0].bringToFront(); await pages[0].$eval('[data-tag-input-cn]', el => { el.value = '窗口A标签'; });
  await pages[0].evaluate(() => saveTag());
  await pages[1].bringToFront(); await pages[1].$eval('[data-tag-input-cn]', el => { el.value = '窗口B标签'; });
  await pages[1].evaluate(() => saveTag()); await pages[1].evaluate(() => saveTag());
  assert.match(await pages[1].$eval('[data-tag-message]', el => el.textContent), /重新核对/);
  assert.equal(await pages[1].$eval('[data-tag-input-cn]', el => el.value), '窗口B标签');
  assert.equal(s.DB.query("SELECT label_cn FROM product_tags WHERE id='shared-test'")[0].label_cn, '窗口A标签');

  for (const page of pages) { await page.bringToFront(); await page.evaluate(() => postersView()); await page.evaluate(() => addPoster()); }
  await pages[0].bringToFront(); await pages[0].$eval('.poster-title-cn', el => { el.value = '窗口A海报'; });
  await pages[0].evaluate(() => savePosters());
  await pages[1].bringToFront(); await pages[1].$eval('.poster-title-cn', el => { el.value = '窗口B海报'; });
  await pages[1].evaluate(() => savePosters()); await pages[1].evaluate(() => savePosters());
  assert.match(await pages[1].$eval('#posterSaveMsg', el => el.textContent), /重新核对/);
  assert.equal(await pages[1].$eval('.poster-title-cn', el => el.value), '窗口B海报');
  assert.deepEqual(s.DB.query('SELECT title_cn FROM homepage_posters').map(r => r.title_cn), ['窗口A海报']);

  // Review is a complete snapshot diff and both controls stay disabled until explicitly approved.
  const page = pages[0]; await page.bringToFront();
  const reordered = await page.evaluate(() => publicationDiff({ products: [
    { sku: 'KEEP', name_cn: '保留商品', price_cents: 360 }, { sku: 'REMOVE', name_cn: '删除商品', price_cents: 200 },
  ] }, { products: [{ sku: 'ADD', name_cn: '新增商品', price_cents: 300 }, { sku: 'KEEP', name_cn: '保留商品', price_cents: 400 }] }));
  assert.deepEqual(reordered.map(d => d.path).sort(), ['products.ADD', 'products.KEEP.price_cents', 'products.REMOVE', 'products.order']);
  assert.equal(reordered.find(d => d.path === 'products.KEEP.price_cents').before, 360, 'reordering does not pair a price with another product');
  const reviewValues = await page.evaluate(() => {
    const plain = html => { const el = document.createElement('div'); el.innerHTML = html; return el.textContent; };
    const unknown = publicationDiff({ settings: { future_field: { mode: '完整原值', options: [1, 2] } } },
      { settings: { future_field: { mode: '完整新值', options: [2, 3] } } });
    const tagOrder = publicationDiff({ products: [{ sku: 'KEEP', tags: [{ id: 'one', label_cn: '一' }, { id: 'two', label_cn: '二' }] }] },
      { products: [{ sku: 'KEEP', tags: [{ id: 'two', label_cn: '二' }, { id: 'one', label_cn: '一' }] }] });
    const duplicateIds = publicationDiff([{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }], [{ id: 'same', label: 'C' }]);
    return { unknown, tagOrder, duplicateIds, price: plain(publicationReviewValue(360, ['products','KEEP','price_cents'], false, '')),
      added: plain(publicationReviewValue({ sku: 'ADD', price_cents: 300, future_field: '新增未识别值' }, ['products','ADD'], true, '')),
      embedded: plain(publicationReviewValue('data:image/png;base64,' + 'A'.repeat(2000), ['settings','brand_logo'], true, '')),
      image: publicationReviewValue('/public/media/' + 'a'.repeat(64), ['settings','brand_logo'], true, '/preview/signed/') };
  });
  assert.deepEqual(reviewValues.tagOrder.map(d => d.path), ['products.KEEP.tags.order'], 'tag IDs align through reordering too');
  assert.equal(reviewValues.duplicateIds.length, 1, 'ambiguous identifiers retain the entire arrays instead of dropping a row');
  assert.equal(reviewValues.duplicateIds[0].before[1].label, 'B');
  assert.deepEqual(reviewValues.unknown.map(d => [d.path, d.before, d.after]), [
    ['settings.future_field.mode', '完整原值', '完整新值'], ['settings.future_field.options', [1, 2], [2, 3]],
  ], 'unknown fields and all values remain available');
  assert.match(reviewValues.price, /S\$3\.60.*360 分/);
  assert.match(reviewValues.added, /SKUADD[\s\S]*S\$3\.00[\s\S]*future_field新增未识别值/);
  assert.match(reviewValues.image, /href="\/preview\/signed\/media\/a{64}"/);
  assert.ok(!reviewValues.embedded.includes('data:image') && reviewValues.embedded.includes('下载原图核对'), 'uploaded bytes do not drown out the review');
  await page.evaluate(() => publicationView());
  assert.equal(await page.$eval('[data-publish-now]', el => el.disabled), true);
  await page.evaluate(() => previewRelease());
  assert.match(await page.$eval('[data-publication-review]', el => el.textContent), /窗口A店名/);
  assert.match(await page.$eval('[data-publication-review]', el => el.textContent), /窗口A已保存/);
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.$eval('[data-publication-review] table', el => el.getBoundingClientRect().right <= document.documentElement.clientWidth), true,
    'the candidate column must be visible on mobile without discovering a hidden horizontal scroll');
  assert.match(await page.$eval('[data-publication-review]', el => el.textContent), /商品 TEST1/);
  assert.equal(await page.$eval('[data-publication-review] table', el => el.scrollWidth <= el.clientWidth), true, 'long before/after text wraps within mobile review');
  assert.ok((await page.$eval('[data-publication-review]', el => el.textContent)).includes('用于核对的长文案。'.repeat(80)), 'long values are complete, not truncated');
  assert.equal(await page.$$eval('[data-publication-review] td[data-label="待发布"]', cells => cells.every(el => {
    const rect = el.getBoundingClientRect(); return rect.width > 250 && rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
  })), true, 'each after value has a full readable mobile line within the screen');
  const imageReview = await page.evaluate(async () => {
    const link = [...document.querySelectorAll('[data-review-image]')].find(a => a.getAttribute('href').startsWith('/preview/'));
    const response = await fetch(link.href);
    return { status: response.status, type: response.headers.get('content-type') };
  });
  assert.equal(imageReview.status, 200, 'pending uploaded logo links to actual signed preview media before publication');
  assert.equal(imageReview.type, 'image/png');
  const qaDir = new URL('../_qa/admin-content/', import.meta.url); mkdirSync(qaDir, { recursive: true });
  await page.screenshot({ path: new URL('publication-review-mobile.png', qaDir).pathname, fullPage: true });
  await page.$eval('[data-review-path="products.TEST1.detail_cn"]', el => el.scrollIntoView());
  await page.screenshot({ path: new URL('publication-review-mobile-detail.png', qaDir).pathname });
  await page.setViewport({ width: 1200, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: new URL('publication-review-desktop.png', qaDir).pathname, fullPage: true });
  await page.click('[data-approve-publication]');
  assert.equal(await page.$eval('[data-publish-now]', el => el.disabled), false);
  const activeBefore = s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  assert.equal((await s.call('/api/admin/product-toggle', { sku: PRODUCT.sku, active: 0, base_revision: s.revision() })).status, 200);
  await page.evaluate(() => publishNow());
  assert.equal(s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id, activeBefore);
  assert.match(await page.$eval('[data-publication-message]', el => el.textContent), /重新预览核对/);
  await page.evaluate(() => previewRelease());
  await page.click('[data-approve-publication]');
  losePublicationResponse = true;
  await page.evaluate(() => publishNow());
  assert.match(await page.$eval('[data-publication-message]', el => el.textContent), /已重新读取确认/);
  assert.notEqual(s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id, activeBefore);
  const publishedCount = s.DB.query('SELECT COUNT(*) n FROM public_content_releases')[0].n;
  await page.evaluate(() => publishNow());
  assert.equal(s.DB.query('SELECT COUNT(*) n FROM public_content_releases')[0].n, publishedCount, 'lost response is read back, never blindly retried');

  const postersRead = (await s.call('/api/admin/posters')).body;
  assert.equal((await s.call('/api/admin/posters', { base_revision: postersRead.draft_revision, collection_revision: postersRead.collection_revision,
    posters: [{ id: 'future-ui', title_cn: '未来预览UI唯一海报', action_type: 'none', starts: '2099-01-01', ends: '2099-01-01' }] })).status, 200);
  await page.$eval('[data-effective-at]', el => { el.value = '2099-01-01T10:00'; el.dispatchEvent(new Event('change')); });
  await page.evaluate(() => previewRelease());
  const futurePreview = await page.evaluate(async () => (await fetch(document.querySelector('[data-reviewed-preview]').href)).text());
  assert.ok(futurePreview.includes('未来预览UI唯一海报'), 'UI requests a signed preview for the exact reviewed future date');
  await page.click('[data-approve-publication]');
  assert.equal(await page.$eval('[data-schedule-release]', el => el.disabled), false);
  assert.equal(await page.$eval('[data-publish-now]', el => el.disabled), true);
  await page.$eval('[data-effective-at]', el => { el.value = '2099-01-02T10:00'; el.dispatchEvent(new Event('change')); });
  assert.equal(await page.$eval('[data-schedule-release]', el => el.disabled), true, 'changing the date requires reviewing that date again');
  await page.evaluate(() => previewRelease());
  const nextDayPreview = await page.evaluate(async () => (await fetch(document.querySelector('[data-reviewed-preview]').href)).text());
  assert.ok(!nextDayPreview.includes('未来预览UI唯一海报'), 'changing the date changes the preview and approved snapshot together');
  await page.click('[data-approve-publication]');
  await page.evaluate(() => scheduleRelease());
  assert.match(await page.$eval('[data-publication-message]', el => el.textContent), /已排程/);
  await page.evaluate(() => cancelRelease(document.querySelector('[data-cancel-release]').dataset.cancelRelease));
  const currentId = s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  assert.equal(await page.$(`[data-rollback-release="${currentId}"]`), null, 'current release is not offered as a rollback target');
  assert.ok(await page.$(`[data-rollback-release="${activeBefore}"]`), 'actual superseded release is selectable');
  let competingId;
  s.DB.beforeBatch(/INSERT INTO public_content_releases/, async () => {
    const reviewed = (await s.call('/api/admin/publication/draft-snapshot')).body;
    const result = await s.call('/api/admin/publication/publish-exact', { expected_active_release_id: reviewed.active.release_id,
      expected_draft_checksum: reviewed.draft.checksum, base_revision: reviewed.draft_revision });
    assert.equal(result.status, 200); competingId = result.body.release_id;
  });
  await page.evaluate(id => rollbackRelease(id), activeBefore);
  assert.equal(s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id, competingId, 'rollback refuses a later active release');
  loseRollbackResponse = true;
  await page.evaluate(id => rollbackRelease(id), activeBefore);
  const restoredId = s.DB.query('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  assert.notEqual(restoredId, competingId);
  const source = s.DB.query('SELECT checksum,snapshot_json FROM public_content_releases WHERE id=?', activeBefore)[0];
  const restored = s.DB.query('SELECT checksum,snapshot_json FROM public_content_releases WHERE id=?', restoredId)[0];
  assert.deepEqual(restored, source);
  assert.match(await page.$eval('[data-publication-message]', el => el.textContent), /已重新读取确认/);
});
