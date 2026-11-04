// Short, isolated storefront button audit. It clicks every current button family
// against local D1/Worker only and blocks payment/OAuth creation requests.

import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';
import { signSession } from '../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8812;
const BASE = `https://127.0.0.1:${PORT}`;
const AUTH_SECRET = 'storefront-visual-auth-secret';
const UID = 'visual-member-1';
const OID = '77777777-7777-4777-8777-777777777777';
const OUT = path.join(ROOT, '_qa', 'storefront-buttons');
const persist = mkdtempSync(path.join(tmpdir(), 'hl-buttons-'));
const CHROME = findChrome();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const d1 = sql => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql], { cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe'] });
let child = null;
let browser = null;
const clicked = [];
const checks = [];
const check = (name, value, detail = '') => {
  checks.push({ name, ok:!!value, detail });
  console.log(value ? '  ✅' : '  ❌', name, detail ? `:: ${detail}` : '');
};

async function waitUp(timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if ((await fetch(BASE + '/api/menu')).ok) return true; } catch (error) {}
    await sleep(300);
  }
  return false;
}

async function stopWorker() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch (error) {}
  await sleep(700);
  try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (error) {}
  child = null;
}

async function startWorker() {
  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist, '--port', String(PORT),
    '--local-protocol', 'https', '--test-scheduled',
    '--var', `AUTH_SECRET:${AUTH_SECRET}`, '--var', 'PAY_MODE:manual',
    '--var', 'TELEGRAM_BOT_TOKEN:', '--var', 'TELEGRAM_CHAT_ID:'], { cwd:ROOT, stdio:['ignore','pipe','pipe'] });
  const log = createWriteStream(path.join(persist, 'wrangler.log'), { flags:'a' });
  log.on('error', () => {});
  child.stdout.pipe(log, { end:false }); child.stderr.pipe(log, { end:false });
  if (!await waitUp()) throw new Error('local Worker did not start');
  // 价格只认活动发布；一分钟 Cron 是唯一被允许创建首个发布的路径。
  // dev 里没有真 cron，这里显式触发一次，否则下单会 503。
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const r = JSON.parse(d1('SELECT active_release_id FROM public_content_state'))[0].results;
    if (r[0] && r[0].active_release_id) break;
    await new Promise(res => setTimeout(res, 500));
  }
}

function seed() {
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd:ROOT, stdio:['ignore','pipe','pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
    { cwd:ROOT, stdio:['ignore','pipe','pipe'] });
  const now = new Date().toISOString();
  const sgtDow = new Date(Date.now() + 8 * 3600e3).getUTCDay();
  const hours = Object.fromEntries(Array.from({ length:7 }, (_, dow) => [dow, dow === sgtDow ? null : ['10:00','20:30']]));
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('${UID}','91234567','视觉验收会员','${now}','${now}')`);
  d1(`INSERT INTO members (phone,user_id,name,balance,points,created_at,updated_at)
      VALUES ('91234567','${UID}','视觉验收会员',88.5,12,'${now}','${now}')`);
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,total,
        fulfilment,pay_provider,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total,address)
      VALUES ('${OID}','HL-${day}-0099','${now}','视觉验收会员','91234567','${UID}',
        '[{"sku":"S01","name":"鲜肉包","qty":1,"unit_price":5}]',5,0,5,'pickup','balance','PAID','${now}',5,'ready',0,'Example Food Court')`);
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES
      ('business_hours','${JSON.stringify(hours)}','${now}'),
      ('PAY_MODE','manual','${now}'),
      ('pickup_enabled','1','${now}'),
      ('shop_name','Example Food Court','${now}'),
      ('shop_address','Example Food Court #01-01, Singapore 100003','${now}'),
      ('SHOP_POSTAL','100003','${now}'),
      ('pickup_points','[{"id":"riverside","active":true,"name":"Riverside Mall","address":"1 Example Road, Singapore 100001","postal":"100001"},{"id":"vp","active":true,"name":"Garden Plaza","address":"Garden Plaza Road, Singapore 100004","postal":"100004"}]','${now}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`);
}

async function click(page, selector, name) {
  await page.waitForSelector(selector, { visible:true, timeout:10000 });
  await page.click(selector);
  clicked.push(name);
}

async function main() {
  mkdirSync(OUT, { recursive:true });
  seed();
  await startWorker();

  browser = await puppeteer.launch({ executablePath:CHROME, headless:true, args:['--ignore-certificate-errors','--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error.message || error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  page.on('dialog', async dialog => { clicked.push(`dialog:${dialog.message().slice(0, 40)}`); await dialog.accept(); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && ['/api/topup/checkout','/api/auth/link-start'].includes(url.pathname)) {
      request.respond({ status:200, contentType:'application/json', body:'{"error":"visual audit blocked external flow"}' });
    } else request.continue();
  });
  await page.setViewport({ width:390, height:800, isMobile:true });
  await page.goto(BASE + '/', { waitUntil:'networkidle2' });
  const token = await signSession({ AUTH_SECRET }, UID);
  await page.evaluate(value => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('hl_token', value); }, token);
  await page.reload({ waitUntil:'networkidle2' });
  await page.waitForSelector('.card .add');
  await page.waitForFunction(() => /S\$\s*88\.50/.test(document.getElementById('memberBtn')?.innerText || ''));

  // Opening campaign: close button and claim button are separate visible controls.
  if (await page.$('#posterModal.show #posterClose')) {
    await page.screenshot({ path:path.join(OUT, '01-opening-poster.png') });
    await click(page, '#posterClose', 'opening poster close');
  }
  const posterAction = await page.$('button[data-poster-action]');
  if (posterAction) {
    await click(page, 'button[data-poster-action]', 'campaign claim');
    check('campaign button shows a result', await page.$eval('#posterToast', el => !!el.textContent.trim()));
  }

  await click(page, '#langBtn', 'language EN');
  check('language button switches to English', await page.$eval('#langBtn', el => el.textContent.trim() === '中'));
  await click(page, '#langBtn', 'language CN');

  await click(page, '#memberBtn', 'member centre');
  await page.waitForSelector('#memberSheet.show #saveProfileBtn');
  await page.screenshot({ path:path.join(OUT, '02-member-balance.png'), fullPage:false });
  check('member centre shows balance', await page.$eval('#memberBody', el => /S\$\s*88\.50/.test(el.innerText)));
  await click(page, '#saveProfileBtn', 'save profile');
  await page.waitForFunction(() => /已保存|Saved/.test(document.getElementById('profileMsg')?.innerText || ''));
  const providerCount = await page.$$eval('.link-provider', buttons => buttons.length);
  for (let i = 0; i < providerCount; i++) {
    await page.$$eval('.link-provider', (buttons, index) => buttons[index].click(), i);
    clicked.push(`link provider ${i + 1}`);
    await sleep(80);
  }
  await click(page, '#topupBtn', 'open top-up tiers');
  await page.waitForSelector('.topup-opt');
  const topupCount = await page.$$eval('.topup-opt', buttons => buttons.length);
  for (let i = 0; i < topupCount; i++) {
    await page.$$eval('.topup-opt', (buttons, index) => buttons[index].click(), i);
    clicked.push(`top-up option ${i + 1}`);
    await page.waitForFunction(() => [...document.querySelectorAll('.topup-opt')].every(button => !button.disabled));
  }
  await page.screenshot({ path:path.join(OUT, '03-topup-options.png'), fullPage:false });
  await page.evaluate(() => document.getElementById('memberSheet').classList.remove('show'));

  // Every homepage stored-value CTA is clicked; all should reach the same member/top-up view.
  const promoButtonCount = await page.$$eval('.sv-card button', buttons => buttons.length);
  for (let i = 0; i < promoButtonCount; i++) {
    await page.$$eval('.sv-card button', (buttons, index) => buttons[index].click(), i);
    clicked.push(`homepage stored-value CTA ${i + 1}`);
    await page.waitForSelector('#memberSheet.show .topup-opt');
    await page.evaluate(() => document.getElementById('memberSheet').classList.remove('show'));
  }

  // Click every product add button, then every rendered + and − stepper button.
  const productSkus = await page.$$eval('.add', buttons => buttons.map(button => button.dataset.sku));
  for (const sku of productSkus) {
    await page.$eval(`[data-a="inc"][data-sku="${sku}"]`, button => button.click());
    clicked.push(`product add ${sku}`);
  }
  for (const sku of productSkus) {
    await page.$eval(`[data-a="inc"][data-sku="${sku}"]`, button => button.click());
    clicked.push(`product increment ${sku}`);
  }
  for (const sku of productSkus) {
    await page.$eval(`[data-a="dec"][data-sku="${sku}"]`, button => button.click());
    clicked.push(`product decrement ${sku}`);
  }
  check('every menu product button was exercised', productSkus.length >= 20, `${productSkus.length} products`);
  await page.screenshot({ path:path.join(OUT, '04-all-product-buttons.png'), fullPage:true });

  // Wrangler's local proxy can exit with an empty internal error after a burst of
  // asset/auth requests on Linux CI. Keep the same D1 and browser localStorage, but
  // start checkout on a fresh Worker so a green audit means the buttons were really
  // clicked instead of depending on one unusually long-lived local proxy process.
  await stopWorker();
  await startWorker();
  await page.reload({ waitUntil:'networkidle2' });
  await page.waitForFunction(() => /S\$\s*88\.50/.test(document.getElementById('memberBtn')?.innerText || ''));

  await click(page, '#checkout', 'checkout');
  await page.waitForSelector('#sheet.show #useBal');
  await page.waitForFunction(() => /S\$\s*88\.50/.test(document.getElementById('useBalLabel')?.innerText || ''));
  const autoSlot = await page.evaluate(() => ({ date:document.getElementById('date')?.value || '', time:document.getElementById('time')?.value || '', msg:document.getElementById('autoScheduleMsg')?.innerText || '' }));
  check('closed store jumps to the next opening automatically', !!autoSlot.date && !!autoSlot.time && /自动安排|Automatically scheduled/.test(autoSlot.msg), `${autoSlot.date} ${autoSlot.time}`);
  const cartSkus = await page.$$eval('#coLines [data-ca="inc"]', buttons => buttons.map(button => button.dataset.sku));
  for (const sku of cartSkus) {
    await page.$eval(`#coLines [data-ca="inc"][data-sku="${sku}"]`, button => button.click());
    clicked.push(`cart increment ${sku}`);
  }
  for (const sku of cartSkus) {
    await page.$eval(`#coLines [data-ca="dec"][data-sku="${sku}"]`, button => button.click());
    clicked.push(`cart decrement ${sku}`);
  }
  check('checkout balance is visible and selected', await page.$eval('#useBal', input => !!input.offsetParent && input.checked));
  await click(page, '#useBal', 'balance opt out');
  check('opt-out keeps balance visible', await page.$eval('#useBalLabel', el => /S\$\s*88\.50/.test(el.innerText)));
  await click(page, '#useBal', 'balance opt in');
  await page.type('#promo', 'NOT-A-PROMO');
  await click(page, '#applyPromo', 'apply promo');
  // 等【终态】而不是「有没有字」：applyPromo 现在会先显示「检查中…」，
  // 只等 innerText 非空的话，请求根本没回来也算过。
  // 超时也不能只抛一个光秃秃的 TimeoutError —— 要把当时屏幕上的内容说出来，
  // 否则下次 CI 红了还是只能猜（这一条就是这么在 CI 上卡了 30 秒的）。
  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('promoMsg')?.innerText || '';
      return !!text && !/检查中|Checking/.test(text);
    }, { timeout: 20000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      promoMsg: document.getElementById('promoMsg')?.innerText || '(空)',
      promoValue: document.getElementById('promo')?.value || '(空)',
    }));
    throw new Error(`点了「应用优惠码」但 promoMsg 没进终态：msg=${JSON.stringify(state.promoMsg)} 输入=${state.promoValue}`);
  }
  check('invalid promo tells the customer something', await page.$eval('#promoMsg', el => !!el.innerText.trim()));

  // 请求本身失败时也必须说话。原来这里没有 try/catch：一抖就永远停在空白，
  // 顾客点了「应用」屏幕上什么都不发生。注入一个必定失败的 fetch 来证明现在不会了。
  await page.evaluate(() => {
    window.__realFetch = window.fetch;
    window.fetch = (url, init) => String(url).includes('/api/promo/check')
      ? Promise.reject(new Error('injected network failure'))
      : window.__realFetch(url, init);
    document.getElementById('promoMsg').textContent = '';
  });
  await page.$eval('#promo', el => { el.value = 'NETWORK-DOWN'; });
  await click(page, '#applyPromo', 'apply promo while offline');
  await page.waitForFunction(() => {
    const text = document.getElementById('promoMsg')?.innerText || '';
    return !!text && !/检查中|Checking/.test(text);
  }, { timeout: 10000 }).catch(() => {});
  const offlineMsg = await page.$eval('#promoMsg', el => el.innerText.trim());
  check('promo check failure still tells the customer', /重试|try again/i.test(offlineMsg), offlineMsg || '(一片空白)');
  await page.evaluate(() => { window.fetch = window.__realFetch; document.getElementById('promo').value = ''; });

  const fulfilments = await page.$$eval('[name=ff]', radios => radios.map(radio => radio.value));
  for (const value of fulfilments) {
    await page.$eval(`[name=ff][value="${value}"]`, radio => radio.click());
    clicked.push(`fulfilment ${value}`);
  }
  await page.$eval('[name=ff][value="pickup"]', radio => radio.click());
  const pickupValues = await page.$$eval('#pickupPoint option', options => options.map(option => option.value));
  for (const value of pickupValues) {
    await page.select('#pickupPoint', value);
    clicked.push(`pickup point ${value}`);
  }
  await page.screenshot({ path:path.join(OUT, '05-checkout-auto-balance.png'), fullPage:true });

  // Postal lookup is a distinct button; exercise it without ordering delivery.
  await page.$eval('[name=ff][value="anytime"]', radio => radio.click());
  await page.type('#postal', '100003');
  await click(page, '#lookupPostal', 'postal lookup');
  await page.waitForFunction(() => !!document.getElementById('zoneMsg')?.innerText);
  await page.$eval('[name=ff][value="pickup"]', radio => radio.click());
  await page.$eval('#name', input => { input.value = '视觉验收会员'; input.dispatchEvent(new Event('input', { bubbles:true })); });
  await page.$eval('#phone', input => { input.value = '91234567'; input.dispatchEvent(new Event('input', { bubbles:true })); });
  await click(page, '#submit', 'place local test order');
  await page.waitForFunction(() => /\/invoice\/[0-9a-f-]+/i.test(location.pathname), { timeout:30000 });
  check('submit reaches a local invoice', /\/invoice\//.test(page.url()), page.url().replace(BASE, ''));
  await page.screenshot({ path:path.join(OUT, '06-local-invoice.png'), fullPage:true });

  // Ready-order progress controls: notify-arrival then close. Telegram vars are empty.
  const progress = await browser.newPage();
  await progress.setViewport({ width:390, height:800, isMobile:true });
  await progress.goto(`${BASE}/?order=${OID}`, { waitUntil:'networkidle2' });
  await progress.waitForSelector('#progArrive');
  await click(progress, '#progArrive', 'arrival notice');
  await progress.waitForFunction(() => /已告诉|knows/.test(document.getElementById('orderProgress')?.innerText || ''));
  await progress.screenshot({ path:path.join(OUT, '07-arrival-notice.png'), fullPage:false });
  await click(progress, '#progClose', 'progress close');
  check('progress close hides the card', !(await progress.$('#orderProgress .prog-card')));

  // WeChat-only copy/close buttons in a clean guest page.
  const wechat = await browser.newPage();
  await wechat.setUserAgent('Mozilla/5.0 MicroMessenger/8.0.50 Mobile');
  await wechat.setViewport({ width:390, height:800, isMobile:true });
  await wechat.goto(BASE + '/', { waitUntil:'networkidle2' });
  await wechat.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await wechat.reload({ waitUntil:'networkidle2' });
  if (await wechat.$('#posterModal.show #posterClose')) await click(wechat, '#posterClose', 'WeChat opening poster close');
  check('WeChat browser mode is active', await wechat.evaluate(() => isWeChatBrowser()), await wechat.evaluate(() => navigator.userAgent));
  await click(wechat, '#memberBtn', 'WeChat member');
  await wechat.waitForSelector('#wxSheet.show #wxCopyBtn');
  await click(wechat, '#wxCopyBtn', 'WeChat copy link');
  await click(wechat, '#wxOkBtn', 'WeChat guide close');
  check('WeChat close hides guide', !(await wechat.$('#wxSheet.show')));

  check('no JavaScript errors during storefront clicks', errors.length === 0, errors.slice(0, 2).join(' | '));
  check('all current button families were clicked', [
    'opening poster close','campaign claim','language EN','language CN','member centre','save profile',
    'open top-up tiers','checkout','balance opt out','balance opt in','apply promo','postal lookup',
    'place local test order','arrival notice','progress close','WeChat member','WeChat copy link','WeChat guide close',
  ].every(name => clicked.includes(name)), `${clicked.length} total clicks`);

  const failed = checks.filter(item => !item.ok);
  console.log(JSON.stringify({ products:productSkus.length, pickup_points:pickupValues.length,
    topup_options:topupCount, homepage_topup_buttons:promoButtonCount, clicks:clicked.length,
    checks_passed:checks.length - failed.length, checks_failed:failed.length, screenshots:OUT }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (browser) await browser.close(); } catch (error) {}
  await stopWorker();
  if (process.exitCode) {
    try { copyFileSync(path.join(persist, 'wrangler.log'), path.join(OUT, 'wrangler.log')); } catch (error) {}
  } else {
    try { rmSync(persist, { recursive:true, force:true }); } catch (error) {}
  }
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});
