// catalog-guard-v1 on the deployed source: guarded product text writes, exact whole-snapshot publication and
// rollback, and public media served from the BLOB shape production D1 returns.
//
// Every request goes through the real Worker against the real migrations on node:sqlite (batch = one transaction).
// Races are reproduced by landing a boss mutation right before the guarded batch — after the route has read — and
// The boss routes and guarded catalog client must both refuse stale reads after the admin CAS migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import worker from '../worker/index.js';
import { canonicalJson } from '../worker/publication.js';
import { createSqliteD1 } from './sqlite-d1.mjs';

const OWNER = 'catalog-guard-owner-admin-token';
const ORIGIN = 'https://shop.example';
const ROW_COLUMNS = ['sku', 'name_cn', 'name_en', 'price', 'category', 'kcal', 'img', 'description_cn', 'description_en',
  'detail_cn', 'detail_en', 'active', 'sort'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const rowSha = row => sha256(JSON.stringify(ROW_COLUMNS.map(column => row[column] ?? null)));
const jpeg = fill => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(96).fill(fill)]);
const dataUrl = bytes => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
const MB4_IMAGE = jpeg(4);
const MB5_IMAGE = jpeg(5);

const TARGET = {
  S01: {
    name_cn: '招牌鲜肉包 (105g)', name_en: 'Pork Bun (105g)', price: '3.60',
    description_cn: '严选湖南新鲜黑猪肉，慢火熬制高汤入馅，一口浓郁爆汁！',
    description_en: 'Carefully selected fresh Hunan black pork filled with slow-simmered broth.',
    detail_cn: '【品质卖点】示例点心铺招牌必点！\n【保存 / 加热】建议蒸箱 / 蒸锅大火复蒸 8–10 分钟；冷藏保存 2 天，冷冻保存 14 天。',
    detail_en: '【Highlights】\nOur signature must-try item!\n【Storage & Reheating】\nReheat in a steamer over high heat for 8–10 minutes.',
  },
  MB5: {
    name_cn: '经典上海生煎（4 只装）', name_en: 'Classic Shanghai Pan-Fried Pork Buns (4 pieces)', price: '6.50',
    description_cn: '薄底酥脆金黄，皮软多汁，满满鲜美的黑猪肉浓汤馅！',
    description_en: 'Golden crispy bottom, soft wrappers and juicy black pork filling with rich broth.',
    detail_cn: '【保存 / 加热】推荐平底锅小火煎制，底部淋少许清水焖 4–5 分钟；冷藏保存 1 天，冷冻保存 14 天。\n【过敏原与饮食提示】含有麸质（小麦）、大豆、猪肉、芝麻成分。',
    detail_en: '【Storage & Reheating】\nPan-fry on low heat, add a splash of water and simmer covered for 4–5 minutes.\n【Allergens & Dietary Information】\nContains gluten (wheat), soybeans, pork and sesame.',
  },
};
const SEED = [
  { sku: 'S01', name_cn: '鲜肉包', name_en: 'Juicy Pork Bun', price: 3.6, category: 'protein', kcal: 250, img: 'img/01.png',
    description_cn: '鲜肉包', description_en: 'Pork bun', detail_cn: '旧详情', detail_en: 'Old detail', active: 1, sort: 1 },
  { sku: 'S08', name_cn: '清单外商品', name_en: 'Unrelated Bun', price: 3.2, category: 'lowcal', kcal: 180, img: 'img/08.png',
    description_cn: '清单外', description_en: 'Out of scope', detail_cn: '', detail_en: '', active: 1, sort: 8 },
  { sku: 'MB4', name_cn: '烧卖（3粒）', name_en: 'Shaomai (3 pcs)', price: 6.8, category: 'protein', kcal: null, img: dataUrl(MB4_IMAGE),
    description_cn: '烧卖', description_en: 'Shaomai', detail_cn: '', detail_en: '', active: 1, sort: 24 },
];
const MB5_DRAFT = { sku: 'MB5', name_cn: '爆汁湖南黑猪肉生煎包 (5粒)', name_en: 'Juicy Hunan Black Pork Pan-Fried Buns (5pcs)',
  price: 8.8, category: 'protein', kcal: '', img: dataUrl(MB5_IMAGE), description_cn: '生煎', description_en: 'Pan-fried buns',
  detail_cn: '', detail_en: '', active: 1, sort: 25 };

// A published site (bootstrap without MB5) whose draft then gains the boss's MB5, like production.
async function site({ blobs = 'array' } = {}) {
  const d1 = createSqliteD1({ blobs });
  const pending = [];
  const env = { DB: d1, ADMIN_TOKEN: OWNER, AUTH_SECRET: 'catalog-guard-auth-secret' };
  const ctx = { waitUntil: promise => { pending.push(Promise.resolve(promise)); } };
  const settle = async () => { while (pending.length) await pending.shift(); };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const call = async (pathname, { method = 'GET', body, auth = true, origin = ORIGIN } = {}) => {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${OWNER}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await worker.fetch(new Request(origin + pathname,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    await settle();
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ }
    return { status: response.status, headers: response.headers, bytes, json };
  };

  d1.sqlite.exec('DELETE FROM product_tag_assignments; DELETE FROM products; DELETE FROM homepage_posters;');
  const insert = d1.sqlite.prepare(`INSERT INTO products(${ROW_COLUMNS.join(',')}) VALUES(${ROW_COLUMNS.map(() => '?').join(',')})`);
  for (const row of SEED) insert.run(...ROW_COLUMNS.map(column => row[column]));
  await worker.scheduled({ cron: '* * * * *' }, env, ctx);
  await settle();

  const status = async () => (await call('/api/admin/publication/status')).json;
  const reviewedBody = async (when = '') => {
    const read = (await call('/api/admin/publication/draft-snapshot' + (when ? '?effective_at_sgt=' + when : ''))).json;
    return { base_revision: read.draft_revision, expected_active_release_id: read.active.release_id,
      expected_draft_checksum: read.draft.checksum, ...(when ? { effective_at_sgt: when } : {}) };
  };
  const boss = {
    save: row => call('/api/admin/product-save', { method: 'POST', body: row }),
    toggle: async (sku, active) => {
      const loaded = (await call('/api/admin/products')).json;
      return call('/api/admin/product-toggle', { method: 'POST', body: { sku, active, base_revision: loaded.draft_revision } });
    },
    publishNow: async reviewed => call('/api/admin/publication/publish-now', { method: 'POST',
      body: reviewed || await reviewedBody() }),
    schedule: async () => call('/api/admin/publication/schedule', { method: 'POST', body: await reviewedBody('2099-01-01T10:00') }),
  };
  assert.ok((await status()).active_release_id, 'bootstrap published the seed catalog');
  assert.equal((await boss.save({ ...MB5_DRAFT, base_revision: (await call('/api/admin/products')).json.draft_revision })).status, 200, 'the boss adds MB5 to the draft only');
  return {
    d1, call, boss, status,
    row: async sku => { const read = (await call('/api/admin/products')).json; return { ...read.products.find(product => product.sku === sku), base_revision: read.draft_revision }; },
    publicCatalog: async () => (await call('/public/catalog.json', { auth: false })).json,
    snapshot: async () => (await call('/api/admin/publication/draft-snapshot')).json,
    counts: () => d1.query(`SELECT (SELECT COUNT(*) FROM public_content_releases) AS releases,
      (SELECT COUNT(*) FROM public_media) AS media, (SELECT COUNT(*) FROM public_content_events) AS events,
      (SELECT draft_revision FROM public_content_state WHERE singleton=1) AS draft_revision`)[0],
  };
}

const updateText = (s, body) => s.call('/api/admin/catalog/product-text', { method: 'POST', body });
const textBody = async (s, sku, set = TARGET[sku]) => ({ sku, base_row_sha256: rowSha(await s.row(sku)), set });
const publishExact = (s, reviewed) => s.call('/api/admin/publication/publish-exact', { method: 'POST',
  body: { expected_active_release_id: reviewed.active.release_id, expected_draft_checksum: reviewed.draft.checksum } });
const releaseBatches = (s, since) => s.d1.log.batches.slice(since)
  .filter(batch => batch.some(sql => /INSERT INTO public_content_releases/.test(sql)));

test('public media saved by a publication is served with its original bytes from every D1 BLOB shape', async () => {
  for (const blobs of ['array', 'arraybuffer', 'uint8array']) {
    const s = await site({ blobs });
    const hash = sha256(MB4_IMAGE);
    assert.equal((await s.publicCatalog()).products.find(product => product.sku === 'MB4').image_url, `/public/media/${hash}`);
    for (const origin of [ORIGIN, 'https://boss.shop.example']) {
      const media = await s.call(`/public/media/${hash}`, { auth: false, origin });
      assert.equal(media.status, 200, `${blobs} BLOB via ${origin}`);
      assert.equal(media.headers.get('content-type'), 'image/jpeg');
      assert.equal(sha256(media.bytes), hash, `${blobs} BLOB bytes are the original`);
    }
  }
});

test('a boss edit after the read is refused by both the admin form save and guarded text update', async () => {
  const legacy = await site();
  const stale = await legacy.row('S01');
  assert.equal((await legacy.boss.toggle('S01', 0)).status, 200, 'boss takes S01 offline after the read');
  assert.equal((await legacy.boss.save({ ...stale, ...TARGET.S01 })).status, 409);
  assert.equal((await legacy.row('S01')).active, 0, 'regression: the admin full-row save no longer puts S01 back online');

  const guarded = await site();
  const body = await textBody(guarded, 'S01');
  assert.equal((await guarded.boss.toggle('S01', 0)).status, 200);
  const revision = (await guarded.status()).draft_revision;
  const refused = await updateText(guarded, body);
  assert.equal(refused.status, 409);
  assert.equal(refused.json?.code, 'product_conflict');
  const kept = await guarded.row('S01');
  assert.deepEqual([kept.active, kept.name_cn], [0, '鲜肉包'], 'the boss edit survives and nothing was written');
  assert.equal((await guarded.status()).draft_revision, revision, 'a refused write does not move the draft revision');

  const inflight = await site();
  const inflightBody = await textBody(inflight, 'S01');
  inflight.d1.beforeBatch(/UPDATE products SET name_cn/, async () => {
    assert.equal((await inflight.boss.toggle('S01', 0)).status, 200);
  });
  const lost = await updateText(inflight, inflightBody);
  assert.equal(inflight.d1.pendingHooks(), 0, 'the concurrent edit really landed between the read and the batch');
  assert.equal(lost.status, 409);
  assert.equal(lost.json?.code, 'product_conflict');
  const survived = await inflight.row('S01');
  assert.deepEqual([survived.active, survived.name_cn], [0, '鲜肉包']);
});

test('the guarded text update writes exactly the seven approved fields once and validates before any write', async () => {
  const s = await site();
  const before = await s.row('S01');
  const startRevision = (await s.status()).draft_revision;
  const applied = await updateText(s, { sku: 'S01', base_row_sha256: rowSha(before), set: TARGET.S01 });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  const after = await s.row('S01');
  for (const field of ['name_cn', 'name_en', 'description_cn', 'description_en', 'detail_cn', 'detail_en']) {
    assert.equal(after[field], TARGET.S01[field], field);
  }
  assert.equal(after.price, 3.6);
  for (const field of ['sku', 'category', 'kcal', 'img', 'active', 'sort']) assert.equal(after[field], before[field], `${field} preserved`);
  assert.equal(applied.json.row_sha256, rowSha(after), 'the returned fingerprint is the stored row');
  assert.notEqual(applied.json.draft_revision, startRevision);
  assert.equal((await s.status()).draft_revision, applied.json.draft_revision);
  assert.equal(s.d1.query("SELECT COUNT(*) AS n FROM public_content_events WHERE action='product_text_updated'")[0].n, 1);

  const retry = await updateText(s, { sku: 'S01', base_row_sha256: rowSha(before), set: TARGET.S01 });
  assert.equal(retry.status, 409, 'a retry after a lost response cannot write a second time');
  assert.equal(rowSha(await s.row('S01')), rowSha(after));

  const fresh = rowSha(after);
  const unchanged = s.counts();
  for (const [body, expected, why] of [
    [{ sku: 'S01', base_row_sha256: fresh, set: { ...TARGET.S01, img: 'img/99.png' } }, 400, 'extra field'],
    [{ sku: 'S01', base_row_sha256: fresh, set: { name_cn: TARGET.S01.name_cn } }, 400, 'missing fields'],
    [{ sku: 'S01', base_row_sha256: fresh, set: { ...TARGET.S01, name_cn: ` ${TARGET.S01.name_cn} ` } }, 400, 'text the save rules would alter'],
    [{ sku: 'S01', base_row_sha256: fresh, set: { ...TARGET.S01, price: '0' } }, 400, 'zero price'],
    [{ sku: 'S01', base_row_sha256: fresh, set: { ...TARGET.S01, price: '2.805' } }, 400, 'sub-cent price'],
    [{ sku: 'S01', base_row_sha256: fresh, set: { ...TARGET.S01, name_en: '' } }, 400, 'empty name'],
    [{ sku: 'S01', base_row_sha256: 'abc', set: TARGET.S01 }, 400, 'malformed fingerprint'],
    [{ sku: 'NOPE', base_row_sha256: fresh, set: TARGET.S01 }, 404, 'unknown sku'],
  ]) {
    assert.equal((await updateText(s, body)).status, expected, why);
  }
  assert.deepEqual(s.counts(), unchanged, 'invalid requests write nothing');
  assert.equal((await s.call('/api/admin/catalog/product-text', { method: 'POST', auth: false,
    body: { sku: 'S01', base_row_sha256: fresh, set: TARGET.S01 } })).status, 401);
});

test('the draft snapshot shows the complete publishable content and its checksum and writes nothing', async () => {
  const s = await site();
  const before = s.counts();
  const response = await s.call('/api/admin/publication/draft-snapshot');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = response.json;
  assert.equal(body.guarded_api, 'catalog-guard-v1');
  const state = await s.status();
  assert.equal(body.active.release_id, state.active_release_id);
  assert.equal(body.draft_revision, state.draft_revision);
  const stored = s.d1.query('SELECT checksum, snapshot_json FROM public_content_releases WHERE id=?', state.active_release_id)[0];
  assert.equal(body.active.checksum, stored.checksum);
  assert.equal(canonicalJson(body.active.snapshot), stored.snapshot_json);
  assert.equal(body.draft.checksum, sha256(canonicalJson(body.draft.snapshot)));
  assert.deepEqual(body.scheduled_release_ids, []);
  assert.equal(body.draft.snapshot.products.find(product => product.sku === 'MB5').image_url, `/public/media/${sha256(MB5_IMAGE)}`);
  assert.equal(body.active.snapshot.products.some(product => product.sku === 'MB5'), false);
  assert.doesNotMatch(response.bytes.toString('utf8'), /data:image/);
  assert.deepEqual(s.counts(), before);
  assert.equal((await s.call('/api/admin/publication/draft-snapshot', { auth: false })).status, 401);
});

test('a non-target draft change is refused by both admin publish-now and exact publication', async () => {
  const legacy = await site();
  const oldReview = await legacy.snapshot();
  assert.equal((await legacy.boss.toggle('S08', 0)).status, 200);
  assert.equal((await legacy.boss.publishNow({ base_revision: oldReview.draft_revision, expected_active_release_id: oldReview.active.release_id, expected_draft_checksum: oldReview.draft.checksum })).status, 409);
  assert.equal((await legacy.publicCatalog()).products.some(product => product.sku === 'S08'), true,
    'the unreviewed change stays in the draft');

  const s = await site();
  const reviewed = await s.snapshot();
  assert.equal((await s.boss.toggle('S08', 0)).status, 200);
  const before = s.counts();
  const refused = await publishExact(s, reviewed);
  assert.equal(refused.status, 409);
  assert.equal(refused.json?.code, 'draft_snapshot_mismatch');
  assert.deepEqual(s.counts(), before, 'nothing was materialized');
  assert.equal((await s.status()).active_release_id, reviewed.active.release_id);
  assert.equal((await s.publicCatalog()).products.some(product => product.sku === 'S08'), true);
});

test('after a race is refused, re-review publishes precisely the snapshot and original media in one batch', async () => {
  const s = await site();
  for (const sku of ['S01', 'MB5']) assert.equal((await updateText(s, await textBody(s, sku))).status, 200, sku);
  const reviewed = await s.snapshot();
  const mark = s.d1.log.batches.length;
  s.d1.beforeBatch(/INSERT INTO public_content_releases/, async () => {
    assert.equal((await s.boss.toggle('S08', 0)).status, 200, 'boss change after the server verified the checksum');
  });
  const racedPublication = await publishExact(s, reviewed);
  assert.equal(s.d1.pendingHooks(), 0);
  assert.equal(racedPublication.status, 409, 'availability changes now advance the draft CAS');
  assert.equal((await s.status()).active_release_id, reviewed.active.release_id);
  assert.equal((await s.boss.toggle('S08', 1)).status, 200);
  const published = await publishExact(s, await s.snapshot());
  assert.equal(published.status, 200, JSON.stringify(published.json));
  assert.equal(published.json.checksum, reviewed.draft.checksum);

  const state = await s.status();
  assert.equal(state.active_release_id, published.json.release_id);
  assert.deepEqual(state.releases.map(release => release.status), ['published', 'superseded']);
  assert.deepEqual(s.d1.query('SELECT status FROM public_content_releases').map(row => row.status).sort(), ['published', 'superseded']);
  assert.equal(s.d1.query('SELECT snapshot_json FROM public_content_releases WHERE id=?', published.json.release_id)[0].snapshot_json,
    canonicalJson(reviewed.draft.snapshot));
  const batches = releaseBatches(s, mark);
  assert.equal(batches.length, 2, 'one zero-write failed batch, then one re-reviewed publication batch');
  assert.ok(batches[1].some(sql => /UPDATE public_content_state SET active_release_id/.test(sql)), 'the successful activation is in its materialization batch');

  const catalog = await s.publicCatalog();
  assert.equal(catalog.release_id, published.json.release_id);
  assert.equal(catalog.products.find(product => product.sku === 'S01').name_cn, TARGET.S01.name_cn);
  const mb5 = catalog.products.find(product => product.sku === 'MB5');
  assert.deepEqual([mb5.name_cn, mb5.price_cents], [TARGET.MB5.name_cn, 650]);
  assert.equal(catalog.products.some(product => product.sku === 'S08'), true, 'the in-window toggle was not promoted');
  assert.equal((await s.row('S08')).active, 1, 'boss restored it before re-reviewing the publication');
  assert.equal((await s.call('/menu/mb5', { auth: false })).status, 200);
  const image = await s.call(mb5.image_url, { auth: false });
  assert.equal(image.status, 200);
  assert.equal(sha256(image.bytes), sha256(MB5_IMAGE));
});

test('exact publication writes nothing when the draft revision, the active release or a schedule moves', async () => {
  const bumped = await site();
  const reviewedBumped = await bumped.snapshot();
  const beforeBumped = bumped.counts();
  bumped.d1.beforeBatch(/INSERT INTO public_content_releases/, async () => {
    assert.equal((await bumped.boss.save({ ...(await bumped.row('S08')), name_cn: '老板刚改的名字' })).status, 200);
  });
  const lostBumped = await publishExact(bumped, reviewedBumped);
  assert.equal(bumped.d1.pendingHooks(), 0);
  assert.equal(lostBumped.status, 409);
  assert.equal(lostBumped.json?.code, 'publication_conflict');
  assert.deepEqual([bumped.counts().releases, bumped.counts().media], [beforeBumped.releases, beforeBumped.media]);
  assert.equal((await bumped.status()).active_release_id, reviewedBumped.active.release_id);

  const raced = await site();
  const reviewedRaced = await raced.snapshot();
  let bossRelease = null;
  raced.d1.beforeBatch(/INSERT INTO public_content_releases/, async () => {
    const response = await raced.boss.publishNow();
    assert.equal(response.status, 200);
    bossRelease = response.json.release_id;
  });
  const lostRaced = await publishExact(raced, reviewedRaced);
  assert.equal(lostRaced.status, 409);
  assert.equal((await raced.status()).active_release_id, bossRelease, 'the concurrent publication stays active');
  assert.equal(raced.counts().releases, 2, 'bootstrap and the boss release only; no orphan row');
  assert.equal(raced.d1.query("SELECT COUNT(*) AS n FROM public_content_releases WHERE status='scheduled'")[0].n, 0);

  const refused = await site();
  const reviewed = await refused.snapshot();
  const ok = { expected_active_release_id: reviewed.active.release_id, expected_draft_checksum: reviewed.draft.checksum };
  const before = refused.counts();
  for (const [body, expected, code] of [
    [{ ...ok, expected_active_release_id: 'another-release' }, 409, 'active_release_changed'],
    [{ ...ok, expected_draft_checksum: '0'.repeat(64) }, 409, 'draft_snapshot_mismatch'],
    [{ expected_active_release_id: reviewed.active.release_id }, 400, 'invalid_request'],
  ]) {
    const response = await refused.call('/api/admin/publication/publish-exact', { method: 'POST', body });
    assert.equal(response.status, expected, code);
    assert.equal(response.json?.code, code);
  }
  assert.deepEqual(refused.counts(), before);
  assert.equal((await refused.boss.schedule()).status, 200, 'the boss schedules a future release');
  const scheduled = refused.counts();
  const pendingSchedule = await refused.call('/api/admin/publication/publish-exact', { method: 'POST', body: ok });
  assert.equal(pendingSchedule.status, 409);
  assert.equal(pendingSchedule.json?.code, 'scheduled_release_pending');
  assert.deepEqual(refused.counts(), scheduled);
  assert.equal((await refused.call('/api/admin/publication/publish-exact', { method: 'POST', auth: false, body: ok })).status, 401);
});

test('exact rollback republishes a historical snapshot only while the reviewed release is still active', async () => {
  const s = await site();
  const original = (await s.status()).active_release_id;
  const originalChecksum = s.d1.query('SELECT checksum FROM public_content_releases WHERE id=?', original)[0].checksum;
  assert.equal((await updateText(s, await textBody(s, 'MB5'))).status, 200);
  const published = await publishExact(s, await s.snapshot());
  assert.equal(published.status, 200);
  const rollback = body => s.call('/api/admin/publication/rollback-exact', { method: 'POST', body });

  const before = s.counts();
  const stale = await rollback({ release_id: original, expected_active_release_id: original });
  assert.equal(stale.status, 409);
  assert.equal(stale.json?.code, 'active_release_changed');
  assert.deepEqual(s.counts(), before);

  s.d1.beforeBatch(/INSERT INTO public_content_releases/, async () => {
    assert.equal((await s.boss.publishNow()).status, 200, 'a boss publication lands inside the rollback window');
  });
  const lost = await rollback({ release_id: original, expected_active_release_id: published.json.release_id });
  assert.equal(s.d1.pendingHooks(), 0);
  assert.equal(lost.status, 409);
  const bossActive = (await s.status()).active_release_id;
  assert.notEqual(bossActive, published.json.release_id, 'the newer boss publication is not overwritten');

  const rolled = await rollback({ release_id: original, expected_active_release_id: bossActive });
  assert.equal(rolled.status, 200, JSON.stringify(rolled.json));
  assert.equal(rolled.json.checksum, originalChecksum);
  const catalog = await s.publicCatalog();
  assert.equal(catalog.release_id, rolled.json.release_id);
  assert.equal(catalog.products.some(product => product.sku === 'MB5'), false);
  assert.equal((await rollback({ release_id: 'missing-release', expected_active_release_id: rolled.json.release_id })).status, 404);
  assert.equal((await s.call('/api/admin/publication/rollback-exact', { method: 'POST', auth: false,
    body: { release_id: original, expected_active_release_id: rolled.json.release_id } })).status, 401);
});
