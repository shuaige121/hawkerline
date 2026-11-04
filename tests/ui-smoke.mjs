// 真浏览器 × 真 Worker 冒烟。
//
// 与 refund-e2e.mjs 的分工：那个用 fetch 验 API 契约与资金流；这个用真 Chrome 打真 wrangler dev，
// 验「老板/店员/顾客在屏幕上真的能走通」——各前端 agent 自测时用的是打桩后端，这一层才是合起来的证据。
//
//     node tests/ui-smoke.mjs            # 无头
//     node tests/ui-smoke.mjs --headed   # 看着它点

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';
import { signSession } from '../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8801;
const BASE = `https://127.0.0.1:${PORT}`;
const ADMIN = 'testadmin';
const AUTH_SECRET = 'ui-smoke-auth-secret';
const HEADED = process.argv.includes('--headed');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const CHROME = findChrome();   // 找不到就退 1，不再静默跳过（跳过 = 零断言假绿）

const persist = mkdtempSync(path.join(tmpdir(), 'hl-ui-'));
let child = null, browser = null;
let pass = 0; const fails = [];
const ok = (n, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', n, extra ? `:: ${extra}` : ''); }
  else { fails.push(n); console.log('  ❌', n, extra ? `:: ${extra}` : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d1 = sql => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = sql => JSON.parse(d1(sql))[0].results;

const OID = '11111111-2222-3333-4444-555555555555';
const TOMORROW_OID = '11111111-2222-3333-4444-666666666666';
const UID = 'user-ui-0001';
const ONLINE_UID = 'user-online-no-phone';
// 播种时刻必须跟着真实时钟走。写死日期会让厨房看板（只显示 SGT 当天）在第二天集体变红，
// 而更糟的是空看板会让「零 PII」「有推进按钮」这类断言假绿——什么都没渲染，自然也没有 PII。
const NOW = new Date().toISOString();
const SGT_TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const SGT_TOMORROW = new Date(Date.now() + 32 * 3600e3).toISOString().slice(0, 10);
const INV = 'HL-' + SGT_TODAY.replace(/-/g, '') + '-0007';
const INV_TOMORROW = 'HL-' + SGT_TODAY.replace(/-/g, '') + '-0008';

function seed() {
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('${UID}','91234567','陈美玲','${NOW}','${NOW}')`);
  d1(`INSERT INTO members (phone,user_id,balance,points,created_at,updated_at) VALUES ('91234567','${UID}',120,0,'${NOW}','${NOW}')`);
  // Real online-wallet shape: OAuth account can have no contact phone. The
  // backend must still identify the Stripe top-up by account/email and show the
  // actual post-credit balance in the boss audit page.
  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('${ONLINE_UID}',NULL,'线上会员','${NOW}','${NOW}')`);
  d1(`INSERT INTO auth_identities (provider,provider_sub,user_id,email,display_name,created_at,updated_at)
      VALUES ('google','online-no-phone','${ONLINE_UID}','paid200@example.com','线上会员','${NOW}','${NOW}')`);
  d1(`INSERT INTO members (phone,user_id,balance,points,created_at,updated_at)
      VALUES ('account:${ONLINE_UID}','${ONLINE_UID}',220,0,'${NOW}','${NOW}')`);
  d1(`INSERT INTO topups (id,phone,user_id,amount,bonus,credited,pay_method,pay_status,cashier,created_at,note,client_token)
      VALUES ('topup-online-200','','${ONLINE_UID}',200,20,220,'stripe','PAID','stripe','${NOW}','checkout.session.completed','ui-online-200')`);
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,pay_provider,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total,address)
      VALUES ('${OID}','${INV}','${NOW}','陈美玲','91234567','${UID}',
        '[{"sku":"S01","name":"鲜肉包","qty":2,"unit_price":5},{"sku":"C1","name":"均衡套餐","qty":1,"unit_price":20,"components":[{"sku":"S01","name":"鲜肉包","qty":1},{"sku":"S05","name":"炒酱肉包","qty":1},{"sku":"S06","name":"茄子包","qty":1},{"sku":"S07","name":"青菜香菇包","qty":1}]},{"sku":"BAD","name":"脏数据行","qty":1}]',50,8,58,'anytime','balance','PAID','${NOW}',58,'new',0,'Blk 123 Ang Mo Kio')`);
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const h = pbkdf2Sync('123456', Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
  d1(`INSERT INTO pos_pins (cashier,pin_hash,pin_salt,updated_at) VALUES ('pos1','${h}','${salt}','${NOW}')
      ON CONFLICT(cashier) DO UPDATE SET pin_hash=excluded.pin_hash,pin_salt=excluded.pin_salt`);
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES
      ('pickup_enabled','1','${NOW}'),
      ('shop_name','Example Food Court','${NOW}'),
      ('shop_address','Example Food Court #01-01, Singapore 100003','${NOW}'),
      ('SHOP_POSTAL','100003','${NOW}'),
      ('delivery_note','每日 16:00 截止次日预订。常规计划配送时间 12:00 - 19:00。当天急单请选【自费随时送】。','${NOW}'),
      ('pickup_points','[{"id":"riverside","active":true,"name":"Riverside Mall","name_en":"Riverside Mall","address":"1 Example Road, Singapore 100001","postal":"100001","detail":"Lobby pickup"},{"id":"garden-plaza","active":true,"name":"Garden Plaza","name_en":"Garden Plaza","address":"Garden Plaza Road, Singapore 100002","postal":"100002","detail":"Guardhouse pickup"}]','${NOW}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`);
}

async function waitUp(t = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { if ((await fetch(BASE + '/api/menu')).ok) return true; } catch (e) {}
    await sleep(700);
  }
  return false;
}

async function stopWorker() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch (e) {}
  await sleep(700);
  try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (e) {}
  child = null;
}

async function startWorker() {
  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist, '--port', String(PORT),
    '--local-protocol', 'https', '--test-scheduled',
    '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', `AUTH_SECRET:${AUTH_SECRET}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(persist, 'wrangler.log'), { flags:'a' });
  // stdout 和 stderr 都 pipe 到同一个流时，【谁先结束谁就把流 end() 掉】，
  // 另一个再写就是 ERR_STREAM_WRITE_AFTER_END，而且它以 unhandled 'error' 抛出 → 整个测试红。
  // macOS 上顺序碰巧良性，Linux CI 上翻车：一个只改了文档的 commit 也会红。
  // { end:false } 让两条流都不去 end 它；再兜一个 error handler，写日志失败绝不该弄红测试。
  log.on('error', () => {});
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  if (!await waitUp()) throw new Error('wrangler dev 没起来');
  // 定价只认【活动发布】。一分钟 Cron 是唯一被允许创建首个发布的路径，
  // dev 里没有真 cron，所以这里显式触发一次，否则下单会 503（部署后到首个
  // cron tick 之间线上也是这个窗口，Task 12 的部署闸门要等指针非空）。
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const r = rows('SELECT active_release_id FROM public_content_state');
    if (r[0] && r[0].active_release_id) return;
    await sleep(500);
  }
  throw new Error('bootstrap 发布没有建立，下单会 503');
}

// Direct SQL below changes a synthetic draft only. Restarting the Worker/cron
// preserves an existing publication, so each hours scenario must explicitly
// publish the reviewed snapshot before a customer can order against it.
async function publishFixtureDraft() {
  const headers = { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' };
  const read = await fetch(BASE + '/api/admin/publication/draft-snapshot', { headers });
  const review = await read.json();
  if (!read.ok || !review.ok) throw new Error('营业时间 fixture 读取草稿失败：' + (review.error || read.status));
  const response = await fetch(BASE + '/api/admin/publication/publish-exact', { method: 'POST', headers,
    body: JSON.stringify({ base_revision: review.draft_revision, expected_active_release_id: review.active.release_id,
      expected_draft_checksum: review.draft.checksum }) });
  const published = await response.json();
  if (!response.ok || !published.ok) throw new Error('营业时间 fixture 发布失败：' + (published.error || response.status));
  const verified = await (await fetch(BASE + '/api/admin/publication/draft-snapshot', { headers })).json();
  if (verified.active?.release_id !== published.release_id || verified.active?.checksum !== review.draft.checksum) {
    throw new Error('营业时间 fixture 未成为核对过的活动发布');
  }
  return published.release_id;
}

async function loadPublishedFixture(page, releaseId) {
  // Public HTML may retain the previous release in the 60-second edge cache.
  // A loaded document never updates itself: navigate again until the customer
  // actually receives this scenario's publication, rather than sleeping once.
  const deadline = Date.now() + 90000;
  let observed = '';
  while (Date.now() < deadline) {
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
    observed = await page.evaluate(() => window.HL_MENU_REVISION);
    if (observed === releaseId) return;
    await sleep(750);
  }
  throw new Error(`营业时间 fixture 页面版本未更新：expected=${releaseId}, observed=${observed}`);
}

async function main() {
  console.log('· 建库播种'); seed();
  console.log('· 启动 wrangler dev');
  await startWorker();
  console.log('· 就绪\n');

  browser = await puppeteer.launch({ executablePath: CHROME, headless: !HEADED,
    args: ['--ignore-certificate-errors', '--no-sandbox'] });

  // ── 老板后台：真的点一次退运费 ──────────────────────────────────────────
  console.log('【老板后台 · 真浏览器点退运费】');
  const admin = await browser.newPage();
  admin.on('dialog', async d => { await d.accept(); });          // alert/confirm 一律确认
  await admin.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
  await admin.evaluate((t) => { sessionStorage.setItem('hl_admin', t); }, ADMIN);   // 后台用 sessionStorage
  await admin.reload({ waitUntil: 'networkidle2' });
  await sleep(1500);

  const adminHtml = await admin.content();
  ok('后台页面真的渲染出订单', adminHtml.includes(INV));
  ok('订单行出现「退运费」按钮', /退运费/.test(adminHtml));
  ok('订单行显示厨房状态', /已下单|制作中|可取餐/.test(adminHtml));

  const balBefore = +rows(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;
  await waitUp(); await sleep(500); // external wrangler d1 can briefly reload local Miniflare
  const clicked = await admin.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /退运费/.test(x.textContent));
    if (!b) return false; b.click(); return true;
  });
  ok('点到了退运费按钮', clicked);
  await sleep(900);
  // 自绘二次确认层：找确认键
  const confirmed = await admin.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /确认退/.test(x.textContent));
    if (!b) return false; b.click(); return true;
  });
  ok('弹出了二次确认并点了确认', confirmed);
  await sleep(2500);

  const balAfter = +rows(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;
  const oAfter = rows(`SELECT pay_status,refunded_total FROM orders WHERE id='${OID}'`)[0];
  await waitUp(); await sleep(500);
  ok('★ 通过 UI 真的退了运费 8 元', Math.abs((balAfter - balBefore) - 8) < 0.005, `${balBefore} → ${balAfter}`);
  ok('★ 订单仍是 PAID（没被打成 REFUNDED）', oAfter.pay_status === 'PAID', oAfter.pay_status);
  ok('refunded_total = 8', Math.abs(+oAfter.refunded_total - 8) < 0.005);
  await admin.screenshot({ path: path.join(persist, 'admin.png'), fullPage: false });

  console.log('\n【老板后台 · 恢复功能入口】');
  await admin.evaluate(() => window.postersView());
  await admin.waitForFunction(() => /手机开屏|首页活动/.test(document.body.innerText));
  const posterAdminText = await admin.evaluate(() => document.body.innerText);
  const posterAdminValues = await admin.$$eval('.poster-admin-row input', inputs => inputs.map(x => x.value).join(' '));
  ok('后台能管理开屏 / 首页活动', /手机开屏|首页活动/.test(posterAdminText));
  ok('后台读到 NEW80 首单海报', /NEW80|首单立减/.test(posterAdminText + ' ' + posterAdminValues));
  await admin.screenshot({ path: path.join(persist, 'admin-posters.png'), fullPage: false });

  await admin.evaluate(() => window.topupView());
  await admin.waitForFunction(() => /这里才是全部充值记录/.test(document.body.innerText));
  const topupAdminText = await admin.evaluate(() => document.body.innerText);
  ok('充值页明确显示全部充值记录', /这里才是全部充值记录/.test(topupAdminText));
  ok('充值赠额档位仍可配置', /赠额档位|充多少送多少/.test(topupAdminText));
  ok('★ 没手机号的 S$200 线上充值按账号/email 显示', /paid200@example\.com/.test(topupAdminText) && /S\$200\.00/.test(topupAdminText));
  ok('★ 充值审计显示实际到账与当前余额 S$220', /S\$220\.00/.test(topupAdminText));
  await admin.screenshot({ path: path.join(persist, 'admin-topups.png'), fullPage: true });

  await admin.evaluate(() => window.settingsView());
  await admin.waitForFunction(() => /其他自取点/.test(document.body.innerText));
  const settingsText = await admin.evaluate(() => document.body.innerText);
  const pickupAdminValues = await admin.$$eval('.pickup-extra input', inputs => inputs.map(x => x.value).join(' '));
  ok('后台自取点编辑器已恢复', /其他自取点/.test(settingsText));
  ok('后台能读到额外自取点', /Riverside Mall/.test(pickupAdminValues) && /Garden Plaza/.test(pickupAdminValues));

  // ── 收银台 ────────────────────────────────────────────────────────────
  console.log('\n【收银台】');
  const pos = await browser.newPage();
  await pos.goto(BASE + '/pos', { waitUntil: 'networkidle2' });
  const posHtml = await pos.content();
  ok('收银台加载出登录界面', /收银|登录|PIN|密码/.test(posHtml));
  const posLogin = await pos.evaluate(async () => {
    const r = await fetch('/api/pos/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cashier: 'pos1', pin: '123456' }) });
    const d = await r.json();
    if (d.token) { sessionStorage.setItem('hl_staff', d.token); sessionStorage.setItem('hl_cashier', 'pos1'); }
    return !!d.token;
  });
  ok('收银员能登录', posLogin);
  await pos.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  const posHtml2 = await pos.content();
  ok('收银台出现「退运费」入口', /退运费/.test(posHtml2));
  ok('收银台充值入口还在', /充值/.test(posHtml2));
  await pos.screenshot({ path: path.join(persist, 'pos.png') });

  // ── 顾客端 ────────────────────────────────────────────────────────────
  console.log('\n【顾客端 · 制作进度深链】');
  const cust = await browser.newPage();
  await cust.setViewport({ width: 390, height: 800, isMobile: true });
  await cust.goto(`${BASE}/?order=${OID}`, { waitUntil: 'networkidle2' });
  const memberToken = await signSession({ AUTH_SECRET }, UID);
  await cust.evaluate(token => localStorage.setItem('hl_token', token), memberToken);
  await cust.reload({ waitUntil: 'networkidle2' });
  await sleep(2000);
  const cHtml = await cust.content();
  ok('★ 深链进来真的显示了制作进度卡', /制作进度|已下单|进度/.test(cHtml));
  ok('进度卡显示单号', cHtml.includes(INV));
  ok('菜单正常渲染（没被进度卡挤坏）', /鲜肉包|加入|菜单|S\$/.test(cHtml));
  ok('★ 首页活动海报已恢复', /NEW80|首单立减/.test(cHtml));
  ok('★ 首页会员储值入口已恢复', /会员储值|充值越多送越多/.test(cHtml));
  const memberButtonText = await cust.$eval('#memberBtn', el => el.innerText);
  ok('★ 登录后首页直接显示储值余额', /S\$\s*128\.00/.test(memberButtonText), memberButtonText);
  ok('★ 首页直接看得到 3 个取餐点', /可选取餐点/.test(cHtml) && /Riverside Mall/.test(cHtml) && /Garden Plaza/.test(cHtml));
  const promoSize = await cust.$eval('.sv-card', el => ({ height:Math.round(el.getBoundingClientRect().height), title:parseFloat(getComputedStyle(el.querySelector('.sv-title')).fontSize) }));
  ok('★ 储值入口是真正放大的大卡片', promoSize.height >= 260 && promoSize.title >= 22, `${promoSize.height}px / 标题 ${promoSize.title}px`);
  await cust.screenshot({ path: path.join(persist, 'customer.png') });
  await cust.screenshot({ path: path.join(persist, 'customer-home.png'), fullPage: true });

  await cust.$eval('.add', b => b.click());
  await cust.$eval('#checkout', b => b.click());
  await cust.waitForSelector('#sheet.show #pickupPoint');
  await cust.waitForFunction(() => /S\$\s*128\.00/.test(document.getElementById('useBalLabel')?.innerText || ''));
  const checkoutWallet = await cust.evaluate(() => ({
    visible: !!document.getElementById('useBal')?.offsetParent,
    checked: !!document.getElementById('useBal')?.checked,
    label: document.getElementById('useBalLabel')?.innerText || '',
    hiddenToggle: !!document.getElementById('moreToggle'),
  }));
  ok('★ 结账页不再隐藏余额', checkoutWallet.visible && !checkoutWallet.hiddenToggle, checkoutWallet.label);
  ok('★ 登录会员默认自动使用余额', checkoutWallet.checked, checkoutWallet.label);
  await cust.$eval('#useBal', el => el.click());
  const balanceAfterOptOut = await cust.$eval('#useBalLabel', el => el.innerText);
  ok('取消自动抵扣后余额仍然显示', /S\$\s*128\.00/.test(balanceAfterOptOut), balanceAfterOptOut);
  await cust.$eval('#useBal', el => el.click());
  const pickupOptions = await cust.$$eval('#pickupPoint option', options => options.map(x => ({ value:x.value, text:x.textContent })));
  ok('★ 结账显示 3 个自取点', pickupOptions.length === 3, pickupOptions.map(x => x.text).join(' / '));
  await cust.select('#pickupPoint', 'riverside');
  await sleep(300);
  const pickupInfo = await cust.$eval('#pickupInfo', el => el.innerText);
  ok('★ 切换自取点后显示对应地址', /Riverside Mall/.test(pickupInfo) && /100001/.test(pickupInfo));
  const pickupHasWrongMainPhoto = await cust.$eval('#pickupInfo', el => !!el.querySelector('img'));
  ok('额外自取点没配照片时不冒用主店照片', !pickupHasWrongMainPhoto);
  await cust.screenshot({ path: path.join(persist, 'customer-pickup.png'), fullPage: false });

  await cust.$eval('[name=ff][value=discount]', b => b.click());
  await cust.$eval('#postal', el => { el.value = '570001'; el.dispatchEvent(new Event('input', { bubbles:true })); });
  await cust.evaluate(() => lookupPostal());
  await cust.waitForFunction(() => /运费\s*S\$\s*10\.00/.test(document.getElementById('sheetSummary')?.innerText || ''));
  const deliverySummary = await cust.$eval('#sheetSummary', el => el.innerText);
  ok('★ 填邮编后结账明细显示真实运费 S$10', /运费\s*S\$\s*10\.00/.test(deliverySummary));
  const deliveryDateError = await cust.$eval('#dateMsg', el => el.innerText);
  ok('自动配送日期会跳过店休日', !/本店休息|closed that day/i.test(deliveryDateError));
  await cust.$eval('#sheetSummary', el => el.scrollIntoView({ block:'center' }));
  await cust.screenshot({ path: path.join(persist, 'customer-delivery.png'), fullPage: false });
  await cust.evaluate(() => hide());

  // 推进到 ready 后顾客端应变绿
  await cust.evaluate(() => localStorage.clear());
  d1(`UPDATE orders SET fulfil_status='ready' WHERE id='${OID}'`);
  await waitUp(); await sleep(500);
  await cust.goto(`${BASE}/?order=${OID}`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  const cHtml2 = await cust.content();
  ok('★ 状态推到 ready 后顾客端跟着变', /可取餐|已出餐|ready/i.test(cHtml2));
  await cust.screenshot({ path: path.join(persist, 'customer-ready.png') });

  // ── 厨房端 ────────────────────────────────────────────────────────────
  console.log('\n【厨房端 · 挂墙平板】');
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('KITCHEN_PASSWORD','kitchen123','${NOW}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
  d1(`UPDATE orders SET fulfil_status='new' WHERE id='${OID}'`);
  // 阴性对照：一张预约到明天的单。看板只该显示今天要做的，明天那张必须不出现。
  // 没有这条，一个「什么都不显示」的空看板会让下面的零 PII 断言假绿。
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,deliver_at,pay_provider,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total,address)
      VALUES ('${TOMORROW_OID}','${INV_TOMORROW}','${NOW}','明天自取的顾客','98761234','${UID}',
        '[{"sku":"S01","name":"明天才做的包","qty":3,"unit_price":5}]',15,0,15,'pickup','${SGT_TOMORROW}','balance','PAID','${NOW}',15,'new',0,'Example Food Court')
      ON CONFLICT(id) DO NOTHING`);
  await waitUp(); await sleep(500);
  const kit = await browser.newPage();
  kit.on('dialog', async d => { await d.accept(); });
  await kit.setViewport({ width: 1024, height: 768 });
  await kit.goto(BASE + '/kitchen', { waitUntil: 'networkidle2' });
  const kHtml0 = await kit.content();
  ok('厨房页加载出登录界面', /密码|登录|接单/.test(kHtml0));

  const kLogin = await kit.evaluate(async () => {
    const r = await fetch('/api/kitchen/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'kitchen123' }) });
    const d = await r.json();
    if (d.token) { localStorage.setItem('hl_kitchen_session', d.token); sessionStorage.setItem('hl_kitchen_session', d.token); }
    return !!d.token;
  });
  ok('厨房能登录', kLogin);
  await kit.reload({ waitUntil: 'networkidle2' });
  await sleep(3000);
  const kHtml = await kit.content();
  const boardHasToday = kHtml.includes(INV);
  ok('★ 厨房看板显示今天要做的单', boardHasToday, boardHasToday ? '' : '看板没渲染出订单');
  ok('★ 厨房看板显示商品与数量', /鲜肉包/.test(kHtml));
  ok('★ 厨房看板有推进状态的按钮', /开始制作|出餐完成|已交付/.test(kHtml));
  ok('★ 明天的预约单不出现在今天的看板上', !kHtml.includes(INV_TOMORROW) && !/明天才做的包/.test(kHtml));
  // 套餐必须按订单行记下的组成在板上展开，否则后厨不知道要做哪几样（C1 = S01+S05+S06+S07）
  const comboSub = await kit.evaluate(() => {
    const subs = [...document.querySelectorAll('.ksub')].map(x => x.innerText.replace(/\s+/g, ' ').trim());
    return subs;
  });
  ok('★ 厨房看板把套餐展开成了组成单品', comboSub.length >= 4, comboSub.join(' / ') || '（没有成分行）');
  ok('★ 成分行带数量', comboSub.every(s => /×\s*\d+/.test(s)), comboSub.slice(0, 2).join(' / '));
  // 空看板上「没有 PII」是废话。先要求看板真的渲染出了单，这条才算数。
  ok('★ 厨房看板零 PII（不显示电话/地址）', boardHasToday && !/91234567|Ang Mo Kio/.test(kHtml),
    !boardHasToday ? '看板是空的，这条断言不成立' : (/91234567|Ang Mo Kio/.test(kHtml) ? '看板上出现了电话或地址' : ''));

  const kBefore = 'new'; // seeded immediately before opening the kitchen page
  const kClicked = await kit.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /开始制作/.test(x.textContent));
    if (!b) return false; b.click(); return true;
  });
  ok('点到了「开始制作」', kClicked);
  await sleep(2500);
  await kit.screenshot({ path: path.join(persist, 'kitchen.png') });

  // External `wrangler d1 execute` calls can destabilise a long-lived local
  // proxy on macOS. Split the browser suite here while keeping the same D1
  // directory, so the invoice/order half starts on a fresh Worker process.
  await stopWorker();
  await startWorker();

  // 发票页深链
  const inv = await browser.newPage();
  await inv.goto(`${BASE}/invoice/${OID}`, { waitUntil: 'networkidle2' });
  const invHtml = await inv.content();
  const invStatus = await inv.evaluate(() => document.body.innerText.slice(0, 200));
  ok('发票页有「查看制作进度」深链', /查看制作进度/.test(invHtml), /查看制作进度/.test(invHtml) ? '' : `页面开头：${invStatus.replace(/\s+/g,' ')}`);
  ok('★ 发票页不含 cs_live_ 之类的长 session id 当备注', !/cs_(live|test)_[A-Za-z0-9]{20,}/.test(invHtml));
  ok('★ 一行脏商品数据不会让整张发票 500', /鲜肉包/.test(invHtml) && /—/.test(invHtml));

  // Keep the final external D1 read after all browser requests: the local D1 CLI
  // can briefly restart Miniflare even for a read-only query.
  const kAfter = rows(`SELECT fulfil_status f FROM orders WHERE id='${OID}'`)[0].f;
  ok('★ 厨房点一下真的把状态推进了', kBefore === 'new' && kAfter === 'preparing', `${kBefore} → ${kAfter}`);

  // ── 顾客端 · 真实下单 ──────────────────────────────────────────────────
  // 放在最后：这一段会新建订单、并改营业时间，不影响上面按播种订单写死的断言。
  //
  // 上面所有顾客端检查都是「先往 D1 塞一张单，再看各端渲染成什么样」。那验不出
  // 下单本身——2026-08-08 那次覆盖之所以能通过当时的检查，正是因为没人真按过下单键。
  // 这一段从空购物车点到发票页，落库金额与页面都得对上。
  console.log('\n【顾客端 · 真实下单（从空购物车点到发票页）】');
  // 营业时间设成全周 00:00-23:59，PAY_MODE=manual：闸门结果不能取决于跑它的时刻，
  // 也不能依赖外网（manual 走 PayNow 兜底，不调 Stripe）。
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES
      ('business_hours','{"0":["00:00","23:59"],"1":["00:00","23:59"],"2":["00:00","23:59"],"3":["00:00","23:59"],"4":["00:00","23:59"],"5":["00:00","23:59"],"6":["00:00","23:59"]}','${NOW}'),
      ('PAY_MODE','manual','${NOW}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`);
  await waitUp(); await sleep(600);
  const allDayRelease = await publishFixtureDraft();

  const buy = await browser.newPage();
  const buyErrors = [];
  buy.on('pageerror', e => buyErrors.push(String(e && e.message || e)));
  buy.on('console', m => { if (m.type() === 'error') buyErrors.push(m.text()); });
  buy.on('dialog', async d => { await d.accept(); });
  await buy.setViewport({ width: 390, height: 800, isMobile: true });
  await loadPublishedFixture(buy, allDayRelease);
  await buy.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await buy.reload({ waitUntil: 'networkidle2' });
  await sleep(1800);

  // 像真顾客那样点：第一下点 .add，那个按钮会被重绘成「− 1 +」步进器，
  // 第二下必须重新找可见的「+」。照着已摘掉的旧节点再点一次，onclick 会在 closest('.ctl') 上抛错，
  // 内存加了但 localStorage 没存上——那是测试自己造的假象，不是顾客会遇到的。
  await buy.evaluate(() => { const b = document.querySelector('.add'); if (b) b.click(); });
  await sleep(400);
  await buy.evaluate(() => {
    const inc = [...document.querySelectorAll('.qty [data-a="inc"]')].find(x => x.offsetParent !== null);
    if (inc) inc.click();
  });
  await sleep(400);
  const added = await buy.evaluate(() => {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('hl_cart') || '{}'); } catch (e) {}
    return Object.values(saved).reduce((a, b) => a + (+b || 0), 0);
  });
  ok('★ 点「加入」真的进了购物车（内存与 localStorage 一致 2 件）', added === 2, `${added} 件`);
  const cartCount = await buy.evaluate(() => document.body.innerText.match(/S\$\s*[\d.]+/) ? 1 : 0);
  ok('购物车栏出现金额', cartCount === 1);

  await buy.$eval('#checkout', b => b.click());
  await buy.waitForSelector('#sheet.show #pickupPoint');
  await buy.$eval('[name=ff][value=pickup]', b => b.click());
  await sleep(400);
  await buy.select('#pickupPoint', 'main');
  await buy.$eval('#phone', el => { el.value = '98765432'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await buy.$eval('#name', el => { el.value = '冒烟顾客'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(600);
  const dueText = await buy.$eval('#sheetSummary', el => el.innerText);
  ok('结账明细算出了应付金额', /S\$\s*[\d.]+/.test(dueText), dueText.replace(/\s+/g, ' ').slice(0, 70));
  const submitEnabled = await buy.$eval('#submit', b => !b.disabled);
  ok('下单按钮可点（营业中、金额有效）', submitEnabled);
  await buy.screenshot({ path: path.join(persist, 'customer-checkout.png'), fullPage: true });

  const ordersBefore = +rows('SELECT COUNT(*) n FROM orders')[0].n;
  await waitUp(); await sleep(400);
  await Promise.all([
    buy.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {}),
    buy.$eval('#submit', b => b.click()),
  ]);
  await sleep(1500);
  const buyUrl = buy.url();
  ok('★ 真的下单成功并跳到发票页', /\/invoice\/[0-9a-f-]{36}/i.test(buyUrl), buyUrl.replace(BASE, '') || '(没跳转)');
  await buy.screenshot({ path: path.join(persist, 'customer-invoice.png'), fullPage: true });
  const invoiceHtml = await buy.content();

  const newId = (buyUrl.match(/\/invoice\/([0-9a-f-]{36})/i) || [])[1] || '';
  await waitUp(); await sleep(400);
  // 自取点落库在 unit_no（id）+ address（下单当刻的名称·地址快照），orders 没有 pickup_point_id 列
  const placed = newId ? rows(`SELECT id,invoice_no,fulfilment,unit_no,address,subtotal,total,pay_status,phone,customer_name,items_json FROM orders WHERE id='${newId}'`)[0] : null;
  ok('★ 订单真的落进 D1', !!placed, newId || '(没拿到订单号)');
  ok('★ 落库的是自取单并带上了自取点', !!placed && placed.fulfilment === 'pickup' && placed.unit_no === 'main',
    placed ? `${placed.fulfilment} / ${placed.unit_no}` : '');
  ok('★ 自取点名称地址快照也写进了订单', !!placed && /Example Food Court/.test(String(placed.address || '')),
    placed ? String(placed.address || '(空)') : '');
  ok('★ 顾客填的电话和名字都存下来了', !!placed && String(placed.phone).includes('98765432') && placed.customer_name === '冒烟顾客',
    placed ? `${placed.phone} / ${placed.customer_name}` : '');
  if (placed) {
    const line = JSON.parse(placed.items_json)[0];
    const priced = rows(`SELECT price FROM products WHERE sku='${String(line.sku).replace(/'/g, "''")}'`)[0];
    const expect = +((+priced.price) * (+line.qty)).toFixed(2);
    ok('★ 落库小计 = 商品单价 × 数量（前端改不了价）', Math.abs(+placed.subtotal - expect) < 0.005,
      `${placed.subtotal} vs ${expect}`);
    ok('★ 发票页显示的就是这张单', invoiceHtml.includes(placed.invoice_no), placed.invoice_no);
    ok('订单落库后订单数 +1', +rows('SELECT COUNT(*) n FROM orders')[0].n === ordersBefore + 1);
  }

  // 上面的外部 D1 读取可能让本地 Miniflare 退出；从同一份本地数据库重启后再继续浏览器请求。
  await stopWorker();
  await startWorker();

  // 付完钱回店里：购物车必须是空的。不然顾客看见「去结算」还亮着，很容易再下一单、储值被扣第二次。
  await buy.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(1500);
  const cartAfter = await buy.evaluate(() => {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('hl_cart') || '{}'); } catch (e) {}
    const qty = Object.values(saved).reduce((a, b) => a + (+b || 0), 0);
    // #checkout 常驻 DOM，空车时是 disabled —— 判可点，别判可见
    const bar = document.getElementById('checkout');
    const count = (document.getElementById('count')?.innerText || '');
    return { qty, checkoutEnabled: !!(bar && !bar.disabled), count };
  });
  ok('★ 下单后购物车清空了（localStorage 也清了）', cartAfter.qty === 0, `残留 ${cartAfter.qty} 件`);
  ok('★ 回到首页「去结算」是灰的、件数归零', !cartAfter.checkoutEnabled && /(^|\D)0(\s*件| items?)/.test(cartAfter.count),
    `按钮可点=${cartAfter.checkoutEnabled} 件数=${cartAfter.count}`);
  // 折叠的 <details> 正文不进 innerText，要读 textContent
  const deliveryNoteShown = await buy.evaluate(() => document.getElementById('deliveryInfo')?.textContent || '');
  ok('★ 老板配的「配送说明」顾客看得到', /配送说明|Delivery info/.test(deliveryNoteShown) && /16:00/.test(deliveryNoteShown),
    deliveryNoteShown.replace(/\s+/g, ' ').slice(0, 50) || '(空)');
  ok('★ 整条下单链路没有 JS 报错', buyErrors.length === 0, buyErrors.slice(0, 2).join(' | '));

  // 营业外空着不选日期/时间：后端也必须兜底排到下一营业时段。前端会主动填，
  // 但 direct POST、旧缓存页面或弱网竞态都不能再得到「请选时间」错误。
  const todayDow = new Date(SGT_TODAY + 'T12:00:00Z').getUTCDay();
  const nextDow = (todayDow + 1) % 7;
  const nextOpeningHours = Object.fromEntries(Array.from({ length: 7 }, (_, dow) =>
    [dow, dow === nextDow ? ['10:00', '20:30'] : null]));
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES
      ('business_hours','${JSON.stringify(nextOpeningHours)}','${NOW}'),
      ('prep_time_min','20','${NOW}'),
      ('store_open','1','${NOW}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`);
  await stopWorker();
  await startWorker();
  const nextOpeningRelease = await publishFixtureDraft();
  await loadPublishedFixture(buy, nextOpeningRelease);
  const sku = placed ? JSON.parse(placed.items_json)[0].sku : 'S01';
  const autoTry = await buy.evaluate(async (s) => {
    const r = await fetch('/api/order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_name: '自动预约测试', phone: '98765432', fulfilment: 'pickup',
        pickup_point_id: 'main', items: [{ sku: s, qty: 1 }],
        menu_revision: window.HL_MENU_REVISION, client_token: 'ui-auto-next-opening' }),
    });
    let d = {}; try { d = await r.json(); } catch (e) {}
    return { status: r.status, ok: !!d.ok, id: String(d.id || ''), error: String(d.error || '') };
  }, sku);
  ok('★ 营业外留空时后端自动接单', autoTry.ok, `${autoTry.status} ${autoTry.error}`.trim());
  const autoOrder = autoTry.id
    ? rows(`SELECT deliver_at,deliver_time FROM orders WHERE id='${autoTry.id.replace(/'/g, "''")}'`)[0]
    : null;
  ok('★ 自动单落到下一营业日开门 + 备餐时间',
    !!autoOrder && autoOrder.deliver_at === SGT_TOMORROW && autoOrder.deliver_time === '10:20',
    autoOrder ? `${autoOrder.deliver_at} ${autoOrder.deliver_time}` : '(未落单)');

  // 反向闸门：全周店休时后端必须拒单。自动预约不能把「没有任何可履约日期」也放过去。
  d1(`UPDATE app_settings SET v='{"0":null,"1":null,"2":null,"3":null,"4":null,"5":null,"6":null}' WHERE k='business_hours'`);
  await stopWorker();
  await startWorker();
  const closedRelease = await publishFixtureDraft();
  await loadPublishedFixture(buy, closedRelease);
  const closedTry = await buy.evaluate(async (s) => {
    const r = await fetch('/api/order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_name: '闭店测试', phone: '98765432', fulfilment: 'pickup',
        pickup_point_id: 'main', items: [{ sku: s, qty: 1 }],
        menu_revision: window.HL_MENU_REVISION, client_token: 'ui-closed-day' }),
    });
    let d = {}; try { d = await r.json(); } catch (e) {}
    return { status: r.status, ok: !!d.ok, error: String(d.error || '') };
  }, sku);
  ok('★ 全周店休时后端拒绝下单', !closedTry.ok, `${closedTry.status} ${closedTry.error}`.trim());
  ok('被拒的单没有落库', +rows('SELECT COUNT(*) n FROM orders')[0].n === ordersBefore + (placed ? 1 : 0) + (autoTry.ok ? 1 : 0));

  // 截图另存一份，便于人工过目（成功时临时目录会被清掉）
  try {
    const keep = path.join(ROOT, '_qa', 'ui-smoke');
    mkdirSync(keep, { recursive: true });
    for (const f of ['admin.png', 'admin-posters.png', 'admin-topups.png', 'pos.png', 'customer.png', 'customer-home.png', 'customer-pickup.png', 'customer-delivery.png', 'customer-ready.png', 'customer-checkout.png', 'customer-invoice.png', 'kitchen.png']) {
      try { copyFileSync(path.join(persist, f), path.join(keep, f)); } catch (e) {}
    }
    console.log('\n· 截图：' + keep);
  } catch (e) { console.log('\n· 截图：' + persist); }
  console.log('─────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { fails.forEach(f => console.log('  ✗', f)); process.exitCode = 1; }
}

main().catch(e => { console.error('\nUI 冒烟异常：', e); process.exitCode = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch (e) {}
    await stopWorker();
    if (!process.exitCode) { try { rmSync(persist, { recursive: true, force: true }); } catch (e) {} }
     // wrangler 的本地代理/puppeteer 的子进程会吊住事件循环：macOS 上进程还是退了，
    // Linux CI 上会一直挂到 job 超时——一次 40 秒就失败的测试因此变成 25 分钟静默等待。
    // 跑完就强制退出，留 500ms 把输出刷干净。
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
