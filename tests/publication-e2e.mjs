// 公开内容发布（排程 / 激活 / bootstrap / 取消 / 回滚）的生命周期端到端测试。
//
// 单独跑：  node tests/publication-e2e.mjs
//
// 设计要点：
//   · 用 Miniflare 起一个【真实的】本地 D1 绑定 —— batch() 是真事务，
//     所以「子语句失败整批回滚」「并发只有一个赢家」这类断言才有意义。
//   · 迁移在内存库里从零重放，不起 wrangler 子进程、不碰任何远端。
//   · 全程只读本地临时目录，跑完即删。有一道闸拒绝对生产运行。

import * as miniflare from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 闸门：绝不对生产运行 ────────────────────────────────────────────────────
if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN) {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
}
if (process.argv.includes('--remote')) {
  console.error('拒绝执行：这个脚本只允许对本地 D1 运行。');
  process.exit(1);
}

// ── SQL 拆分：先去掉 -- 注释（引号内的 -- 不算），再按引号外的 ; 切分 ──────
function splitSqlStatements(sql) {
  let out = '', quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue; }
    out += ch;
  }
  const statements = [];
  let current = '';
  quote = null;
  for (const ch of out) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';') { if (current.trim()) statements.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

let mf = null;
export async function freshDb() {
  if (mf) await mf.dispose();
  const options = {
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: 'hl-publication-e2e' },
  };
  // The locked early v5 release accepts the v4 shape directly; later v5 builds
  // expose an explicit converter. Exercise the same real workerd/D1 in both.
  mf = new miniflare.Miniflare(typeof miniflare.convertV4MiniflareOptions === 'function'
    ? miniflare.convertV4MiniflareOptions(options) : options);
  const DB = await mf.getD1Database('DB');
  for (const file of readdirSync(path.join(ROOT, 'migrations')).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(path.join(ROOT, 'migrations', file), 'utf8');
    for (const statement of splitSqlStatements(sql)) {
      try { await DB.prepare(statement).run(); }
      catch (e) { throw new Error(`${file}: ${e.message}\n  ${statement.slice(0, 120)}`); }
    }
  }
  for (const statement of splitSqlStatements(readFileSync(path.join(ROOT, 'seed', 'demo.sql'), 'utf8'))) await DB.prepare(statement).run();
  return DB;
}

// 统计 D1 语句数：batch 按语句条数计，单发按 1 条计。
export function countingDb(DB) {
  const counter = { queries: 0 };
  const wrapped = {
    prepare: sql => {
      const stmt = DB.prepare(sql);
      return new Proxy(stmt, {
        get(target, prop) {
          const value = target[prop];
          if (prop === 'bind') return (...args) => wrapStatement(target.bind(...args));
          if (typeof value === 'function' && ['first', 'run', 'all', 'raw'].includes(prop)) {
            return (...args) => { counter.queries++; return value.apply(target, args); };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    batch: statements => { counter.queries += statements.length; return DB.batch(statements); },
    counter,
  };
  function wrapStatement(stmt) {
    return new Proxy(stmt, {
      get(target, prop) {
        const value = target[prop];
        if (prop === 'bind') return (...args) => wrapStatement(target.bind(...args));
        if (typeof value === 'function' && ['first', 'run', 'all', 'raw'].includes(prop)) {
          return (...args) => { counter.queries++; return value.apply(target, args); };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return wrapped;
}

// 极简页面生成器：Task 4 会用真的 renderPublicReleasePages 替换它。
export const testPageBuilder = async snapshot => ([
  { path: '/', content_type: 'text/html; charset=utf-8',
    body: `<!doctype html><title>${snapshot.release_id}</title><main>menu</main>`, etag: `"${snapshot.checksum.slice(0, 16)}-home"` },
  { path: '/menu', content_type: 'text/html; charset=utf-8',
    body: `<!doctype html><title>menu</title><main>${(snapshot.products || []).length}</main>`, etag: `"${snapshot.checksum.slice(0, 16)}-menu"` },
  { path: '/public/release.json', content_type: 'application/json; charset=utf-8',
    body: JSON.stringify({ release_id: snapshot.release_id, products: snapshot.products }), etag: `"${snapshot.checksum.slice(0, 16)}-json"` },
]);

// ── 断言收集 ────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
export async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✅', name); }
  catch (e) { failures.push(name); console.log('  ❌', name, '\n     ', e.message); }
}
export function report() {
  console.log(`\n通过 ${passed}，失败 ${failures.length}`);
  if (failures.length) console.log('失败用例：', failures.join('、'));
  // Miniflare 处理完也可能留下句柄，Linux CI 上会挂到 job 超时。
  setTimeout(() => process.exit(failures.length ? 1 : 0), 500);
}

// ── 用例 ────────────────────────────────────────────────────────────────────
import {
  schedulePublicRelease, activateDueRelease, activateReleaseById, ensureActiveRelease,
  cancelScheduledRelease, rollbackPublicRelease, publicationStatus,
  materializeRelease, loadPublishableDraft, buildPublicSnapshot,
} from '../worker/publication.js';
import { materializePublicMedia } from '../worker/public-media.js';

// 直接拿到「已解析好媒体的草稿快照」，用来单独驱动 materializeRelease 的守卫路径。
async function loadPublishableDraftForTest(env, contentAt = new Date('2026-08-29T12:00:00.000Z')) {
  const draft = await loadPublishableDraft(env, { contentAt });
  const mediaByHash = new Map();
  const snapshot = await buildPublicSnapshot(draft, async value => {
    const item = await materializePublicMedia(value);
    mediaByHash.set(item.hash, item);
    return item.publicUrl;
  });
  return { snapshot, media: [...mediaByHash.values()] };
}

const sqlValue = async (DB, sql) => Object.values(await DB.prepare(sql).first() || {})[0];
const activeReleaseId = async DB =>
  (await DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first())?.active_release_id ?? null;
const draftRevision = async DB =>
  (await DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first())?.draft_revision;

await check('schedule → not-yet-due → due activates exactly once', async () => {
  const DB = await freshDb();
  const env = { DB };
  assert.equal(await sqlValue(DB, 'SELECT COUNT(*) FROM public_content_releases'), 0);
  const first = await schedulePublicRelease(env, {
    expectedRevision: await draftRevision(DB), effectiveAtUtc: '2026-08-29T14:30:00.000Z',
    now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: testPageBuilder,
  });
  assert.equal(first.ok, true);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_releases WHERE status='scheduled'"), 1);
  await activateDueRelease(env, { now: new Date('2026-08-29T14:29:59.000Z') });
  assert.equal(await activeReleaseId(DB), null);
  await activateDueRelease(env, { now: new Date('2026-08-29T14:30:00.000Z') });
  assert.equal(await activeReleaseId(DB), first.release_id);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_events WHERE action='published'"), 1);
});

await check('two parallel Cron bootstraps produce exactly one release', async () => {
  const DB = await freshDb();
  const env = { DB };
  const now = new Date('2026-08-29T12:00:00.000Z');
  const results = await Promise.all([
    ensureActiveRelease(env, { allowBootstrap: true, now, pageBuilder: testPageBuilder }),
    ensureActiveRelease(env, { allowBootstrap: true, now, pageBuilder: testPageBuilder }),
  ]);
  const active = await activeReleaseId(DB);
  assert.ok(active, '没有任何 bootstrap 成功');
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_releases WHERE status='published'"), 1);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_events WHERE action='bootstrap'"), 1);
  // 输的那个不能留下任何孤儿行
  assert.equal(await sqlValue(DB, 'SELECT COUNT(*) FROM public_content_releases'), 1);
  assert.equal(await sqlValue(DB, `SELECT COUNT(DISTINCT release_id) FROM public_content_release_pages`), 1);
  assert.equal(results.filter(r => r.active_release_id === active).length, 2, '两个调用都应看到同一个指针');
});

await check('two parallel activations of the same due release produce one winner', async () => {
  const DB = await freshDb();
  const env = { DB };
  const scheduled = await schedulePublicRelease(env, {
    expectedRevision: await draftRevision(DB), effectiveAtUtc: '2026-08-29T10:00:00.000Z',
    now: new Date('2026-08-29T09:00:00.000Z'), pageBuilder: testPageBuilder,
  });
  assert.equal(scheduled.ok, true);
  const now = new Date('2026-08-29T10:00:00.000Z');
  const [a, b] = await Promise.all([
    activateDueRelease(env, { now }), activateDueRelease(env, { now }),
  ]);
  assert.equal([a, b].filter(r => r.activated).length, 1, '恰好一个赢家');
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_events WHERE action='published'"), 1);
});

await check('the latest due release wins and earlier due releases are superseded', async () => {
  const DB = await freshDb();
  const env = { DB };
  const revision = await draftRevision(DB);
  const early = await schedulePublicRelease(env, { expectedRevision: revision,
    effectiveAtUtc: '2026-08-29T10:00:00.000Z', now: new Date('2026-08-29T09:00:00.000Z'), pageBuilder: testPageBuilder });
  const late = await schedulePublicRelease(env, { expectedRevision: revision,
    effectiveAtUtc: '2026-08-29T11:00:00.000Z', now: new Date('2026-08-29T09:30:00.000Z'), pageBuilder: testPageBuilder });
  assert.equal(early.ok && late.ok, true);
  await activateDueRelease(env, { now: new Date('2026-08-29T12:00:00.000Z') });
  assert.equal(await activeReleaseId(DB), late.release_id);
  assert.equal(await sqlValue(DB, `SELECT status FROM public_content_releases WHERE id='${early.release_id}'`), 'superseded');
});

await check('an exactly-due release cannot be cancelled, and activation wins the race', async () => {
  const DB = await freshDb();
  const env = { DB };
  const due = '2026-08-29T10:00:00.000Z';
  const release = await schedulePublicRelease(env, { expectedRevision: await draftRevision(DB),
    effectiveAtUtc: due, now: new Date('2026-08-29T09:00:00.000Z'), pageBuilder: testPageBuilder });
  const now = new Date(due);
  const [cancel, activate] = await Promise.all([
    cancelScheduledRelease(env, { releaseId: release.release_id, now }),
    activateDueRelease(env, { now }),
  ]);
  assert.equal(cancel.ok, false, '正好到点的发布不允许取消');
  assert.equal(cancel.code, 'cancel_rejected');
  assert.equal(activate.activated, true);
  assert.equal(await activeReleaseId(DB), release.release_id);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_events WHERE action='cancelled'"), 0);
});

await check('a future release cancels cleanly and Cron then finds nothing due', async () => {
  const DB = await freshDb();
  const env = { DB };
  const release = await schedulePublicRelease(env, { expectedRevision: await draftRevision(DB),
    effectiveAtUtc: '2026-08-29T18:00:00.000Z', now: new Date('2026-08-29T09:00:00.000Z'), pageBuilder: testPageBuilder });
  const cancelled = await cancelScheduledRelease(env, { releaseId: release.release_id, now: new Date('2026-08-29T10:00:00.000Z') });
  assert.equal(cancelled.ok, true);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_events WHERE action='cancelled'"), 1);
  const after = await activateDueRelease(env, { now: new Date('2026-08-29T19:00:00.000Z') });
  assert.equal(after.activated, false);
  assert.equal(await activeReleaseId(DB), null);
});

await check('rollback republishes the historical snapshot under a new id, never the draft', async () => {
  const DB = await freshDb();
  const env = { DB };
  const now = new Date('2026-08-29T12:00:00.000Z');
  const boot = await ensureActiveRelease(env, { allowBootstrap: true, now, pageBuilder: testPageBuilder });
  const originalChecksum = await sqlValue(DB, `SELECT checksum FROM public_content_releases WHERE id='${boot.active_release_id}'`);
  // 改草稿：回滚绝不能把这条新价格带出去
  await DB.prepare("UPDATE products SET price=99.9 WHERE sku='S01'").run();
  const later = new Date('2026-08-29T13:00:00.000Z');
  const drifted = await schedulePublicRelease(env, { expectedRevision: await draftRevision(DB),
    effectiveAtUtc: later.toISOString(), now: later, pageBuilder: testPageBuilder });
  await activateDueRelease(env, { now: later });
  assert.equal(await activeReleaseId(DB), drifted.release_id);
  const rolled = await rollbackPublicRelease(env, { sourceReleaseId: boot.active_release_id,
    now: new Date('2026-08-29T14:00:00.000Z'), pageBuilder: testPageBuilder });
  assert.equal(rolled.ok, true);
  assert.notEqual(rolled.release_id, boot.active_release_id, '回滚必须是新的 release id');
  assert.equal(rolled.checksum, originalChecksum, '回滚快照必须与历史一致');
  assert.notEqual(rolled.checksum, drifted.checksum, '回滚快照必须不同于当前草稿');
  assert.equal(await activeReleaseId(DB), rolled.release_id);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_releases WHERE status='published'"), 1);
  const price = await sqlValue(DB, `SELECT price_cents FROM public_content_release_products WHERE release_id='${rolled.release_id}' AND sku='S01'`);
  assert.equal(price, 360, '回滚发布的价格必须来自历史快照');
});

await check('a page-builder failure leaves zero schedulable rows', async () => {
  const DB = await freshDb();
  const env = { DB };
  let threw = false;
  try {
    await schedulePublicRelease(env, { expectedRevision: await draftRevision(DB),
      effectiveAtUtc: '2026-08-29T14:00:00.000Z', now: new Date('2026-08-29T12:00:00.000Z'),
      pageBuilder: async () => { throw new Error('renderer exploded'); } });
  } catch { threw = true; }
  assert.equal(threw, true);
  for (const table of ['public_content_releases','public_content_release_products','public_content_release_pages','public_media','public_content_events']) {
    assert.equal(await sqlValue(DB, `SELECT COUNT(*) FROM ${table}`), 0, `${table} 不应有任何行`);
  }
});

// 记录每条语句的 SQL 与绑定数，用来验预算（真 D1 的 statement 不暴露绑定）。
function recordingDb(DB) {
  const seen = { statements: [], batches: [] };
  const wrap = stmt => new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'bind') return (...args) => {
        const bound = target.bind(...args);
        seen.statements.push({ sql: target.__sql, bindings: args.length,
          maxPayload: Math.max(0, ...args.map(a => typeof a === 'string' ? a.length : 0)) });
        return wrap(Object.assign(bound, { __sql: target.__sql }));
      };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    seen,
    prepare: sql => wrap(Object.assign(DB.prepare(sql), { __sql: sql })),
    batch: statements => { seen.batches.push(statements.length); return DB.batch(statements); },
  };
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const distinctPng = i => 'data:image/png;base64,' + Buffer.concat([PNG_SIG, Buffer.alloc(64, i % 251)]).toString('base64');

async function seedMaxFixture(DB, { products = 80, distinctImages = true } = {}) {
  const statements = [];
  for (let i = 0; i < products; i++) {
    const sku = `MAX${String(i).padStart(3, '0')}`;
    statements.push(DB.prepare(
      'INSERT INTO products(sku,name_cn,name_en,price,category,kcal,img,active,sort) VALUES(?,?,?,?,?,?,?,1,?)')
      .bind(sku, `压测包${i}`, `Max bun ${i}`, 3.5 + (i % 10) / 10, 'protein', 200 + i,
        distinctImages ? distinctPng(i) : distinctPng(7), i));
  }
  await DB.batch(statements);
}

await check('pre-Cron public recovery returns bootstrap_pending and writes nothing', async () => {
  const DB = await freshDb();
  const counting = countingDb(DB);
  const env = { DB: counting };
  const now = new Date('2026-08-29T12:00:00.000Z');
  const before = await sqlValue(DB, 'SELECT updated_at FROM public_content_state WHERE singleton=1');
  const [a, b] = await Promise.all([
    ensureActiveRelease(env, { allowBootstrap: false, now }),
    ensureActiveRelease(env, { allowBootstrap: false, now }),
  ]);
  assert.equal(a.bootstrap_pending, true);
  assert.equal(b.bootstrap_pending, true);
  assert.equal(a.active_release_id, null);
  for (const table of ['public_content_releases','public_content_release_products','public_content_release_pages','public_media','public_content_events']) {
    assert.equal(await sqlValue(DB, `SELECT COUNT(*) FROM ${table}`), 0, `${table} 不应有任何行`);
  }
  assert.equal(await sqlValue(DB, 'SELECT updated_at FROM public_content_state WHERE singleton=1'), before, 'state 不应被改写');
  assert.ok(counting.counter.queries < 50, `恢复路径用了 ${counting.counter.queries} 次查询`);
});

await check('posters are resolved against effective_at, not request time', async () => {
  const DB = await freshDb();
  const env = { DB };
  const ts = '2026-08-01T00:00:00.000Z';
  await DB.batch([
    DB.prepare(`INSERT INTO homepage_posters(id,title_cn,starts,ends,active,sort,created_at,updated_at)
      VALUES('aug','八月活动','2026-08-01','2026-08-31',1,1,?,?)`).bind(ts, ts),
    DB.prepare(`INSERT INTO homepage_posters(id,title_cn,starts,ends,active,sort,created_at,updated_at)
      VALUES('sep','九月活动','2026-09-01','2026-09-30',1,2,?,?)`).bind(ts, ts),
  ]);
  const revision = await draftRevision(DB);
  const now = new Date('2026-08-29T12:00:00.000Z');
  // 请求时间在八月，但生效时间在九月 —— 快照必须按生效时间取九月的海报
  const september = await schedulePublicRelease(env, { expectedRevision: revision,
    effectiveAtUtc: '2026-09-15T02:00:00.000Z', now, pageBuilder: testPageBuilder });
  assert.equal(september.ok, true);
  const snapshot = JSON.parse(await sqlValue(DB, `SELECT snapshot_json FROM public_content_releases WHERE id='${september.release_id}'`));
  const ids = snapshot.offers.map(o => o.id);
  assert.ok(ids.includes('sep'), '九月海报应在场');
  assert.ok(!ids.includes('aug'), '八月海报不应出现在九月的发布里');
});

await check('a stale draft revision writes nothing at all', async () => {
  const DB = await freshDb();
  const env = { DB };
  const draft = await loadPublishableDraftForTest(env);
  const result = await materializeRelease(env, {
    snapshot: draft.snapshot, media: draft.media, sourceRevision: 'stale-revision',
    effectiveAtUtc: '2026-08-29T14:00:00.000Z', actor: 'boss',
    now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: testPageBuilder,
    guard: { kind: 'draft', expectedRevision: 'not-the-current-revision' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'revision_conflict');
  for (const table of ['public_content_releases','public_content_release_products','public_content_release_pages','public_media','public_content_events']) {
    assert.equal(await sqlValue(DB, `SELECT COUNT(*) FROM ${table}`), 0, `${table} 不应有任何行`);
  }
});

await check('a child statement constraint failure rolls the whole batch back', async () => {
  const DB = await freshDb();
  const env = { DB };
  const draft = await loadPublishableDraftForTest(env);
  // 同一个 SKU 出现两次 → public_content_release_products 主键冲突（第 3 条语句）
  const poisoned = { ...draft.snapshot, products: [draft.snapshot.products[0], { ...draft.snapshot.products[0] }] };
  let threw = false;
  try {
    await materializeRelease(env, { snapshot: poisoned, media: [], sourceRevision: await draftRevision(DB),
      effectiveAtUtc: '2026-08-29T14:00:00.000Z', actor: 'boss', now: new Date('2026-08-29T12:00:00.000Z'),
      pageBuilder: testPageBuilder, guard: { kind: 'draft', expectedRevision: await draftRevision(DB) } });
  } catch { threw = true; }
  assert.equal(threw, true, '子语句约束冲突必须抛出');
  assert.equal(await sqlValue(DB, 'SELECT COUNT(*) FROM public_content_releases'), 0, '整批必须回滚');
  assert.equal(await sqlValue(DB, 'SELECT COUNT(*) FROM public_content_release_pages'), 0);
});

await check('the maximum fixture stays inside statement, binding, payload, query and CPU budgets', async () => {
  const DB = await freshDb();
  await seedMaxFixture(DB, { products: 80 });
  const recorder = recordingDb(DB);
  const counting = countingDb(DB);
  const env = { DB: recorder };
  const cpuBefore = process.cpuUsage();
  const boot = await ensureActiveRelease(env, { allowBootstrap: true,
    now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: testPageBuilder });
  const cpuMs = (process.cpuUsage(cpuBefore).user + process.cpuUsage(cpuBefore).system) / 1000;
  assert.ok(boot.active_release_id, 'bootstrap 应成功');
  const maxBatch = Math.max(...recorder.seen.batches);
  assert.ok(maxBatch <= 30, `单批 ${maxBatch} 条语句，超过 30 条上限`);
  const maxBindings = Math.max(...recorder.seen.statements.map(s => s.bindings));
  assert.ok(maxBindings <= 100, `单条语句 ${maxBindings} 个绑定，超过 100`);
  const maxPayload = Math.max(...recorder.seen.statements.map(s => s.maxPayload));
  assert.ok(maxPayload < 1500000, `单个 JSON 负载 ${maxPayload} 字节，超过 1.5MB`);
  assert.ok(cpuMs < 15000, `最大夹具用了 ${Math.round(cpuMs)}ms CPU，超过 15s 预算（Worker 30s 的一半）`);
  // 同一路径再跑一次，只数查询
  const DB2 = await freshDb();
  await seedMaxFixture(DB2, { products: 80 });
  const counting2 = countingDb(DB2);
  await ensureActiveRelease({ DB: counting2 }, { allowBootstrap: true,
    now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: testPageBuilder });
  assert.ok(counting2.counter.queries < 50, `bootstrap 用了 ${counting2.counter.queries} 次查询，超过 50`);
});

await check('duplicate media across the whole menu is stored once', async () => {
  const DB = await freshDb();
  await seedMaxFixture(DB, { products: 40, distinctImages: false });
  const counting = countingDb(DB);
  const boot = await ensureActiveRelease({ DB: counting }, { allowBootstrap: true,
    now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: testPageBuilder });
  assert.ok(boot.active_release_id);
  assert.equal(await sqlValue(DB, 'SELECT COUNT(*) FROM public_media'), 1, '同一张图只应入库一次');
  assert.ok(counting.counter.queries < 50, `重复图片路径用了 ${counting.counter.queries} 次查询`);
});

await check('publish-now and rollback never leave two published releases', async () => {
  const DB = await freshDb();
  const env = { DB };
  const now = new Date('2026-08-29T12:00:00.000Z');
  const boot = await ensureActiveRelease(env, { allowBootstrap: true, now, pageBuilder: testPageBuilder });
  const later = new Date('2026-08-29T13:00:00.000Z');
  const due = await schedulePublicRelease(env, { expectedRevision: await draftRevision(DB),
    effectiveAtUtc: later.toISOString(), now: later, pageBuilder: testPageBuilder });
  const [rolled, activated] = await Promise.all([
    rollbackPublicRelease(env, { sourceReleaseId: boot.active_release_id, now: later, pageBuilder: testPageBuilder }),
    activateDueRelease(env, { now: later }),
  ]);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_releases WHERE status='published'"), 1,
    '任何时刻只能有一个 published');
  assert.equal([rolled.ok === true, activated.activated === true].filter(Boolean).length >= 1, true);
  const active = await activeReleaseId(DB);
  assert.equal(await sqlValue(DB, `SELECT status FROM public_content_releases WHERE id='${active}'`), 'published');
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_releases WHERE status='scheduled'"), 0,
    '输掉的目标必须被取消，不能留给 Cron 稍后发布');
});

import { renderPublicReleasePages } from '../worker/public-render.js';

await check('the real renderer drives a full bootstrap and every page lands in D1', async () => {
  const DB = await freshDb();
  const counting = countingDb(DB);
  const boot = await ensureActiveRelease({ DB: counting }, { allowBootstrap: true,
    now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: renderPublicReleasePages });
  assert.ok(boot.active_release_id, 'bootstrap 应成功');
  const paths = (await DB.prepare('SELECT path FROM public_content_release_pages WHERE release_id=? ORDER BY path')
    .bind(boot.active_release_id).all()).results.map(r => r.path);
  for (const required of ['/', '/menu', '/locations', '/offers', '/robots.txt', '/sitemap.xml', '/public/catalog.json']) {
    assert.ok(paths.includes(required), `缺少页面 ${required}`);
  }
  assert.ok(paths.some(p => p.startsWith('/menu/')), '缺少商品详情页');
  const home = await sqlValue(DB, `SELECT body FROM public_content_release_pages WHERE release_id='${boot.active_release_id}' AND path='/'`);
  assert.match(home, /鲜肉包/, '首页原始 HTML 必须含真实商品名');
  assert.match(home, /S\$3\.60/, '首页原始 HTML 必须含展示价');
  assert.doesNotMatch(home, /data:image/, '页面里不得残留 data URI');
  const contentType = await sqlValue(DB, `SELECT content_type FROM public_content_release_pages WHERE release_id='${boot.active_release_id}' AND path='/'`);
  assert.equal(contentType, 'text/html; charset=utf-8');
  assert.ok(counting.counter.queries < 50, `真渲染器 bootstrap 用了 ${counting.counter.queries} 次查询`);
});

import {
  commitDraftMutation, tagUpsertStatements, tagDeleteStatements,
  productTagAssignmentStatements, signPreviewToken, verifyPreviewToken,
} from '../worker/publication.js';

// Draft writes are only accepted once the first release exists (otherwise the bootstrap would publish them unreviewed).
async function liveDb() {
  const DB = await freshDb();
  await ensureActiveRelease({ DB }, { allowBootstrap: true, now: new Date('2026-08-29T12:00:00.000Z'), pageBuilder: testPageBuilder });
  return DB;
}

await check('a draft mutation bumps the global revision and audits itself', async () => {
  const DB = await liveDb();
  const env = { DB };
  const before = await draftRevision(DB);
  const activeBefore = await activeReleaseId(DB);
  const result = await commitDraftMutation(env, {
    expectedRevision: before, action: 'tag_saved', detail: { id: 'chef-pick' },
    buildStatements: ({ revision, now }) => tagUpsertStatements(env, { revision, now,
      tag: { id: 'chef-pick', label_cn: '店长推荐', label_en: "Chef's pick", tone: 'gold', icon: '⭐', active: 1, sort: 5 } }),
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.draft_revision, before);
  assert.equal(await draftRevision(DB), result.draft_revision);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM product_tags WHERE id='chef-pick'"), 1);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM public_content_events WHERE action='tag_saved'"), 1);
  // 内容改动【不能】动活动发布指针
  assert.equal(await activeReleaseId(DB), activeBefore);
});

await check('a stale base revision writes nothing and leaves the draft untouched', async () => {
  const DB = await freshDb();
  const env = { DB };
  const before = await draftRevision(DB);
  const result = await commitDraftMutation(env, {
    expectedRevision: 'someone-elses-revision', action: 'tag_saved',
    buildStatements: ({ revision, now }) => tagUpsertStatements(env, { revision, now,
      tag: { id: 'ghost', label_cn: '幽灵', label_en: '', tone: 'red', icon: '', active: 1, sort: 1 } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(await draftRevision(DB), before, '草稿版本不应前进');
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM product_tags WHERE id='ghost'"), 0);
  assert.equal(await sqlValue(DB, 'SELECT COUNT(*) FROM public_content_events'), 0);
});

await check('two parallel draft mutations produce exactly one winner', async () => {
  const DB = await liveDb();
  const env = { DB };
  const base = await draftRevision(DB);
  const mutation = id => commitDraftMutation(env, { expectedRevision: base, action: 'tag_saved',
    buildStatements: ({ revision, now }) => tagUpsertStatements(env, { revision, now,
      tag: { id, label_cn: '并发', label_en: '', tone: 'blue', icon: '', active: 1, sort: 1 } }) });
  const [a, b] = await Promise.all([mutation('race-a'), mutation('race-b')]);
  assert.equal([a, b].filter(r => r.ok).length, 1, '恰好一个赢家');
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM product_tags WHERE id IN ('race-a','race-b')"), 1);
});

await check('a tag in use cannot be deleted, and assignments keep their order', async () => {
  const DB = await liveDb();
  const env = { DB };
  let revision = await draftRevision(DB);
  const assigned = await commitDraftMutation(env, { expectedRevision: revision, action: 'tags_assigned',
    buildStatements: ({ revision: next }) => productTagAssignmentStatements(env, { revision: next, sku: 'S01', tagIds: ['fresh-meat', 'new-arrival'] }) });
  assert.equal(assigned.ok, true);
  const order = (await DB.prepare("SELECT tag_id FROM product_tag_assignments WHERE sku='S01' ORDER BY sort").all()).results.map(r => r.tag_id);
  assert.deepEqual(order, ['fresh-meat', 'new-arrival'], '标签顺序必须按提交顺序');

  revision = assigned.draft_revision;
  const blocked = await commitDraftMutation(env, { expectedRevision: revision, action: 'tag_deleted',
    buildStatements: ({ revision: next }) => tagDeleteStatements(env, { revision: next, tagId: 'fresh-meat' }) });
  // CAS 会成功（版本前进），但删除语句因为「仍被引用」而是空操作 —— 标签必须还在
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM product_tags WHERE id='fresh-meat'"), 1, '在用标签不得被删除');

  const unassigned = await commitDraftMutation(env, { expectedRevision: blocked.draft_revision, action: 'tags_assigned',
    buildStatements: ({ revision: next }) => productTagAssignmentStatements(env, { revision: next, sku: 'S01', tagIds: [] }) });
  const removed = await commitDraftMutation(env, { expectedRevision: unassigned.draft_revision, action: 'tag_deleted',
    buildStatements: ({ revision: next }) => tagDeleteStatements(env, { revision: next, tagId: 'fresh-meat' }) });
  assert.equal(removed.ok, true);
  assert.equal(await sqlValue(DB, "SELECT COUNT(*) FROM product_tags WHERE id='fresh-meat'"), 0, '无人引用后才允许删除');
});

await check('preview tokens reject tampering, expiry and carry no content', async () => {
  const secret = 'preview-test-secret';
  const token = await signPreviewToken(secret, { draftRevision: 'draft-1',
    expiresAt: new Date('2026-08-29T12:10:00.000Z').toISOString(), nonce: 'nonce-1' });
  const good = await verifyPreviewToken(secret, token, { now: new Date('2026-08-29T12:05:00.000Z') });
  assert.equal(good.ok, true);
  assert.equal(good.draftRevision, 'draft-1');

  const expired = await verifyPreviewToken(secret, token, { now: new Date('2026-08-29T12:11:00.000Z') });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 410);

  const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal((await verifyPreviewToken(secret, tampered, { now: new Date('2026-08-29T12:05:00.000Z') })).ok, false);
  assert.equal((await verifyPreviewToken('another-secret', token, { now: new Date('2026-08-29T12:05:00.000Z') })).ok, false);
  assert.equal((await verifyPreviewToken(secret, 'garbage')).ok, false);
  // 令牌里不得出现任何内容或凭据
  const payload = Buffer.from(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.deepEqual(Object.keys(JSON.parse(payload)).sort(), ['exp', 'n', 'r']);
});

if (mf) await mf.dispose();
report();
