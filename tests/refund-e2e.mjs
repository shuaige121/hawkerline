// 退运费 / 退款 / 厨房闭环 的端到端 smoke —— 打真实的 wrangler dev + 真实的本地 D1。
//
// 不在 `npm test` 里（它要起服务、要几十秒），**部署前单独跑**：
//     node tests/refund-e2e.mjs
//
// 设计要点：
//   · 全程只用【本地】D1，自建自播种，跑完即删。有两道闸拒绝对生产运行。
//   · 主链路故意用「全额储值支付」的订单 —— 这样退款路径完全不需要碰 Stripe，
//     能在没有任何真实密钥的情况下把资金流验到底。
//   · Stripe 那一侧单独验「没配密钥时必须 fail closed（manual_required）」，
//     绝不会向 api.stripe.com 发出任何请求。
//   · 必须 --local-protocol https，否则 /api/* 会被 assets 吞掉全部 404（踩过）。

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = `https://127.0.0.1:${PORT}`;
const ADMIN = 'testadmin';
const AUTH_SECRET = 'e2e-auth-secret';
let STAFF = null;   // 由 /api/pos/login 换取
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // wrangler dev 自签证书

// ── 双重闸门：绝不对生产运行 ────────────────────────────────────────────────
if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN) {
  // 有 token 时 wrangler 可能被诱导走 --remote，直接拒绝跑
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
}
if (process.argv.includes('--remote')) {
  console.error('拒绝执行：这个脚本只允许对本地 D1 运行。');
  process.exit(1);
}

const persist = mkdtempSync(path.join(tmpdir(), 'hl-e2e-'));
let child = null;
let passed = 0;
const failures = [];

const d1 = (sql) => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline',
  '--local', '--persist-to', persist, '--json', '--command', sql],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const d1json = (sql) => { const o = JSON.parse(d1(sql)); return o[0].results; };

const check = (name, fn) => {
  try { const r = fn(); if (r instanceof Promise) return r.then(
    () => { passed++; console.log('  ✅', name); },
    (e) => { failures.push(name); console.log('  ❌', name, '\n     ', e.message); });
    passed++; console.log('  ✅', name);
  } catch (e) { failures.push(name); console.log('  ❌', name, '\n     ', e.message); }
};

const api = async (p, { method = 'GET', token, staff, body, headers = {} } = {}) => {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (staff) h.authorization = `Bearer ${staff}`;
  let r = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); break; }
    catch (error) {
      // An external `wrangler d1 execute` can briefly reload local Miniflare and
      // reset its self-signed HTTPS socket. All money mutations exercised here
      // are idempotent, so retrying the exact request is the faithful browser case.
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUp(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(BASE + '/api/menu'); if (r.ok) return true; } catch (e) {}
    await sleep(700);
  }
  return false;
}

// ── 播种 ────────────────────────────────────────────────────────────────────
const OID = '11111111-2222-3333-4444-555555555555';
const OID2 = '22222222-3333-4444-5555-666666666666';
const UID = 'user-e2e-0001';
// 播种时刻必须跟真实时钟走：厨房看板只显示 SGT 当天，写死日期的种子第二天就让
// 一整段断言变红（2026-08-10 早上就是这么发现的）。发票号也跟着当天走。
const NOW = new Date().toISOString();
const SGT_DATE = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const SGT_DAY = SGT_DATE.replace(/-/g, '');

function seed() {
  console.log('· 建库 + 播种（本地 D1）');
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('${UID}','91234567','测试顾客','${NOW}','${NOW}')`);
  d1(`INSERT INTO members (phone,user_id,balance,points,total_spent,orders_count,created_at,updated_at)
      VALUES ('91234567','${UID}',200,0,0,0,'${NOW}','${NOW}')`);

  // 订单 A：全额储值支付、含运费 10 —— 主链路（不碰 Stripe）
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,pay_provider,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total)
      VALUES ('${OID}','HL-${SGT_DAY}-0001','${NOW}','测试顾客','91234567','${UID}','[]',50,10,
        60,'anytime','balance','PAID','${NOW}',60,'new',0)`);

  // 订单 B：需要走 Stripe 的单（pay_provider=stripe、没有储值抵扣）——用来验 fail closed
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,pay_provider,pay_ref,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total)
      VALUES ('${OID2}','HL-${SGT_DAY}-0002','${NOW}','测试顾客','91234567','${UID}','[]',50,10,
        60,'anytime','stripe','cs_test_x','PAID','${NOW}',0,'new',0)`);

  // 收银员 PIN：STAFF_TOKEN 不是裸 token —— 店员要先 /api/pos/login 换一个签名 token。
  // 这里按 worker 的 hashPassword 同参数（PBKDF2-SHA256 / 10 万次 / 32 字节）现算一个。
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const pinHash = pbkdf2Sync('123456', Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
  d1(`INSERT INTO pos_pins (cashier,pin_hash,pin_salt,updated_at) VALUES ('pos1','${pinHash}','${salt}','${NOW}')
      ON CONFLICT(cashier) DO UPDATE SET pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt`);

  // 专门给「账本口径」用的干净会员：测试全程不动它的钱，所以充值/消费/余额三者恒自洽。
  // 主会员 UID 在测试里会被退款和调账改来改去，拿它验对账等于验一个移动靶。
  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('u-ledger','93330000','账本样本','${NOW}','${NOW}')`);
  d1(`INSERT INTO members (phone,user_id,name,balance,created_at,updated_at) VALUES ('93330000','u-ledger','账本样本',70,'${NOW}','${NOW}')`);
  d1(`INSERT INTO topups (id,phone,user_id,amount,bonus,credited,pay_method,pay_status,created_at) VALUES ('tp-led','93330000','u-ledger',100,0,100,'cash','PAID','${NOW}')`);
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,pay_provider,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total)
      VALUES ('77777777-7777-4777-8777-777777777777','HL-${SGT_DAY}-0009','${NOW}','账本样本','93330000','u-ledger','[]',30,0,
        30,'pickup','balance','PAID','${NOW}',30,'done',0)`);

  d1(`INSERT INTO telegram_subscribers (chat_id,name,added_at) VALUES ('999','老板','${NOW}')`);
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('telegram_webhook_secret','e2esecret','${NOW}')`);
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('KITCHEN_PASSWORD','kitchen123','${NOW}')`);
  // 故意【不】配 telegram_bot_token 与 STRIPE_SECRET_KEY：
  // 这样 callback 逻辑照跑但不会向 api.telegram.org / api.stripe.com 发任何请求。
}

async function main() {
  seed();

  console.log('· 启动 wrangler dev（--local-protocol https，否则 /api 会被 assets 吞掉）');
  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist,
    '--port', String(PORT), '--local-protocol', 'https',
    // 显式传：本机原来是从未跟踪的 .dev.vars 里白捡 AUTH_SECRET 的，
    // 新克隆的仓库和 CI 上没有那个文件，signStaffToken 会抛 → POS 登录 500。
    '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', `AUTH_SECRET:${AUTH_SECRET}`],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const logPath = path.join(persist, 'wrangler.log');
  const log = createWriteStream(logPath);
  // stdout 和 stderr 都 pipe 到同一个流时，【谁先结束谁就把流 end() 掉】，
  // 另一个再写就是 ERR_STREAM_WRITE_AFTER_END，而且它以 unhandled 'error' 抛出 → 整个测试红。
  // macOS 上顺序碰巧良性，Linux CI 上翻车：一个只改了文档的 commit 也会红。
  // { end:false } 让两条流都不去 end 它；再兜一个 error handler，写日志失败绝不该弄红测试。
  log.on('error', () => {});
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.on('exit', (c, sig) => { if (c !== 0 && c !== null) console.error(`\n⚠️ wrangler dev 退出 code=${c} sig=${sig}，日志：${logPath}`); });
  process.on('exit', () => { try { console.error('--- wrangler 日志尾部 ---\n' + readFileSync(logPath,'utf8').split('\n').slice(-40).join('\n')); } catch(e){} });

  if (!await waitUp()) throw new Error('wrangler dev 没能起来');
  console.log('· 服务就绪');

  // 店员先登录换 token（STAFF_TOKEN 是 HMAC 签发的，不是环境变量里的裸串）
  const login = await api('/api/pos/login', { method: 'POST', body: { cashier: 'pos1', pin: '123456' } });
  if (!login.body || !login.body.token) throw new Error('POS 登录失败：' + JSON.stringify(login.body));
  STAFF = login.body.token;
  console.log('· 收银员已登录\n');

  // ── 1. 退运费主链路（全额储值单，零 Stripe 依赖）──────────────────────────
  console.log('【退运费 · 老板后台】');
  const before = d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;

  const r1 = await api('/api/admin/refund-delivery-fee', { method: 'POST', token: ADMIN, body: { order_id: OID } });
  check('退运费返回 ok', () => assert.equal(r1.status, 200, JSON.stringify(r1.body)));
  check('退款金额 = 运费 10', () => assert.equal(r1.body.refunded, 10));
  check('全额储值单 → 全部退回储值，Stripe 侧 0', () => {
    assert.equal(r1.body.balance_amount, 10);
    assert.equal(r1.body.stripe_amount, 0);
  });

  const after = d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;
  check('会员余额真的加回了 10', () => assert.equal(+(after - before).toFixed(2), 10));

  const o = d1json(`SELECT pay_status, refunded_total FROM orders WHERE id='${OID}'`)[0];
  check('★ 订单仍是 PAID（退运费绝不能把订单打成 REFUNDED 锁死）', () => assert.equal(o.pay_status, 'PAID'));
  check('refunded_total 记为 10', () => assert.equal(+o.refunded_total, 10));

  const rf = d1json(`SELECT kind,status,amount,balance_amount,idem_key,actor FROM order_refunds WHERE order_id='${OID}'`);
  check('order_refunds 落一行 succeeded', () => {
    assert.equal(rf.length, 1);
    assert.equal(rf[0].kind, 'delivery_fee');
    assert.equal(rf[0].status, 'succeeded');
    assert.equal(rf[0].actor, 'admin');
  });
  const we = d1json(`SELECT type,amount FROM wallet_events WHERE order_id='${OID}'`);
  check('钱包流水写了一笔 +10 refund', () => {
    assert.equal(we.length, 1);
    assert.equal(we[0].type, 'refund');
    assert.equal(+we[0].amount, 10);
  });

  // ── 2. 幂等：再点一次不能再退一次 ───────────────────────────────────────
  const r2 = await api('/api/admin/refund-delivery-fee', { method: 'POST', token: ADMIN, body: { order_id: OID } });
  const after2 = d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;
  check('★ 重复退运费不会二次扣钱', () => assert.equal(after2, after));
  check('重复退运费返回去重标记或明确拒绝', () => {
    assert.ok(r2.body && (r2.body.deduped === true || r2.body.error), JSON.stringify(r2.body));
  });
  check('order_refunds 仍然只有一行', () => {
    assert.equal(d1json(`SELECT id FROM order_refunds WHERE order_id='${OID}'`).length, 1);
  });

  // ── 3. Stripe 单在没有密钥时必须 fail closed ───────────────────────────
  console.log('\n【Stripe 侧 fail closed】');
  const r3 = await api('/api/admin/refund-delivery-fee', { method: 'POST', token: ADMIN, body: { order_id: OID2 } });
  check('★ 没配 Stripe 密钥 → 拒绝并要求人工处理，不静默成功', () => {
    assert.notEqual(r3.status, 200, JSON.stringify(r3.body));
    assert.ok(String(r3.body.error || '').length > 0);
  });
  const o2 = d1json(`SELECT pay_status, refunded_total FROM orders WHERE id='${OID2}'`)[0];
  check('★ 失败时订单状态不变、没记已退金额（可重试）', () => {
    assert.equal(o2.pay_status, 'PAID');
    assert.equal(+o2.refunded_total, 0);
  });
  const rf2 = d1json(`SELECT status FROM order_refunds WHERE order_id='${OID2}'`);
  check('失败留痕为 manual_required 而不是 succeeded', () => {
    assert.equal(rf2.length, 1);
    assert.notEqual(rf2[0].status, 'succeeded');
  });

  // ── 4. 鉴权 ────────────────────────────────────────────────────────────
  console.log('\n【鉴权】');
  const noTok = await api('/api/admin/refund-delivery-fee', { method: 'POST', body: { order_id: OID } });
  check('无 token 退运费 → 401', () => assert.equal(noTok.status, 401));

  const posOk = await api('/api/pos/refund-delivery-fee', { method: 'POST', staff: STAFF, body: { order_id: OID } });
  check('收银台端点认 STAFF_TOKEN（这单已退，应返业务错误而非 401）', () => assert.notEqual(posOk.status, 401));

  // 老板关掉收银台退款权限
  const settingsBefore = await api('/api/admin/settings', { token: ADMIN });
  const settingsOff = await api('/api/admin/settings', { method: 'POST', token: ADMIN,
    body: { pos_refund_delivery_fee: '0', base_revision: settingsBefore.body.settings_revision } });
  check('资金开关保存通过设置版本 CAS', () => assert.equal(settingsOff.status, 200));
  const posOff = await api('/api/pos/refund-delivery-fee', { method: 'POST', staff: STAFF, body: { order_id: OID2 } });
  check('★ 老板关掉权限后，收银台退款被拒 403', () => {
    assert.equal(posOff.status, 403);
    assert.equal(posOff.body.code, 'pos_refund_disabled');
  });
  await api('/api/admin/settings', { method: 'POST', token: ADMIN,
    body: { pos_refund_delivery_fee: '1', base_revision: settingsOff.body.settings_revision } });

  // ── 5. 顾客侧制作进度 ──────────────────────────────────────────────────
  console.log('\n【顾客侧制作进度】');
  const st = await api(`/api/order/${OID}/status`);
  check('状态接口可读', () => assert.equal(st.status, 200));
  check('状态为 new / 已下单', () => assert.equal(st.body.status, 'new'));
  check('★ 状态接口零 PII（不含姓名/电话/地址/金额）', () => {
    const keys = Object.keys(st.body);
    for (const leak of ['customer_name', 'phone', 'address', 'total', 'items_json', 'paid_by_balance']) {
      assert.ok(!keys.includes(leak), `泄露字段：${leak}`);
    }
  });
  const arr = await api(`/api/order/${OID}/arrived`, { method: 'POST' });
  check('「我到店了」可写', () => assert.equal(arr.status, 200));
  const arr2 = await api(`/api/order/${OID}/arrived`, { method: 'POST' });
  check('「我到店了」只记一次', () => assert.ok(arr2.body.deduped === true || arr2.body.arrived === true));

  // ── 6. Telegram callback 三层鉴权 ──────────────────────────────────────
  console.log('\n【Telegram callback 鉴权】');
  const tg = (payload, secret) => api('/api/telegram/webhook', {
    method: 'POST', body: payload,
    headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
  });
  const cb = (data, chat = '999') => ({ callback_query: { id: 'cb1', data, message: { message_id: 1, chat: { id: chat } } } });

  const bad = await tg(cb('k:preparing:' + OID), 'WRONG');
  check('★ 错的 webresource secret → 403（不处理）', () => assert.equal(bad.status, 403));
  check('订单状态未被推进', () => assert.equal(d1json(`SELECT fulfil_status f FROM orders WHERE id='${OID}'`)[0].f, 'new'));

  const notSub = await tg(cb('k:preparing:' + OID, '12345'), 'e2esecret');
  check('★ 非白名单 chat_id → 不处理', () => assert.equal(notSub.status, 200));
  check('订单状态仍未被推进', () => assert.equal(d1json(`SELECT fulfil_status f FROM orders WHERE id='${OID}'`)[0].f, 'new'));

  const junk = await tg(cb('DROP TABLE orders'), 'e2esecret');
  check('★ 不合规 callback_data → 丢弃', () => assert.equal(junk.status, 200));
  check('订单表还在', () => assert.ok(d1json(`SELECT COUNT(*) c FROM orders`)[0].c >= 2));

  const good = await tg(cb('k:preparing:' + OID), 'e2esecret');
  check('合法 callback 被接受', () => assert.equal(good.status, 200));
  check('★ 厨房状态推进到 preparing', () =>
    assert.equal(d1json(`SELECT fulfil_status f FROM orders WHERE id='${OID}'`)[0].f, 'preparing'));

  await tg(cb('k:ready:' + OID), 'e2esecret');
  check('可以继续推进到 ready', () =>
    assert.equal(d1json(`SELECT fulfil_status f FROM orders WHERE id='${OID}'`)[0].f, 'ready'));
  await tg(cb('k:preparing:' + OID), 'e2esecret');
  check('★ 状态只前进不后退（ready 不会被打回 preparing）', () =>
    assert.equal(d1json(`SELECT fulfil_status f FROM orders WHERE id='${OID}'`)[0].f, 'ready'));

  const ev = d1json(`SELECT type FROM order_events WHERE order_id='${OID}'`);
  check('推进写了 order_events 审计', () => assert.ok(ev.length >= 2, JSON.stringify(ev)));

  // ── 6b. Telegram 退运费按钮全链路（老板点的就是这条）───────────────────
  console.log('\n【Telegram 退运费按钮】');
  const OID3 = '33333333-4444-5555-6666-777777777777';
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,pay_provider,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total)
      VALUES ('${OID3}','HL-${SGT_DAY}-0003','${NOW}','测试顾客','91234567','${UID}','[]',40,12,
        52,'anytime','balance','PAID','${NOW}',52,'new',0)`);
  const balB4 = d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;

  const step1 = await tg(cb('rdf:' + OID3), 'e2esecret');
  check('第一次点「退运费」被接受', () => assert.equal(step1.status, 200));
  check('★ 第一步只做二次确认，一分钱都不能动', () =>
    assert.equal(d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance, balB4));
  check('★ 第一步不产生退款记录', () =>
    assert.equal(d1json(`SELECT id FROM order_refunds WHERE order_id='${OID3}'`).length, 0));

  const cancel = await tg(cb('rdfn:' + OID3), 'e2esecret');
  check('取消被接受', () => assert.equal(cancel.status, 200));
  check('★ 取消后仍然没动钱', () =>
    assert.equal(d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance, balB4));

  const confirm = await tg(cb('rdfy:' + OID3), 'e2esecret');
  check('确认退运费被接受', () => assert.equal(confirm.status, 200));
  const balAfterTg = d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;
  check('★ Telegram 确认后真的退了运费 12 元', () =>
    assert.equal(+(balAfterTg - balB4).toFixed(2), 12), );
  const o3 = d1json(`SELECT pay_status,refunded_total FROM orders WHERE id='${OID3}'`)[0];
  check('★ Telegram 退运费后订单仍是 PAID', () => assert.equal(o3.pay_status, 'PAID'));
  check('refunded_total = 12', () => assert.equal(+o3.refunded_total, 12));
  const rf3 = d1json(`SELECT actor,kind,status FROM order_refunds WHERE order_id='${OID3}'`);
  check('退款记录标明来自 Telegram', () => {
    assert.equal(rf3.length, 1);
    assert.equal(rf3[0].kind, 'delivery_fee');
    assert.ok(String(rf3[0].actor).startsWith('telegram:'), rf3[0].actor);
  });
  const again = await tg(cb('rdfy:' + OID3), 'e2esecret');
  check('★ 再点一次不会二次退款', () => {
    assert.equal(again.status, 200);
    assert.equal(d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance, balAfterTg);
    assert.equal(d1json(`SELECT id FROM order_refunds WHERE order_id='${OID3}'`).length, 1);
  });
  const notSubRefund = await tg(cb('rdfy:' + OID, '55555'), 'e2esecret');
  check('★ 非白名单 chat 点退款 → 不执行', () => assert.equal(notSubRefund.status, 200));
  check('★ 非白名单没能退成', () =>
    assert.equal(d1json(`SELECT id FROM order_refunds WHERE order_id='${OID}' AND kind='delivery_fee'`).length, 1));

  // ── 6c. 厨房看板（挂墙平板直接接单/出餐）─────────────────────────────────
  console.log('\n【厨房看板】');
  const klogin = await api('/api/kitchen/login', { method: 'POST', body: { password: 'kitchen123' } });
  const KTOK = klogin.body && klogin.body.token;
  check('厨房能登录拿到 token', () => assert.ok(KTOK, JSON.stringify(klogin.body)));

  const noAuth = await api('/api/kitchen/board');
  check('★ 厨房看板未鉴权 → 401', () => assert.equal(noAuth.status, 401));

  const board = await api('/api/kitchen/board', { token: KTOK });
  check('厨房看板可读', () => assert.equal(board.status, 200));
  // ⚠️ 下面两条是全称命题：空数组上恒真。先钉住「必须非空」，否则它们只是假绿。
  check('看板列出今天要做的单（非空）', () => {
    assert.ok(Array.isArray(board.body.orders));
    assert.ok(board.body.orders.length > 0, '看板是空的，后面的全称断言全部无效');
  });
  check('★ 看板不含已完成的单', () => {
    assert.ok(board.body.orders.length > 0);
    assert.ok(board.body.orders.every(o => o.fulfil_status !== 'done'));
  });
  check('★ 看板零 PII（不含电话/地址/金额）', () => {
    assert.ok(board.body.orders.length > 0);
    for (const o of board.body.orders || []) {
      for (const leak of ['phone', 'address', 'total', 'paid_by_balance']) {
        assert.ok(!(leak in o), `泄露字段 ${leak}`);
      }
    }
  });

  const target = (board.body.orders || []).find(o => o.fulfil_status === 'new');
  if (target) {
    const adv = await api('/api/kitchen/board/advance', { method: 'POST', token: KTOK,
      body: { order_id: target.id, to: 'preparing' } });
    check('★ 厨房能把订单推进到「制作中」', () => {
      assert.equal(adv.status, 200);
      assert.equal(adv.body.status, 'preparing');
    });
    check('数据库里真的变了', () =>
      assert.equal(d1json(`SELECT fulfil_status f FROM orders WHERE id='${target.id}'`)[0].f, 'preparing'));
    const back = await api('/api/kitchen/board/advance', { method: 'POST', token: KTOK,
      body: { order_id: target.id, to: 'new' } });
    check('★ 厨房也不能让状态倒退', () => assert.notEqual(back.status, 200));
    const bad = await api('/api/kitchen/board/advance', { method: 'POST', token: KTOK,
      body: { order_id: target.id, to: 'hacked' } });
    check('★ 非法状态被拒', () => assert.notEqual(bad.status, 200));
  } else {
    check('看板里有 new 状态的单可推进', () => assert.fail('种子数据里没有 new 单'));
  }

  // ── 6d. 老板端：扣款 / 消费记录 / 归档（老板反馈的三个缺口）──────────────
  console.log('\n【老板端 · 会员管理】');
  const balNow = () => d1json(`SELECT balance FROM members WHERE user_id='${UID}'`)[0].balance;
  const b0 = balNow();

  // 扣款
  const sub = await api('/api/admin/member-balance-adjust', { method: 'POST', token: ADMIN,
    body: { user_id: UID, action: 'subtract', amount: 5, note: '验收扣款', client_token: 'adj-1' } });
  check('★ 老板能扣会员余额', () => { assert.equal(sub.status, 200, JSON.stringify(sub.body)); assert.equal(sub.body.delta, -5); });
  check('余额真的少了 5', () => assert.equal(+(b0 - balNow()).toFixed(2), 5));
  check('★ 扣款写进 wallet_events（台账能看到）', () => {
    const ev = d1json(`SELECT type,amount FROM wallet_events WHERE ref='balance_adjust:adj-1'`);
    assert.equal(ev.length, 1); assert.equal(ev[0].type, 'adjustment'); assert.equal(+ev[0].amount, -5);
  });
  const again2 = await api('/api/admin/member-balance-adjust', { method: 'POST', token: ADMIN,
    body: { user_id: UID, action: 'subtract', amount: 5, note: '验收扣款', client_token: 'adj-1' } });
  check('★ 同一令牌重复提交不会扣两次', () => {
    assert.equal(again2.body.deduped, true);
    assert.equal(+(b0 - balNow()).toFixed(2), 5);
  });
  const over = await api('/api/admin/member-balance-adjust', { method: 'POST', token: ADMIN,
    body: { user_id: UID, action: 'subtract', amount: 99999, client_token: 'adj-2' } });
  check('★ 余额不许扣成负数', () => { assert.equal(over.status, 400); assert.match(String(over.body.error), /余额不足/); });
  const add = await api('/api/admin/member-balance-adjust', { method: 'POST', token: ADMIN,
    body: { user_id: UID, action: 'add', amount: 5, note: '退回', client_token: 'adj-3' } });
  check('老板也能加余额', () => { assert.equal(add.status, 200); assert.equal(add.body.delta, 5); });
  check('加回来后余额复原', () => assert.equal(balNow(), b0));
  const noTokAdj = await api('/api/admin/member-balance-adjust', { method: 'POST', token: ADMIN,
    body: { user_id: UID, action: 'subtract', amount: 1 } });
  check('★ 缺幂等令牌被拒（动钱必须带）', () => assert.equal(noTokAdj.status, 400));

  // 消费记录
  const led = await api(`/api/admin/member-ledger?user_id=u-ledger`, { token: ADMIN });
  check('★ 老板能看到会员消费记录', () => assert.equal(led.status, 200, JSON.stringify(led.body)));
  check('记录里有订单', () => assert.ok((led.body.orders || []).length > 0));
  check('记录里有资金流水', () => assert.ok((led.body.wallet.entries || []).length > 0));
  check('★ 后台账本与顾客端同一口径（余额能自校验）', () => {
    // 充值 100 − 消费 30 = 余额 70，三者必须对得上；对不上就说明两端账本口径漂了
    assert.equal(led.body.wallet.balance_after_reliable, true,
      `computed=${led.body.wallet.computed_balance} vs balance=${led.body.member.balance}`);
    assert.equal(led.body.wallet.computed_balance, 70);
  });
  check('★ 账本对不上时会如实降级，不显示错余额', () => {
    // UID 那位在测试里被退款/调账改过，余额与流水本来就不自洽 —— 必须被判为不可靠
    return api(`/api/admin/member-ledger?user_id=${UID}`, { token: ADMIN }).then(r => {
      assert.equal(r.body.wallet.balance_after_reliable, false);
      assert.ok((r.body.wallet.entries || []).every(e => !('balance_after' in e)),
        '不可靠时绝不能吐出 balance_after');
    });
  });
  const ledNo = await api(`/api/admin/member-ledger?user_id=nobody`, { token: ADMIN });
  check('查不存在的会员 → 404', () => assert.equal(ledNo.status, 404));

  // CRM 备注不是只画在页面上的输入框：保存、清洗、搜索必须贯通真实 D1。
  const savedMember = await api('/api/admin/member-save', { method: 'POST', token: ADMIN,
    body: { user_id: UID, phone: '91234567', name: '测试顾客', birthday: null,
      admin_note: '  不要辣  \r\n\r\n\r\n  对花生过敏  ' } });
  check('★ 会员备注能保存到账号会员', () => {
    assert.equal(savedMember.status, 200, JSON.stringify(savedMember.body));
    assert.equal(d1json(`SELECT admin_note FROM members WHERE user_id='${UID}'`)[0].admin_note, '不要辣\n\n对花生过敏');
  });
  await api('/api/admin/member-save', { method: 'POST', token: ADMIN,
    body: { user_id: UID, phone: '91234567', name: '测试顾客', birthday: null } });
  check('★ 旧版页面没传备注字段时不会误清已有备注', () =>
    assert.equal(d1json(`SELECT admin_note FROM members WHERE user_id='${UID}'`)[0].admin_note, '不要辣\n\n对花生过敏'));
  const noteSearch = await api('/api/admin/members?q=' + encodeURIComponent('花生'), { token: ADMIN });
  check('★ 输入备注关键词能实时搜索到会员', () =>
    assert.ok((noteSearch.body.members || []).some(m => m.user_id === UID && /花生/.test(m.admin_note || ''))));

  const topupAudit = await api(`/api/admin/topups?q=u-ledger&method=cash&since=${SGT_DATE}&limit=1`, { token: ADMIN });
  check('★ 单个会员充值记录按账号过滤且带汇总', () => {
    assert.equal(topupAudit.status, 200, JSON.stringify(topupAudit.body));
    assert.equal(topupAudit.body.summary.count, 1);
    assert.equal(topupAudit.body.topups[0].user_id, 'u-ledger');
    assert.equal(+topupAudit.body.summary.credited, 100);
    assert.equal(topupAudit.body.has_more, false);
  });

  // 归档（「删除」）
  // 老板权限拉满：有余额也能归档。但那是店里欠顾客的钱，必须在审计里留下痕迹。
  const arcBusy = await api('/api/admin/member-archive', { method: 'POST', token: ADMIN,
    body: { user_id: UID, reason: '验收归档' } });
  check('★ 有余额的会员也能归档（老板说了算）', () => assert.equal(arcBusy.status, 200, JSON.stringify(arcBusy.body)));
  check('★ 但归档时的余额必须留在审计里', () => {
    assert.ok(+arcBusy.body.balance_at_archive > 0, '没记下归档时的余额');
    assert.match(String(arcBusy.body.warn || ''), /储值/, '没有提醒老板这笔钱还算负债');
    const row = d1json(`SELECT archive_reason FROM members WHERE user_id='${UID}'`)[0];
    assert.match(String(row.archive_reason), /余额 S\$/, '归档理由里没写余额');
  });
  // 归档完恢复回去，免得影响后面的断言
  await api('/api/admin/member-archive', { method: 'POST', token: ADMIN, body: { user_id: UID, restore: true } });
  d1(`INSERT INTO members (phone,name,balance,created_at,updated_at) VALUES ('90009000','待归档',0,'${NOW}','${NOW}')`);
  const arc = await api('/api/admin/member-archive', { method: 'POST', token: ADMIN,
    body: { phone: '90009000', reason: '重复注册' } });
  check('零余额会员可以归档', () => assert.equal(arc.status, 200));
  check('★ 归档不是删除：行还在，只是打了标记', () => {
    const row = d1json(`SELECT archived_at,archive_reason FROM members WHERE phone='90009000'`);
    assert.equal(row.length, 1, '会员行被真删了 —— 历史订单会变成孤儿');
    assert.ok(row[0].archived_at);
  });
  const list = await api('/api/admin/members', { token: ADMIN });
  check('★ 归档后默认列表里看不到（老板眼里"删掉了"）', () =>
    assert.ok(!(list.body.members || []).some(m => m.phone === '90009000')));
  const listAll = await api('/api/admin/members?include_archived=1', { token: ADMIN });
  check('加参数能查回来', () =>
    assert.ok((listAll.body.members || []).some(m => m.phone === '90009000')));
  const restore = await api('/api/admin/member-archive', { method: 'POST', token: ADMIN,
    body: { phone: '90009000', restore: true } });
  check('★ 归档可撤销', () => {
    assert.equal(restore.status, 200);
    assert.equal(d1json(`SELECT archived_at a FROM members WHERE phone='90009000'`)[0].a, null);
  });

  // ── 7. legacy 储值合并 ─────────────────────────────────────────────────
  console.log('\n【legacy 储值柜台合并】');
  d1(`INSERT INTO members (phone,balance,points,created_at,updated_at) VALUES ('98765432',88.50,5,'${NOW}','${NOW}')`);
  const look = await api('/api/pos/legacy-lookup?phone=98765432', { staff: STAFF });
  check('店员能查到 legacy 钱包', () => { assert.equal(look.status, 200); assert.equal(look.body.found, true); });
  check('★ 查询结果对手机号做掩码', () => assert.ok(/\*/.test(look.body.phone_mask)));

  const start = await api('/api/pos/legacy-claim-start', { method: 'POST', staff: STAFF, body: { phone: '98765432' } });
  check('店员能发起认领票据', () => assert.equal(start.status, 200));
  check('返回 6 位配对码', () => assert.match(String(start.body.pair_code), /^\d{6}$/));
  const balBefore = d1json(`SELECT balance FROM members WHERE phone='98765432'`)[0].balance;
  check('★ 发起票据不动任何钱', () => assert.equal(+balBefore, 88.5));

  // 老板不能跳过顾客绑定直接合并
  const early = await api('/api/admin/legacy-merge', { method: 'POST', token: ADMIN,
    body: { claim_id: start.body.claim_id, expected_balance: 88.5, client_token: 'ct-1' } });
  check('★ 顾客还没登录绑定 → 拒绝合并', () => assert.notEqual(early.status, 200));
  check('★ 钱仍未动', () =>
    assert.equal(+d1json(`SELECT balance FROM members WHERE phone='98765432'`)[0].balance, 88.5));

  console.log('\n─────────────────────────────────');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) { failures.forEach(f => console.log('  ✗', f)); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error('\n端到端测试异常：', e); process.exitCode = 1; })
  .finally(async () => {
    if (child) { try { child.kill('SIGTERM'); } catch (e) {} await sleep(600); try { child.kill('SIGKILL'); } catch (e) {} }
    try { rmSync(persist, { recursive: true, force: true }); } catch (e) {}
     // wrangler 的本地代理/puppeteer 的子进程会吊住事件循环：macOS 上进程还是退了，
    // Linux CI 上会一直挂到 job 超时——一次 40 秒就失败的测试因此变成 25 分钟静默等待。
    // 跑完就强制退出，留 500ms 把输出刷干净。
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
