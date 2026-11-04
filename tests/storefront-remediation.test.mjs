// V07 分类锚点 + V08 失效商品地址：渲染器与 Worker 真路由。
// 浏览器里的点击回归在 tools/ui-smoke.mjs（真 Chrome，对着本地 wrangler dev）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import * as publicRender from '../worker/public-render.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('V07: /menu raw HTML gives every category section a stable anchor id', async () => {
  const release = JSON.parse(fixture('storefront-ux-release.json'));
  const menu = (await publicRender.renderPublicReleasePages(release)).find(p => p.path === '/menu').body;
  const tags = menu.match(/<section class="menu-section"[^>]*>/g) || [];
  for (const category of new Set(release.products.filter(p => p.active).map(p => p.category))) {
    assert.ok(tags.some(tag => tag.includes(`id="cat-${category}"`) && tag.includes(`data-category="${category}"`)), category);
  }
});

test('V08: missing-product page is neutral, bilingual, responsive, and claims nothing about the product', () => {
  assert.equal(typeof publicRender.renderMissingProductPage, 'function', 'worker/public-render.js must export renderMissingProductPage');
  const html = publicRender.renderMissingProductPage();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<meta name="robots" content="noindex/);
  // 这一页不读快照，所以不写任何店名，只用中性标志
  assert.match(html, /\/img\/logo\.svg/);
  assert.match(html, /<a[^>]*href="\/menu"[^>]*>[^<]*返回菜单/); assert.match(html, /Back to menu/);
  // 失效地址（例如尚未发布的 /menu/mb5）不能暗示商品存在、即将上架或售罄
  assert.doesNotMatch(html, /售罄|即将上架|敬请期待|coming soon|sold out|data-add-sku|hl-public-data|storefront\.js/i);
});

// 活动指针存在；页面表里有没有这个 path 由 pageFor 决定。
function fakeDb(pageFor) {
  return {
    prepare(sql) {
      const rows = args => sql.includes("status='scheduled'") ? null
        : sql.includes('public_content_release_pages') ? pageFor(args[args.length - 1])
        : sql.includes('active_release_id') ? { active_release_id: 'rel-1', draft_revision: 'rev-1' } : null;
      return {
        bind: (...args) => ({ first: async () => rows(args), all: async () => ({ results: [] }) }),
        first: async () => rows([]), all: async () => ({ results: [] }),
      };
    },
  };
}
const puts = [];
globalThis.caches = { default: { match: async () => undefined, put: async key => { puts.push(new URL(key.url).pathname); } } };

test('V08: an unknown /menu/<slug> keeps HTTP 404 but returns the branded recovery page', async () => {
  for (const pathname of ['/menu/mb5', '/menu/mb5/']) {
    const res = await worker.fetch(new Request(`https://shop.example${pathname}`), { DB: fakeDb(() => null) }, { waitUntil() {} });
    assert.equal(res.status, 404, pathname);
    assert.match(res.headers.get('content-type') || '', /^text\/html/, pathname);
    assert.equal(res.headers.get('cache-control'), 'private, no-store', pathname);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, pathname);
    const body = await res.text();
    assert.match(body, /<a[^>]*href="\/menu"/, pathname);
    assert.match(body, /返回菜单/, pathname); assert.match(body, /Back to menu/, pathname);
  }
  assert.deepEqual(puts, [], 'a missing product page must never be written to the shared cache');
});

test('V08: a product that IS in the active release is still served from the release', async () => {
  const page = { body: '<h1>鲜肉包</h1>', content_type: 'text/html; charset=utf-8', etag: '"e"', release_id: 'rel-1' };
  const res = await worker.fetch(new Request('https://shop.example/menu/s01'),
    { DB: fakeDb(path => path === '/menu/s01' ? page : null) }, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>鲜肉包</h1>');
});
