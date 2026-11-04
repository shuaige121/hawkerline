// worker/publication.js
import { parseMenuCategories } from './menu-categories.js';
import { actorOf } from './agent-context.js';
import { resolveSnapshotComponents, validateSnapshotComponents, orderLineComponents, componentsDisplayText, ComponentsError } from './product-components.js';
const TAG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TAG_TONES = new Set(['green','gold','red','blue','neutral']);
const codePoints = value => [...String(value || '')];

export function normalizeProductTagInput(input = {}) {
  const id = String(input.id || '').trim().toLowerCase();
  const label_cn = String(input.label_cn || '').trim();
  const label_en = String(input.label_en || '').trim();
  const tone = String(input.tone || 'neutral').trim();
  const icon = String(input.icon || '').trim();
  if (!TAG_ID.test(id)) return {ok:false,status:400,field:'id',error:'标签 ID 只可用小写英文、数字和连字符'};
  if (!label_cn || codePoints(label_cn).length > 24) return {ok:false,status:400,field:'label_cn',error:'中文标签为 1–24 字'};
  if (codePoints(label_en).length > 40) return {ok:false,status:400,field:'label_en',error:'英文标签最多 40 字'};
  if (!TAG_TONES.has(tone)) return {ok:false,status:400,field:'tone',error:'标签颜色无效'};
  if (codePoints(icon).length > 8) return {ok:false,status:400,field:'icon',error:'标签图标最多 8 个字符'};
  return {ok:true,tag:{id,label_cn,label_en,tone,icon,
    active:input.active===0||input.active==='0'||input.active===false?0:1,
    sort:Math.max(0,Math.round(Number(input.sort)||0))}};
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function checksumSnapshot(snapshot) {
  const bytes = new TextEncoder().encode(canonicalJson(snapshot));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(x => x.toString(16).padStart(2,'0')).join('');
}

export function sgtDateTimeLocalToUtc(value) {
  const match = String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [,y,mo,d,h,mi] = match; const ms = Date.UTC(+y,+mo-1,+d,+h-8,+mi);
  const check = new Date(ms+8*3600000).toISOString().slice(0,16);
  return check===`${y}-${mo}-${d}T${h}:${mi}` ? new Date(ms).toISOString() : null;
}

export const productSlug = sku => String(sku||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'-');
export const serializeJsonScript = value => JSON.stringify(value)
  .replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');

// ---------------------------------------------------------------- Task 2
// Draft -> snapshot. Everything below is pure except loadPublishableDraft(),
// which reads only the boss's mutable draft tables at schedule time.

export class PublicContentError extends Error {
  constructor(field, message) { super(message); this.name = 'PublicContentError'; this.field = field; }
}

// Only these app_settings keys may ever reach a public release. Anything not
// listed here -- Stripe keys, WhatsApp ids, store_open -- cannot leak by accident.
export const DRAFT_PUBLIC_SETTING_KEYS = new Set([
  'business_hours','prep_time_min','refund_max_days','delivery_note','delivery_areas',
  'delivery_enabled','delivery_fee','delivery_min','delivery_free_above','DELIVERY_ZONES','SAME_DAY_CUTOFF',
  'gst_registered','gst_rate','service_charge_enabled','service_charge_rate',
  'shop_name','shop_address','shop_address_en','shop_pickup_detail','shop_pickup_detail_en',
  'shop_pickup_photo','pickup_enabled','pickup_points','SHOP_POSTAL','shop_contact_phone',
  'brand_logo','brand_name_cn','brand_name_en','brand_slogan_cn','brand_slogan_en',
  'brand_color_primary','brand_color_secondary','brand_color_bg','brand_color_accent',
  'TOPUP_TIERS','menu_categories',
]);
export const PUBLIC_SNAPSHOT_SETTING_KEYS = new Set([...DRAFT_PUBLIC_SETTING_KEYS, 'delivery']);
PUBLIC_SNAPSHOT_SETTING_KEYS.add('topup_tiers');
PUBLIC_SNAPSHOT_SETTING_KEYS.add('business_hours_schedule');
PUBLIC_SNAPSHOT_SETTING_KEYS.add('pickup_display');
PUBLIC_SNAPSHOT_SETTING_KEYS.add('public_origin');
PUBLIC_SNAPSHOT_SETTING_KEYS.delete('DELIVERY_ZONES');
PUBLIC_SNAPSHOT_SETTING_KEYS.delete('SAME_DAY_CUTOFF');
PUBLIC_SNAPSHOT_SETTING_KEYS.delete('TOPUP_TIERS');

// The built-in delivery rules, kept identical to worker/index.js `DELIVERY`.
// Task 6 removes the duplicate there and consumes this one.
export const DELIVERY_DEFAULTS = {
  same_day_cutoff: '16:00',
  anytime: { fee: 0, note: '自费随时送 · 运费另算（下单后单独报）' },
  zones: [
    { id: 'core',  name_cn: '核心大本营', name_en: 'Core (Mon–Fri)',  weekdays: [1,2,3,4,5],
      sectors: ['28','29','31','32','33','56','57'], free_over: 100, fee: 10, block_below: 0 },
    { id: 'west',  name_cn: '西部片区',   name_en: 'West (Tue)',       weekdays: [2],
      sectors: ['05','11','12','60','61','62','64'], free_over: 200, fee: 10, block_below: 100 },
    { id: 'east',  name_cn: '东部/东北片区', name_en: 'East/NE (Wed)',  weekdays: [3],
      sectors: ['30','46','47','48','51','52','53','54','55','81','82'], free_over: 200, fee: 10, block_below: 100 },
    { id: 'north', name_cn: '北部/西北片区', name_en: 'North/NW (Thu)', weekdays: [4],
      sectors: ['65','67','68','73','75','76'], free_over: 200, fee: 10, block_below: 100 },
    { id: 'south', name_cn: '中南/沿海片区', name_en: 'Central-S (Fri)', weekdays: [5],
      sectors: ['01','02','03','04','06','07','08','10','14','15','16'], free_over: 200, fee: 10, block_below: 100 },
  ],
};

const CUTOFF_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const SAFE_LABEL = /^[^\x00-\x1f]{0,60}$/;
const finiteMoney = value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100000;

// Publishes a stable delivery object. A malformed override is rejected rather
// than silently replaced by defaults -- publishing a different rule than the
// boss configured would mis-price real orders.
export function normalizePublishedDeliveryConfig(settings = {}) {
  const cutoffRaw = String(settings.SAME_DAY_CUTOFF || '').trim();
  if (cutoffRaw && !CUTOFF_RE.test(cutoffRaw)) throw new PublicContentError('SAME_DAY_CUTOFF','当日截单时间格式无效');
  const zonesRaw = String(settings.DELIVERY_ZONES || '').trim();
  let zones = DELIVERY_DEFAULTS.zones;
  if (zonesRaw) {
    if (zonesRaw.length > 20000) throw new PublicContentError('DELIVERY_ZONES','配送片区 JSON 过大');
    let parsed;
    try { parsed = JSON.parse(zonesRaw); } catch { throw new PublicContentError('DELIVERY_ZONES','配送片区不是有效 JSON'); }
    if (!Array.isArray(parsed) || !parsed.length) throw new PublicContentError('DELIVERY_ZONES','配送片区必须是非空数组');
    const ids = new Set(), sectors = new Set();
    zones = parsed.map(zone => {
      const id = String(zone?.id || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) throw new PublicContentError('DELIVERY_ZONES','片区 ID 无效');
      if (ids.has(id)) throw new PublicContentError('DELIVERY_ZONES',`片区 ID 重复：${id}`);
      ids.add(id);
      if (!SAFE_LABEL.test(String(zone.name_cn||'')) || !SAFE_LABEL.test(String(zone.name_en||''))) {
        throw new PublicContentError('DELIVERY_ZONES','片区名称含非法字符');
      }
      const weekdays = Array.isArray(zone.weekdays) ? zone.weekdays.map(Number) : null;
      if (!weekdays || !weekdays.length || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new PublicContentError('DELIVERY_ZONES','片区星期无效');
      }
      if (new Set(weekdays).size !== weekdays.length) throw new PublicContentError('DELIVERY_ZONES','片区星期重复');
      const zoneSectors = Array.isArray(zone.sectors) ? zone.sectors.map(s => String(s).trim()) : null;
      if (!zoneSectors || !zoneSectors.length || zoneSectors.some(s => !/^\d{2}$/.test(s))) {
        throw new PublicContentError('DELIVERY_ZONES','邮区必须是两位数字');
      }
      for (const sector of zoneSectors) {
        if (sectors.has(sector)) throw new PublicContentError('DELIVERY_ZONES',`邮区重复：${sector}`);
        sectors.add(sector);
      }
      for (const key of ['free_over','fee','block_below']) {
        if (!finiteMoney(zone[key])) throw new PublicContentError('DELIVERY_ZONES',`片区金额无效：${key}`);
      }
      return { id, name_cn:String(zone.name_cn||''), name_en:String(zone.name_en||''),
        weekdays, sectors:zoneSectors, free_over:Number(zone.free_over),
        fee:Number(zone.fee), block_below:Number(zone.block_below) };
    });
  }
  return { same_day_cutoff: cutoffRaw || DELIVERY_DEFAULTS.same_day_cutoff,
    anytime: {...DELIVERY_DEFAULTS.anytime}, zones };
}

// 储值档位是老板管理的【固定公开事实】，必须随发布一起发出去 ——
// 否则首页每次加载都要打 /api/topup-tiers，那是一条 D1 查询，
// 直接违反「正常浏览零固定内容请求」。清洗规则与 worker/index.js parseTiers 一致。
export const TOPUP_TIERS_PUBLIC_DEFAULT = [[500,80],[200,25],[100,10],[50,3]];
export function normalizePublishedTopupTiers(raw) {
  let tiers = TOPUP_TIERS_PUBLIC_DEFAULT;
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new PublicContentError('TOPUP_TIERS','储值档位不是有效 JSON'); }
    if (!Array.isArray(parsed)) throw new PublicContentError('TOPUP_TIERS','储值档位必须是数组');
    if (parsed.length) tiers = parsed;
  }
  const cleaned = tiers.map(t => [Number(t && t[0]), Number(t && t[1])])
    .filter(([amount, bonus]) => Number.isFinite(amount) && Number.isFinite(bonus) && amount > 0 && bonus >= 0);
  return cleaned.length ? cleaned : TOPUP_TIERS_PUBLIC_DEFAULT.slice();
}

// 营业时段：解析规则与默认值只在这里定义一份，worker/index.js 的
// parseBusinessHours 直接复用它，浏览器直接用发布出来的结果 —— 三处不会漂移。
export const BUSINESS_HOURS_PUBLIC_DEFAULT = { 0:['09:30','21:30'], 1:null, 2:['10:00','20:30'],
  3:['10:00','20:30'], 4:['10:00','20:30'], 5:['10:00','20:30'], 6:['09:30','21:30'] };
export function normalizePublishedBusinessHours(raw) {
  if (!raw) return { ...BUSINESS_HOURS_PUBLIC_DEFAULT };
  try {
    const parsed = JSON.parse(raw); const out = {};
    for (let d = 0; d < 7; d++) {
      const v = parsed[d];
      out[d] = (Array.isArray(v) && v.length === 2 && /^\d{1,2}:\d{2}$/.test(v[0]) && /^\d{1,2}:\d{2}$/.test(v[1])) ? [v[0], v[1]] : null;
    }
    return out;
  } catch { return { ...BUSINESS_HOURS_PUBLIC_DEFAULT }; }
}

const cleanPickupId = (id, index) => {
  const cleaned = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'-');
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(cleaned) ? cleaned : `point-${index + 1}`;
};

// Rates are percentages in this codebase (worker/index.js saneRate: gst 0-20,
// service charge 0-30). Publishing an out-of-range rate would mis-price a cart.
function assertPublishableFinance(raw) {
  const ranges = { gst_rate: 20, service_charge_rate: 30 };
  for (const [key, max] of Object.entries(ranges)) {
    if (raw[key] === undefined || raw[key] === '') continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw new PublicContentError(key, `${key} 超出 0-${max} 的允许范围`);
    }
  }
  if (raw.business_hours) {
    let hours;
    try { hours = JSON.parse(raw.business_hours); } catch { throw new PublicContentError('business_hours','营业时间不是有效 JSON'); }
    if (!hours || typeof hours !== 'object' || Array.isArray(hours)) throw new PublicContentError('business_hours','营业时间必须是对象');
    for (const [dow, span] of Object.entries(hours)) {
      if (!/^[0-6]$/.test(dow)) throw new PublicContentError('business_hours','营业时间的星期无效');
      if (span === null) continue;
      if (!Array.isArray(span) || span.length !== 2 || span.some(v => !CUTOFF_RE.test(String(v)))) {
        throw new PublicContentError('business_hours','营业时间必须是 [开门,关门] 的 HH:MM');
      }
    }
  }
}

export function parsePublishableSettings(rows=[]) {
  const raw=Object.fromEntries(rows.filter(row=>DRAFT_PUBLIC_SETTING_KEYS.has(row.k)).map(row=>[row.k,String(row.v??'')]));
  assertPublishableFinance(raw);
  let pickup_points=[];
  try { pickup_points=raw.pickup_points?JSON.parse(raw.pickup_points):[]; } catch { throw new PublicContentError('pickup_points','额外自取点不是有效 JSON'); }
  if (!Array.isArray(pickup_points)) throw new PublicContentError('pickup_points','额外自取点必须是数组');
  const extras = pickup_points.map((point,index)=>({
    id:cleanPickupId(point.id,index),active:point.active===0||point.active==='0'||point.active===false?0:1,
    name:String(point.name||point.name_cn||''),name_en:String(point.name_en||''),
    address:String(point.address||''),address_en:String(point.address_en||''),postal:String(point.postal||''),
    detail:String(point.detail||''),detail_en:String(point.detail_en||''),photo:String(point.photo||''),sort:index*10,
  }));
  const postal=String(raw.SHOP_POSTAL||'').replace(/\D/g,'').slice(0,6);
  const main={id:'main',built_in:true,active:raw.pickup_enabled!=='0'?1:0,
    name:raw.shop_name||raw.brand_name_cn||raw.brand_name_en||'',name_en:'',
    address:raw.shop_address||(postal?`S(${postal})`:''),address_en:raw.shop_address_en||'',
    postal,detail:raw.shop_pickup_detail||'',detail_en:raw.shop_pickup_detail_en||'',
    photo:raw.shop_pickup_photo||'',sort:0};
  return {...raw,
    menu_categories:parseMenuCategories(raw.menu_categories),
    delivery:normalizePublishedDeliveryConfig(raw),
    topup_tiers:normalizePublishedTopupTiers(raw.TOPUP_TIERS),
    business_hours_schedule:normalizePublishedBusinessHours(raw.business_hours),
    pickup_points:extras,
    pickup_display:[main,...extras].filter(point=>point.active)};
}

export async function loadPublishableDraft(env,{contentAt=new Date()}={}) {
  const today=new Date(contentAt.getTime()+8*3600000).toISOString().slice(0,10);
  const [settingRows,productRows,tagRows,assignmentRows,posterRows,domainRows]=await env.DB.batch([
    env.DB.prepare(`SELECT k,v FROM app_settings WHERE k IN (${[...DRAFT_PUBLIC_SETTING_KEYS].map(()=>'?').join(',')})`).bind(...DRAFT_PUBLIC_SETTING_KEYS),
    env.DB.prepare(`SELECT sku,name_cn,name_en,price,category,kcal,img,description_cn,description_en,detail_cn,detail_en,active,sort,components FROM products ORDER BY sort,sku`),
    env.DB.prepare(`SELECT id,label_cn,label_en,tone,icon,active,sort FROM product_tags ORDER BY sort,id`),
    env.DB.prepare(`SELECT sku,tag_id,sort FROM product_tag_assignments ORDER BY sku,sort,tag_id`),
    env.DB.prepare(`SELECT hp.*,pr.sku AS product_exists,pr.active AS product_active,pc.code AS promo_exists,pc.active AS promo_active,
      pc.starts AS promo_starts,pc.ends AS promo_ends,pc.max_uses,pc.used
      FROM homepage_posters hp LEFT JOIN products pr ON hp.action_type='product' AND pr.sku=hp.action_value
      LEFT JOIN promo_codes pc ON hp.action_type='promo' AND pc.code=hp.action_value ORDER BY hp.sort,hp.created_at,hp.id`),
    env.DB.prepare(`SELECT v FROM app_settings WHERE k='SHOP_DOMAIN'`),
  ]);
  const posters=(posterRows.results||[]).filter(row=>row.active&&(!row.starts||row.starts<=today)&&(!row.ends||row.ends>=today)
    &&(row.action_type!=='product'||row.product_exists&&row.product_active)
    &&(row.action_type!=='promo'||row.promo_exists&&row.promo_active&&(!row.promo_starts||row.promo_starts<=today)
      &&(!row.promo_ends||row.promo_ends>=today)&&(!row.max_uses||row.used<row.max_uses)));
  const settings=parsePublishableSettings(settingRows.results);
  const domain=String(domainRows?.results?.[0]?.v||env.SHOP_DOMAIN||'').trim().replace(/^https?:\/\//,'').replace(/\/.*$/,'').toLowerCase();
  if (/^[a-z0-9.-]+(?::\d+)?$/.test(domain)) settings.public_origin=`https://${domain}`;
  // wrangler.toml BRAND is the documented fallback until a brand name is saved in /admin
  if (!settings.brand_name_cn && !settings.brand_name_en && env.BRAND) settings.brand_name_en=String(env.BRAND).trim().slice(0,80);
  return {settings,products:productRows.results||[],tags:tagRows.results||[],
    assignments:assignmentRows.results||[],posters};
}

const POSTER_REF = /^[A-Za-z0-9_-]{1,40}$/;
export function validatePosterAction(type, value) {
  const kind = String(type || 'none').trim();
  const raw = String(value || '').trim();
  if (kind === 'none' || kind === '') return { type: 'none', value: '' };
  if (kind !== 'product' && kind !== 'promo') throw new PublicContentError('action_type', `海报动作无效：${kind}`);
  if (!POSTER_REF.test(raw)) throw new PublicContentError('action_value', '海报动作目标无效');
  return { type: kind, value: raw };
}

const PUBLIC_MEDIA_URL = /^\/public\/media\/[0-9a-f]{64}$/;
const isPublishableMediaUrl = value => {
  const url = String(value || '');
  if (!url) return true;
  if (PUBLIC_MEDIA_URL.test(url)) return true;
  if (/[\x00-\x1f\s]/.test(url)) return false;
  if (url.includes('..')) return false;
  // A scheme is only ever allowed to be https, and never with credentials.
  if (url.includes(':')) return /^https:\/\/[^@\s:]+(\/[^@\s]*)?$/i.test(url);
  if (url.startsWith('//')) return false;                       // protocol-relative
  // Same-origin asset the storefront already ships, e.g. `img/product-fallback.svg`.
  return /^\/?[a-z0-9][a-z0-9._\/-]*$/i.test(url);
};

// Fails closed: anything that could poison a page, mis-price a cart, or push a
// row past D1's 2 MB limit is rejected before a release row is ever written.
export function validatePublicSnapshot(snapshot) {
  const fail = (field, error) => ({ ok: false, field, error });
  if (!snapshot || typeof snapshot !== 'object') return fail('snapshot','快照结构无效');
  const skus = new Set(), slugs = new Set();
  for (const product of snapshot.products || []) {
    if (!product.sku) return fail('sku','商品缺少 SKU');
    if (skus.has(product.sku)) return fail('sku',`SKU 重复：${product.sku}`);
    skus.add(product.sku);
    if (slugs.has(product.slug)) return fail('slug',`商品地址重复：${product.slug}`);
    slugs.add(product.slug);
    if (!String(product.name_cn || '').trim()) return fail('name_cn',`${product.sku} 缺少中文名`);
    if (!Number.isInteger(product.price_cents) || product.price_cents < 0 || product.price_cents > 10000000) {
      return fail('price_cents',`${product.sku} 价格无效`);
    }
    if (!isPublishableMediaUrl(product.image_url)) return fail('image_url',`${product.sku} 图片地址不可发布`);
    let lastSort = -Infinity;
    for (const tag of product.tags || []) {
      if (!tag || !TAG_ID.test(String(tag.id || ''))) return fail('tags',`${product.sku} 标签引用无效`);
      if (!TAG_TONES.has(String(tag.tone))) return fail('tags',`${product.sku} 标签颜色无效`);
      const sort = Number(tag.sort) || 0;
      if (sort < lastSort) return fail('tags',`${product.sku} 标签顺序无效`);
      lastSort = sort;
    }
  }
  const bySku = new Map((snapshot.products || []).map(product => [product.sku, product]));
  for (const product of snapshot.products || []) {
    const problem = validateSnapshotComponents(product, bySku);
    if (problem) return fail('components', problem);
  }
  const offerIds = new Set();
  for (const offer of snapshot.offers || []) {
    if (!offer.id) return fail('offer','海报缺少 ID');
    if (offerIds.has(offer.id)) return fail('offer',`海报 ID 重复：${offer.id}`);
    offerIds.add(offer.id);
    if (!isPublishableMediaUrl(offer.image_url)) return fail('offer',`海报 ${offer.id} 图片地址不可发布`);
  }
  const settings = snapshot.settings || {};
  if (!settings.delivery || !Array.isArray(settings.delivery.zones)) return fail('delivery','快照缺少配送规则');
  if (settings.pickup_points !== undefined) {
    if (!Array.isArray(settings.pickup_points)) return fail('pickup_points','自取点必须是数组');
    const ids = new Set();
    for (const point of settings.pickup_points) {
      if (!point || !point.id) return fail('pickup_points','自取点缺少 ID');
      if (ids.has(point.id)) return fail('pickup_points',`自取点 ID 重复：${point.id}`);
      ids.add(point.id);
      if (!isPublishableMediaUrl(point.photo)) return fail('pickup_points',`自取点 ${point.id} 图片地址不可发布`);
    }
  }
  for (const key of ['brand_logo','shop_pickup_photo']) {
    if (!isPublishableMediaUrl(settings[key])) return fail(key,'图片地址不可发布');
  }
  const size = canonicalJson(snapshot).length;
  if (size > 1800000) return fail('snapshot',`快照 ${size} 字节，接近 D1 单行 2MB 上限`);
  return { ok: true };
}

export async function buildPublicSnapshot(draft, mediaResolver) {
  const settings = Object.fromEntries(Object.entries(draft.settings||{}).filter(([k])=>PUBLIC_SNAPSHOT_SETTING_KEYS.has(k)));
  // A draft loaded through parsePublishableSettings already carries `delivery`;
  // a hand-built draft (tests, bootstrap) gets it derived here.
  if (!settings.delivery) settings.delivery = normalizePublishedDeliveryConfig(draft.settings||{});
  if (!settings.topup_tiers) settings.topup_tiers = normalizePublishedTopupTiers((draft.settings||{}).TOPUP_TIERS);
  if (!settings.business_hours_schedule) settings.business_hours_schedule = normalizePublishedBusinessHours((draft.settings||{}).business_hours);
  for (const key of ['brand_logo','shop_pickup_photo']) {
    if (/^data:image\//i.test(String(settings[key]||''))) settings[key]=await mediaResolver(settings[key]);
  }
  for (const key of ['pickup_points','pickup_display']) {
    if (!Array.isArray(settings[key])) continue;
    settings[key]=await Promise.all(settings[key].map(async point=>({...point,
      photo:/^data:image\//i.test(String(point.photo||''))?await mediaResolver(point.photo):String(point.photo||'')})));
  }
  const assignments = new Map();
  for (const row of draft.assignments||[]) {
    const list=assignments.get(row.sku)||[]; list.push(row); assignments.set(row.sku,list);
  }
  const tagById = new Map((draft.tags||[]).map(t=>[t.id,t]));
  const products=[];
  for (const p of draft.products||[]) {
    const image_url = /^data:image\//i.test(String(p.img||'')) ? await mediaResolver(p.img) : String(p.img||'');
    const tags=(assignments.get(p.sku)||[]).sort((a,b)=>a.sort-b.sort||a.tag_id.localeCompare(b.tag_id))
      .map(a=>tagById.get(a.tag_id)).filter(t=>t&&t.active).map(t=>({id:t.id,label_cn:t.label_cn,label_en:t.label_en,tone:t.tone,icon:t.icon,sort:t.sort}));
    // 每个商品都带 components（单品为 []），新订单据此明确知道「不展开」。
    // 存储值不合法直接阻断发布，不静默丢项。顾客看到的「含：…」在这里由组成生成一次，前台与 SSR 只负责显示。
    let components;
    try { components=resolveSnapshotComponents(p.components,draft.products,p.sku); }
    catch (e) { if (e instanceof ComponentsError) throw new PublicContentError('components',e.message); throw e; }
    const contents=components.length?{components,contents_cn:componentsDisplayText(components,'cn'),contents_en:componentsDisplayText(components,'en')}:{components};
    products.push({sku:p.sku,slug:productSlug(p.sku),name_cn:p.name_cn,name_en:p.name_en,
      price_cents:Math.round(Number(p.price)*100),category:p.category,kcal:p.kcal,image_url,
      description_cn:p.description_cn||'',description_en:p.description_en||'',
      detail_cn:p.detail_cn||'',detail_en:p.detail_en||'',active:+p.active?1:0,sort:+p.sort||0,tags,
      ...contents});
  }
  const offers=await Promise.all((draft.posters||[]).map(async poster=>{
    const action = validatePosterAction(poster.action_type, poster.action_value);
    return {
      id:String(poster.id),title_cn:String(poster.title_cn||''),title_en:String(poster.title_en||''),
      body_cn:String(poster.body_cn||''),body_en:String(poster.body_en||''),
      badge:String(poster.badge||''),image_url:/^data:image\//i.test(String(poster.image_data||poster.image_url||''))
        ?await mediaResolver(poster.image_data||poster.image_url):String(poster.image_url||''),
      action_type:action.type, action_value:action.value,
      cta_cn:String(poster.cta_cn||''),cta_en:String(poster.cta_en||''),
      active:1,show_on_home:+poster.show_on_home?1:0,show_on_open:+poster.show_on_open?1:0,
      sort:+poster.sort||0,starts:String(poster.starts||''),ends:String(poster.ends||''),
    };
  }));
  const snapshot={schema_version:1,settings,products:products.sort((a,b)=>a.sort-b.sort||a.sku.localeCompare(b.sku)),offers};
  const checked=validatePublicSnapshot(snapshot); if(!checked.ok) throw new PublicContentError(checked.field,checked.error);
  return snapshot;
}

// ---------------------------------------------------------------- Task 3
// Release lifecycle. Every write below is guarded so a loser in a race writes
// nothing at all: the release row is always statement #1 of the batch, and each
// child statement carries `WHERE EXISTS(release id + source_revision)`.
//
// NOTE on bindings: SQLite numbers `?` by position in the SQL TEXT, not by the
// order arguments are conceptually "used". Every .bind() below is written to
// match its statement's textual placeholder order exactly.

import {
  materializePublicMedia, publicMediaInsertStatements, chunkMediaForD1,
  MAX_PUBLICATION_STATEMENTS,
} from './public-media.js';

const MAX_PAGE_CHUNK_BYTES = 1500000;
const RELEASE_PRODUCT_COLUMNS = [
  'sku','name_cn','name_en','price_cents','category','kcal','image_url',
  'description_cn','description_en','detail_cn','detail_en','active','sort','components_json',
];

// Renderers return `contentType`; the D1 column is `content_type`. Normalising
// here keeps both spellings working and returns rows ready for insertion.
export function validateReleasePages(pages, releaseId) {
  if (!Array.isArray(pages) || !pages.length) throw new PublicContentError('pages', `${releaseId} 没有生成任何页面`);
  const seen = new Set();
  const normalized = [];
  for (const raw of pages) {
    const page = { ...raw, content_type: raw?.content_type ?? raw?.contentType };
    normalized.push(page);
    const p = String(page?.path || '');
    if (!p.startsWith('/')) throw new PublicContentError('pages', `页面路径无效：${p}`);
    if (seen.has(p)) throw new PublicContentError('pages', `页面路径重复：${p}`);
    seen.add(p);
    if (!String(page.content_type || '')) throw new PublicContentError('pages', `${p} 缺少 content_type`);
    if (!String(page.body || '')) throw new PublicContentError('pages', `${p} 页面为空`);
    if (String(page.body).length > MAX_PAGE_CHUNK_BYTES) throw new PublicContentError('pages', `${p} 超过单条 1.5MB 预算`);
    if (!String(page.etag || '')) throw new PublicContentError('pages', `${p} 缺少 etag`);
  }
  return normalized;
}

function releaseProductsInsert(env, releaseId, sourceRevision, products = []) {
  const json = JSON.stringify((products || []).map(p => ({
    sku: p.sku, name_cn: p.name_cn, name_en: p.name_en || '', price_cents: p.price_cents,
    category: p.category || '', kcal: p.kcal ?? null, image_url: p.image_url || '',
    description_cn: p.description_cn || '', description_en: p.description_en || '',
    detail_cn: p.detail_cn || '', detail_en: p.detail_en || '',
    active: p.active ? 1 : 0, sort: p.sort || 0, tags: p.tags || [],
    // 快照没有 components → NULL（下单时不记组成）；单品为 '[]'
    components_json: Array.isArray(p.components) ? JSON.stringify(p.components) : null,
  })));
  if (json.length > MAX_PAGE_CHUNK_BYTES) throw new PublicContentError('products', '商品快照超过 1.5MB 单语句预算');
  const selects = RELEASE_PRODUCT_COLUMNS.map(col => `json_extract(value,'$.${col}')`).join(',');
  return env.DB.prepare(`INSERT INTO public_content_release_products
    (release_id,${RELEASE_PRODUCT_COLUMNS.join(',')},tags_json)
    SELECT ?,${selects},json_extract(value,'$.tags') FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM public_content_releases WHERE id=? AND source_revision=?)`)
    .bind(releaseId, json, releaseId, sourceRevision);
}

function releasePageInsertStatements(env, releaseId, sourceRevision, pages = []) {
  const chunks = [];
  let current = [], bytes = 0;
  for (const page of pages) {
    const size = String(page.body).length;
    if (current.length && (current.length >= 20 || bytes + size > MAX_PAGE_CHUNK_BYTES)) {
      chunks.push(current); current = []; bytes = 0;
    }
    current.push(page); bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks.map(chunk => {
    const values = chunk.map(() => '(?,?,?,?)').join(',');
    return env.DB.prepare(`INSERT INTO public_content_release_pages(release_id,path,content_type,body,etag)
      SELECT ?,column1,column2,column3,column4 FROM (VALUES ${values})
      WHERE EXISTS(SELECT 1 FROM public_content_releases WHERE id=? AND source_revision=?)`)
      .bind(releaseId, ...chunk.flatMap(p => [p.path, p.content_type, p.body, p.etag]), releaseId, sourceRevision);
  });
}

// Audit row that only lands if THIS caller owns the pointer (activation nonce).
function releaseEventInsert(env, releaseId, action, actor, detail, now, guardReleaseId, guardToken) {
  return env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
    .bind(crypto.randomUUID(), releaseId, action, actor, JSON.stringify(detail || {}), now.toISOString(), guardReleaseId, guardToken);
}

// Audit row for creation, guarded by the release the same batch just inserted.
function releaseCreationEventInsert(env, releaseId, sourceRevision, action, actor, detail, now) {
  return env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_content_releases WHERE id=? AND source_revision=?)`)
    .bind(crypto.randomUUID(), releaseId, action, actor, JSON.stringify(detail || {}), now.toISOString(), releaseId, sourceRevision);
}

function releaseActivationConflictEventInsert(env, targetId, actor, expectedActiveId, token, now) {
  return env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
    SELECT ?,?,'activation_conflict',?,?,? WHERE NOT EXISTS(
      SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
    .bind(crypto.randomUUID(), targetId, actor, JSON.stringify({ expected_active_id: expectedActiveId || null }), now.toISOString(), targetId, token);
}

export async function materializeRelease(env,{
  snapshot,media=[],sourceRevision,effectiveAtUtc,actor,eventAction='scheduled',now=new Date(),
  releaseId=crypto.randomUUID(),pageBuilder,guard,activateBootstrap=false,
}) {
  if (!['draft','bootstrap','historical'].includes(guard?.kind)) throw new Error('invalid release guard');
  const checksum=await checksumSnapshot(snapshot);
  if (guard.kind==='historical'&&checksum!==guard.sourceChecksum) throw new Error('historical snapshot checksum mismatch');
  const pages=validateReleasePages(
    await pageBuilder({...snapshot,release_id:releaseId,checksum,published_at:effectiveAtUtc}),releaseId);
  let guardSql=guard.kind==='draft'
    ? `EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`
    : guard.kind==='bootstrap'
      ? `EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND active_release_id IS NULL AND draft_revision=?)`
      : `EXISTS(SELECT 1 FROM public_content_releases WHERE id=? AND checksum=?)`;
  const guardParams=guard.kind==='historical'?[guard.sourceReleaseId,guard.sourceChecksum]:[guard.expectedRevision];
  if (guard.kind==='draft' && guard.expectedActiveId !== undefined) {
    guardSql += ` AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND active_release_id=?)
      AND NOT EXISTS(SELECT 1 FROM public_content_releases WHERE status='scheduled')`;
    guardParams.push(guard.expectedActiveId);
  }
  const activationToken=activateBootstrap?`activation-${crypto.randomUUID()}`:null;
  const guardedRelease=env.DB.prepare(`INSERT INTO public_content_releases
    (id,status,effective_at,created_at,created_by,source_revision,checksum,snapshot_json)
    SELECT ?,'scheduled',?,?,?,?,?,? WHERE ${guardSql}`)
    .bind(releaseId,effectiveAtUtc,now.toISOString(),actor,sourceRevision,checksum,canonicalJson(snapshot),...guardParams);
  const statements=[guardedRelease,
    ...publicMediaInsertStatements(env,media,releaseId,sourceRevision,now),
    releaseProductsInsert(env,releaseId,sourceRevision,snapshot.products),
    ...releasePageInsertStatements(env,releaseId,sourceRevision,pages)];
  if (activateBootstrap) statements.push(
    env.DB.prepare(`UPDATE public_content_state SET active_release_id=?,activation_nonce=?,updated_at=?
      WHERE singleton=1 AND active_release_id IS NULL AND draft_revision=?
      AND EXISTS(SELECT 1 FROM public_content_releases WHERE id=? AND source_revision=?)`)
      .bind(releaseId,activationToken,now.toISOString(),guard.expectedRevision,releaseId,sourceRevision),
    env.DB.prepare(`UPDATE public_content_releases SET status='published',published_at=? WHERE id=?
      AND EXISTS(SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
      .bind(now.toISOString(),releaseId,releaseId,activationToken),
    releaseEventInsert(env,releaseId,'bootstrap',actor,{},now,releaseId,activationToken));
  else statements.push(releaseCreationEventInsert(env,releaseId,sourceRevision,eventAction,actor,
    {effective_at:effectiveAtUtc,...(guard.expectedActiveId !== undefined ? {expected_active_release_id:guard.expectedActiveId} : {})},now));
  if (statements.length > MAX_PUBLICATION_STATEMENTS) {
    throw new PublicContentError('batch',`发布需要 ${statements.length} 条语句，超过 ${MAX_PUBLICATION_STATEMENTS} 条上限`);
  }
  const result=await env.DB.batch(statements);
  const activated=!activateBootstrap||result[result.length-3]?.meta?.changes===1;
  return result[0]?.meta?.changes===1&&activated?{ok:true,release_id:releaseId,checksum,activated:activateBootstrap}
    :{ok:false,status:409,code:'revision_conflict'};
}

export async function schedulePublicRelease(env,{
  expectedRevision,effectiveAtUtc,actor='boss',now=new Date(),releaseId=crypto.randomUUID(),pageBuilder,
  expectedActiveId,expectedChecksum,
}) {
  const exact = expectedActiveId !== undefined || expectedChecksum !== undefined;
  if (exact) {
    if (!expectedActiveId || !/^[0-9a-f]{64}$/.test(String(expectedChecksum || ''))) return {ok:false,status:400,code:'invalid_request'};
    const checked = await exactPublicationPrecheck(env,expectedActiveId);
    if (!checked.ok) return checked;
  }
  const state=await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
  if (!state||state.draft_revision!==expectedRevision) return {ok:false,status:409,code:'revision_conflict'};
  const contentAt=new Date(effectiveAtUtc); if (!Number.isFinite(contentAt.getTime())) return {ok:false,status:400,code:'invalid_effective_at'};
  const draft=await loadPublishableDraft(env,{contentAt}); const mediaByHash=new Map();
  const snapshot=await buildPublicSnapshot(draft,async value=>{const item=await materializePublicMedia(value);mediaByHash.set(item.hash,item);return item.publicUrl;});
  if (exact && await checksumSnapshot(snapshot)!==expectedChecksum) return {ok:false,status:409,code:'draft_snapshot_mismatch'};
  return materializeRelease(env,{snapshot,media:[...mediaByHash.values()],sourceRevision:expectedRevision,effectiveAtUtc,actor,now,releaseId,pageBuilder,
    eventAction:exact?'scheduled_exact':'scheduled',guard:{kind:'draft',expectedRevision,...(exact?{expectedActiveId}:{})}});
}

export async function activateDueRelease(env,{now=new Date(),actor='system:cron'}={}) {
  const iso=now.toISOString();
  const candidate=await env.DB.prepare(`SELECT id FROM public_content_releases
    WHERE status='scheduled' AND effective_at<=?
    ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1`).bind(iso).first();
  if (!candidate) return {activated:false,reason:'none_due'};
  const state=await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
  return activateReleaseById(env,{targetId:candidate.id,expectedActiveId:state?.active_release_id||null,now,actor,requireDue:true});
}

export async function activateReleaseById(env,{targetId,expectedActiveId,now=new Date(),actor='boss',requireDue=true}={}) {
  const iso=now.toISOString();
  const token=`activation-${crypto.randomUUID()}`;
  const writes=[
    env.DB.prepare(`UPDATE public_content_state SET active_release_id=?,activation_nonce=?,updated_at=?
      WHERE singleton=1 AND active_release_id IS ? AND EXISTS(
        SELECT 1 FROM public_content_releases WHERE id=? AND status='scheduled' AND (?=0 OR effective_at<=?))
      AND NOT EXISTS(SELECT 1 FROM public_content_events WHERE release_id=? AND action='scheduled_exact'
        AND json_extract(detail_json,'$.expected_active_release_id') IS NOT public_content_state.active_release_id)`)
      .bind(targetId,token,iso,expectedActiveId,targetId,requireDue?1:0,iso,targetId),
    env.DB.prepare(`UPDATE public_content_releases SET status='published',published_at=?
      WHERE id=? AND EXISTS(SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
      .bind(iso,targetId,targetId,token),
    env.DB.prepare(`UPDATE public_content_releases SET status='superseded'
      WHERE status='published' AND id<>? AND EXISTS(
        SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
      .bind(targetId,targetId,token),
    env.DB.prepare(`UPDATE public_content_releases SET status='superseded'
      WHERE status='scheduled' AND effective_at<=? AND id<>? AND EXISTS(
        SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
      .bind(iso,targetId,targetId,token),
    releaseEventInsert(env,targetId,'published',actor,{},now,targetId,token),
    releaseActivationConflictEventInsert(env,targetId,actor,expectedActiveId,token,now),
    env.DB.prepare(`UPDATE public_content_releases SET status='cancelled' WHERE id=? AND status='scheduled'
      AND NOT EXISTS(SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)`)
      .bind(targetId,targetId,token),
  ];
  const result=await env.DB.batch(writes);
  return result[0]?.meta?.changes===1?{activated:true,release_id:targetId}:{activated:false,reason:'lost_race'};
}

// The ONLY caller allowed to pass allowBootstrap:true is the one-minute Cron.
// A public request passes false and never touches a mutable draft table.
export async function ensureActiveRelease(env,{
  allowBootstrap=false,now=new Date(),actor='system:cron',pageBuilder,
}={}) {
  await activateDueRelease(env,{now,actor});
  const state=await env.DB.prepare('SELECT active_release_id,draft_revision FROM public_content_state WHERE singleton=1').first();
  if (state?.active_release_id) return {active_release_id:state.active_release_id};
  if (!allowBootstrap) return {active_release_id:null,bootstrap_pending:true};
  const expectedRevision=state?.draft_revision;
  const draft=await loadPublishableDraft(env,{contentAt:now});
  const mediaByHash=new Map();
  const snapshot=await buildPublicSnapshot(draft,async value=>{const item=await materializePublicMedia(value);mediaByHash.set(item.hash,item);return item.publicUrl;});
  const result=await materializeRelease(env,{snapshot,media:[...mediaByHash.values()],sourceRevision:expectedRevision,
    effectiveAtUtc:now.toISOString(),actor,eventAction:'bootstrap',now,pageBuilder,
    guard:{kind:'bootstrap',expectedRevision},activateBootstrap:true});
  if (result.ok) return {active_release_id:result.release_id,bootstrapped:true};
  // Lost the bootstrap CAS to a concurrent Cron: the pointer it set is just as
  // valid as ours, so re-read it instead of reporting a false bootstrap_pending.
  const settled=await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
  return settled?.active_release_id
    ?{active_release_id:settled.active_release_id}
    :{active_release_id:null,bootstrap_pending:true,reason:result.code};
}

// Audit first, mutation second, both bound to the SAME captured `now`: D1
// serializes writes, so an exact-due release can never be cancelled out from
// under an activation that is already eligible.
export async function cancelScheduledRelease(env,{releaseId,now=new Date(),actor='boss'}={}) {
  const iso=now.toISOString();
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
      SELECT ?,?,'cancelled',?,?,? WHERE EXISTS(
        SELECT 1 FROM public_content_releases WHERE id=? AND status='scheduled' AND effective_at>?)`)
      .bind(crypto.randomUUID(),releaseId,actor,'{}',iso,releaseId,iso),
    env.DB.prepare(`UPDATE public_content_releases SET status='cancelled'
      WHERE id=? AND status='scheduled' AND effective_at>?`).bind(releaseId,iso),
  ]);
  return result[1]?.meta?.changes===1?{ok:true,release_id:releaseId}:{ok:false,status:409,code:'cancel_rejected'};
}

// Rollback republishes a historical snapshot as a NEW immutable release. It
// never reads the current draft, so a rollback cannot smuggle in unpublished edits.
// 回滚到「组成」功能之前的菜单：那份菜单没有组成数据，顾客看到的文案和厨房出餐会不一致。
// 当前上线的菜单已带组成时拒绝这种回滚，请在后台按那份菜单编辑后重新发布。
const hasComponentsModel=snapshot=>(snapshot?.products||[]).some(p=>Array.isArray(p.components));
async function rollbackComponentsProblem(env,snapshot) {
  if (hasComponentsModel(snapshot)) return null;
  const active=await env.DB.prepare(`SELECT r.snapshot_json FROM public_content_state s JOIN public_content_releases r ON r.id=s.active_release_id
    WHERE s.singleton=1`).first();
  let live=null; try { live=JSON.parse(active?.snapshot_json||'null'); } catch { live=null; }
  if (!hasComponentsModel(live)) return null;
  return {ok:false,status:422,code:'snapshot_predates_components',
    error:'这个历史版本早于「组成」功能，回滚后顾客菜单与厨房出餐可能不一致，已拒绝。请在后台按需要的内容编辑后重新发布。'};
}

export async function rollbackPublicRelease(env,{sourceReleaseId,now=new Date(),actor='boss',pageBuilder}={}) {
  const state=await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
  const source=await env.DB.prepare('SELECT id,checksum,snapshot_json FROM public_content_releases WHERE id=?')
    .bind(sourceReleaseId).first();
  if (!source) return {ok:false,status:404,code:'release_not_found'};
  let snapshot;
  try { snapshot=JSON.parse(source.snapshot_json); } catch { return {ok:false,status:409,code:'snapshot_unreadable'}; }
  const checked=validatePublicSnapshot(snapshot);
  if (!checked.ok) return {ok:false,status:409,code:'snapshot_invalid',field:checked.field};
  const predates=await rollbackComponentsProblem(env,snapshot); if (predates) return predates;
  const media=[];
  const materialized=await materializeRelease(env,{snapshot,media,sourceRevision:`rollback:${sourceReleaseId}`,
    effectiveAtUtc:now.toISOString(),actor,eventAction:'rollback',now,pageBuilder,
    guard:{kind:'historical',sourceReleaseId,sourceChecksum:source.checksum}});
  if (!materialized.ok) return materialized;
  const activation=await activateReleaseById(env,{targetId:materialized.release_id,
    expectedActiveId:state?.active_release_id||null,now,actor,requireDue:false});
  return activation.activated
    ? {ok:true,release_id:materialized.release_id,checksum:materialized.checksum,rolled_back_to:sourceReleaseId}
    : {ok:false,status:409,code:'publication_conflict'};
}

export async function publicationStatus(env) {
  const [stateRows,releaseRows]=await env.DB.batch([
    env.DB.prepare('SELECT active_release_id,draft_revision,updated_at FROM public_content_state WHERE singleton=1'),
    env.DB.prepare(`SELECT id,status,effective_at,created_at,created_by,checksum,published_at
      FROM public_content_releases WHERE status IN ('scheduled','published','superseded')
      ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
        created_at DESC,effective_at DESC,id DESC LIMIT 20`),
  ]);
  const state=(stateRows.results||[])[0]||null;
  return {active_release_id:state?.active_release_id||null,draft_revision:state?.draft_revision||null,
    updated_at:state?.updated_at||null,releases:releaseRows.results||[]};
}

// ---------------------------------------------------------------- Task 7
// 结账/POS 的权威定价。价格、可售状态、以及随发布走的税/服务费/配送规则
// 全部来自【同一个】活动发布，一条 SQL 取齐 —— 同一笔交易绝不再解析第二次
// 活动指针，否则中途激活新发布会把两套规则拌在一起算钱。

export function validateAndParseStoredSnapshot(snapshotJson, releaseId) {
  let snapshot;
  try { snapshot = JSON.parse(snapshotJson || 'null'); }
  catch { throw new PublicContentError('snapshot', `发布 ${releaseId} 的快照无法解析`); }
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.settings) {
    throw new PublicContentError('snapshot', `发布 ${releaseId} 的快照结构无效`);
  }
  return snapshot;
}

// 只取「随发布固定下来」的交易规则；紧急停业、优惠码、实时运费报价不在其中。
export function extractTransactionRules(settings = {}) {
  const pickupDisplay = Array.isArray(settings.pickup_display)
    ? settings.pickup_display.filter(point => point && point.active !== false && point.active !== 0 && point.active !== '0') : [];
  const prep = settings.prep_time_min == null || settings.prep_time_min === '' ? 20 : Number(settings.prep_time_min);
  return {
    delivery: settings.delivery || null,
    delivery_enabled: settings.delivery_enabled !== '0',
    delivery_fee: (settings.delivery_fee != null && settings.delivery_fee !== '') ? Number(settings.delivery_fee) : 4,
    delivery_min: Number(settings.delivery_min) || 0,
    delivery_free_above: Number(settings.delivery_free_above) || 0,
    gst_registered: settings.gst_registered === '1' || settings.gst_registered === 1 || settings.gst_registered === true,
    gst_rate: Number(settings.gst_rate) || 9,
    service_charge_enabled: settings.service_charge_enabled === '1' || settings.service_charge_enabled === 1 || settings.service_charge_enabled === true,
    service_charge_rate: Number(settings.service_charge_rate) || 10,
    business_hours_schedule: settings.business_hours_schedule || normalizePublishedBusinessHours(settings.business_hours),
    prep_time_min: Math.min(180, Math.max(0, Number.isFinite(prep) ? prep : 20)),
    pickup_enabled: pickupDisplay.length > 0,
    pickup_display: pickupDisplay,
  };
}

// 发布行里的组成：NULL = 快照里没有组成数据（undefined，下单时不记组成，厨房按单品出餐）。
function releaseRowComponents(row) {
  if (row==null||row.components_json==null) return undefined;
  try { const list=JSON.parse(row.components_json); return Array.isArray(list)?list:undefined; } catch { return undefined; }
}

// 当前活动发布里这些 SKU 的行（价格、名称、分类、组成）。后台补录等非顾客入口也按已发布菜单出餐。
export async function activeReleaseProductRows(env,skus) {
  const unique=[...new Set((skus||[]).map(s=>String(s||'').trim().toUpperCase()).filter(Boolean))].slice(0,99);
  const state=await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
  const releaseId=state?.active_release_id||null;
  if (!unique.length||!releaseId) return {releaseId,bySku:new Map()};
  const {results}=await env.DB.prepare(`SELECT p.sku,p.name_cn,p.name_en,p.price_cents,p.category,p.active,p.components_json
    FROM public_content_release_products p WHERE p.release_id=? AND p.sku IN (${unique.map(()=>'?').join(',')})`).bind(releaseId,...unique).all();
  const rows=results||[];
  return {releaseId,bySku:new Map(rows.map(r=>{
    const published=releaseRowComponents(r), components=orderLineComponents(published);
    return [r.sku,{...r,...(components?{components}:{})}];
  }))};
}

export async function quoteActiveReleaseItems(env,{menuRevision,items}) {
  if (!Array.isArray(items)) return {ok:false,status:400,error:'invalid_cart'};
  menuRevision=String(menuRevision||'').trim();
  const normalized=items.map(item=>({sku:String(item?.sku||'').trim().toUpperCase(),qty:Number(item?.qty)}));
  const unique=[...new Set(normalized.map(item=>item.sku))];
  // D1 allows 100 bound parameters: one historical revision plus at most 99 SKUs.
  // 空的 menu_revision = 客户端根本没带版本（老客户端 / 迁移期）：不算参数错误，
  // 走 409 menu_changed，让顾客按当前发布的价格显式确认一次。
  if ((menuRevision && !/^[a-z0-9_-]{1,80}$/i.test(menuRevision)) || unique.length!==normalized.length || unique.length<1 || unique.length>99 ||
      normalized.some(item=>!item.sku||!Number.isInteger(item.qty)||item.qty<1||item.qty>99)) {
    return {ok:false,status:400,error:'invalid_cart'};
  }
  const marks=unique.map(()=>'?').join(',');
  // `s.active_release_id` 必须带表前缀：裸列名会先绑到子查询的内层表，
  // 相关子查询悄悄退化成不相关查询 —— 那会拿错 release 的价格去算钱，且不报错。
  const row=await env.DB.prepare(`SELECT s.active_release_id,r.snapshot_json,
    COALESCE((SELECT json_group_array(json_object('release_id',p.release_id,'sku',p.sku,'name_cn',p.name_cn,'name_en',p.name_en,
      'price_cents',p.price_cents,'active',p.active,'category',p.category,'components_json',p.components_json)) FROM public_content_release_products p
      WHERE p.release_id IN (s.active_release_id,?) AND p.sku IN (${marks})),'[]') AS product_rows_json
    FROM public_content_state s JOIN public_content_releases r ON r.id=s.active_release_id WHERE s.singleton=1`)
    .bind(menuRevision,...unique).first();
  if (!row) return {ok:false,status:503,error:'no_active_release'};
  const active=row.active_release_id||null;
  const productRows=JSON.parse(row.product_rows_json||'[]');
  const activeSnapshot=validateAndParseStoredSnapshot(row.snapshot_json,active);
  const release_rules=extractTransactionRules(activeSnapshot.settings);
  const byReleaseSku=new Map(productRows.map(r=>[`${r.release_id}\0${r.sku}`,r]));
  // 组成取自同一个活动发布：顾客看到的组成 = 订单记下的组成 = 厨房出餐的组成。
  const lines=normalized.map(item=>{
    const current=byReleaseSku.get(`${active}\0${item.sku}`);
    const published=current&&current.active?releaseRowComponents(current):undefined;
    const components=orderLineComponents(published);
    return current&&current.active
      ? {sku:item.sku,qty:item.qty,name_cn:current.name_cn,name_en:current.name_en||'',unit_price_cents:Number(current.price_cents),
          line_total_cents:Number(current.price_cents)*item.qty,available:true,
          ...(current.category?{category:current.category}:{}),
          ...(components?{components,contents_cn:componentsDisplayText(published,'cn'),contents_en:componentsDisplayText(published,'en')}:{})}
      : {sku:item.sku,qty:item.qty,name_cn:current?.name_cn||'',name_en:current?.name_en||'',unit_price_cents:null,line_total_cents:0,available:false};
  });
  const subtotal_cents=lines.reduce((sum,line)=>sum+line.line_total_cents,0);
  const changes=normalized.flatMap(item=>{
    const sku=String(item.sku), current=byReleaseSku.get(`${active}\0${sku}`), old=byReleaseSku.get(`${menuRevision}\0${sku}`);
    if (!current||!current.active) return [{sku,reason:'unavailable',old_price_cents:old?.price_cents??null,new_price_cents:null}];
    const updates=[];
    if (!old||Number(old.price_cents)!==Number(current.price_cents)) updates.push({sku,reason:'price',
      old_price_cents:old?.price_cents??null,new_price_cents:current.price_cents});
    if (old && ((old.name_cn||'')!==(current.name_cn||'') || (old.name_en||'')!==(current.name_en||''))) updates.push({sku,reason:'name',
      old_name_cn:old.name_cn||'',old_name_en:old.name_en||'',new_name_cn:current.name_cn||'',new_name_en:current.name_en||''});
    // 组成变了也必须让顾客/店员先看到再确认：厨房会按新组成做。旧发布没有组成数据时无从比较，不算变化。
    const oldParts=old?releaseRowComponents(old):undefined, newParts=releaseRowComponents(current);
    if (oldParts&&newParts&&(componentsDisplayText(oldParts,'cn')!==componentsDisplayText(newParts,'cn')||componentsDisplayText(oldParts,'en')!==componentsDisplayText(newParts,'en'))) {
      updates.push({sku,reason:'contents',old_contents_cn:componentsDisplayText(oldParts,'cn'),old_contents_en:componentsDisplayText(oldParts,'en'),
        new_contents_cn:componentsDisplayText(newParts,'cn'),new_contents_en:componentsDisplayText(newParts,'en')});
    }
    return updates;
  });
  if (menuRevision!==active || changes.length) return {ok:false,status:409,error:'menu_changed',code:'menu_changed',
    active_revision:active,changes,lines,subtotal_cents,release_rules};
  return {ok:true,revision:active,lines,subtotal_cents,release_rules};
}

// ---------------------------------------------------------------- Task 8
// 草稿改动的唯一入口。全局 draft_revision 的 CAS 永远是批次第 0 条语句：
// 抢输了，后面每一条子语句的 WHERE EXISTS 都不成立，整批什么都不写。
// 凭据、打印/店员/快递密钥、钱包与支付开关、紧急停业开关都【不走】这里
// —— 它们不是可发布内容，改它们不应该让草稿版本前进。

export async function commitDraftMutation(env,{expectedRevision,buildStatements,actor='boss',action,detail={}}) {
  actor=actorOf(env,actor);
  const next=`draft-${crypto.randomUUID()}`; const now=new Date().toISOString();
  // 首个发布（bootstrap）之前不接受草稿写入：否则 bootstrap 会把未经预览的草稿直接发布出去。
  const guarded=env.DB.prepare(`UPDATE public_content_state SET draft_revision=?,updated_at=?
    WHERE singleton=1 AND draft_revision=? AND active_release_id IS NOT NULL`).bind(next,now,expectedRevision);
  const statements=buildStatements({revision:next,now});
  const result=await env.DB.batch([guarded,...statements,
    env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
      SELECT ?,NULL,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
      .bind(crypto.randomUUID(),action,actor,canonicalJson(detail),now,next)]);
  const guard=result[0];
  if (guard?.meta?.changes===1) return {ok:true,draft_revision:next};
  const state=await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
  return state&&!state.active_release_id?{ok:false,status:409,error:'bootstrap_pending'}:{ok:false,status:409,error:'revision_conflict'};
}

// 每条子语句都必须挂上「新版本已经写进去了」这个守卫，输掉 CAS 的批次才会全空转。
const draftGuard = revision => ({
  sql: ` AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`,
  bind: revision,
});

export function tagUpsertStatements(env,{revision,now,tag}) {
  const guard=draftGuard(revision);
  return [env.DB.prepare(`INSERT INTO product_tags(id,label_cn,label_en,tone,icon,active,sort,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)
    ON CONFLICT(id) DO UPDATE SET label_cn=excluded.label_cn,label_en=excluded.label_en,tone=excluded.tone,
      icon=excluded.icon,active=excluded.active,sort=excluded.sort,updated_at=excluded.updated_at`)
    .bind(tag.id,tag.label_cn,tag.label_en,tag.tone,tag.icon,tag.active,tag.sort,now,now,revision)];
}

export function tagDeleteStatements(env,{revision,tagId}) {
  return [env.DB.prepare(`DELETE FROM product_tags WHERE id=?
    AND NOT EXISTS(SELECT 1 FROM product_tag_assignments WHERE tag_id=?)
    AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
    .bind(tagId,tagId,revision)];
}

export function productTagAssignmentStatements(env,{revision,sku,tagIds}) {
  const statements=[env.DB.prepare(`DELETE FROM product_tag_assignments WHERE sku=?
    AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`).bind(sku,revision)];
  tagIds.forEach((tagId,index)=>{
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO product_tag_assignments(sku,tag_id,sort)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM product_tags WHERE id=? AND active=1)
      AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
      .bind(sku,tagId,(index+1)*10,tagId,revision));
  });
  return statements;
}

// ── 预览令牌 ────────────────────────────────────────────────────────────────
// 只签 {draft_revision, exp, nonce, content_at?}：不含内容或凭据。
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b64urlDecode = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')), ch=>ch.charCodeAt(0));

async function previewKey(secret) {
  return crypto.subtle.importKey('raw',new TextEncoder().encode(String(secret||'')),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}

export async function signPreviewToken(secret,{draftRevision,expiresAt,nonce,contentAt}) {
  const payload=b64url(new TextEncoder().encode(JSON.stringify({r:draftRevision,exp:expiresAt,n:nonce,
    ...(contentAt !== undefined ? {c:contentAt} : {})})));
  const signature=new Uint8Array(await crypto.subtle.sign('HMAC',await previewKey(secret),new TextEncoder().encode(payload)));
  return `${payload}.${b64url(signature)}`;
}

export async function verifyPreviewToken(secret,token,{now=new Date()}={}) {
  const [payload,signature]=String(token||'').split('.');
  if (!payload||!signature) return {ok:false,status:404};
  let valid=false;
  try { valid=await crypto.subtle.verify('HMAC',await previewKey(secret),b64urlDecode(signature),new TextEncoder().encode(payload)); }
  catch { return {ok:false,status:404}; }
  if (!valid) return {ok:false,status:404};
  let claims;
  try { claims=JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch { return {ok:false,status:404}; }
  if (!claims?.exp || Date.parse(claims.exp) <= now.getTime()) return {ok:false,status:410,error:'preview_expired'};
  if (claims.c !== undefined && (typeof claims.c !== 'string' || !Number.isFinite(Date.parse(claims.c)))) return {ok:false,status:404};
  return {ok:true,draftRevision:claims.r,expiresAt:claims.exp,nonce:claims.n,...(claims.c !== undefined ? {contentAt:claims.c} : {})};
}

// 内容改动后推进全局草稿版本，让「老板看到的草稿」和「排程时快照的内容」对得上。
// 只有【可发布内容】才推进：凭据、支付开关、紧急停业不属于内容，改它们不动这个版本。
export async function touchDraftRevision(env, changedKeys = null) {
  if (Array.isArray(changedKeys) && !changedKeys.some(key => DRAFT_PUBLIC_SETTING_KEYS.has(key))) return null;
  const next = `draft-${crypto.randomUUID()}`;
  try {
    await env.DB.prepare('UPDATE public_content_state SET draft_revision=?,updated_at=? WHERE singleton=1')
      .bind(next, new Date().toISOString()).run();
    return next;
  } catch (error) { console.error('draft revision bump failed', error); return null; }
}

// ---------------------------------------------------------------- catalog-guard-v1
// 旧入口原样留给老板后台，但「逐项核对之后再写 / 再发」的调用方不能靠它们：product-save 是整行
// UPDATE … WHERE sku=?，上下架 / 排序 / 换图不推进草稿版本，publish-now 物化请求时的整份草稿后再用
// 第二个批次激活。下面三类入口的前提全部在同一个 D1 批次里原子校验，核对之后任何一项变了就整批不写、返回 409：
//   商品文案：调用方读到的整行指纹没变，才只写 7 个文案 / 价格字段；
//   精确发布：草稿快照校验和等于调用方核对过的值、活动发布没换、没有待生效排程，物化与激活才一起落库；
//   精确回滚：活动发布仍是调用方核对过的那一个，历史快照才重新发布。
export const CATALOG_GUARD_API = 'catalog-guard-v1';
export const PRODUCT_ROW_COLUMNS = ['sku','name_cn','name_en','price','category','kcal','img',
  'description_cn','description_en','detail_cn','detail_en','active','sort'];
export const PRODUCT_TEXT_FIELDS = ['name_cn','name_en','price','description_cn','description_en','detail_cn','detail_en'];

async function sha256Hex(text) {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  return [...digest].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// 与 GET /api/admin/products 返回的同 13 列、同顺序；调用方用同一规则算指纹。
export const productRowFingerprint=row=>sha256Hex(JSON.stringify(PRODUCT_ROW_COLUMNS.map(column=>row?.[column]??null)));

export async function commitProductTextExact(env,{sku,baseRowSha256,values,actor='boss',now=new Date()}) {
  const row=await env.DB.prepare(`SELECT ${PRODUCT_ROW_COLUMNS.join(',')} FROM products WHERE sku=?`).bind(sku).first();
  if (!row) return {ok:false,status:404,code:'product_not_found'};
  if (await productRowFingerprint(row)!==baseRowSha256) return {ok:false,status:409,code:'product_conflict'};
  const next=`draft-${crypto.randomUUID()}`, iso=now.toISOString();
  // 读到的整行原值逐列 IS 比较：读完之后这一行被任何入口改过（含不推进版本的上下架），两条语句都不生效。
  const unchanged=PRODUCT_ROW_COLUMNS.map(column=>`${column} IS ?`).join(' AND ');
  const base=PRODUCT_ROW_COLUMNS.map(column=>row[column]??null);
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE public_content_state SET draft_revision=?,updated_at=?
      WHERE singleton=1 AND active_release_id IS NOT NULL AND EXISTS(SELECT 1 FROM products WHERE ${unchanged})`).bind(next,iso,...base),
    env.DB.prepare(`UPDATE products SET ${PRODUCT_TEXT_FIELDS.map(field=>`${field}=?`).join(',')}
      WHERE ${unchanged} AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
      .bind(...PRODUCT_TEXT_FIELDS.map(field=>values[field]),...base,next),
    env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
      SELECT ?,NULL,'product_text_updated',?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
      .bind(crypto.randomUUID(),actor,canonicalJson({sku,base_row_sha256:baseRowSha256}),iso,next),
  ]);
  if (result[1]?.meta?.changes!==1) {
    const state=await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
    return {ok:false,status:409,code:state&&!state.active_release_id?'bootstrap_pending':'product_conflict'};
  }
  return {ok:true,draft_revision:next,row_sha256:await productRowFingerprint({...row,...values})};
}

// 只读：活动发布的原始快照 + 当前草稿按发布规则算出的完整快照与校验和。不写 D1、不写媒体。
export async function draftSnapshotComparison(env,{now=new Date()}={}) {
  const [stateRows,scheduledRows]=await env.DB.batch([
    env.DB.prepare('SELECT active_release_id,draft_revision FROM public_content_state WHERE singleton=1'),
    env.DB.prepare(`SELECT id FROM public_content_releases WHERE status='scheduled' ORDER BY effective_at,created_at,id`),
  ]);
  const state=(stateRows.results||[])[0]||null;
  let active=null;
  if (state?.active_release_id) {
    const row=await env.DB.prepare('SELECT id,checksum,snapshot_json FROM public_content_releases WHERE id=?')
      .bind(state.active_release_id).first();
    if (!row) throw new PublicContentError('active_release','活动发布不存在');
    let snapshot;
    try { snapshot=JSON.parse(row.snapshot_json); } catch { throw new PublicContentError('active_release','活动发布快照无法解析'); }
    active={release_id:row.id,checksum:row.checksum,snapshot};
  }
  const draft=await loadPublishableDraft(env,{contentAt:now});
  const snapshot=await buildPublicSnapshot(draft,async value=>(await materializePublicMedia(value)).publicUrl);
  // The editor must never pair one draft's content with another draft's revision.
  // All participating content writers advance draft_revision atomically.
  const current=await env.DB.prepare('SELECT active_release_id,draft_revision FROM public_content_state WHERE singleton=1').first();
  if (current?.draft_revision!==state?.draft_revision || current?.active_release_id!==state?.active_release_id) {
    return {ok:false,status:409,code:'revision_conflict'};
  }
  return {ok:true,guarded_api:CATALOG_GUARD_API,content_at:now.toISOString(),draft_revision:state?.draft_revision||null,
    active,scheduled_release_ids:(scheduledRows.results||[]).map(row=>row.id),
    draft:{checksum:await checksumSnapshot(snapshot),snapshot}};
}

async function exactPublicationPrecheck(env,expectedActiveId) {
  const [stateRows,scheduledRows]=await env.DB.batch([
    env.DB.prepare('SELECT active_release_id,draft_revision FROM public_content_state WHERE singleton=1'),
    env.DB.prepare(`SELECT id FROM public_content_releases WHERE status='scheduled' LIMIT 1`),
  ]);
  const state=(stateRows.results||[])[0];
  if (!state) return {ok:false,status:503,code:'publication_uninitialized'};
  if (state.active_release_id!==expectedActiveId) return {ok:false,status:409,code:'active_release_changed'};
  if ((scheduledRows.results||[]).length) return {ok:false,status:409,code:'scheduled_release_pending'};
  return {ok:true,draftRevision:state.draft_revision};
}

// 物化 + 激活在【同一个】批次：第 0 条只在活动指针仍是 expectedActiveId、草稿版本（给了才比）未变、
// 且没有任何 scheduled 发布时插入；其余语句挂在这一行或本次激活 nonce 上。抢输了整批空转，不留 scheduled 行给 Cron。
async function activateExactRelease(env,{snapshot,media=[],sourceRevision,expectedActiveId,expectedRevision=null,
  actor,now,releaseId,pageBuilder,eventAction}) {
  const checksum=await checksumSnapshot(snapshot), iso=now.toISOString();
  const pages=validateReleasePages(await pageBuilder({...snapshot,release_id:releaseId,checksum,published_at:iso}),releaseId);
  const token=`activation-${crypto.randomUUID()}`;
  const revisionSql=expectedRevision===null?'':' AND draft_revision=?';
  const revisionParams=expectedRevision===null?[]:[expectedRevision];
  const owned='EXISTS(SELECT 1 FROM public_content_state WHERE active_release_id=? AND activation_nonce=?)';
  const statements=[
    env.DB.prepare(`INSERT INTO public_content_releases
      (id,status,effective_at,created_at,created_by,source_revision,checksum,snapshot_json)
      SELECT ?,'scheduled',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state
        WHERE singleton=1 AND active_release_id=?${revisionSql})
      AND NOT EXISTS(SELECT 1 FROM public_content_releases WHERE status='scheduled')`)
      .bind(releaseId,iso,iso,actor,sourceRevision,checksum,canonicalJson(snapshot),expectedActiveId,...revisionParams),
    ...publicMediaInsertStatements(env,media,releaseId,sourceRevision,now),
    releaseProductsInsert(env,releaseId,sourceRevision,snapshot.products),
    ...releasePageInsertStatements(env,releaseId,sourceRevision,pages),
    env.DB.prepare(`UPDATE public_content_state SET active_release_id=?,activation_nonce=?,updated_at=?
      WHERE singleton=1 AND active_release_id=? AND EXISTS(
        SELECT 1 FROM public_content_releases WHERE id=? AND source_revision=? AND status='scheduled')`)
      .bind(releaseId,token,iso,expectedActiveId,releaseId,sourceRevision),
    env.DB.prepare(`UPDATE public_content_releases SET status='published',published_at=? WHERE id=? AND ${owned}`)
      .bind(iso,releaseId,releaseId,token),
    env.DB.prepare(`UPDATE public_content_releases SET status='superseded' WHERE status='published' AND id<>? AND ${owned}`)
      .bind(releaseId,releaseId,token),
    releaseEventInsert(env,releaseId,eventAction,actor,{expected_active_release_id:expectedActiveId,checksum},now,releaseId,token),
    env.DB.prepare(`UPDATE public_content_releases SET status='cancelled' WHERE id=? AND status='scheduled' AND NOT ${owned}`)
      .bind(releaseId,releaseId,token),
  ];
  if (statements.length > MAX_PUBLICATION_STATEMENTS) {
    throw new PublicContentError('batch',`发布需要 ${statements.length} 条语句，超过 ${MAX_PUBLICATION_STATEMENTS} 条上限`);
  }
  const result=await env.DB.batch(statements);
  const activation=result[statements.length-5];
  return result[0]?.meta?.changes===1&&activation?.meta?.changes===1
    ?{ok:true,release_id:releaseId,checksum,published_at:iso}
    :{ok:false,status:409,code:'publication_conflict'};
}

export async function publishExactDraft(env,{expectedActiveId,expectedChecksum,expectedRevision,actor='boss',now=new Date(),
  releaseId=crypto.randomUUID(),pageBuilder}={}) {
  if (!expectedActiveId||!/^[0-9a-f]{64}$/.test(String(expectedChecksum||''))) return {ok:false,status:400,code:'invalid_request'};
  const precheck=await exactPublicationPrecheck(env,expectedActiveId);
  if (!precheck.ok) return precheck;
  if (expectedRevision !== undefined && precheck.draftRevision !== expectedRevision) return {ok:false,status:409,code:'revision_conflict'};
  const draft=await loadPublishableDraft(env,{contentAt:now}); const mediaByHash=new Map();
  const snapshot=await buildPublicSnapshot(draft,async value=>{const item=await materializePublicMedia(value);mediaByHash.set(item.hash,item);return item.publicUrl;});
  if (await checksumSnapshot(snapshot)!==expectedChecksum) return {ok:false,status:409,code:'draft_snapshot_mismatch'};
  return activateExactRelease(env,{snapshot,media:[...mediaByHash.values()],sourceRevision:precheck.draftRevision,
    expectedActiveId,expectedRevision:precheck.draftRevision,actor,now,releaseId,pageBuilder,eventAction:'published_exact'});
}

export async function rollbackExactRelease(env,{sourceReleaseId,expectedActiveId,actor='boss',now=new Date(),
  releaseId=crypto.randomUUID(),pageBuilder}={}) {
  if (!sourceReleaseId||!expectedActiveId) return {ok:false,status:400,code:'invalid_request'};
  const precheck=await exactPublicationPrecheck(env,expectedActiveId);
  if (!precheck.ok) return precheck;
  const source=await env.DB.prepare('SELECT id,checksum,snapshot_json FROM public_content_releases WHERE id=?').bind(sourceReleaseId).first();
  if (!source) return {ok:false,status:404,code:'release_not_found'};
  let snapshot;
  try { snapshot=JSON.parse(source.snapshot_json); } catch { return {ok:false,status:409,code:'snapshot_unreadable'}; }
  const checked=validatePublicSnapshot(snapshot);
  if (!checked.ok) return {ok:false,status:409,code:'snapshot_invalid',field:checked.field};
  if (await checksumSnapshot(snapshot)!==source.checksum) return {ok:false,status:409,code:'snapshot_checksum_mismatch'};
  const predates=await rollbackComponentsProblem(env,snapshot); if (predates) return predates;
  return activateExactRelease(env,{snapshot,media:[],sourceRevision:`rollback:${sourceReleaseId}`,expectedActiveId,
    actor,now,releaseId,pageBuilder,eventAction:'rollback_exact'});
}
