// 老板后台全按钮点击 + 视觉验收（真 Chrome × 真 Worker × 真本地 D1）。
//
//   node tests/boss-ui-smoke.mjs            # 无头
//   node tests/boss-ui-smoke.mjs --headed   # 看着它点
//
// 只跑本地，跑完删库。截图落 _qa/boss-ui/，**要人打开看**——
// DOM 断言证明不了"两米外看得清""按钮没被遮住""金额没显示成 undefined"。

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8861, BASE = `https://127.0.0.1:${PORT}`, ADMIN = 'testadmin';
const AUTH_SECRET = 'boss-ui-auth-secret';
const HEADED = process.argv.includes('--headed');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const CHROME = findChrome();   // 找不到就退 1，不再静默跳过（跳过 = 零断言假绿）

const persist = mkdtempSync(path.join(tmpdir(), 'hl-boss-'));
let child = null, browser = null, page = null;
let pass = 0; const fails = []; const consoleErrs = [];
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✅', n, extra ? `:: ${extra}` : ''); }
  else { fails.push(n); console.log('  ❌', n, extra ? `:: ${extra}` : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d1 = sql => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = sql => JSON.parse(d1(sql))[0].results;
const num = sql => { const r = rows(sql); return r.length ? Object.values(r[0])[0] : null; };

async function waitUp(t = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { if ((await fetch(BASE + '/api/menu')).ok) return true; } catch (e) {} await sleep(700); }
  return false;
}
// 回到看板首页 —— 进了子视图后顶部导航会被替换掉，不先回去就找不到别的入口
// （第一版脚本没做这一步，把「储值台账」这种本来就存在的页也误报成"找不到"）
const goHome = async () => {
  await page.evaluate(() => { if (typeof dash === 'function') dash(); else location.reload(); });
  await new Promise(r => setTimeout(r, 1200));
};
// 点一个「文字包含 X」的按钮；返回是否点到
const clickText = (re) => page.evaluate((src) => {
  const rx = new RegExp(src);
  const b = [...document.querySelectorAll('button,a')].find(x => rx.test((x.textContent || '').trim()) && x.offsetParent !== null);
  if (!b) return false; b.click(); return true;
}, re.source);
const bodyText = () => page.evaluate(() => document.body.innerText);
const shot = async (name) => { await page.screenshot({ path: path.join(persist, name + '.png') }); };

async function main() {
  console.log('· 播种');
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('node', ['tests/seed-demo.mjs', '--persist', persist], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  // 两种历史储值场景：① 已有账号可一键并 ② 还没账号要先绑
  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('u-wait','80000002','王老太','2026-08-09','2026-08-09')`);
  d1(`INSERT INTO auth_identities (provider,provider_sub,user_id,email,display_name,created_at,updated_at)
      VALUES ('apple','ap9','u-wait','wang@privaterelay.appleid.com','王老太','2026-08-09','2026-08-09')`);
  d1(`INSERT INTO members (phone,name,balance,points,created_at,updated_at) VALUES ('91112222','李先生',300,20,'2026-06-01','2026-06-01')`);
  // 余额必须有来源，否则储值负债明细账天生就不平（账面少 300，差异栏常年飘红，
  // 真出问题时反而没人看）。生产里这类历史钱包也都有对应的充值记录。
  d1(`INSERT INTO topups (id,phone,amount,bonus,credited,pay_method,pay_status,cashier,created_at,note)
      VALUES ('tp-legacy-lee','91112222',300,0,300,'cash','PAID','pos1','2026-06-01','历史钱包期初余额')`);
  d1(`INSERT INTO user_accounts (id,name,created_at,updated_at) VALUES ('u-lee','Lee','2026-08-09','2026-08-09')`);
  d1(`INSERT INTO auth_identities (provider,provider_sub,user_id,email,display_name,created_at,updated_at)
      VALUES ('google','gg9','u-lee','lee@example.com','Lee','2026-08-09','2026-08-09')`);

  console.log('· 起服务');
  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist, '--port', String(PORT),
    '--local-protocol', 'https', '--test-scheduled', '--var', `ADMIN_TOKEN:${ADMIN}`,
    '--var', `AUTH_SECRET:${AUTH_SECRET}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(persist, 'wrangler.log'));
  // stdout 和 stderr 都 pipe 到同一个流时，【谁先结束谁就把流 end() 掉】，
  // 另一个再写就是 ERR_STREAM_WRITE_AFTER_END，而且它以 unhandled 'error' 抛出 → 整个测试红。
  // macOS 上顺序碰巧良性，Linux CI 上翻车：一个只改了文档的 commit 也会红。
  // { end:false } 让两条流都不去 end 它；再兜一个 error handler，写日志失败绝不该弄红测试。
  log.on('error', () => {});
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  if (!await waitUp()) throw new Error('wrangler dev 起不来');
  const bootstrap = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  const bootstrapRelease = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  if (!bootstrap.ok || !bootstrapRelease) throw new Error('本地发布 bootstrap 未完成');
  const bootstrapSnapshot = rows(`SELECT checksum,snapshot_json FROM public_content_releases WHERE id='${bootstrapRelease}'`)[0];
  const bootstrapTags = rows(`SELECT tags_json FROM public_content_release_products WHERE release_id='${bootstrapRelease}' AND sku='S01'`)[0].tags_json;

  browser = await puppeteer.launch({ executablePath: CHROME, headless: !HEADED,
    args: ['--ignore-certificate-errors', '--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('dialog', async d => { await d.accept(); });
  page.on('pageerror', e => consoleErrs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push('console: ' + m.text().slice(0, 160)); });

  await page.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
  await page.evaluate(t => sessionStorage.setItem('hl_admin', t), ADMIN);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1800);
  console.log('· 就绪\n');

  // ── 导航：每个页签都要能点开 ─────────────────────────────────────────
  console.log('【导航】');
  const navs = await page.evaluate(() =>
    [...document.querySelectorAll('.nav button, nav button, button')]
      .map(b => (b.textContent || '').trim()).filter(t => /^[\p{Emoji}\u{1F300}-\u{1FAFF}]/u.test(t)));
  ok('顶部功能入口数量合理', navs.length >= 12, `${navs.length} 个`);

  for (const [label, expect] of [
    ['会员', /会员|余额|积分/], ['历史储值', /历史储值|待认领|合并/],
    ['审计记录', /审计|流水|退款/], ['储值台账', /台账|负债|对账/],
  ]) {
    await goHome();
    const hit = await clickText(new RegExp(label));
    await sleep(1200);
    const txt = await bodyText();
    ok(`打开「${label}」`, hit && expect.test(txt), hit ? '' : '找不到这个入口');
    if (hit) await shot('nav-' + label);
  }

  // ── 会员：消费记录 / 扣款 / 归档 ──────────────────────────────────────
  console.log('\n【会员管理】');
  await goHome(); await clickText(/会员/); await sleep(1200);
  ok('会员列表出现余额列', /余额|balance/i.test(await bodyText()));
  ok('会员列表恢复「会员备注」', /会员备注/.test(await bodyText()));

  const noteClicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tbody tr')].find(tr => /98765432/.test(tr.textContent || ''));
    const note = row && row.querySelector('textarea[id^="mnote-"]');
    const save = row && row.querySelector('button[id^="msb-"]');
    if (!note || !save) return false;
    note.value = 'UI验收备注：少糖';
    save.click();
    return true;
  });
  await sleep(1000);
  ok('会员备注能从页面保存', noteClicked && d1(`SELECT admin_note FROM members WHERE user_id='u-demo-2'`).includes('UI验收备注：少糖'));

  const search = await page.$('#member-q');
  if (search) {
    await search.click({ clickCount: 3 });
    await page.keyboard.type('少糖');
    await sleep(1000);
  }
  const searched = await page.evaluate(() => ({
    focused: document.activeElement && document.activeElement.id === 'member-q',
    rows: [...document.querySelectorAll('tbody tr')].filter(tr => /98765432/.test(tr.textContent || '')).length,
  }));
  ok('输入备注关键词会自动搜索（不用再点按钮）', searched.focused && searched.rows === 1);

  ok('点开单个会员「充值记录」', await clickText(/充值记录/));
  await sleep(1400);
  const topupText = await bodyText();
  ok('充值记录保留账号身份并显示筛选汇总', /充值流水审计/.test(topupText) && /林伟强/.test(topupText) && /筛选笔数/.test(topupText));

  // 充值页本身要能按 Email / 姓名找到会员；u-lee 故意没有手机号，验证入账确实按 user_id，
  // 不会因为旧接口只认 phone 而卡住。
  const topupSearch = await page.$('#tu-member-q');
  if (topupSearch) {
    await topupSearch.type('lee@example.com');
    await sleep(1600);   // 搜索有 debounce：900ms 会偶发抢跑，抖动的断言比没断言更糟
  }
  const foundEmailMember = await page.evaluate(() => /Lee/.test(document.getElementById('tu-member-results')?.innerText || ''));
  ok('充值页可按 Email 搜到没有手机号的会员', foundEmailMember);
  if (foundEmailMember) {
    await page.evaluate(() => document.querySelector('#tu-member-results button')?.click());
    await sleep(300);
    const picked = await page.evaluate(() => ({
      selected: document.getElementById('tu-selected')?.innerText || '',
      email: document.getElementById('tu-email')?.value || '',
      phone: document.getElementById('tu-phone')?.value || '',
    }));
    ok('搜索结果可选中并带回会员资料', /Lee/.test(picked.selected) && picked.email === 'lee@example.com' && picked.phone === '');
    await page.evaluate(() => { document.getElementById('tu-amt').value = '10'; window.doTopup(); });
    await sleep(1400);
    ok('没有手机号的会员按 user_id 真正入账', +num(`SELECT balance FROM members WHERE user_id='u-lee'`) === 10);
  }

  // 找不到时在同一界面填姓名 / 手机 / Email；成功后资料、余额和流水应一起存在。
  await page.evaluate(() => {
    document.getElementById('tu-name').value = 'Eva Yuan';
    document.getElementById('tu-phone').value = '98887766';
    document.getElementById('tu-email').value = 'eva@example.com';
    document.getElementById('tu-amt').value = '20';
  });
  await shot('topup-new-member');
  await page.evaluate(() => window.doTopup());
  await sleep(1400);
  const eva = rows(`SELECT name,email,balance FROM members WHERE phone='98887766'`)[0];
  ok('充值页可同时建立姓名 / Email 会员档案', eva?.name === 'Eva Yuan' && eva?.email === 'eva@example.com' && +eva?.balance === 20);
  ok('新会员充值流水同步落账', +num(`SELECT COUNT(*) FROM topups WHERE phone='98887766' AND amount=20`) === 1);
  await clickText(/会员列表/); await sleep(1000);

  // 新建后要能在会员页搜到并「删除」。删除在产品里是可恢复的归档：余额与历史账不丢，
  // 默认列表隐藏；勾选「显示已归档」后仍能查到。
  const evaSearch = await page.$('#member-q');
  if (evaSearch) {
    // 从「少糖」筛选返回时输入框已有旧值；三击全选跨浏览器不稳定，曾实际变成
    // 「少糖Eva Yuan」导致假红。明确替换 value 并触发 input，才是真实的改搜索词语义。
    await page.evaluate(() => {
      const input = document.getElementById('member-q');
      input.value = 'Eva Yuan';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(900);
  }
  const evaVisible = await page.evaluate(() => [...document.querySelectorAll('tbody tr')]
    .some(tr => /98887766/.test(tr.textContent || '') && tr.querySelector('input[id^="mn-"]')?.value === 'Eva Yuan'));
  ok('新建会员能按姓名搜索出来', evaVisible);
  await shot('member-created-search');
  const evaArchiveClicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tbody tr')].find(tr => /98887766/.test(tr.textContent || ''));
    const button = row && row.querySelector('button[id^="march-"]');
    if (!button) return false; button.click(); return true;
  });
  await sleep(400);
  ok('新会员可以点「归档」删除', evaArchiveClicked && /归档会员/.test(await bodyText()));
  await shot('member-archive-confirm');
  if (evaArchiveClicked) { await clickText(/仍然归档/); await sleep(1400); }
  const evaArchived = rows(`SELECT archived_at FROM members WHERE phone='98887766'`)[0];
  const evaHidden = await page.evaluate(() => ![...document.querySelectorAll('tbody tr')]
    .some(tr => /98887766/.test(tr.textContent || '')));
  ok('归档后默认搜索结果隐藏会员', !!evaArchived?.archived_at && evaHidden);
  await page.evaluate(() => document.getElementById('member-arch')?.click());
  await sleep(1000);
  const evaRecoverable = await page.evaluate(() => [...document.querySelectorAll('tbody tr')]
    .some(tr => /98887766/.test(tr.textContent || '') && /已归档/.test(tr.textContent || '')));
  ok('显示已归档后仍能搜到，可恢复且账目保留', evaRecoverable);
  await shot('member-archived-search');

  await page.evaluate(() => window.membersView(true, '98765432', false)); await sleep(1000);

  const balBefore = +num(`SELECT balance FROM members WHERE phone='98765432'`);
  ok('点开「消费记录」', await clickText(/消费记录/));
  await sleep(1500);
  const led = await bodyText();
  ok('消费记录显示流水', /充值|消费|退款|流水/.test(led));
  ok('★ 消费记录里没有 undefined / NaN', !/undefined|NaN|\[object/.test(led),
    /undefined|NaN|\[object/.test(led) ? led.match(/.{0,40}(undefined|NaN|\[object).{0,20}/)?.[0] : '');
  await shot('member-ledger');

  await goHome(); await clickText(/会员/); await sleep(1200);
  ok('点开「调整余额」', await clickText(/调整余额/));
  await sleep(900);
  await shot('adjust-dialog');
  const dlg = await bodyText();
  ok('调整余额弹层出现', /金额|加|减|原因/.test(dlg));
  // ⚠️ 一定要关掉：弹层遮罩会挡住后面所有点击，第一版脚本忘了关，
  // 结果把"界面没做"和"我自己挡住了"混为一谈。
  await page.keyboard.press('Escape'); await sleep(500);
  const stillOpen = await page.evaluate(() => !!document.querySelector('.mask.show, .modal.show, dialog[open]'));
  ok('弹层能用 ESC 关掉', !stillOpen);

  // ── 历史储值：一键并入 ───────────────────────────────────────────────
  console.log('\n【历史储值】');
  await goHome();
  const hasPage = await clickText(/历史储值/);
  await sleep(1500);
  if (hasPage) {
    const t = await bodyText();
    ok('待认领名单列出老会员', /8740|87\*|王老太|待认领/.test(t));
    ok('★ 已登录的那位被标出来', /已登录|等待|privaterelay|wang@/i.test(t));
    await shot('legacy-list');

    const legacyBefore = +num(`SELECT balance FROM members WHERE phone='80000002'`);
    const totalBeforeMerge = +num(`SELECT ROUND(SUM(balance),2) FROM members WHERE balance>0`);
    const clicked = await clickText(/一键并入|并入账号|合并/);
    ok('点到「一键并入」', clicked);
    if (clicked) {
      await sleep(900); await shot('legacy-confirm');
      await clickText(/确认/); await sleep(2500);
      const after = +num(`SELECT balance FROM members WHERE phone='80000002'`);
      const acct = +num(`SELECT COALESCE(balance,0) FROM members WHERE user_id='u-wait'`);
      ok('★ 通过界面真的把钱并过去了', after === 0 && Math.abs(acct - legacyBefore) < 0.005,
        `legacy ${legacyBefore} → ${after}，账号 ${acct}`);
      ok('★ 审计留痕', +num(`SELECT COUNT(*) FROM legacy_merges WHERE status='committed'`) >= 1);
      ok('★ 总余额守恒', Math.abs(+num(`SELECT ROUND(SUM(balance),2) FROM members WHERE balance>0`) - totalBeforeMerge) < 0.01,
        String(num(`SELECT ROUND(SUM(balance),2) FROM members WHERE balance>0`)));
      await shot('legacy-after');
    }
  } else { ok('存在「历史储值」页', false, '老板点不到 —— 13 位老会员的钱还是拿不回来'); }

  // ── 审计记录 ────────────────────────────────────────────────────────
  console.log('\n【审计记录】');
  await goHome();
  // 别用 /审计/ 模糊点：会员充值页里有「充值审计（最近 60 笔）」，先被匹配到就会跳错页，
  // 然后这里报「审计页看不到合并」——那是我点错了，不是功能没了。先精确进页，再断言内容。
  let auditOk = await clickText(/^审计记录/);
  if (!auditOk) auditOk = await page.evaluate(() => {
    if (typeof window.auditLogView === 'function') { window.auditLogView(); return true; } return false; });
  await sleep(1800);
  if (auditOk) {
    const t = await bodyText();
    ok('★ 真的进到了审计记录页（不是别的页）', /审计记录|余额调整|履约推进/.test(t),
      t.replace(/\s+/g, ' ').slice(0, 60));
    ok('审计页能看到刚才的合并', /历史储值并入|legacy_merge|合并/.test(t));
    ok('★ 审计页没有 undefined / NaN', !/undefined|NaN|\[object/.test(t));
    await shot('audit');
  } else ok('存在「审计记录」页', false);

  // ── 全局体检 ────────────────────────────────────────────────────────
  console.log('\n【全局】');
  const finalTxt = await bodyText();
  ok('★ 页面无 JS 报错', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '));
  ok('★ 全页无 undefined/NaN/[object Object]', !/undefined|NaN|\[object Object\]/.test(finalTxt));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok('桌面宽度不横向溢出', !overflow);
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await sleep(800);
  const mOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  await shot('mobile');
  ok('手机宽度不横向溢出（表格自己滚不算）', !mOverflow, mOverflow ? '整页会横向拖动' : '');

  try {
    const keep = path.join(ROOT, '_qa', 'boss-ui');
    mkdirSync(keep, { recursive: true });
    for (const f of ['nav-会员', 'nav-历史储值', 'nav-审计记录', 'nav-储值台账', 'member-ledger',
      'topup-new-member', 'member-created-search', 'member-archive-confirm', 'member-archived-search',
      'adjust-dialog', 'legacy-list', 'legacy-confirm', 'legacy-after', 'audit', 'mobile', 'wallet-ledger']) {
      try { copyFileSync(path.join(persist, f + '.png'), path.join(keep, f + '.png')); } catch (e) {}
    }
    console.log('\n· 截图：' + keep);
  } catch (e) {}

  // ── 储值负债明细账 ────────────────────────────────────────────────────────
  console.log('\n【储值负债明细账】');
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,a')].find(x => /储值台账/.test(x.textContent || ''));
    if (b) b.click();
  });
  await sleep(1500);
  const ledger = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table.ledger')][0];
    if (!t) return null;
    const cell = label => {
      const row = [...t.querySelectorAll('tr')].find(r => (r.textContent || '').includes(label));
      if (!row) return null;
      const nums = [...row.querySelectorAll('.num')].map(n => n.textContent.trim());
      return nums;
    };
    return {
      headers: [...t.querySelectorAll('thead th')].map(h => h.textContent.trim()),
      total: cell('合计'), expected: cell('账面应剩'),
      actual: cell('会员余额合计'), diff: cell('差异'),
      rightAligned: [...t.querySelectorAll('td.num')].every(td =>
        getComputedStyle(td).textAlign === 'right'),
      tabular: getComputedStyle(t.querySelector('td.num')).fontVariantNumeric.includes('tabular-nums'),
    };
  });
  ok('★ 是一张借贷分列的账表', !!ledger && ledger.headers.some(h => h.includes('借方')) && ledger.headers.some(h => h.includes('贷方')),
    ledger ? ledger.headers.join(' / ') : '没渲染出来');
  ok('数字列右对齐且用等宽数字', !!ledger && ledger.rightAligned && ledger.tabular);
  const money = v => Number(String(v || '').replace(/,/g, '')) || 0;
  ok('★ 借贷合计与账面应剩自洽', !!ledger &&
    Math.abs((money(ledger.total?.[1]) - money(ledger.total?.[0])) - money(ledger.expected?.[1])) < 0.01,
    ledger ? `贷${ledger.total?.[1]} − 借${ledger.total?.[0]} vs 应剩${ledger.expected?.[1]}` : '');
  ok('★ 演示账套是平的（差异 0.00）', !!ledger && Math.abs(money(ledger.diff?.[1])) < 0.01,
    ledger ? `差异=${ledger.diff?.[1] || '(空)'}` : '');
  ok('★ 差异行写出数字而不是留白（留白会被读成「没算」）',
    !!ledger && /\d/.test(String(ledger.diff?.[1] || '')), `差异栏=「${ledger?.diff?.[1] ?? ''}」`);
  ok('已排除项都写了理由', await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table.ledger')];
    if (tables.length < 2) return true;   // 没有已排除项时不强求
    return [...tables[1].querySelectorAll('tbody tr')].every(r => (r.children[3]?.textContent || '').trim().length > 4);
  }));
  try { await page.screenshot({ path: path.join(persist, 'wallet-ledger.png'), fullPage: true }); } catch (e) {}

  // ── 商品标签 + 内容发布 ────────────────────────────────────────────────────
  console.log('\n【商品标签】');
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.querySelector('[data-admin-nav="tags"]')?.click());
  await sleep(900);
  ok('★ 进得去商品标签页', !!(await page.$('[data-tag-list]')));
  const seededTags = await page.$$eval('[data-tag-id]', els => els.map(e => e.dataset.tagId));
  ok('迁移种下的四个标签都在', ['new-arrival', 'low-cal-healthy', 'fresh-meat', 'meat-veg-balance'].every(id => seededTags.includes(id)),
    seededTags.join(','));

  await page.evaluate(() => {
    document.querySelector('[data-tag-input-id]').value = 'chef-pick';
    document.querySelector('[data-tag-input-cn]').value = '店长推荐';
    document.querySelector('[data-tag-input-en]').value = "Chef's pick";
    document.querySelector('[data-tag-input-tone]').value = 'gold';
    document.querySelector('[data-tag-input-icon]').value = '⭐';
  });
  await page.evaluate(() => document.querySelector('[data-save-tag]').click());
  await sleep(1200);
  ok('★ 新标签真的建出来了', !!(await page.$('[data-tag-id="chef-pick"]')));
  ok('保存后按钮恢复可点', await page.$eval('[data-save-tag]', el => !el.disabled));
  ok('★ 提示明确说了「还没上线」', /还没上线|草稿/.test(await page.$eval('[data-tag-message]', el => el.textContent)));

  // 非法输入：必须报错而不是静默吞掉
  await page.evaluate(() => {
    document.querySelector('[data-tag-input-id]').value = 'BAD ID';
    document.querySelector('[data-tag-input-cn]').value = '坏';
  });
  await page.evaluate(() => document.querySelector('[data-save-tag]').click());
  await sleep(900);
  ok('★ 非法标签 ID 有可见报错', /失败|无效|只可用/.test(await page.$eval('[data-tag-message]', el => el.textContent)));
  ok('报错后按钮仍可点（没卡死）', await page.$eval('[data-save-tag]', el => !el.disabled));

  // 挂标签：按点击顺序
  await page.evaluate(() => { const sel = document.querySelector('[data-assign-sku]'); sel.value = 'S01'; sel.dispatchEvent(new Event('change')); });
  await sleep(400);
  await page.evaluate(() => document.querySelector('[data-tag-chip="chef-pick"]')?.click());
  await page.evaluate(() => document.querySelector('[data-tag-chip="fresh-meat"]')?.click());
  await page.evaluate(() => document.querySelector('[data-save-assignment]').click());
  await sleep(1000);
  const assigned = rows("SELECT tag_id FROM product_tag_assignments WHERE sku='S01' ORDER BY sort").map(r => r.tag_id);
  ok('★ 标签按点击顺序挂到了商品上', assigned.join(',') === 'chef-pick,fresh-meat', assigned.join(','));

  const beforePublish = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  ok('★ 改草稿【没有】动线上版本', beforePublish === bootstrapRelease, String(beforePublish));

  console.log('\n【内容发布】');
  await page.evaluate(() => document.querySelector('[onclick="dash()"]')?.click());
  await sleep(700);
  await page.evaluate(() => document.querySelector('[data-admin-nav="publication"]')?.click());
  await sleep(1000);
  ok('★ 进得去内容发布页', !!(await page.$('[data-publication-status]')));
  ok('页面显示线上版本与草稿版本',
    !!(await page.$('[data-live-revision]')) && !!(await page.$('[data-draft-revision]')));
  ok('★ 明说草稿不会自己上线', /不会自己上线/.test(await page.$eval('[data-publication-status]', el => el.textContent)));
  ok('★ 未核对前两个发布按钮都禁用', await page.$eval('[data-publish-now]', el => el.disabled) && await page.$eval('[data-schedule-release]', el => el.disabled));
  const reviewAndApprove = async () => {
    await page.click('[data-preview-release]');
    await page.waitForSelector('[data-approve-publication]', { timeout: 15000 });
    ok('★ 审批前展示完整变更', /本次将发布整站草稿/.test(await page.$eval('[data-publication-review]', el => el.textContent)));
    const link = await page.$eval('[data-reviewed-preview]', el => el.href);
    const preview = await browser.newPage(); await preview.bringToFront();
    const response = await preview.goto(link, { waitUntil: 'domcontentloaded' });
    ok('★ 签名页面预览可打开', response.status() === 200, String(response.status()));
    await preview.close(); await page.bringToFront();
    await page.click('[data-approve-publication]');
  };

  // 排程 → 取消
  await page.evaluate(() => { const input = document.querySelector('[data-effective-at]'); input.value = '2099-01-01T10:00'; input.dispatchEvent(new Event('change')); });
  await reviewAndApprove();
  ok('★ 定时审阅不能误点立即发布', await page.$eval('[data-publish-now]', el => el.disabled));
  await page.evaluate(() => document.querySelector('[data-schedule-release]').click());
  await sleep(1600);
  const scheduledRows = rows("SELECT id FROM public_content_releases WHERE status='scheduled'");
  ok('★ 定时发布真的排上了', scheduledRows.length === 1, String(scheduledRows.length));
  ok('排程提示带出了生效时间', /2099-01-01/.test(await page.$eval('[data-publication-message]', el => el.textContent)));
  ok('★ 排程【没有】让草稿上线',
    rows('SELECT active_release_id FROM public_content_state')[0].active_release_id === beforePublish);
  await page.evaluate(() => document.querySelector('[data-cancel-release]')?.click());
  await sleep(1400);
  ok('★ 排程可以取消', rows("SELECT COUNT(*) AS n FROM public_content_releases WHERE status='scheduled'")[0].n === 0);

  // 缺生效时间：定时按钮不可触发，页面说明立即发布需留空。
  await page.evaluate(() => { const input = document.querySelector('[data-effective-at]'); input.value = ''; input.dispatchEvent(new Event('change')); });
  ok('★ 没选时间定时按钮禁用', await page.$eval('[data-schedule-release]', el => el.disabled));
  ok('★ 改时间必须重新核对', /重新预览/.test(await page.$eval('[data-publication-message]', el => el.textContent)));

  // 立即发布
  await reviewAndApprove();
  await page.evaluate(() => document.querySelector('[data-publish-now]').click());
  await sleep(2200);
  const live = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  ok('★ 立即发布真的上线了', !!live && live !== bootstrapRelease, String(live));
  ok('★ 发布出去的商品行带上了新标签',
    JSON.parse(rows(`SELECT tags_json FROM public_content_release_products WHERE release_id='${live}' AND sku='S01'`)[0].tags_json)
      .some(t => t.id === 'chef-pick'));
  ok('发布提示带出了版本号', /已上线/.test(await page.$eval('[data-publication-message]', el => el.textContent)));

  // Select the actual bootstrap history, not the currently published row.
  ok('★ 当前版本没有误导性的回滚按钮', !(await page.$(`[data-rollback-release="${live}"]`)));
  ok('★ 原始历史版本可供选择', !!(await page.$(`[data-rollback-release="${bootstrapRelease}"]`)));
  await page.click(`[data-rollback-release="${bootstrapRelease}"]`);
  await sleep(2200);
  const afterRollback = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  ok('★ 回滚建的是【新】发布，不是改历史', afterRollback && afterRollback !== live, `${live} → ${afterRollback}`);
  ok('★ 任何时刻只有一个 published',
    rows("SELECT COUNT(*) AS n FROM public_content_releases WHERE status='published'")[0].n === 1);
  ok('历史那一版还在（没有被就地改写）',
    rows(`SELECT COUNT(*) AS n FROM public_content_releases WHERE id='${live}'`)[0].n === 1);
  const restoredSnapshot = rows(`SELECT checksum,snapshot_json FROM public_content_releases WHERE id='${afterRollback}'`)[0];
  ok('★ 回滚恢复了完整历史快照与checksum', restoredSnapshot.checksum === bootstrapSnapshot.checksum && restoredSnapshot.snapshot_json === bootstrapSnapshot.snapshot_json);
  ok('★ 回滚恢复历史标签而非保留新草稿标签', rows(`SELECT tags_json FROM public_content_release_products WHERE release_id='${afterRollback}' AND sku='S01'`)[0].tags_json === bootstrapTags);

  console.log('─────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (consoleErrs.length) { console.log('控制台错误：'); consoleErrs.slice(0, 5).forEach(e => console.log('  ', e)); }
  if (fails.length) { fails.forEach(f => console.log('  ✗', f)); process.exitCode = 1; }
}

main().catch(e => { console.error('\nUI 冒烟异常：', e); process.exitCode = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch (e) {}
    if (child) { try { child.kill('SIGTERM'); } catch (e) {} await sleep(600); try { child.kill('SIGKILL'); } catch (e) {} }
    if (!process.exitCode) { try { rmSync(persist, { recursive: true, force: true }); } catch (e) {} }
    else console.log('· 现场保留：' + persist);
     // wrangler 的本地代理/puppeteer 的子进程会吊住事件循环：macOS 上进程还是退了，
    // Linux CI 上会一直挂到 job 超时——一次 40 秒就失败的测试因此变成 25 分钟静默等待。
    // 跑完就强制退出，留 500ms 把输出刷干净。
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
