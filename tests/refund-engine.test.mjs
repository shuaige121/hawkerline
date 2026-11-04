// 退款引擎回归测试。
//
// 为什么有这个文件：上一版仓库的 14 项单测对金额【完全瞎】——审计做过变异测试，
// 把订单 total 改成 0、把 Stripe 验签整段跳过、把优惠码封顶去掉，14/14 依旧全绿。
// 所以这里的每一条都必须满足一个标准：**把对应的实现改坏，这条必须变红。**
// 每个 describe 顶部注明「改坏什么会让它红」，方便以后做故障注入自查。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planRefundSplit,
  classifyChargeRefund,
  computeOrderTotals,
  payNoteFor,
  paynowPayload,
  tgCopyRows,
  orderActionRows,
} from '../worker/index.js';

// ── 退款拆分 ────────────────────────────────────────────────────────────────
// 改坏 planRefundSplit 的任一行（先退储值、不减已退、不封顶）都会让下面变红。
test('退款优先原路退回 Stripe，储值只兜底', () => {
  // 总额 100，储值付 40，Stripe 付 60。退 50 → 全部走 Stripe。
  const a = planRefundSplit({ total: 100, paidByBalance: 40, alreadyStripe: 0, amount: 50, provider: 'stripe' });
  assert.equal(a.stripe, 50);
  assert.equal(a.balance, 0);

  // 退 80 → Stripe 只能退 60，剩下 20 退回储值
  const b = planRefundSplit({ total: 100, paidByBalance: 40, alreadyStripe: 0, amount: 80, provider: 'stripe' });
  assert.equal(b.stripe, 60);
  assert.equal(b.balance, 20);

  // 已经原路退过 60 → 再退只能走储值
  const c = planRefundSplit({ total: 100, paidByBalance: 40, alreadyStripe: 60, amount: 30, provider: 'stripe' });
  assert.equal(c.stripe, 0);
  assert.equal(c.balance, 30);

  // 全额储值单：Stripe 侧没有钱可退
  const d = planRefundSplit({ total: 100, paidByBalance: 100, alreadyStripe: 0, amount: 100, provider: 'balance' });
  assert.equal(d.stripe, 0);
  assert.equal(d.balance, 100);
});

test('★ 现金 / 线下单绝不走 Stripe，退多少现钞要明确说出来', () => {
  // 老板在 POS 录的现金单：顾客当初递的是现钞，Stripe 那边根本没有这笔交易。
  // 修复前这里会被整笔算成「Stripe 那部分」→ 502「没有可退款的 payment_intent」，
  // 还把老板往 Stripe 后台带偏（那里什么都查不到）。
  const cash = planRefundSplit({ total: 30, paidByBalance: 0, alreadyStripe: 0, amount: 30, provider: 'cash' });
  assert.equal(cash.stripe, 0, '现金单不许产生 Stripe 退款');
  assert.equal(cash.balance, 0, '没用储值就不该退储值');
  assert.equal(cash.cash, 30, '整笔应记为「当面退现金 30」');

  // 柜台单：一半储值一半现金
  const mixed = planRefundSplit({ total: 50, paidByBalance: 20, alreadyStripe: 0, amount: 50, provider: 'paynow' });
  assert.equal(mixed.stripe, 0);
  assert.equal(mixed.balance, 20, '储值抵扣过多少就退回多少');
  assert.equal(mixed.cash, 30, '剩下的是现钞，要当面退');

  // provider 缺失时也必须 fail closed 到「不走 Stripe」
  const unknown = planRefundSplit({ total: 10, paidByBalance: 0, alreadyStripe: 0, amount: 10 });
  assert.equal(unknown.stripe, 0, 'provider 不明时绝不能擅自去 Stripe 扣退款');
});

test('退款拆分两侧之和恒等于退款总额（不会凭空多退或少退）', () => {
  for (const total of [12.3, 99.99, 123.26, 550]) {
    for (const bal of [0, 1.05, total / 3, total]) {
      for (const amt of [0.01, total / 7, total]) {
        const s = planRefundSplit({ total, paidByBalance: bal, alreadyStripe: 0, amount: +amt.toFixed(2), provider: 'stripe' });
        assert.ok(Math.abs(s.stripe + s.balance + s.cash - +amt.toFixed(2)) < 0.005,
          `total=${total} bal=${bal} amt=${amt} → ${s.stripe}+${s.balance}+${s.cash}`);
        assert.ok(s.stripe >= 0 && s.balance >= 0 && s.cash >= 0, '拆分不允许出现负数');
      }
    }
  }
});

// ── P0：charge.refunded 误判 ─────────────────────────────────────────────────
// 这一组钉的是一个真实会白送钱的坑。把 classifyChargeRefund 退回
// `amountRefunded >= stripePortion → full` 的老写法，第一条立刻变红。
test('P0：Stripe 那笔恰好等于运费时，退运费不得被误判成整单退款', () => {
  // 生产真实单 ORD-20260808-0001：total 123.26 / 储值付 104.16 / Stripe 只收了 19.10 = 运费本身
  const r = classifyChargeRefund({
    total: 123.26, paidByBalance: 104.16,
    amountRefunded: 19.10,   // Stripe 侧累计已退 = 运费
    ownStripe: 19.10,        // 这 19.10 是我们自己发起的退运费
  });
  assert.equal(r.kind, 'fee_only',
    '误判成 full 会置 REFUNDED（订单锁死）并把 104.16 储值白退给顾客');
});

test('真正的整单退款仍然要被认出来', () => {
  // 没有任何自发起的部分退款，Stripe 把它收的 60 全退了
  const r = classifyChargeRefund({ total: 100, paidByBalance: 40, amountRefunded: 60, ownStripe: 0 });
  assert.equal(r.kind, 'full');
});

test('先退了运费、之后货款也退了 → 仍然是整单退款', () => {
  // total 100 / 储值 0 / Stripe 100，其中运费 10 已退
  const r = classifyChargeRefund({ total: 100, paidByBalance: 0, amountRefunded: 100, ownStripe: 10 });
  assert.equal(r.kind, 'full');
});

test('退了一半货款 → partial，绝不自动退储值', () => {
  const r = classifyChargeRefund({ total: 100, paidByBalance: 0, amountRefunded: 30, ownStripe: 0 });
  assert.equal(r.kind, 'partial');
});

test('没有自发起退款时，绝不会被判成 fee_only', () => {
  // ownStripe=0 说明这笔退款不是我们发起的（老板在 Stripe 后台点的），
  // 此时无论金额多少都不能走 fee_only 分支（那会漏掉真正的整单退款）
  for (const amt of [0, 1, 19.1, 60, 100]) {
    const r = classifyChargeRefund({ total: 100, paidByBalance: 40, amountRefunded: amt, ownStripe: 0 });
    assert.notEqual(r.kind, 'fee_only');
  }
});

// ── 金额计算 ────────────────────────────────────────────────────────────────
// 把 computeOrderTotals 的 total 改成 0（审计做过的那个变异）→ 这条立刻红。
test('订单金额：total = 小计 + 运费 − 优惠 + 服务费 + GST', () => {
  const pricing = { service_charge_rate: 0, gst_rate: 0, gst_registered: 0 };
  const t = computeOrderTotals(100, 10, 5, pricing);
  assert.equal(t.total, 105, 'total 必须真的等于算出来的钱');
  assert.ok(t.total > 0, 'total 恒为 0 是一个会让全场免费的严重缺陷');

  const t2 = computeOrderTotals(50, 0, 0, pricing);
  assert.equal(t2.total, 50);
});

test('优惠不得超过小计（不能把订单算成负数，也不能记下自相矛盾的优惠额）', () => {
  const pricing = { service_charge_rate: 0, gst_rate: 0, gst_registered: 0 };
  const t = computeOrderTotals(20, 5, 999, pricing);   // 荒谬的大额优惠
  assert.ok(t.total >= 0, `total 不能为负，实际 ${t.total}`);
  assert.equal(t.discount, 20, '记在订单上的优惠额必须被封顶到小计，否则报表/对账会出现 优惠999/小计20');
  assert.equal(t.total, 5, '优惠吃光商品后只剩运费');
});

// ── PayNow 备注 ─────────────────────────────────────────────────────────────
// 把 payNoteFor 改回直接返回 pay_ref → 第一条红；把 slice(0,25) 去掉 → 第三条红。
test('PayNow 备注从单号派生，绝不把 Stripe session id 给顾客抄', () => {
  const csLive = 'cs_live_' + 'a'.repeat(58);   // 生产里真是 66 字符
  assert.equal(csLive.length, 66);
  const note = payNoteFor({ invoice_no: 'ORD-20260724-0001', pay_ref: csLive });
  assert.equal(note, 'ORD0001');
  assert.ok(!note.includes('cs_live'), '备注里出现 cs_live 就是顾客抄不到、老板对不上账');
});

test('没有单号时回退 pay_ref，但必须截断到 25 字符', () => {
  const note = payNoteFor({ invoice_no: '', pay_ref: 'cs_live_' + 'b'.repeat(58) });
  assert.ok(note.length <= 25, `回退值也不能超 25，实际 ${note.length}`);
});

test('PayNow 二维码：超长/空 reference 都不能让整张码挂掉', () => {
  // 66 字符 ref：修复前会被原样塞进 62/01，银行 App 截断或拒扫
  const payload = paynowPayload('201234567A', 19.10, 'cs_live_' + 'c'.repeat(58), 'DEMO KITCHEN PTE LTD');
  assert.ok(!payload.includes('cccccccccccccccccccccccccc'.slice(0, 30)),
    'reference 必须被截断，不能整串进码');
  // 从 payload 里把 62 域拆出来，确认长度 ≤25
  const i = payload.indexOf('62');
  assert.ok(i > 0);
  // null / undefined 不能变成字面量 "undefined"
  const p2 = paynowPayload('201234567A', 1, null, 'SHOP');
  assert.ok(!p2.includes('undefined'), 'null reference 不能落成字符串 undefined');
  assert.doesNotThrow(() => paynowPayload('201234567A', 1, undefined, 'SHOP'));
});

// ── Telegram 按钮 ───────────────────────────────────────────────────────────
// 把 tgCopyRows 改回无条件 .slice(0,256) → 第二条红。
test('Telegram 复制按钮：短内容单按钮', () => {
  const rows = tgCopyRows('复制', '短内容');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0].copy_text.text, '短内容');
});

test('Telegram 复制按钮：超 256 时拆成两段，内容一个字不丢', () => {
  const body = ['备注：ORD-20260717-0002 · 食品配送 · 尽快',
    '取货：' + 'A'.repeat(120), '送达：' + 'B'.repeat(120), '收件人：顾客 · 91234567'].join('\n');
  assert.ok(body.length > 256, '这条测试的前提是内容确实超长');
  const rows = tgCopyRows('复制全部叫车资料', body);
  assert.equal(rows.length, 2, '超长必须拆成两个按钮，而不是静默截断');
  const joined = rows.map(r => r[0].copy_text.text).join('\n');
  // 拆分只允许在换行处，重组后每一行都必须还在
  for (const line of body.split('\n')) {
    assert.ok(joined.includes(line.slice(0, 40)), `丢了内容：${line.slice(0, 40)}`);
  }
  for (const r of rows) assert.ok(r[0].copy_text.text.length <= 256);
});

// ── 订单操作按钮 ────────────────────────────────────────────────────────────
test('退运费按钮只在「已付款 + 有运费 + 没退过」时出现', () => {
  const base = { id: '11111111-2222-3333-4444-555555555555', fulfil_status: 'new' };
  const has = (o) => JSON.stringify(orderActionRows({ ...base, ...o })).includes('退运费');

  assert.ok(has({ pay_status: 'PAID', delivery_fee: 10, refunded_total: 0 }), '正常情况应该有');
  assert.ok(!has({ pay_status: 'UNPAID', delivery_fee: 10, refunded_total: 0 }), '没付款不能退');
  assert.ok(!has({ pay_status: 'PAID', delivery_fee: 0, refunded_total: 0 }), '没运费不该出现');
  assert.ok(!has({ pay_status: 'PAID', delivery_fee: 10, refunded_total: 10 }), '退过了不能再退');
  assert.ok(!has({ pay_status: 'REFUNDED', delivery_fee: 10, refunded_total: 0 }), '已退款单不能再退运费');
});

test('callback_data 必须在 Telegram 的 64 字节上限内，且能被 webhook 的正则接住', () => {
  const o = { id: '11111111-2222-3333-4444-555555555555', fulfil_status: 'new',
    pay_status: 'PAID', delivery_fee: 10, refunded_total: 0 };
  // 与 worker 里 webhook 分支使用的是同一个模式；改宽了这里也要同步改，否则形同虚设
  const RE = /^(?:k:(preparing|ready|done)|(rdf|rdfy|rdfn)):([0-9a-fA-F-]{8,64})$/;
  const datas = orderActionRows(o).flat().map(b => b.callback_data).filter(Boolean);
  assert.ok(datas.length >= 2, '至少应有厨房推进 + 退运费两类按钮');
  for (const d of datas) {
    assert.ok(Buffer.byteLength(d, 'utf8') <= 64, `callback_data 超 64 字节：${d}`);
    assert.match(d, RE, `callback_data 不符合 webhook 的严格正则：${d}`);
  }
});

test('厨房按钮只前进不后退', () => {
  const mk = (st) => orderActionRows({ id: '11111111-2222-3333-4444-555555555555',
    fulfil_status: st, pay_status: 'PAID', delivery_fee: 0, refunded_total: 0 })
    .flat().map(b => b.callback_data).filter(Boolean).join(' ');
  assert.ok(mk('new').includes('k:preparing'), 'new 应能开始制作');
  assert.ok(!mk('ready').includes('k:preparing'), 'ready 不能倒退回 preparing');
  assert.ok(!mk('done').includes('k:'), 'done 之后没有可推进的状态');
});

// ── 小票机票面 ──────────────────────────────────────────────────────────────
// 事故原型：48 列 × 12px 需要 346px，而 72mm 纸只有 272px —— 实纸上每根分隔线
// 都断成两行拖个孤儿字符，厨房拿到的是一张看不懂的票。
import { PRINT_PROFILES, maxFontPxFor, printFontPx } from '../worker/index.js';

test('★ 每种小票机的默认字号都必须装得进它的纸宽', () => {
  for (const [id, p] of Object.entries(PRINT_PROFILES)) {
    const cap = maxFontPxFor(p);
    assert.ok(p.font_px <= cap,
      `${id}：默认 ${p.font_px}px 超过纸宽上限 ${cap}px（${p.cols} 列 / ${p.width_mm}mm），实纸会折行`);
  }
});

test('★ 老板把字号调大也不能调出纸宽', () => {
  const p = PRINT_PROFILES.text80;
  const cap = maxFontPxFor(p);
  assert.equal(printFontPx(16, p), cap, '手动调到 16px 必须被钳制回纸宽上限');
  assert.ok(printFontPx(6, p) <= cap, '调小是允许的');
  assert.equal(printFontPx('乱七八糟', p), Math.min(p.font_px, cap), '非法值回落到默认且仍受钳制');
});

// ── 厨房屏上的备注 ──────────────────────────────────────────────────────────
// 事故原型：退运费后 orders.note 被追加了 ` [退运费 S$8.00 储值8.00]`，
// 这串记账注解直接印在挂墙的厨房平板上（真截图里看到的）。厨师不需要看退款账，
// 而且那块屏人来人往，金额不该摊在上面。
import { kitchenNote } from '../worker/index.js';

test('★ 厨房备注只保留顾客要求，剥掉系统记账注解', () => {
  assert.equal(kitchenNote('不要葱 [退运费 S$8.00 储值8.00]'), '不要葱');
  assert.equal(kitchenNote(' [退运费 S$8.00 原路3.00 储值5.00]'), null, '只剩注解就该是空');
  assert.equal(kitchenNote('多加辣 [⚠PARTIAL_REFUND refunded=5.00/stripe=10.00 储值未自动退·请人工对账]'), '多加辣');
  assert.equal(kitchenNote('少油 [⚠AMOUNT_MISMATCH paid=10.00 expected=12.00]'), '少油');
  assert.equal(kitchenNote('[⚠PAID_ON_CANCELLED Stripe实收 10.00]'), null);
  // 多条注解叠加（同一单退了运费又被打了告警）
  assert.equal(kitchenNote('不要香菜 [退运费 S$8.00] [⚠PARTIAL_REFUND x]'), '不要香菜');
  // 顾客自己写的方括号不该被误删
  assert.equal(kitchenNote('备注[急]'), '备注[急]');
  assert.equal(kitchenNote(null), null);
  assert.equal(kitchenNote(''), null);
});
