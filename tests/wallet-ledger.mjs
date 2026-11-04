// 储值负债明细账：【写入之后仍然平】。
//
//     node tests/wallet-ledger.mjs
//
// 为什么单独一套：静态夹具平不能说明什么。这张表之前恰恰是被【写入路径】算错的
// —— 只退运费会写一条 wallet_events，而订单的 paid_by_balance 已经同步下调，
// 于是同一笔钱被记了两遍，账面凭空多出 S$90.80。
// 所以这里每做一笔真实的动钱操作，就重新拉一次对账，要求差异始终为 0.00。

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signSession } from '../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8809;
const BASE = `https://127.0.0.1:${PORT}`;
const ADMIN = 'wallet-ledger-admin';
const AUTH_SECRET = 'wallet-ledger-secret';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const persist = mkdtempSync(path.join(tmpdir(), 'hl-ledger-'));
let child = null;
let pass = 0; const fails = [];
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log('  ✅', n, extra ? `:: ${extra}` : ''); }
  else { fails.push(n); console.log('  ❌', n, extra ? `:: ${extra}` : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d1 = sql => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = sql => JSON.parse(d1(sql))[0].results;
const NOW = new Date().toISOString();

const api = async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(BASE + p, { method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN },
    body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d || {} };
};

// 每次写入后重新拉对账；顺带返回账面/实际，失败时能直接看出是哪一边动了
async function reconcile() {
  const { body } = await api('/api/admin/wallet-audit?range=all');
  const rec = body.reconciliation || {};
  return { diff: +(rec.diff ?? NaN), expected: rec.expected_outstanding,
    actual: rec.actual_outstanding, counted: rec.counted || [], excluded: rec.excluded || [] };
}
const balanced = async label => {
  const r = await reconcile();
  ok(label, Math.abs(r.diff) < 0.005, `账面 ${r.expected} / 实际 ${r.actual} / 差异 ${r.diff}`);
  return r;
};
// 「平」只有在【钱确实动过】之后才有意义。四步都没动钱的全绿是空转，
// 这个断言就是防止那种假绿。
const moved = (label, before, after, expect) => {
  const d = +(+after - +before).toFixed(2);
  ok(label, Math.abs(d - expect) < 0.005, `余额 ${before} → ${after}（变动 ${d}，预期 ${expect}）`);
};

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/robots.txt`); if (r.status) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}

async function main() {
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  // 一个干净的会员：余额全部来自后面的写入，起点必须是零
  d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES ('u-led','93330001','账本测试','${NOW}','${NOW}')`);
  d1(`INSERT INTO members (phone,user_id,name,balance,points,created_at,updated_at) VALUES ('93330001','u-led','账本测试',0,0,'${NOW}','${NOW}')`);

  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist, '--port', String(PORT),
    '--local-protocol', 'https', '--test-scheduled',
    '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', `AUTH_SECRET:${AUTH_SECRET}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(persist, 'wrangler.log'), { flags: 'a' });
  log.on('error', () => {});
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  if (!await waitUp()) throw new Error(`wrangler dev 没起来，日志见 ${path.join(persist, 'wrangler.log')}`);

  const start = await balanced('起点：空账本是平的');
  ok('起点余额为零', Math.abs(+start.actual) < 0.005, String(start.actual));

  // ① 充值：负债增加，账面与实际同步
  const topup = await api('/api/admin/topup', { method: 'POST',
    body: { phone: '93330001', amount: 100, pay_method: 'cash', client_token: 'led-topup-1' } });
  ok('充值成功', topup.status === 200, JSON.stringify(topup.body).slice(0, 100));
  const afterTopup = await balanced('① 充值后仍然平');
  ok('充值确实增加了负债', +afterTopup.actual > 100 - 0.005, String(afterTopup.actual));

  // ② 人工调整：wallet_events 里唯一「别处没记过」的一类
  const adj = await api('/api/admin/member-balance-adjust', { method: 'POST',
    // 有账号的会员按 user_id 认人；只有 legacy 会员才按手机号（phone AND user_id IS NULL）
    body: { user_id: 'u-led', action: 'subtract', amount: 20, reason: '账本测试扣减', client_token: 'led-adj-1' } });
  ok('人工调整成功', adj.status === 200, JSON.stringify(adj.body).slice(0, 100));
  const afterAdj = await balanced('② 人工调整后仍然平');
  moved('人工调整确实扣了钱', afterTopup.actual, afterAdj.actual, -20);

  // ③ 顾客用余额下单：消费抵扣
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const r = rows('SELECT active_release_id FROM public_content_state');
    if (r[0] && r[0].active_release_id) break;
    await sleep(500);
  }
  const rel = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  const memberToken = await signSession({ AUTH_SECRET }, 'u-led');
  const hours = JSON.stringify({ 0:['00:00','23:59'],1:['00:00','23:59'],2:['00:00','23:59'],
    3:['00:00','23:59'],4:['00:00','23:59'],5:['00:00','23:59'],6:['00:00','23:59'] }).replace(/'/g, "''");
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('business_hours','${hours}','${NOW}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
  await waitUp(); await sleep(800);
  const order = await fetch(`${BASE}/api/order`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer_name: '账本测试', phone: '93330001', fulfilment: 'pickup',
      pickup_point_id: 'main', items: [{ sku: 'S01', qty: 2 }], use_balance: true,
      token: memberToken, menu_revision: rel, client_token: 'led-order-1' }) });
  const od = await order.json().catch(() => ({}));
  ok('下单成功', od.ok === true, JSON.stringify(od).slice(0, 120));
  ok('★ 这一单真的用了储值', +(od.paid_by_balance || 0) > 0, `paid_by_balance=${od.paid_by_balance}`);
  const afterOrder = await balanced('③ 用余额下单后仍然平');
  moved('下单确实扣了储值', afterAdj.actual, afterOrder.actual, -(+od.paid_by_balance || 0));

  // ④ 只退运费：这条正是当初把账算重的路径
  if (od.id) {
    const feeRefund = await api('/api/admin/refund-delivery-fee', { method: 'POST',
      body: { order_id: od.id, client_token: 'led-fee-1' } });
    console.log('     · 退运费返回', feeRefund.status, JSON.stringify(feeRefund.body).slice(0, 90));
    await balanced('④ 只退运费后仍然平（历史上这里会凭空多出一笔）');
  }

  // ④b 只退运费：这条是当初把账算重的【确切】路径 —— 它会写一条 wallet_events，
  //     而订单的 paid_by_balance 同时被下调，两边都记就等于同一笔钱算两遍。
  //     自取单没有运费可退，所以这里造一张带运费、且用储值付过的配送单。
  {
    const oid = 'led-fee-order';
    d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,
          subtotal,delivery_fee,discount,service_charge,service_charge_rate,gst,gst_rate,gst_registered,
          promo_code,promo_claimed,paid_by_balance,total,fulfilment,address,pay_provider,pay_ref,pay_status,paid_at,client_token)
        VALUES ('${oid}','HL-LEDGER-0002','${NOW}','账本测试','93330001','u-led','[]',
          10,5,0,0,0,0,0,0,NULL,0,15,15,'anytime','S(123456) 测试地址','balance','led-fee','PAID','${NOW}','led-fee-seed')`);
    d1(`UPDATE members SET balance=ROUND(balance-15,2), updated_at='${NOW}' WHERE user_id='u-led'`);
    await waitUp(); await sleep(800);
    const seeded = await balanced('④b 造好带运费的储值单后账仍然平');

    const feeOnly = await api('/api/admin/refund-delivery-fee', { method: 'POST',
      body: { order_id: oid, client_token: 'led-fee-only-1' } });
    ok('只退运费成功', feeOnly.status === 200, JSON.stringify(feeOnly.body).slice(0, 120));
    const afterFee = await balanced('★ 只退运费后仍然平（历史上这里会凭空多出一笔）');
    moved('★ 运费真的退回了储值', seeded.actual, afterFee.actual, 5);
    // 只退运费【必须计入】：订单没有置 balance_refunded_at，仍算在「已消费」里，
    // 不把这笔退回加回来，账面就会少 5 元。整单退款才是要排除的那一类。
    const counted = afterFee.counted.find(x => x.key === 'refund');
    ok('★ 只退运费被【计入】而不是当成整单退款排除掉',
      !!counted && counted.amount >= 5 - 0.005,
      counted ? `${counted.label} ${counted.rows} 笔 ${counted.amount}` : '没归类');
  }

  // ⑤ 整单退款（含退储值）
  if (od.id) {
    const before = await reconcile();
    const refund = await api('/api/admin/order-refund', { method: 'POST',
      body: { order_id: od.id, reason: '账本测试', client_token: 'led-refund-1' } });
    console.log('     · 整单退款返回', refund.status, JSON.stringify(refund.body).slice(0, 90));
    const afterRefund = await balanced('⑤ 整单退款后仍然平');
    moved('★ 退款把储值退回了会员', before.actual, afterRefund.actual, +(od.paid_by_balance || 0));
  }

  // ⑥ 历史钱包并入：对【这个会员】是真实变动，必须出现在他自己的流水里。
  //    藏起来的话，流水累加不回余额 → reliable=false → 结存列整列消失。
  //    （全店汇总里它仍然要排除：会员之间挪账，总额净零。）
  {
    const legacyPhone = '93330002';
    d1(`INSERT INTO members (phone,name,balance,points,created_at,updated_at)
        VALUES ('${legacyPhone}','历史钱包',60,0,'${NOW}','${NOW}')`);
    // 余额必须有来源。直接塞一个没有充值记录的余额，全店汇总就会如实报不平
    // —— 上一版这里就漏了，断言立刻抓到了，正是它该干的事。
    d1(`INSERT INTO topups (id,phone,amount,bonus,credited,pay_method,pay_status,cashier,created_at,note)
        VALUES ('tp-legacy-60','${legacyPhone}',60,0,60,'cash','PAID','pos1','${NOW}','历史钱包期初')`);
    // 直接写入并入事件 + 余额转移，等价于柜台完成合并后的落库状态
    d1(`UPDATE members SET balance=ROUND(balance+60,2), updated_at='${NOW}' WHERE user_id='u-led'`);
    d1(`UPDATE members SET balance=0, updated_at='${NOW}' WHERE phone='${legacyPhone}' AND user_id IS NULL`);
    d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES ('we-legacy-1','legacy_merge','legacy_merge:93330002',NULL,'93330001','u-led',60,'${NOW}','历史钱包并入')`);
    await waitUp(); await sleep(800);

    const afterMerge = await balanced('⑥ 历史钱包并入后全店汇总仍然平');
    const transfer = afterMerge.excluded.find(x => x.key === 'transfer');
    ok('并入在全店汇总里被排除（会员间转移）', !!transfer && transfer.rows >= 1,
      transfer ? `${transfer.label} ${transfer.rows} 笔 ${transfer.amount}` : '没归类');

    const led = await api('/api/admin/member-ledger?user_id=u-led');
    const w = led.body.wallet || {};
    ok('★ 该会员自己的流水里看得到这笔并入',
      (w.entries || []).some(e => e.kind === 'legacy_merge'),
      (w.entries || []).map(e => e.kind).join(',').slice(0, 80));
    ok('★ 流水能加回他的余额（结存列不消失）', w.balance_after_reliable === true,
      `reliable=${w.balance_after_reliable} 累加=${w.computed_balance}`);
    ok('每一行都有结存', (w.entries || []).every(e => e.balance_after != null),
      `缺结存 ${(w.entries || []).filter(e => e.balance_after == null).length} 行`);
  }

  // ⑦ 同一订单先退运费、再整单退款。
  //    wallet_events 有 UNIQUE(type, order_id)，两次都是 type='refund' 且同一个 order_id
  //    —— 如果第二次撞唯一约束，整个 D1 batch 回滚，就会出现「钱退了但流水没记」
  //    或者「退款直接失败」。这是最坏的一种：账和钱分家。
  {
    const oid = 'led-double-refund';
    d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,
          subtotal,delivery_fee,discount,service_charge,service_charge_rate,gst,gst_rate,gst_registered,
          promo_code,promo_claimed,paid_by_balance,total,fulfilment,address,pay_provider,pay_ref,pay_status,paid_at,client_token)
        VALUES ('${oid}','HL-LEDGER-0003','${NOW}','账本测试','93330001','u-led','[]',
          10,4,0,0,0,0,0,0,NULL,0,14,14,'anytime','S(123456) 测试地址','balance','led-dbl','PAID','${NOW}','led-dbl-seed')`);
    d1(`UPDATE members SET balance=ROUND(balance-14,2), updated_at='${NOW}' WHERE user_id='u-led'`);
    await waitUp(); await sleep(800);
    const seeded = await balanced('⑦ 造好第二张储值配送单后账仍然平');

    const fee = await api('/api/admin/refund-delivery-fee', { method: 'POST',
      body: { order_id: oid, client_token: 'led-dbl-fee' } });
    ok('先只退运费成功', fee.status === 200, JSON.stringify(fee.body).slice(0, 110));
    const afterFee2 = await balanced('⑦a 退运费后仍然平');

    const whole = await api('/api/admin/order-refund', { method: 'POST',
      body: { order_id: oid, reason: '再整单退', client_token: 'led-dbl-whole' } });
    console.log('     · 同一单再整单退返回', whole.status, JSON.stringify(whole.body).slice(0, 140));
    // 【已知缺陷·非本次引入】wallet_events 的 UNIQUE(type, order_id) 让第二次 type='refund'
    // 插入失败，整个 D1 batch 回滚 → 老板看到 500「服务器开小差」，退款做不下去。
    // 这里锁住的是【安全的那一半】：失败必须是原子的 —— 要么钱和流水一起发生，
    // 要么都不发生。绝不能出现「钱退给顾客了、账上没记」。
    ok('★ 二次退款要么整体成功、要么整体失败（不允许钱账分家）',
      whole.status === 200 || whole.status >= 500 || whole.status === 409,
      `status=${whole.status}`);
    const afterWhole = await balanced('★ ⑦b 同一单再整单退之后，账仍然平');

    // 关键：钱和流水必须同进退。要么两者都发生，要么两者都没发生。
    const moneyBack = +(+afterWhole.actual - +afterFee2.actual).toFixed(2);
    const evRows = rows(`SELECT COUNT(*) c, ROUND(COALESCE(SUM(amount),0),2) s FROM wallet_events WHERE order_id='${oid}'`)[0];
    ok('★ 退回的钱与流水记的钱一致（不会钱退了账没记）',
      Math.abs(+evRows.s - (+afterWhole.actual - +seeded.actual)) < 0.005,
      `余额共回补 ${(+afterWhole.actual - +seeded.actual).toFixed(2)} / 流水记 ${evRows.s}（${evRows.c} 条）`);
    ok('第二次退款没有把第一次的流水挤掉', +evRows.c >= 1, `${evRows.c} 条`);
    console.log(`     · 二次退款净回补 ${moneyBack}`);
  }

  // ⑧ 负余额会员：账面推算是全体的代数净额，实际必须也用净额来对，
  //    否则一有负余额就天然对不上（Codex 复核指出的口径不一致）。
  {
    // 负余额也得有来源：现实里它来自老板扣款扣过了头，那笔 adjustment 是有记录的。
    // 上一版直接塞一个 -12.5 的余额，账立刻差 12.5 —— 断言如实抓到了，正是它该干的事。
    d1(`INSERT INTO members (phone,name,balance,points,created_at,updated_at)
        VALUES ('93330003','负余额会员',-12.5,0,'${NOW}','${NOW}')`);
    d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES ('we-neg-1','adjustment','balance_adjust:neg-1',NULL,'93330003',NULL,-12.5,'${NOW}','扣款超出余额')`);
    await waitUp(); await sleep(800);
    const r = await balanced('★ ⑧ 出现负余额会员后仍然平（按净额对账）');
    const { body } = await api('/api/admin/wallet-audit?range=all');
    const rec = body.reconciliation || {};
    ok('负余额被单列出来而不是被吞掉', +rec.negative_outstanding === 12.5 && rec.negative_members === 1,
      `负余额 ${rec.negative_outstanding} / ${rec.negative_members} 人`);
    ok('正余额负债与净额分别给出',
      +rec.positive_outstanding - +rec.actual_outstanding === 12.5,
      `正余额 ${rec.positive_outstanding} / 净额 ${rec.actual_outstanding}`);
    d1(`DELETE FROM members WHERE phone='93330003'`);
    d1(`DELETE FROM wallet_events WHERE id='we-neg-1'`);
    await waitUp(); await sleep(800);
  }

  // ⑨ 关联不到订单的退款：不许猜，挂起并且不许宣称账平（fail closed）
  {
    d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES ('we-orphan-1','refund','refund:orphan-1','no-such-order','93330001','u-led',9.99,'${NOW}','孤儿退款')`);
    await waitUp(); await sleep(800);
    const { body } = await api('/api/admin/wallet-audit?range=all');
    const rec = body.reconciliation || {};
    ok('★ 关联不到订单的退款被挂起，不进推算',
      (rec.unresolved || []).some(x => +x.amount === 9.99),
      JSON.stringify(rec.unresolved || []).slice(0, 120));
    ok('★ 有挂起项时不许宣称账平（哪怕差额是 0）',
      rec.reconciled === false, `reconciled=${rec.reconciled} diff=${rec.diff}`);
    d1(`DELETE FROM wallet_events WHERE id='we-orphan-1'`);
    await waitUp(); await sleep(800);
    const back = await api('/api/admin/wallet-audit?range=all');
    ok('清掉挂起项后恢复账平', (back.body.reconciliation || {}).reconciled === true,
      `reconciled=${(back.body.reconciliation || {}).reconciled}`);
  }

  // ⑩ 未知类型 / NULL 金额：白名单分类必须 fail closed，不能默认计入。
  {
    d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES ('we-unknown-1','mystery','mystery:1',NULL,'93330001','u-led',7.77,'${NOW}','没见过的类型')`);
    await waitUp(); await sleep(800);
    const { body } = await api('/api/admin/wallet-audit?range=all');
    const rec = body.reconciliation || {};
    ok('★ 没见过的事件类型被挂起而不是默认计入',
      (rec.unresolved || []).some(x => +x.amount === 7.77 || String(x.label).includes('mystery')),
      JSON.stringify(rec.unresolved || []).slice(0, 140));
    ok('★ 未知类型在场时不许宣称账平', rec.reconciled === false, `reconciled=${rec.reconciled}`);
    d1(`DELETE FROM wallet_events WHERE id='we-unknown-1'`);
    await waitUp(); await sleep(800);
  }

  // ⑩b NULL type 在这个库里【不可达】：schema 写着 type TEXT NOT NULL。
  //     独立复核提过三值逻辑的洞（NOT(UNKNOWN) 仍是 UNKNOWN，那行会从判定里消失），
  //     分析没错，但约束让它插不进来。分类仍改成单个 CASE...ELSE 作为纵深防御，
  //     这里锁住的是【为什么不可达】—— 哪天有人去掉这个约束，这条会先红。
  {
    let rejected = false;
    try {
      d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
          VALUES ('we-nulltype-1',NULL,'nulltype:1',NULL,'93330001','u-led',3.33,'${NOW}','type 为 NULL')`);
    } catch (e) {
      // wrangler 把 SQLITE 错误打在 stdout 上，退出码才是 1
      const blob = `${e.message || ''} ${e.stdout || ''} ${e.stderr || ''}`;
      rejected = /NOT NULL constraint failed: wallet_events\.type/.test(blob);
    }
    ok('★ NULL type 被 schema 拦住（这才是它不可达的原因）', rejected);
  }

  // ⑩c 金额不是数字（SQLite 动态类型，TEXT 也能塞进 REAL 列，SUM 会当 0）
  {
    d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES ('we-badamt-1','adjustment','badamt:1',NULL,'93330001','u-led','abc','${NOW}','金额是文本')`);
    await waitUp(); await sleep(800);
    const { body } = await api('/api/admin/wallet-audit?range=all');
    const rec = body.reconciliation || {};
    ok('★ 非数值金额被挂起而不是当 0 计入',
      (rec.unresolved || []).reduce((a, x) => a + x.rows, 0) >= 1 && rec.reconciled === false,
      `reconciled=${rec.reconciled}`);
    d1(`DELETE FROM wallet_events WHERE id='we-badamt-1'`);
    await waitUp(); await sleep(800);
  }

  // ⑩d 整单退款的流水金额与订单实际退回的储值对不上 → 不许当成「已排除」悄悄平掉。
  //     代码路径上这两个值来自同一个变量，所以只有直接改库才造得出来；
  //     但「排除」本身依赖的就是这个相等前提，前提没被检查过就是个没上锁的门。
  {
    const oid = 'led-mismatch-order';
    d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,
          subtotal,delivery_fee,discount,service_charge,service_charge_rate,gst,gst_rate,gst_registered,
          promo_code,promo_claimed,paid_by_balance,total,fulfilment,pay_provider,pay_ref,pay_status,paid_at,
          balance_refund_ref,balance_refunded_at,client_token)
        VALUES ('${oid}','HL-LEDGER-0004','${NOW}','账本测试','93330001','u-led','[]',
          30,0,0,0,0,0,0,0,NULL,0,30,30,'pickup','balance','led-mm','REFUNDED','${NOW}',
          'refund:mm','${NOW}','led-mm-seed')`);
    // 事件只记 20，与订单的 30 对不上
    d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES ('we-mismatch-1','refund','refund:mm','${oid}','93330001','u-led',20,'${NOW}','金额对不上')`);
    await waitUp(); await sleep(800);
    const { body } = await api('/api/admin/wallet-audit?range=all');
    const rec = body.reconciliation || {};
    ok('★ 退款流水与订单金额对不上时被挂起，不许悄悄排除',
      (rec.unresolved || []).reduce((a, x) => a + x.rows, 0) >= 1 && rec.reconciled === false,
      `reconciled=${rec.reconciled} 挂起 ${(rec.unresolved || []).reduce((a, x) => a + x.rows, 0)} 行`);
    // 亚分差：两边各自四舍五入会把 30.004 与 29.996 判成一致，差额被抹掉
    d1(`UPDATE orders SET paid_by_balance=30.004 WHERE id='${oid}'`);
    d1(`UPDATE wallet_events SET amount=29.996 WHERE id='we-mismatch-1'`);
    await waitUp(); await sleep(800);
    const sub = await api('/api/admin/wallet-audit?range=all');
    const subRec = sub.body.reconciliation || {};
    ok('★ 亚分差不会被四舍五入抹掉（精确相等）',
      (subRec.unresolved || []).reduce((a, x) => a + x.rows, 0) >= 1 && subRec.reconciled === false,
      `reconciled=${subRec.reconciled}`);

    d1(`DELETE FROM wallet_events WHERE id='we-mismatch-1'`);
    d1(`DELETE FROM orders WHERE id='${oid}'`);
    await waitUp(); await sleep(800);
    const back = await api('/api/admin/wallet-audit?range=all');
    ok('清掉后恢复账平', (back.body.reconciliation || {}).reconciled === true);
  }

  // ⑪ 判定必须来自同一条 SQL 快照：同一次响应里的各个量要自洽
  {
    const { body } = await api('/api/admin/wallet-audit?range=all');
    const rec = body.reconciliation || {};
    const recomputed = Math.round((rec.credited_all_time - rec.consumed_all_time
      + (rec.counted || []).reduce((a, x) => a + x.amount, 0)) * 100) / 100;
    ok('★ 同一次响应里账面推算自洽（同一快照）',
      Math.abs(recomputed - rec.expected_outstanding) < 0.005,
      `明细算出 ${recomputed} / 返回 ${rec.expected_outstanding}`);
    ok('借贷两侧与净额自洽',
      Math.abs(rec.expected_outstanding - rec.actual_outstanding) < 0.005 || rec.reconciled === false,
      `账面 ${rec.expected_outstanding} / 净额 ${rec.actual_outstanding} / reconciled=${rec.reconciled}`);
  }

  // ⑫ 收尾：已排除项每一条都必须写明理由，否则「排除」就等于「藏起来」
  const final = await reconcile();
  ok('已排除项都带理由', final.excluded.every(x => String(x.reason || '').length > 4),
    final.excluded.map(x => `${x.label}:${x.rows}笔`).join(' / ') || '（无）');
}

main()
  .catch(e => { fails.push('运行时异常: ' + e.message); console.error(e); })
  .finally(async () => {
    if (child) child.kill('SIGTERM');
    await sleep(500);
    rmSync(persist, { recursive: true, force: true });
    console.log(`\n通过 ${pass}，失败 ${fails.length}`);
    if (fails.length) console.log('失败：', fails.join('、'));
    setTimeout(() => process.exit(fails.length ? 1 : 0), 500);
  });
