import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { walletLedgerWithBalances } from '../worker/index.js';

test('wallet audit reconstructs the balance after every credit and debit', () => {
  // 返回值现在带自校验结果：{entries, reliable, dated, truncated, computed_balance}。
  // reliable 为 false 时 entries 里【不含】balance_after —— 见 money-guards.test.mjs。
  const res = walletLedgerWithBalances([
    { kind: 'refund', event_id: 'refund-1', delta: 30, created_at: '2026-08-03T00:00:00Z' },
    { kind: 'spend', event_id: 'spend-1', delta: -30, created_at: '2026-08-02T00:00:00Z' },
    { kind: 'topup', event_id: 'topup-1', delta: 100, principal: 90, bonus: 10, created_at: '2026-08-01T00:00:00Z' },
  ], 100);

  assert.equal(res.reliable, true, '这组数据加起来正好等于 100，必须判为可靠');
  assert.deepEqual(res.entries.map(entry => [entry.kind, entry.delta, entry.balance_after]), [
    ['refund', 30, 100],
    ['spend', -30, 70],
    ['topup', 100, 100],
  ]);
  assert.equal(res.entries[2].principal, 90);
  assert.equal(res.entries[2].bonus, 10);
});

test('member centre renders a clear stored-value ledger', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
    + '\n' + fs.readFileSync(new URL('../web/storefront.js', import.meta.url), 'utf8');
  assert.match(html, /储值账本/);
  assert.match(html, /充值 · 消费 · 退款/);
  assert.match(html, /balance_after/);
  assert.match(html, /变动后余额/);
});
