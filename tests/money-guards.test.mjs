// 资金/身份护栏回归测试。
// 每一条都对应一个曾经真实发生过（或审计确认可发生）的事故，改坏实现必须变红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  sgCounterPhone,
  sameTopupOp,
  walletLedgerWithBalances,
  checkFulfilTime,
  stripeVerify,
  normFulfilStatus,
  FULFIL_FLOW,
} from '../worker/index.js';

// ── 手机号护栏 ──────────────────────────────────────────────────────────────
// 事故原型：normPhone 只删非数字，手机号 "1" 也能建出会员并【立即入账真金】；
// `["91234567"]` 会被 String() 成合法号收下。
test('柜台手机号：只接受新加坡形态，畸形输入一律拒', () => {
  assert.deepEqual(sgCounterPhone('91234567'), { local: '91234567', intl: '6591234567', typed: '91234567' });
  assert.equal(sgCounterPhone('+65 9123 4567').local, '91234567', '带 +65 和空格要归一到同一个人');
  assert.equal(sgCounterPhone('6591234567').local, '91234567');

  for (const bad of ['1', '123', '12345678', '0912345678', '', '   ', 'abcdefgh']) {
    assert.equal(sgCounterPhone(bad), null, `"${bad}" 不该被当成合法手机号`);
  }
  // 非字符串必须直接拒，不能 String() 兜底
  for (const bad of [['91234567'], { phone: '91234567' }, 91234567, null, undefined, true]) {
    assert.equal(sgCounterPhone(bad), null, `${JSON.stringify(bad)} 是非字符串，必须拒绝`);
  }
});

// ── 充值幂等令牌 ────────────────────────────────────────────────────────────
// 事故原型：同一个 client_token 换个人/换金额复用 → 接口返回 200 假成功，
// 收银员收了 B 的现金、屏幕显示成功、钱进了 A 的账。
test('充值令牌必须绑回原操作：换人 / 换金额 / 换渠道都不算同一笔', () => {
  const prev = { user_id: 'u1', phone: '91234567', amount: 50, pay_method: 'cash' };
  assert.equal(sameTopupOp(prev, { userId: 'u1', phone: '91234567', amount: 50, payMethod: 'cash' }), true);

  assert.equal(sameTopupOp(prev, { userId: 'u2', phone: '91234567', amount: 50, payMethod: 'cash' }), false, '换账号');
  assert.equal(sameTopupOp(prev, { userId: 'u1', phone: '91234567', amount: 500, payMethod: 'cash' }), false, '换金额');
  assert.equal(sameTopupOp(prev, { userId: 'u1', phone: '91234567', amount: 50, payMethod: 'paynow' }), false, '换渠道');
  assert.equal(sameTopupOp(null, { userId: 'u1', amount: 50, payMethod: 'cash' }), false, '没有原笔');
});

test('充值令牌：legacy 无账号会员按手机号比，8 位与 +65 视为同一人', () => {
  const prev = { user_id: null, phone: '91234567', amount: 50, pay_method: 'cash' };
  assert.equal(sameTopupOp(prev, { userId: null, phone: '6591234567', amount: 50, payMethod: 'cash' }), true);
  assert.equal(sameTopupOp(prev, { userId: null, phone: '98765432', amount: 50, payMethod: 'cash' }), false);
  // 一边有账号一边没有 → fail closed，绝不放行
  assert.equal(sameTopupOp(prev, { userId: 'u1', phone: '91234567', amount: 50, payMethod: 'cash' }), false);
});

// ── 钱包账本自校验 ──────────────────────────────────────────────────────────
// 事故原型：从 members.balance 倒着减 → 任何差额都被结构性地推到最老一行的
// 隐式起始余额里（那个值从不显示），于是错账永远不可见。
const row = (id, delta, at) => ({ event_id: id, delta, created_at: at, kind: 'topup' });

test('账本正序累加，balance_after 逐行正确', () => {
  // 入参按 created_at DESC（最新在前）
  const rows = [
    row('c', -20, '2026-08-03T00:00:00.000Z'),
    row('b', +50, '2026-08-02T00:00:00.000Z'),
    row('a', +100, '2026-08-01T00:00:00.000Z'),
  ];
  const r = walletLedgerWithBalances(rows, 130);
  assert.equal(r.reliable, true);
  assert.equal(r.computed_balance, 130);
  assert.equal(r.entries.find(e => e.event_id === 'a').balance_after, 100);
  assert.equal(r.entries.find(e => e.event_id === 'b').balance_after, 150);
  assert.equal(r.entries.find(e => e.event_id === 'c').balance_after, 130);
});

test('账本对不上 members.balance 时必须降级，绝不显示错余额', () => {
  const rows = [row('b', +50, '2026-08-02T00:00:00.000Z'), row('a', +100, '2026-08-01T00:00:00.000Z')];
  // 真实余额被人绕过账本改成 999（生产里真有 16 笔这样的 adjustment）
  const r = walletLedgerWithBalances(rows, 999);
  assert.equal(r.reliable, false, '对不上就必须 reliable=false');
  for (const e of r.entries) {
    assert.ok(!('balance_after' in e), '不可靠时绝不能吐出 balance_after —— 宁可少一列也不能显示错的');
  }
});

test('脏日期会让排序错位，必须单独判（求和与顺序无关，只校验终值发现不了）', () => {
  const rows = [row('b', +50, '15/07/2026T12:00:00.000Z'), row('a', +100, '2026-08-01T00:00:00.000Z')];
  const r = walletLedgerWithBalances(rows, 150);
  assert.equal(r.computed_balance, 150, '终值是对的 —— 这正是只校验终值会漏掉它的原因');
  assert.equal(r.reliable, false, '有脏日期就必须降级');
});

test('被 LIMIT 截断时无法自校验，如实降级', () => {
  const rows = [row('a', +100, '2026-08-01T00:00:00.000Z')];
  const r = walletLedgerWithBalances(rows, 100, { truncated: true });
  assert.equal(r.reliable, false);
});

test('账本用整数分累加，不出现浮点漂移', () => {
  const rows = [];
  // 时间必须是合法 ISO —— 写成 00:99 会被脏日期闸门正确拦下（那是另一条测试的事）
  for (let i = 0; i < 100; i++) {
    const hh = String(Math.floor(i / 60)).padStart(2, '0'), mm = String(i % 60).padStart(2, '0');
    rows.push(row('e' + i, 0.10, `2026-08-01T${hh}:${mm}:00.000Z`));
  }
  const r = walletLedgerWithBalances(rows.reverse(), 10);
  assert.equal(r.computed_balance, 10, '0.1 加 100 次必须正好是 10');
  assert.equal(r.reliable, true);
});

// ── Stripe 验签 ─────────────────────────────────────────────────────────────
// 事故原型：审计的变异测试把 stripeVerify 整段跳过，14/14 依旧全绿 ——
// 意味着任何人伪造 webhook 都能把订单/充值置成 PAID。
const stripeSig = (raw, secret, t) => {
  const mac = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return `t=${t},v1=${mac}`;
};

test('Stripe 验签：合法签名通过', async () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const secret = 'whsec_testsecret';
  const t = Math.floor(Date.now() / 1000);
  const ev = await stripeVerify(raw, stripeSig(raw, secret, t), secret);
  assert.equal(ev.id, 'evt_1');
});

test('Stripe 验签：篡改 body / 错密钥 / 缺签名 都必须拒', async () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const secret = 'whsec_testsecret';
  const t = Math.floor(Date.now() / 1000);
  const good = stripeSig(raw, secret, t);

  await assert.rejects(() => stripeVerify(raw + ' ', good, secret), '改了一个字节也必须拒');
  await assert.rejects(() => stripeVerify(raw, stripeSig(raw, 'whsec_wrong', t), secret), '错密钥必须拒');
  await assert.rejects(() => stripeVerify(raw, '', secret), '缺签名必须拒');
  await assert.rejects(() => stripeVerify(raw, 't=1,v1=deadbeef', secret), '乱签名必须拒');
});

// ── 预约时间 ────────────────────────────────────────────────────────────────
// 事故原型：打烊后顾客想约明天自取、只选日期不选时刻 → 被恒拒，
// 而前端还写着「留空=尽快」诱导他别填时间。
const SCHEDULE = { 0: ['09:30', '21:30'], 1: null, 2: ['10:00', '20:30'], 3: ['10:00', '20:30'],
  4: ['10:00', '20:30'], 5: ['10:00', '20:30'], 6: ['09:30', '21:30'] };
// 2026-08-12 是周三；用固定时刻避免测试随时间漂移
const closedNow = new Date('2026-08-11T15:00:00.000Z');   // SGT 23:00，已打烊

test('自取预约：只选日期不选时刻，打烊后也要放行', () => {
  const r = checkFulfilTime(SCHEDULE, 20, '2026-08-12', null, closedNow, true);
  assert.deepEqual(r, { ok: true }, '这是转化流失的直接来源，必须放行');
});

test('营业外完全留空时自动排到下一营业时间 + 备餐时间', () => {
  const r = checkFulfilTime(SCHEDULE, 20, null, null, closedNow, false);
  assert.deepEqual(r, { ok: true, auto: { date: '2026-08-12', time: '10:20' } });
});

test('自费随时送明确只选日期时仍要求时刻', () => {
  const r = checkFulfilTime(SCHEDULE, 20, '2026-08-12', null, closedNow, false);
  assert.ok(r.error, '明确选日期后不应偷偷替顾客决定时刻');
});

test('休息日仍然拒（周一休息）', () => {
  const r = checkFulfilTime(SCHEDULE, 20, '2026-08-17', null, closedNow, true);   // 2026-08-17 周一
  assert.ok(r.error);
  assert.match(r.error, /休息/);
});

test('营业时间外的具体时刻仍然拒', () => {
  const r = checkFulfilTime(SCHEDULE, 20, '2026-08-12', '23:00', closedNow, true);
  assert.ok(r.error);
});

// ── 履约状态机 ──────────────────────────────────────────────────────────────
test('履约状态只认白名单，未知值一律归到 new', () => {
  assert.equal(normFulfilStatus('preparing'), 'preparing');
  assert.equal(normFulfilStatus('READY'), 'ready');
  for (const bad of ['', null, undefined, 'hacked', 'DROP TABLE', 123, ['ready']]) {
    assert.equal(normFulfilStatus(bad), 'new', `${JSON.stringify(bad)} 必须归一到 new`);
  }
});

test('状态流转顺序固定，不允许被改乱', () => {
  assert.deepEqual(FULFIL_FLOW, ['new', 'preparing', 'ready', 'done']);
});
