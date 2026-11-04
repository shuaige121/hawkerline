// tests/publication-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson, checksumSnapshot, normalizeProductTagInput,
  productSlug, serializeJsonScript, sgtDateTimeLocalToUtc,
} from '../worker/publication.js';

test('tag validation accepts the five tones and rejects unsafe fields', () => {
  const good = normalizeProductTagInput({
    id:'fresh-meat', label_cn:'纯鲜肉', label_en:'Fresh meat',
    tone:'red', icon:'🥩', active:true, sort:3,
  });
  assert.equal(good.ok, true);
  assert.equal(good.tag.id, 'fresh-meat');
  for (const tone of ['green','gold','red','blue','neutral']) {
    assert.equal(normalizeProductTagInput({ id:`tag-${tone}`, label_cn:'标签', tone }).ok, true);
  }
  assert.equal(normalizeProductTagInput({ id:'BAD ID', label_cn:'标签', tone:'green' }).ok, false);
  assert.equal(normalizeProductTagInput({ id:'safe', label_cn:'', tone:'green' }).ok, false);
  assert.equal(normalizeProductTagInput({ id:'safe', label_cn:'标签', tone:'script' }).ok, false);
  assert.equal(normalizeProductTagInput({ id:'safe', label_cn:'标签', tone:'green', icon:'123456789' }).ok, false);
});

test('canonical checksum ignores object key insertion order', async () => {
  assert.equal(canonicalJson({b:2,a:{d:4,c:3}}), canonicalJson({a:{c:3,d:4},b:2}));
  assert.equal(await checksumSnapshot({b:2,a:1}), await checksumSnapshot({a:1,b:2}));
  assert.notEqual(await checksumSnapshot({a:1}), await checksumSnapshot({a:2}));
});

test('SGT datetime conversion is exact and JSON cannot end a script', () => {
  assert.equal(sgtDateTimeLocalToUtc('2026-08-29T22:30'), '2026-08-29T14:30:00.000Z');
  assert.equal(sgtDateTimeLocalToUtc('2026-02-30T10:00'), null);
  assert.equal(productSlug('S01'), 's01');
  const encoded = serializeJsonScript({x:'</script><img onerror=1>', y:'\u2028'});
  assert.doesNotMatch(encoded, /<\/script/i);
  assert.doesNotMatch(encoded, /\u2028/);
});

// ---------------------------------------------------------------- Task 2
import {
  buildPublicSnapshot, loadPublishableDraft, parsePublishableSettings,
  normalizePublishedDeliveryConfig, validatePublicSnapshot,
} from '../worker/publication.js';
import {
  decodePublicDataUrl, materializePublicMedia,
  publicMediaInsertStatements, chunkMediaForD1,
} from '../worker/public-media.js';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=';

// Mirrors the real D1 shapes: batch() resolves the five prepared statements in order.
function realShapeFixture({settings = [], products = [], tags = [], assignments = [], posters = []} = {}) {
  const calls = [];
  const stmt = sql => ({sql, bindings: [], bind(...args) { this.bindings = args; return this; }});
  return {
    calls,
    DB: {
      prepare(sql) { const s = stmt(sql); calls.push(s); return s; },
      async batch() {
        return [{results: settings}, {results: products}, {results: tags},
          {results: assignments}, {results: posters}];
      },
    },
  };
}

test('public media is content addressed and snapshots contain no data URI or private key', async () => {
  const raw = PNG_1x1;
  assert.equal(decodePublicDataUrl(raw).contentType, 'image/png');
  assert.throws(()=>decodePublicDataUrl('data:image/png;base64,'+Buffer.from('not-a-png').toString('base64')),/signature/);
  const a = await materializePublicMedia(raw), b = await materializePublicMedia(raw);
  assert.equal(a.hash, b.hash);
  assert.match(a.publicUrl, /^\/public\/media\/[0-9a-f]{64}$/);
  const snapshot = await buildPublicSnapshot({
    settings:{brand_name_cn:'示例点心铺',brand_logo:raw,shop_address:'公开地址',shop_pickup_photo:raw,
      pickup_points:[{id:'second',active:1,name:'第二自取点',address:'2 Test Rd',photo:raw}],STRIPE_SECRET_KEY:'sk_live_forbidden'},
    products:[{sku:'S01',name_cn:'鲜肉包',name_en:'Pork bun',price:3.6,category:'protein',active:1,sort:1,img:raw}],
    tags:[],assignments:[],posters:[{id:'P01',title_cn:'新品',image_data:raw,action_type:'none',action_value:''}],
  }, async value => (await materializePublicMedia(value)).publicUrl);
  assert.doesNotMatch(JSON.stringify(snapshot), /data:image|sk_live|STRIPE_SECRET_KEY/);
  assert.match(snapshot.settings.brand_logo, /^\/public\/media\/[0-9a-f]{64}$/);
  assert.match(snapshot.settings.shop_pickup_photo, /^\/public\/media\/[0-9a-f]{64}$/);
  assert.match(snapshot.settings.pickup_points[0].photo, /^\/public\/media\/[0-9a-f]{64}$/);
  assert.match(snapshot.offers[0].image_url, /^\/public\/media\/[0-9a-f]{64}$/);
  assert.equal(snapshot.products[0].price_cents, 360);
  assert.equal(snapshot.settings.delivery.same_day_cutoff,'16:00');
  assert.equal(Array.isArray(snapshot.settings.delivery.zones),true);
});

test('draft loader parses real setting rows and filters posters at the release effective time', async () => {
  const env=realShapeFixture({
    settings:[{k:'pickup_points',v:JSON.stringify([{id:'second',photo:'data:image/png;base64,iVBORw0KGgo='}])}],
    posters:[
      {id:'live',active:1,starts:'2026-08-01',ends:'2026-08-31',badge:'本月',sort:10},
      {id:'off',active:0,starts:null,ends:null,sort:20},
      {id:'old',active:1,starts:'2026-07-01',ends:'2026-07-31',sort:30},
    ]});
  const draft=await loadPublishableDraft(env,{contentAt:new Date('2026-08-29T12:00:00.000Z')});
  assert.equal(Array.isArray(draft.settings.pickup_points),true);
  assert.deepEqual(draft.posters.map(p=>p.id),['live']);
  assert.equal(draft.posters[0].badge,'本月');
  const september=await loadPublishableDraft(env,{contentAt:new Date('2026-09-01T00:00:00.000Z')});
  assert.deepEqual(september.posters.map(p=>p.id),[]);
});

test('media chunks stay inside the D1 statement, binding and blob budgets', async () => {
  const media = Array.from({length:45}, (_, i) => ({
    hash:(i+1000).toString(16).padStart(64,'0'), contentType:'image/png',
    bytes:new Uint8Array(1000), byteLength:1000,
  }));
  const chunks = chunkMediaForD1(media, {maxItems:20, maxBytes:1500000});
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 20, 'chunk over 20 rows');

  const env = realShapeFixture();
  const statements = publicMediaInsertStatements(env, media, 'rel-1', 'rev-1', new Date('2026-08-29T00:00:00.000Z'));
  assert.equal(statements.length, 3);
  for (const s of statements) {
    assert.ok(s.bindings.length <= 83, `binding count ${s.bindings.length} over 83`);
    // SQL text order is: created_at (SELECT), then the VALUES tuples, then the guard
    assert.equal(s.bindings[0], '2026-08-29T00:00:00.000Z');
    // the stale-release guard must be the last thing bound, so a superseded release inserts nothing
    assert.deepEqual(s.bindings.slice(-2), ['rel-1','rev-1']);
    assert.match(s.sql, /WHERE EXISTS\(SELECT 1 FROM public_content_releases WHERE id=\? AND source_revision=\?\)/);
  }
  assert.deepEqual(publicMediaInsertStatements(env, [], 'rel-1', 'rev-1'), []);

  const oversized = Array.from({length:31}, (_, i) => ({
    hash:(i+1).toString(16).padStart(64,'0'), contentType:'image/png',
    bytes:new Uint8Array(800000), byteLength:800000,
  }));
  assert.throws(()=>chunkMediaForD1(oversized,{maxItems:20,maxBytes:1500000}), /statement/i);
});

test('delivery config publishes defaults and rejects malformed overrides', () => {
  const base = normalizePublishedDeliveryConfig({});
  assert.equal(base.same_day_cutoff, '16:00');
  assert.equal(base.zones.length, 5);
  assert.equal(normalizePublishedDeliveryConfig({SAME_DAY_CUTOFF:'09:30'}).same_day_cutoff, '09:30');
  assert.throws(()=>normalizePublishedDeliveryConfig({SAME_DAY_CUTOFF:'25:00'}), /截单/);
  assert.throws(()=>normalizePublishedDeliveryConfig({DELIVERY_ZONES:'{'}), /JSON/);
  assert.throws(()=>normalizePublishedDeliveryConfig({DELIVERY_ZONES:JSON.stringify([
    {id:'a',weekdays:[1],sectors:['28'],free_over:100,fee:10,block_below:0},
    {id:'a',weekdays:[2],sectors:['29'],free_over:100,fee:10,block_below:0}])}), /重复/);
  assert.throws(()=>normalizePublishedDeliveryConfig({DELIVERY_ZONES:JSON.stringify([
    {id:'a',weekdays:[9],sectors:['28'],free_over:100,fee:10,block_below:0}])}), /星期/);
  assert.throws(()=>normalizePublishedDeliveryConfig({DELIVERY_ZONES:JSON.stringify([
    {id:'a',weekdays:[1],sectors:['28'],free_over:-1,fee:10,block_below:0}])}), /金额/);
});

test('snapshot validator rejects duplicate skus and unsafe values', () => {
  const ok = {schema_version:1, settings:{delivery:normalizePublishedDeliveryConfig({}),pickup_points:[]},
    products:[{sku:'S01',slug:'s01',name_cn:'A',price_cents:100,tags:[],active:1,sort:0}], offers:[]};
  assert.equal(validatePublicSnapshot(ok).ok, true);
  const dupe = JSON.parse(JSON.stringify(ok));
  dupe.products.push({...dupe.products[0]});
  assert.equal(validatePublicSnapshot(dupe).ok, false);
  const negative = JSON.parse(JSON.stringify(ok));
  negative.products[0].price_cents = -1;
  assert.equal(validatePublicSnapshot(negative).ok, false);
  const noName = JSON.parse(JSON.stringify(ok));
  noName.products[0].name_cn = '';
  assert.equal(validatePublicSnapshot(noName).ok, false);
  const badMedia = JSON.parse(JSON.stringify(ok));
  badMedia.products[0].image_url = 'javascript:alert(1)';
  assert.equal(validatePublicSnapshot(badMedia).ok, false);
});
