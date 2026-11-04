import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../worker/index.js';

const html = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
test('dashboard hides the bun chart and requests schedule ordering before slicing', async () => {
  const app = { innerHTML: '' }, paths = [], window = {};
  const context = vm.createContext({ app, window, FULFIL_LABEL: {}, esc: String,
    rowHtml: o => `<tr data-id="${o.id}"></tr>`, auditPeriod() {}, loadOnlineTopupReconcileAlert() {},
    api: async path => {
      paths.push(path);
      if (path.includes('/orders')) return { orders: Array.from({ length: 35 }, (_, id) => ({ id })) };
      if (path.endsWith('/production')) return { total: 8, buns: [{ name: 'Hidden bun', qty: 8 }] };
      if (path.endsWith('/settings')) return { config: { store_open: true } };
      return {};
    },
  });
  vm.runInContext(html.slice(html.indexOf('function scheduleOrder('), html.indexOf('function rowHtml(')), context);
  await vm.runInContext("dash('PAID', false, '')", context);
  assert.ok(paths.includes('/api/admin/orders?status=PAID'));
  assert.doesNotMatch(app.innerHTML, /今日各包子备货量|Hidden bun|class="bartrack"/);
  assert.match(app.innerHTML, /今天及之后按取餐／配送时间从早到晚，历史订单排在后面/);
  assert.equal(window._adminOrders.length, 30);
  await vm.runInContext("dash('', true, '')", context);
  assert.equal(window._adminOrders.length, 35);
});

test('dashboard puts today and upcoming orders first, then past orders most recent first', () => {
  const context = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function scheduleOrder('), html.indexOf('async function dash(')), context);
  const day = n => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);   // Singapore date offset
  const now = new Date().toISOString();
  const orders = [
    { id: 'old', created_at: `${day(-60)}T01:00:00.000Z`, deliver_at: day(-60), deliver_time: '09:00' },
    { id: 'yesterday-am', created_at: `${day(-2)}T01:00:00.000Z`, deliver_at: day(-1), deliver_time: '09:00' },
    { id: 'yesterday-pm', created_at: `${day(-2)}T02:00:00.000Z`, deliver_at: day(-1), deliver_time: '15:00' },
    { id: 'tomorrow', created_at: now, deliver_at: day(1), deliver_time: '09:00' },
    { id: 'today-pm', created_at: now, deliver_at: day(0), deliver_time: '15:00' },
    { id: 'today-no-time', created_at: now, deliver_at: day(0), deliver_time: null },
    { id: 'undated-now', created_at: now, deliver_at: null, deliver_time: null },
    { id: 'today-am', created_at: now, deliver_at: day(0), deliver_time: '09:00' },
    { id: 'undated-old', created_at: `${day(-3)}T01:00:00.000Z`, deliver_at: '', deliver_time: '' },
  ];
  assert.deepEqual(context.scheduleOrder(orders).map(o => o.id),
    ['today-am', 'today-pm', 'today-no-time', 'undated-now', 'tomorrow', 'yesterday-pm', 'yesterday-am', 'undated-old', 'old']);
});

test('real orders route sorts by schedule before LIMIT and preserves filtering/default order', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders(id TEXT, created_at TEXT, deliver_at TEXT, deliver_time TEXT, pay_status TEXT, source TEXT);
    CREATE TABLE order_events(id TEXT,order_id TEXT,type TEXT);
    CREATE TABLE order_refunds(order_id TEXT,status TEXT);`);
  const insert = db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)');
  insert.run('late', '2026-09-20T01:00:00Z', '2026-09-23', '09:00', 'PAID', 'online');
  insert.run('early', '2026-09-21T01:00:00Z', '2026-09-22', '09:00', 'PAID', 'online');
  insert.run('afternoon', '2026-09-22T01:00:00Z', '2026-09-22', '15:00', 'PAID', 'online');
  insert.run('no-time', '2026-09-21T02:00:00Z', '2026-09-22', '', 'PAID', 'online');
  insert.run('undated', '2026-09-21T18:00:00Z', null, null, 'PAID', 'online');
  insert.run('unpaid', '2026-09-22T02:00:00Z', '2026-09-22', '08:00', 'UNPAID', 'offline');
  const DB = { prepare(sql) { let binds = []; return { bind(...args) { binds = args; return this; }, async all() { return { results: db.prepare(sql).all(...binds) }; } }; } };
  async function orders(query) {
    const response = await worker.fetch(new Request('http://localhost/api/admin/orders' + query,
      { headers: { authorization: 'Bearer unit-admin' } }), { ADMIN_TOKEN: 'unit-admin', DB }, {});
    assert.equal(response.status, 200);
    return (await response.json()).orders.map(o => o.id);
  }
  try {
    assert.deepEqual(await orders('?sort=fulfilment&status=PAID'), ['early','afternoon','no-time','undated','late']);
    assert.deepEqual(await orders('?sort=fulfilment&source=offline'), ['unpaid']);
    assert.equal((await orders(''))[0], 'unpaid');
    for (let i = 0; i < 505; i++) insert.run(`future-${i}`, '2026-09-24T01:00:00Z', '2026-09-25', '12:00', 'PAID', 'online');
    const limited = await orders('?sort=fulfilment&status=PAID');
    assert.equal(limited.length, 500);
    assert.deepEqual(limited.slice(0,5), ['early','afternoon','no-time','undated','late']);
  } finally { db.close(); }
});
