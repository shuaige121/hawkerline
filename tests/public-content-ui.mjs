// 公开内容发布的真浏览器验收。
//
//     node tests/public-content-ui.mjs            # 无头
//     node tests/public-content-ui.mjs --headed   # 看着它点
//
// 核心断言：正常浏览（首页 / 商品详情 / 自取点 / 加购物车）对固定内容接口
// 【零请求】；标签、发布价来自页面自带的发布数据；/api/store-status 只在
// ①打开结账 ②结账可见性恢复 ③首次提交前 这三个时刻出现。

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8803;
const BASE = `https://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const CHROME = findChrome();
const persist = mkdtempSync(path.join(tmpdir(), 'hl-pub-ui-'));
let child = null, browser = null;
let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name, extra ? `:: ${extra}` : ''); }
  else { fails.push(name); console.log('  ❌', name, extra ? `:: ${extra}` : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d1 = sql => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = sql => JSON.parse(d1(sql))[0].results;

const FORBIDDEN = /\/api\/(?:menu|config|posters|delivery-config|store-status|quote|promo\/check|topup-tiers)(?:\?|$)/;

function seed() {
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  // 全天营业：避免营业时段把结账流程挡掉，让断言只测发布/网络行为
  const hours = JSON.stringify({ 0:['00:00','23:59'],1:['00:00','23:59'],2:['00:00','23:59'],
    3:['00:00','23:59'],4:['00:00','23:59'],5:['00:00','23:59'],6:['00:00','23:59'] }).replace(/'/g, "''");
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('business_hours','${hours}',datetime('now'))
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
  // 给 S01 挂一个标签，验证标签随发布进入原始 HTML
  d1(`INSERT OR IGNORE INTO product_tag_assignments (sku,tag_id,sort) VALUES ('S01','fresh-meat',1)`);
}

// 直接打 API 下一单，返回 total（失败返回 null）
async function postOrder(menuRevision, clientToken, attempt = 0) {
  let r;
  try {
    r = await fetch(`${BASE}/api/order`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_name: '费率验收', phone: '98765432', fulfilment: 'pickup',
      pickup_point_id: 'main', items: [{ sku: 'S01', qty: 1 }],
      menu_revision: menuRevision, client_token: clientToken,
    }),
    });
  } catch (e) {
    // 同一个 client_token 重试是安全的：服务端按它去重
    if (attempt < 2) { await sleep(1200); return postOrder(menuRevision, clientToken, attempt + 1); }
    console.log('     · 下单请求失败：', e.message); return null;
  }
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { console.log('     · 下单未成功：', r.status, JSON.stringify(d).slice(0, 160)); return null; }
  return d.total;
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/robots.txt`); if (r.status) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}

async function up() {
  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist, '--port', String(PORT),
    '--local-protocol', 'https', '--test-scheduled'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(persist, 'wrangler.log'), { flags: 'a' });
  log.on('error', () => {});
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  if (!await waitUp()) throw new Error(`wrangler dev 没起来，日志见 ${path.join(persist, 'wrangler.log')}`);
}

async function main() {
  seed();
  await up();

  // 一分钟 Cron 做首次 bootstrap（唯一允许创建第一个发布的路径）
  const scheduled = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  ok('cron 触发 bootstrap 返回 200', scheduled.status === 200, `status=${scheduled.status}`);
  for (let i = 0; i < 20 && !rows('SELECT active_release_id FROM public_content_state')[0].active_release_id; i++) await sleep(500);
  const releaseId = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  ok('bootstrap 建立了活动发布', !!releaseId, String(releaseId));

  browser = await puppeteer.launch({ executablePath: CHROME, headless: !HEADED,
    args: ['--ignore-certificate-errors', '--no-sandbox'] });
  const page = await browser.newPage();
  const forbidden = [];
  const storeStatus = [];
  page.on('request', req => {
    const p = new URL(req.url()).pathname + (new URL(req.url()).search || '');
    if (/\/api\/store-status/.test(p)) { storeStatus.push(p); return; }
    if (FORBIDDEN.test(p)) forbidden.push(req.url());
  });

  // 爬虫看到的是【裸 HTTP 响应】，不是注水后的 DOM —— 所以这三条用 fetch 断言。
  const rawHome = await (await fetch(`${BASE}/`)).text();
  ok('原始 HTML 含商品名（无需执行 JS）', rawHome.includes('鲜肉包'));
  ok('原始 HTML 含发布价', rawHome.includes('S$3.60'), rawHome.match(/S\$\d+\.\d{2}/)?.[0] || 'no price found');
  ok('原始 HTML 含标签', rawHome.includes('纯鲜肉'));
  ok('原始 HTML 不含 data URI', !rawHome.includes('data:image'));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  ok('首页 data-public-release 是当前发布', await page.$eval('html', el => el.dataset.publicRelease) === releaseId);

  await page.click('[data-add-sku="S01"], .add[data-sku="S01"], [data-sku="S01"] button').catch(() => {});
  await sleep(400);
  await page.goto(`${BASE}/menu/s01`, { waitUntil: 'networkidle0' });
  ok('商品详情页保留服务端渲染内容', (await page.content()).includes('鲜肉包'));
  await page.goto(`${BASE}/locations`, { waitUntil: 'networkidle0' });
  await page.goto(`${BASE}/offers`, { waitUntil: 'networkidle0' });
  ok('正常浏览对固定内容接口零请求', forbidden.length === 0, forbidden.join(', '));
  ok('正常浏览不调用 store-status', storeStatus.length === 0, storeStatus.join(', '));

  // 打开结账 → 恰好一次 store-status
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { document.querySelector('[data-add-sku], .grid button')?.click(); });
  await sleep(300);
  await page.evaluate(() => document.getElementById('checkout')?.click());
  await sleep(800);
  ok('打开结账恰好触发一次 store-status', storeStatus.length === 1, `count=${storeStatus.length}`);

  // 结账开着时页面重新可见 → 再确认一次
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(600);
  ok('结账可见性恢复再确认一次', storeStatus.length === 2, `count=${storeStatus.length}`);

  ok('浏览全程仍无固定内容请求', forbidden.length === 0, forbidden.join(', '));

  // ── 多视口视觉 + 布局 + 可访问性验收 ────────────────────────────────────
  const shots = path.join(ROOT, '_qa', 'public-content');
  mkdirSync(shots, { recursive: true });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const failedRequests = [];
  page.on('requestfailed', r => { if (new URL(r.url()).host === new URL(BASE).host) failedRequests.push(r.url()); });

  const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'narrow', width: 1000, height: 900 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
  ];
  const PAGES = [['home', '/'], ['menu', '/menu'], ['product', '/menu/s01'], ['locations', '/locations'], ['offers', '/offers']];

  for (const viewport of VIEWPORTS) {
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    for (const [label, route] of PAGES) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle0' });
      await sleep(250);
      await page.screenshot({ path: path.join(shots, `${label}-${viewport.name}.png`), fullPage: true });
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      ok(`${label}/${viewport.name} 不横向溢出`, noOverflow);
      const touchOk = await page.evaluate(() => [...document.querySelectorAll('button,a')].every(el => {
        const r = el.getBoundingClientRect();
        return r.width === 0 || r.height === 0 || (r.width >= 24 && r.height >= 24);
      }));
      ok(`${label}/${viewport.name} 可点元素不小于 24px`, touchOk);
    }
  }

  // 语义与可访问性（在 mobile 视口下查一次就够，结构与视口无关）
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  for (const [label, route] of PAGES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle0' });
    const a11y = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => +h.tagName[1]);
      let hierarchical = true;
      for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i - 1] > 1) hierarchical = false;
      return {
        h1Count: document.querySelectorAll('h1').length,
        hierarchical,
        imagesWithoutAlt: [...document.querySelectorAll('img')].filter(img => !img.getAttribute('alt')).length,
        unlabelledControls: [...document.querySelectorAll('button')].filter(b =>
          !b.textContent.trim() && !b.getAttribute('aria-label')).length,
      };
    });
    ok(`${label} 恰好一个 h1`, a11y.h1Count === 1, `h1=${a11y.h1Count}`);
    ok(`${label} 标题层级不跳级`, a11y.hierarchical);
    ok(`${label} 图片都有 alt`, a11y.imagesWithoutAlt === 0, `缺 alt=${a11y.imagesWithoutAlt}`);
    ok(`${label} 按钮都有可读名字`, a11y.unlabelledControls === 0, `无名按钮=${a11y.unlabelledControls}`);
  }

  // 原始 HTML（未执行 JS）必须自带全部公开事实
  for (const [label, route, needles] of [
    ['菜单页', '/menu', ['鲜肉包', 'S$3.60', 'canonical']],
    ['商品页', '/menu/s01', ['鲜肉包', 'application/ld+json', 'canonical']],
    ['自取点页', '/locations', ['自取点 Pickup locations', 'canonical']],
    ['优惠页', '/offers', ['canonical']],
  ]) {
    const raw = await (await fetch(BASE + route)).text();
    const missing = needles.filter(n => !raw.includes(n));
    ok(`${label}原始 HTML 自带公开事实`, missing.length === 0, missing.join(', '));
    ok(`${label}带发布标记`, /data-public-release="[^"]+"/.test(raw));
  }

  // ── 私有面必须不可缓存、不可索引 ────────────────────────────────────────
  for (const [label, route] of [['未知发票', '/invoice/00000000-0000-4000-8000-000000000000'],
                                 ['后台', '/admin'], ['POS', '/pos'], ['厨房', '/kitchen']]) {
    const r = await fetch(BASE + route, { redirect: 'manual' });
    ok(`${label}页 no-store`, /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control') || '(none)');
    ok(`${label}页 noindex`, /noindex/.test(r.headers.get('x-robots-tag') || ''), r.headers.get('x-robots-tag') || '(none)');
  }

  // ── 钱：改了草稿但没发布，成交必须按【发布】的税率算 ──────────────────
  {
    const releaseId = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
    const beforeTotal = await postOrder(releaseId, 'hl-rate-before');
    ok('按发布税率成交（改动前）', beforeTotal !== null && Math.abs(beforeTotal - 3.6) < 0.005, String(beforeTotal));

    // 老板打开服务费 + GST，但【不发布】
    d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('service_charge_enabled','1',datetime('now'))
        ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
    d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('service_charge_rate','10',datetime('now'))
        ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
    d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('gst_registered','1',datetime('now'))
        ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
    d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('gst_rate','9',datetime('now'))
        ON CONFLICT(k) DO UPDATE SET v=excluded.v`);

    // 外部 wrangler d1 execute 会让 dev 里的本地实例重载，紧接着发请求会 ECONNRESET。
    // 等它重新起来再下单（ui-smoke 里同样的坑）。
    await waitUp();
    await sleep(800);
    const afterTotal = await postOrder(releaseId, 'hl-rate-after');
    ok('★ 草稿改了税率但没发布 → 仍按发布的税率收钱',
      afterTotal !== null && Math.abs(afterTotal - 3.6) < 0.005,
      `改动后收 ${afterTotal}（若是 4.31 就说明读了可变设置）`);
  }

  ok('全程无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  ok('无同源资源加载失败', failedRequests.length === 0, failedRequests.slice(0, 2).join(' | '));
  console.log('\n· 截图：' + shots);
}

main()
  .catch(e => { fails.push('运行时异常: ' + e.message); console.error(e); })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (child) child.kill('SIGTERM');
    await sleep(500);
    rmSync(persist, { recursive: true, force: true });
    console.log(`\n通过 ${pass}，失败 ${fails.length}`);
    if (fails.length) console.log('失败：', fails.join('、'));
    // wrangler 的本地代理和 puppeteer 的子进程会吊住事件循环：macOS 上碰巧退了，
    // Linux CI 上会一直挂到 job 超时 —— 一个 93/0 全绿的套件因此变成红叉。
    setTimeout(() => process.exit(fails.length ? 1 : 0), 500);
  });
