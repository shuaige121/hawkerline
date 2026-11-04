// 公开路由的缓存优先与私有面保护。
// 核心不变量：暖缓存命中【绝对不碰 D1】——所以这里的 env.DB 是个一碰就抛的 Proxy。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  servePublicPage, servePublicMedia, publicCacheKey,
  classifyPublicPath, isAuthenticatedPublicRequest, privateResponse,
} from '../worker/public-cache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { waitUntil(p) { return p; } };
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngBytes = (fill = 3) => new Uint8Array(Buffer.concat([PNG_SIG, Buffer.alloc(32, fill)]));
const sha256Hex = async bytes => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
};

// 记录被查询的表名，用来证明「只读了不可变发布表」。
function fakeDb(rows) {
  const seen = [];
  return {
    seen,
    DB: {
      prepare(sql) {
        seen.push(sql);
        const node = {
          bind: (...args) => ({ first: async () => rows(sql, args), all: async () => ({ results: [] }) }),
          first: async () => rows(sql, []),
          all: async () => ({ results: [] }),
        };
        return node;
      },
    },
  };
}
const missingCache = { match: async () => undefined, put: async () => {} };

// 活动指针存在、没有到期待发布 —— ensureActiveRelease 会先查后者。
const pointerRows = sql => {
  if (sql.includes("status='scheduled'")) return null;
  if (sql.includes('active_release_id') && !sql.includes('pages')) return { active_release_id: 'rel-1', draft_revision: 'rev-1' };
  return { body: 'ok', content_type: 'text/html; charset=utf-8', etag: '"e"', release_id: 'rel-1' };
};

test('friendly route cache hit performs zero D1 operations', async () => {
  let dbCalls=0;
  const env={DB:new Proxy({}, {get(){dbCalls++; throw new Error('D1 accessed on cache hit')}})};
  const cached=new Response('<!doctype html><h1>鲜肉包</h1>',{headers:{'content-type':'text/html'}});
  const cache={match:async()=>cached,put:async()=>assert.fail('cache put on hit')};
  const response=await servePublicPage(new Request('https://shop.example/menu'),env,{waitUntil(){}},{cache});
  assert.equal(await response.text(), '<!doctype html><h1>鲜肉包</h1>');
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'public, max-age=60');
  assert.equal(dbCalls,0);
});

test('a cache miss reads only the pointer and immutable release pages', async () => {
  const fake = fakeDb(sql => sql.includes("status='scheduled'") ? null
    : sql.includes('active_release_id') && !sql.includes('pages') ? { active_release_id: 'rel-1', draft_revision: 'rev-1' }
    : { body: '<h1>menu</h1>', content_type: 'text/html; charset=utf-8', etag: '"e"', release_id: 'rel-1' });
  const puts = [];
  const cache = { match: async () => undefined, put: async (k, v) => puts.push([k, v]) };
  const response = await servePublicPage(new Request('https://shop.example/menu'), { DB: fake.DB }, ctx, { cache });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'public, max-age=60');
  assert.equal(response.headers.get('x-public-release'), 'rel-1');
  const touched = fake.seen.join(' ');
  assert.doesNotMatch(touched, /\bFROM products\b|app_settings|homepage_posters/, '缓存未命中也不得读草稿表');
  assert.match(touched, /public_content_release_pages/);
  assert.equal(puts.length, 1, '未认证的未命中应回填缓存');
  assert.equal(puts[0][1].headers.get('cache-control'), 'public, max-age=60', 'Cache API 副本必须可缓存');
  assert.equal(puts[0][1].headers.get('cloudflare-cdn-cache-control'), 'public, max-age=60');
});

test('a versioned catalog is immutable and never resolves the active pointer', async () => {
  const fake = fakeDb(() => ({ body: '{"release_id":"rel-9"}', content_type: 'application/json; charset=utf-8',
    etag: '"v"', release_id: 'rel-9' }));
  const response = await servePublicPage(
    new Request('https://shop.example/public/releases/rel-9/catalog.json'), { DB: fake.DB }, ctx, { cache: missingCache });
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), null);
  assert.doesNotMatch(fake.seen.join(' '), /public_content_state/, '版本化目录不得解析活动指针');
});

test('the cache key drops the query string and the trailing slash', () => {
  const key = publicCacheKey(new Request('https://www.shop.example/menu/?utm_source=x&a=1'));
  assert.equal(key.url, 'https://shop.example/menu');
  assert.equal(publicCacheKey(new Request('https://shop.example/?x=1')).url, 'https://shop.example/');
});

test('authenticated requests get private headers and never populate the cache', async () => {
  const cached = new Response('<h1>hi</h1>', { headers: { 'content-type': 'text/html' } });
  let dbCalls = 0;
  const throwingEnv = { DB: new Proxy({}, { get() { dbCalls++; throw new Error('D1 on authed hit'); } }) };
  const hit = await servePublicPage(new Request('https://shop.example/menu', { headers: { cookie: 's=1' } }),
    throwingEnv, ctx, { cache: { match: async () => cached, put: async () => assert.fail('put on hit') } });
  assert.equal(hit.headers.get('cache-control'), 'private, no-store');
  assert.equal(hit.headers.get('cloudflare-cdn-cache-control'), null);
  assert.equal(hit.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(dbCalls, 0, '认证请求的缓存命中同样不得碰 D1');

  // 之前这里用 assert.fail 当探针 —— 但它会被实现里的 .catch 吞掉，
  // 于是「把 cache.put 挪到认证判断之前」这个回归永远不会让测试变红。
  // 改成记录 + 等 waitUntil 落地后再断言。
  const fake = fakeDb(pointerRows);
  const puts = [];
  const waits = [];
  const recordingCtx = { waitUntil(p) { waits.push(p); return p; } };
  const miss = await servePublicPage(new Request('https://shop.example/menu', { headers: { authorization: 'Bearer t' } }),
    { DB: fake.DB }, recordingCtx, { cache: { match: async () => undefined, put: async (...args) => { puts.push(args); } } });
  assert.equal(miss.headers.get('cache-control'), 'private, no-store');
  assert.equal(miss.headers.get('cloudflare-cdn-cache-control'), null);
  await Promise.all(waits);
  assert.equal(puts.length, 0, '认证请求的未命中绝不能写进共享缓存');

  // 媒体路径同样验一遍
  const mediaBytes = pngBytes(6);
  const mediaHash = await sha256Hex(mediaBytes);
  const mediaPuts = [];
  const mediaWaits = [];
  const mediaEnv = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ content_type: 'image/png', body: mediaBytes, byte_length: mediaBytes.byteLength }) }) }) } };
  const mediaMiss = await servePublicMedia(new Request(`https://shop.example/public/media/${mediaHash}`, { headers: { cookie: 'a=1' } }),
    mediaEnv, { waitUntil(p) { mediaWaits.push(p); return p; } },
    { cache: { match: async () => undefined, put: async (...args) => { mediaPuts.push(args); } } });
  assert.equal(mediaMiss.headers.get('cache-control'), 'private, no-store');
  await Promise.all(mediaWaits);
  assert.equal(mediaPuts.length, 0, '认证请求的媒体未命中也不能写进共享缓存');
});

test('a cache read failure falls through to D1 and a write failure still serves', async () => {
  const rows = pointerRows;
  for (const broken of [
    { match: () => { throw new Error('sync read boom'); }, put: async () => {} },
    { match: async () => { throw new Error('async read boom'); }, put: async () => {} },
  ]) {
    const response = await servePublicPage(new Request('https://shop.example/menu'), { DB: fakeDb(rows).DB }, ctx, { cache: broken });
    assert.equal(await response.text(), 'ok');
  }
  for (const broken of [
    { match: async () => undefined, put: () => { throw new Error('sync put boom'); } },
    { match: async () => undefined, put: async () => { throw new Error('async put boom'); } },
  ]) {
    const response = await servePublicPage(new Request('https://shop.example/menu'), { DB: fakeDb(rows).DB }, ctx, { cache: broken });
    assert.equal(await response.text(), 'ok');
  }
});

test('media is content-verified before it is ever served', async () => {
  const bytes = pngBytes(9);
  const hash = await sha256Hex(bytes);
  const good = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ content_type: 'image/png', body: bytes, byte_length: bytes.byteLength }) }) }) } };
  const response = await servePublicMedia(new Request(`https://shop.example/public/media/${hash}`), good, ctx, { cache: missingCache });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('etag'), `"${hash}"`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);

  const cases = {
    'missing row': null,
    'byte length mismatch': { content_type: 'image/png', body: bytes, byte_length: bytes.byteLength + 1 },
    'MIME signature mismatch': { content_type: 'image/jpeg', body: bytes, byte_length: bytes.byteLength },
    'unsupported MIME': { content_type: 'image/gif', body: bytes, byte_length: bytes.byteLength },
    'wrong bytes for hash': { content_type: 'image/png', body: pngBytes(11), byte_length: 40 },
  };
  for (const [name, row] of Object.entries(cases)) {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } };
    const bad = await servePublicMedia(new Request(`https://shop.example/public/media/${hash}`), env, ctx, { cache: missingCache });
    assert.equal(bad.status, 404, name);
    assert.equal(bad.headers.get('cache-control'), 'private, no-store', name);
  }
  assert.equal(await servePublicMedia(new Request('https://shop.example/public/media/not-a-hash'), good, ctx, { cache: missingCache }), null);
});

test('production D1 BLOB return shapes normalize to the same verified bytes', async () => {
  const bytes = pngBytes(17);
  const hash = await sha256Hex(bytes);
  const padded = new Uint8Array(bytes.byteLength + 6);
  padded.set(bytes, 3);
  const shapes = {
    ArrayBuffer: bytes.slice().buffer,
    Uint8Array: bytes.slice(),
    ArrayBufferView: new DataView(padded.buffer, 3, bytes.byteLength),
    'plain number[]': [...bytes],
  };
  for (const [name, body] of Object.entries(shapes)) {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({
      content_type: 'image/png', body, byte_length: bytes.byteLength,
    }) }) }) } };
    const response = await servePublicMedia(
      new Request(`https://shop.example/public/media/${hash}`), env, ctx, { cache: missingCache });
    assert.equal(response.status, 200, name);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes, name);
  }
});

test('a warm media hit performs zero D1 operations and honours authentication', async () => {
  const bytes = pngBytes(4);
  const hash = await sha256Hex(bytes);
  let dbCalls = 0;
  const env = { DB: new Proxy({}, { get() { dbCalls++; throw new Error('D1 on media hit'); } }) };
  const cached = new Response(bytes, { headers: { 'content-type': 'image/png' } });
  const cache = { match: async () => cached.clone(), put: async () => assert.fail('put on hit') };
  const anon = await servePublicMedia(new Request(`https://shop.example/public/media/${hash}`), env, ctx, { cache });
  assert.equal(anon.headers.get('cache-control'), null);
  const authed = await servePublicMedia(new Request(`https://shop.example/public/media/${hash}`, { headers: { cookie: 'a=1' } }), env, ctx, { cache });
  assert.equal(authed.headers.get('cache-control'), 'private, no-store');
  assert.equal(dbCalls, 0);

  // 写缓存失败不得影响响应
  const good = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ content_type: 'image/png', body: bytes, byte_length: bytes.byteLength }) }) }) } };
  for (const put of [() => { throw new Error('sync'); }, async () => { throw new Error('async'); }]) {
    const response = await servePublicMedia(new Request(`https://shop.example/public/media/${hash}`), good, ctx, { cache: { match: async () => undefined, put } });
    assert.equal(response.status, 200);
  }
});

test('public path classification covers exactly the crawlable surface', () => {
  for (const ok of ['https://shop.example/', 'https://shop.example/menu', 'https://shop.example/menu/s01',
    'https://shop.example/locations', 'https://shop.example/offers', 'https://shop.example/public/catalog.json',
    'https://shop.example/public/releases/rel-1/catalog.json', 'https://shop.example/sitemap.xml', 'https://shop.example/robots.txt']) {
    assert.equal(classifyPublicPath(ok), true, ok);
  }
  for (const no of ['https://shop.example/admin', 'https://shop.example/pos', 'https://shop.example/api/menu',
    'https://shop.example/invoice/abc', 'https://shop.example/kitchen', 'https://shop.example/public/media/'+'a'.repeat(64)]) {
    assert.equal(classifyPublicPath(no), false, no);
  }
  assert.equal(isAuthenticatedPublicRequest(new Request('https://shop.example/', { headers: { cookie: 'x' } })), true);
  assert.equal(isAuthenticatedPublicRequest(new Request('https://shop.example/')), false);
  assert.equal(privateResponse(new Response('x')).headers.get('cache-control'), 'private, no-store');
});

test('the www redirect and public routing run before any D1 access in worker/index.js', () => {
  const source = readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8');
  const fetchStart = source.indexOf('async fetch(');
  const redirect = source.indexOf("url.hostname === 'www.' + apex", fetchStart);
  const publicRoute = source.indexOf('classifyPublicPath', fetchStart);
  const firstDb = source.indexOf('env.DB', fetchStart);
  assert.ok(redirect > 0, 'fetch() 里必须有 www 重定向');
  assert.ok(publicRoute > 0, 'fetch() 里必须有公开路由分类');
  assert.ok(redirect < firstDb, 'www 重定向必须在任何 env.DB 访问之前');
  assert.ok(publicRoute < firstDb, '公开路由必须在任何 env.DB 访问之前');
});

test('the /api/menu compatibility projection reads one immutable release query', async () => {
  const { activeReleaseMenuProjection } = await import('../worker/public-cache.js');
  const seen = [];
  const env = { DB: { prepare(sql) { seen.push(sql); return { all: async () => ({ results: [
    { release_id: 'rel-7', sku: 'S01', name_cn: '鲜肉包', name_en: 'Pork Bun', price_cents: 360,
      category: 'protein', kcal: 260, image_url: '/public/media/' + 'a'.repeat(64),
      description_cn: '每日现包', description_en: 'Fresh', detail_cn: '肉汁', detail_en: 'Juicy',
      tags_json: '[{"id":"fresh-meat","label_cn":"纯鲜肉","tone":"red"}]' },
  ] }) }; } } };
  const projection = await activeReleaseMenuProjection(env);
  assert.equal(seen.length, 1, '兼容投影必须只用一条查询');
  assert.doesNotMatch(seen[0], /\bFROM products\b/, '绝不能读草稿 products 表');
  assert.match(seen[0], /public_content_release_products/);
  assert.equal(projection.release_id, 'rel-7');
  assert.equal(projection.menu_revision, 'rel-7');
  const [product] = projection.products;
  for (const field of ['sku','name_cn','name_en','price','img','category','kcal','description_cn','detail_cn']) {
    assert.ok(field in product, `旧字段 ${field} 必须保留`);
  }
  assert.equal(product.price, 3.6);
  assert.equal(product.price_cents, 360);
  assert.deepEqual(product.tags, [{ id: 'fresh-meat', label_cn: '纯鲜肉', tone: 'red' }]);
  assert.doesNotMatch(JSON.stringify(projection), /data:image/);
});

// ── 源码级不变量 ───────────────────────────────────────────────────────────
// 这几条只有真浏览器测试能动态验证，但浏览器套件不在 `node --test` 里，
// 变异测试也就撞不到它们。做成可执行断言，变异一旦恢复这些坏行为就会红。
test('the storefront never fetches fixed content on boot', () => {
  const storefront = readFileSync(path.join(ROOT, 'web', 'storefront.js'), 'utf8');
  for (const forbidden of ['/api/menu', '/api/config', '/api/posters', '/api/delivery-config', '/api/topup-tiers']) {
    for (const q of ["'", '"', '`']) {
      assert.ok(!storefront.includes('fetch(' + q + forbidden),
        'storefront.js 不得请求固定内容接口 ' + forbidden);
    }
  }
  assert.match(storefront, /hl-public-data/, '店面必须从页面自带的发布数据注水');
});

test('store-status is only called at the three named moments', () => {
  const storefront = readFileSync(path.join(ROOT, 'web', 'storefront.js'), 'utf8');
  const fetches = storefront.match(/fetch\(\s*['"`]\/api\/store-status/g) || [];
  assert.equal(fetches.length, 1, '只允许在 refreshStoreStatus() 里有一处请求');
  const callSites = storefront.match(/refreshStoreStatus\(\)/g) || [];
  // 定义 1 处 + window 挂载 0 处 + 三个调用点（visibilitychange / 打开结账 / 首次提交前）
  assert.ok(callSites.length >= 3 && callSites.length <= 5, `调用点数量异常：${callSites.length}`);
  assert.match(storefront, /visibilitychange/, '结账可见性恢复必须重新确认');
  assert.match(storefront, /_orderAttempted/, '重试不得再做停业预检，必须让服务端去重先跑');
});

test('order pricing is validated before the first write', () => {
  const worker = readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8');
  const orderRoute = worker.indexOf("pathname === '/api/order' && req.method === 'POST'");
  assert.ok(orderRoute > 0);
  const quote = worker.indexOf('quoteActiveReleaseItems(env', orderRoute);
  const insert = worker.indexOf('INSERT INTO orders', orderRoute);
  const promo = worker.indexOf('claimPromoUse', orderRoute);
  assert.ok(quote > 0 && insert > 0, '下单路由必须同时有发布定价与订单写入');
  assert.ok(quote < insert, '发布定价必须早于订单写入');
  if (promo > 0) assert.ok(quote < promo, '发布定价必须早于占用优惠码');
  assert.match(worker, /menu_revision/, '订单必须记录被接受的发布版本');

  // 客户端必须把「这车是哪个发布加出来的」一起送上来，否则服务端无从判断菜单是否已变
  const storefront = readFileSync(path.join(ROOT, 'web', 'storefront.js'), 'utf8');
  assert.match(storefront, /menu_revision:\s*acceptedRevisionForCart\(\) \|\| _cartRevision \|\| window\.HL_MENU_REVISION/,
    '下单载荷必须带上 menu_revision');
  const pos = readFileSync(path.join(ROOT, 'web', 'pos.html'), 'utf8');
  assert.match(pos, /menu_revision:/, 'POS 收款也必须带上发布版本');
});
