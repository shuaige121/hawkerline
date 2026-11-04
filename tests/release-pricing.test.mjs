// 结账/POS 的权威定价：价格只能来自【活动发布】，一条查询拿全，
// 陈旧的 menu_revision 必须在任何写入之前 409 掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteActiveReleaseItems, extractTransactionRules } from '../worker/publication.js';

const snapshotFor = (rules = {}) => JSON.stringify({
  schema_version: 1,
  settings: {
    delivery: { same_day_cutoff: '16:00', anytime: { fee: 0, note: '' }, zones: [] },
    delivery_enabled: '1', delivery_fee: '4', delivery_min: '0', delivery_free_above: '0',
    gst_registered: '1', gst_rate: String(rules.gst_rate ?? 9),
    service_charge_enabled: '0', service_charge_rate: '10',
    business_hours_schedule: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
    prep_time_min: '20',
  },
  products: [], offers: [],
});

// 一条查询返回：活动指针 + 该发布的快照 + 涉及 SKU 在（活动 / 历史）两个发布里的行
function fakePricingDb({ active, products = {}, historical = {}, rules = {}, flipPointerAfterReadTo = null }) {
  const db = { reads: 0, writes: 0 };
  db.prepare = () => ({
    bind: () => ({
      first: async () => {
        db.reads++;
        const rows = [];
        for (const [sku, row] of Object.entries(products)) rows.push({ release_id: active, sku, name_cn: row.name_cn || '鲜肉包', price_cents: row.price_cents, active: row.active });
        for (const [sku, row] of Object.entries(historical)) rows.push({ release_id: row.release_id, sku, name_cn: row.name_cn || '鲜肉包', price_cents: row.price_cents, active: row.active });
        const answer = { active_release_id: active, snapshot_json: snapshotFor(rules), product_rows_json: JSON.stringify(rows) };
        if (flipPointerAfterReadTo) active = flipPointerAfterReadTo;   // 读完之后指针被别的激活改掉
        return answer;
      },
    }),
  });
  return db;
}
const throwingDb = () => ({ reads: 0, prepare() { this.reads++; throw new Error('D1 touched before validation'); } });

test('active revision prices all lines with one batch query', async () => {
  const db = fakePricingDb({ active: 'rel-2', products: {
    S01: { price_cents: 390, active: 1 }, S02: { price_cents: 420, active: 1 } } });
  const result = await quoteActiveReleaseItems({ DB: db }, { menuRevision: 'rel-2', items: [{ sku: 'S01', qty: 2 }, { sku: 'S02', qty: 1 }] });
  assert.equal(result.ok, true);
  assert.equal(result.subtotal_cents, 1200);
  assert.equal(db.reads, 1);
  assert.equal(result.revision, 'rel-2');
});

test('stale revision reports the exact differences and current lines', async () => {
  const db = fakePricingDb({ active: 'rel-2',
    products: { S01: { price_cents: 390, active: 1 } },
    historical: { S01: { release_id: 'rel-1', price_cents: 360, active: 1 } } });
  const result = await quoteActiveReleaseItems({ DB: db }, { menuRevision: 'rel-1', items: [{ sku: 'S01', qty: 2 }] });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'menu_changed');
  assert.equal(result.active_revision, 'rel-2');
  assert.deepEqual(result.changes, [{ sku: 'S01', reason: 'price', old_price_cents: 360, new_price_cents: 390 }]);
  assert.deepEqual(result.lines, [{ sku: 'S01', qty: 2, name_cn: '鲜肉包', name_en: '', unit_price_cents: 390, line_total_cents: 780, available: true }]);
  assert.equal(result.subtotal_cents, 780);
});

test('a delisted sku is reported unavailable, not silently priced', async () => {
  const db = fakePricingDb({ active: 'rel-2', products: { S01: { price_cents: 390, active: 0 } } });
  const result = await quoteActiveReleaseItems({ DB: db }, { menuRevision: 'rel-2', items: [{ sku: 'S01', qty: 1 }] });
  assert.equal(result.status, 409);
  assert.equal(result.changes[0].reason, 'unavailable');
  assert.equal(result.lines[0].available, false);
  assert.equal(result.subtotal_cents, 0);
});

test('cart validation rejects bad shapes and oversized carts before D1', async () => {
  for (const items of [{}, null, 'x', [],
    Array.from({ length: 100 }, (_, i) => ({ sku: `S${i}`, qty: 1 })),
    [{ sku: 'S01', qty: 0 }], [{ sku: 'S01', qty: 100 }], [{ sku: 'S01', qty: 1.5 }],
    [{ sku: 'S01', qty: 1 }, { sku: 'S01', qty: 1 }], [{ sku: '', qty: 1 }]]) {
    const db = throwingDb();
    const result = await quoteActiveReleaseItems({ DB: db }, { menuRevision: 'rel-2', items });
    assert.equal(result.status, 400, JSON.stringify(items));
    assert.equal(db.reads, 0, 'D1 must not be touched for an invalid cart');
  }
  const db = throwingDb();
  assert.equal((await quoteActiveReleaseItems({ DB: db }, { menuRevision: 'bad revision!', items: [{ sku: 'S01', qty: 1 }] })).status, 400);
  assert.equal(db.reads, 0);
});

test('activation between quote and totals cannot mix release rules', async () => {
  const db = fakePricingDb({ active: 'rel-2', rules: { gst_rate: 9 }, flipPointerAfterReadTo: 'rel-3',
    products: { S01: { price_cents: 390, active: 1 } } });
  const quote = await quoteActiveReleaseItems({ DB: db }, { menuRevision: 'rel-2', items: [{ sku: 'S01', qty: 1 }] });
  assert.equal(quote.revision, 'rel-2');
  assert.equal(quote.release_rules.gst_rate, 9);
  assert.equal(db.reads, 1, '同一笔交易绝不能再解析一次活动指针');
});

test('transaction rules come from the release snapshot, not the mutable draft', () => {
  const rules = extractTransactionRules(JSON.parse(snapshotFor({ gst_rate: 7 })).settings);
  assert.equal(rules.gst_rate, 7);
  assert.equal(rules.gst_registered, true);
  assert.equal(rules.service_charge_enabled, false);
  assert.equal(rules.delivery.same_day_cutoff, '16:00');
  assert.equal(rules.prep_time_min, 20);
});
