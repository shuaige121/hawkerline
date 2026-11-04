// Hawkerline — restaurant ordering, kitchen, menu and POS Worker
// Payment: dynamic PayNow QR (zero-fee, real merchant UEN) by default; Stripe PayNow
// checkout (auto-confirm via webhook) when PAY_MODE=stripe. Membership + admin included.
import QRCode from 'qrcode-svg';
import {
  servePublicPage, servePublicMedia, classifyPublicPath, privateResponse,
  activeReleaseMenuProjection,
} from './public-cache.js';
import { renderPublicReleasePages, renderMissingProductPage } from './public-render.js';
import { loadMenuCategories, validateMenuCategories, MenuCategoryError } from './menu-categories.js';
import { AGENT_ADMIN, actorOf } from './agent-context.js';
import { AGENT_SCOPES, ToolError, createAgentKey, listAgentKeys, revokeAgentKey, listAgentAudit, handleMcp, handleAgentRest, renderLlmsTxt } from './agent.js';
import { materializePublicMedia } from './public-media.js';
import { ComponentsError, normalizeComponentsInput, componentsToStored, parseStoredComponents, resolveSnapshotComponents,
  orderLineComponents, kitchenLinesFromItem, componentsDisplayText } from './product-components.js';
// 订单行：带上发布时的组成（单品为 []）和分类，厨房与备货单只认订单行，不回查可变的草稿表。
const pricedLineExtras = line => ({
  ...(Array.isArray(line.components) ? { components: line.components } : {}),
  ...(line.category ? { category: line.category } : {}),
});
import { ensureActiveRelease, loadPublishableDraft, buildPublicSnapshot, DELIVERY_DEFAULTS,
  DRAFT_PUBLIC_SETTING_KEYS,
  BUSINESS_HOURS_PUBLIC_DEFAULT, normalizePublishedBusinessHours, quoteActiveReleaseItems,
  commitDraftMutation, tagUpsertStatements, tagDeleteStatements, productTagAssignmentStatements,
  normalizeProductTagInput, publicationStatus, schedulePublicRelease, cancelScheduledRelease,
  sgtDateTimeLocalToUtc,
  signPreviewToken, verifyPreviewToken,
  PRODUCT_TEXT_FIELDS, commitProductTextExact, draftSnapshotComparison, publishExactDraft, rollbackExactRelease,
  activeReleaseProductRows } from './publication.js';

// ----- PayNow dynamic QR (EMVCo / SGQR spec) -----
const _bytes = (s) => new TextEncoder().encode(String(s));   // QR 编码用 UTF-8，TLV 长度/CRC 都必须按字节算
function _tlv(t, v) {
  v = String(v);
  const len = _bytes(v).length;                              // EMVCo 长度 = UTF-8 字节数（非 JS .length）
  if (len > 99) throw new Error('TLV ' + t + ' value too long (' + len + ' bytes)');  // ≥100 会撑爆 2 位长度 → 让上层降级（不出 QR）
  return t + String(len).padStart(2, '0') + v;
}
function _crc16(s) {
  let crc = 0xFFFF;
  for (const b of _bytes(s)) {                               // 按 UTF-8 字节算（ASCII 下与原 charCodeAt 等价，CJK 下才正确）
    crc ^= b << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
// proxy type 2 = UEN; editable 0 = amount locked. Mirrors the merchant's real SGQR fields.
function paynowPayload(uen, amount, ref, merchant, city = 'Singapore') {
  const mai = _tlv('00', 'SG.PAYNOW') + _tlv('01', '2') + _tlv('02', uen) + _tlv('03', '0');
  let p = _tlv('00', '01') + _tlv('01', '12') + _tlv('26', mai)
    + _tlv('52', '0000') + _tlv('53', '702') + _tlv('54', amount.toFixed(2)) + _tlv('58', 'SG')
    + _tlv('59', merchant.slice(0, 25)) + _tlv('60', city.slice(0, 15))
    // EMVCo 62/01 bill reference 上限 25，且 TLV 长度只有 2 位十进制 —— ≥100 字节会 throw 让整张 QR 消失。
    // 这里是唯一没做长度保护的字段（同行 merchant/city 都有），必须与它们对齐；null/undefined 不能落成字面量 "undefined"。
    + _tlv('62', _tlv('01', String(ref == null ? '' : ref).slice(0, 25)));
  return p + '6304' + _crc16(p + '6304');
}
function paynowQrSvg(uen, amount, ref, merchant) {
  const payload = paynowPayload(uen, amount, ref, merchant);
  return new QRCode({ content: payload, padding: 1, width: 200, height: 200, ecl: 'M', join: true }).svg();
}
// 顾客要抄进银行 App 的 PayNow 备注 —— 只能从 invoice_no 派生，【绝不能直接显示 orders.pay_ref】：
// 下单时 pay_ref 是短码（单号前缀 + 末四位），但 Stripe 分支 (/api/order) 会立刻把它覆写成 66 字符的
// cs_live_… checkout session id（那列被复用来记 session，付款流程本身不读它）。直接显示的后果是
// 顾客抄不到备注、手机上溢出被切，钱到账也对不上单。invoice_no 为空才回退 pay_ref。
function payNoteFor(o) {
  const inv = String((o && o.invoice_no) || '').trim();
  if (inv) return inv.split('-')[0] + inv.slice(-4);
  return String((o && o.pay_ref) || '').slice(0, 25);
}

// 套餐 / 单人餐的「组成」随订单行一起记下（worker/product-components.js），
// 小票、厨房看板、Telegram、备货单都按订单行展开；没有记组成的订单行按单品出餐。
// 厨房展开一行订单：订单行自带组成（下单时从发布的菜单记下）就按它，否则按单品出餐。
export function kitchenLines(item) {
  return kitchenLinesFromItem(item) ?? [];
}
// 一次查完这张单需要的所有成分名。查不到名字就退回 SKU——宁可后厨看见 S07，也不能整块不显示。
// 订单行自带组成和名称，不需要回查商品表；保留函数供调用方使用。
async function bomNameMap() { return {}; }

// ===== Delivery tiers + postal-sector zones (single source of truth) =========
// Three fulfilment tiers: pickup 自取 | discount 优惠配送(老板自有车·按片区预约) | anytime 自费随时送(快递实时报价).
// 优惠配送 eligibility/fee/weekday is decided by the first 2 digits of the SG postal.
// Outer zones share one fee rule; core is cheaper & never blocked. Defaults follow Singapore postal sectors; owners override them in /admin.
// Money/eligibility is recomputed server-side; the client copy (/api/delivery-config) is UX-only.
const SGT_OFFSET_MIN = 8 * 60;                    // Singapore = UTC+8, no DST
// 配送默认规则的唯一定义在 worker/publication.js（发布快照与服务端下单共用一份，
// 避免顾客看到的规则和服务端算价的规则漂移）。
const DELIVERY = DELIVERY_DEFAULTS;
async function deliveryConfig(env) {              // app_settings(DELIVERY_ZONES / SAME_DAY_CUTOFF) overrides built-in (no redeploy)
  let cfg = DELIVERY;
  const z = await setting(env, 'DELIVERY_ZONES');
  if (z) { try { cfg = { ...DELIVERY, zones: JSON.parse(z) }; } catch (e) {} }
  const cutoff = await setting(env, 'SAME_DAY_CUTOFF');
  if (cutoff && /^([01]?\d|2[0-3]):[0-5]\d$/.test(cutoff)) cfg = { ...cfg, same_day_cutoff: cutoff };   // 含时分范围校验，挡 '99:99' 致截单失效
  return cfg;
}
function postalSector(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 2 ? d.slice(0, 2) : null; }
function findZone(cfg, postal) { const s = postalSector(postal); return s ? (cfg.zones.find(z => z.sectors.includes(s)) || null) : null; }
function zoneFee(zone, subtotal) {               // {fee} | {blocked:true,min}
  if (subtotal >= zone.free_over) return { fee: 0 };
  if (zone.block_below && subtotal < zone.block_below) return { blocked: true, min: zone.block_below };
  return { fee: zone.fee };
}
function sgtTodayStr(now = new Date()) { return new Date(now.getTime() + SGT_OFFSET_MIN * 60000).toISOString().slice(0, 10); }
function pastSgtCutoff(cutoff, now = new Date()) {
  const sgt = new Date(now.getTime() + SGT_OFFSET_MIN * 60000);
  const [h, m] = String(cutoff || '16:00').split(':').map(Number);
  return (sgt.getUTCHours() * 60 + sgt.getUTCMinutes()) >= (h * 60 + (m || 0));
}
function weekdayOf(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }

// ===== 营业时间（boss 可配，SGT 判断；营业时间外顾客仍可【预约】，下单时刻由 checkFulfilTime 校验落在营业时段内）=====
// app_settings.business_hours = JSON {dow: [open,close] | null}，dow=JS getDay（0=周日..6=周六）。
const BUSINESS_HOURS_DEFAULT = BUSINESS_HOURS_PUBLIC_DEFAULT;   // 唯一定义在 publication.js
function cleanProductText(v, max = 120) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanProductLongText(v, max = 2000) {
  return String(v == null ? '' : v)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}
function normalizeProductInput(b, categoryKeys) {
  const sku = String(b.sku == null ? '' : b.sku).replace(/\s+/g, '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,16}$/.test(sku)) return { error: 'SKU 只能含字母/数字/_-，长度 2-16' };
  const nameCn = cleanProductText(b.name_cn || b.name_en, 120);
  const nameEn = cleanProductText(b.name_en || b.name_cn, 160);
  if (!nameCn || !nameEn) return { error: '商品名称必填（中文或英文至少一个）· name_cn or name_en is required' };
  const price = Math.round(Number(b.price) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0 || price > 999) return { error: '价格需为 0-999 的正数' };
  const category = cleanProductText(b.category, 24);   // same limit as menu-categories.js keys
  if (!categoryKeys || !categoryKeys.has(category)) return { error: `商品分类无效：${category || '（空）'}。可用分类：${[...(categoryKeys || [])].join(', ')}` };
  let kcal = null;
  if (b.kcal !== '' && b.kcal != null) {
    kcal = Math.round(Number(b.kcal));
    if (!Number.isFinite(kcal) || kcal < 0 || kcal > 9999) return { error: '热量需为 0-9999 的整数' };
  }
  const img = cleanProductText(b.img, 900000);
  if (img && img.includes('..')) return { error: '图片路径不能包含 ..' };
  if (img && !/^\/?img\/[A-Za-z0-9_.\/-]+\.(png|jpe?g|webp|gif)$/i.test(img) && !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(img)) {
    return { error: '图片只允许 /img/ 路径或后台上传的图片数据' };
  }
  if (img && img.startsWith('data:image/') && img.length > 900000) return { error: '图片过大，请压缩后再传（约 <600KB）' };
  const sort = b.sort === '' || b.sort == null ? null : Math.max(0, Math.round(Number(b.sort) || 0));
  const active = (b.active === 0 || b.active === '0' || b.active === false) ? 0 : 1;
  const descriptionCn = cleanProductText(b.description_cn, 240);
  const descriptionEn = cleanProductText(b.description_en, 300);
  const detailCn = cleanProductLongText(b.detail_cn, 2000);
  const detailEn = cleanProductLongText(b.detail_en, 2400);
  return { product: {
    sku, name_cn: nameCn, name_en: nameEn, price, category, kcal, img: img || null, active, sort,
    description_cn: descriptionCn, description_en: descriptionEn, detail_cn: detailCn, detail_en: detailEn,
  } };
}
// 解析规则与发布快照共用一份，顾客看到的营业时段与服务端校验的一定一致。
const parseBusinessHours = raw => normalizePublishedBusinessHours(raw);
function sgtNowParts(now = new Date()) {
  const sgt = new Date(now.getTime() + SGT_OFFSET_MIN * 60000);
  return { dow: sgt.getUTCDay(), hhmm: String(sgt.getUTCHours()).padStart(2, '0') + ':' + String(sgt.getUTCMinutes()).padStart(2, '0') };
}
function withinBusinessHours(schedule, now = new Date()) {
  const { dow, hhmm } = sgtNowParts(now); const t = schedule[dow];
  if (!t) return { open: false, today: null, hhmm };
  return { open: hhmm >= t[0] && hhmm < t[1], today: t, hhmm };
}
function addMinutesHHMM(hhmm, mins) {           // "13:40" + 20 → "14:00"（钳在 23:59）
  const [h, m] = String(hhmm).split(':').map(Number);
  const tot = Math.min(24 * 60 - 1, (h * 60 + m) + Math.max(0, mins | 0));
  return String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0');
}
function nextBusinessSlot(schedule, prepMin, now = new Date()) {
  const sgt = new Date(now.getTime() + SGT_OFFSET_MIN * 60000);
  const nowHHMM = String(sgt.getUTCHours()).padStart(2, '0') + ':' + String(sgt.getUTCMinutes()).padStart(2, '0');
  const toMin = value => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
  const toHHMM = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  for (let offset = 0; offset < 14; offset++) {
    const day = new Date(sgt); day.setUTCDate(day.getUTCDate() + offset);
    const win = schedule[day.getUTCDay()];
    if (!Array.isArray(win) || win.length !== 2) continue;
    if (offset === 0 && nowHHMM >= win[1]) continue;
    const readyMin = toMin(win[0]) + Math.max(0, +prepMin || 0);
    if (readyMin >= toMin(win[1])) continue;
    return { date: day.toISOString().slice(0, 10), time: toHHMM(readyMin) };
  }
  return null;
}
// 营业时段【外】仍允许【预约】下单：校验顾客选的取餐/送达 日期+时刻 落在某营业日的营业时段内，
// 且当天的单留足备货时间（默认 20 分钟）。store_open=false（紧急下线）在外层先拦，不到这里。
// 返回 {ok:true} 或 {error:'...'}。仅用于自取/即时配送；优惠配送有独立片区配送日逻辑。
function checkFulfilTime(schedule, prepMin, wantDate, wantTime, now = new Date(), allowFutureDateOnly = false) {
  const { dow: nowDow, hhmm: nowHHMM } = sgtNowParts(now);
  const todayStr = sgtTodayStr(now);
  // 顾客完全没选日期/时刻：营业中仍按「尽快」；营业外自动排到下一次可履约时间。
  // 明确选过日期或时刻时不偷偷改，继续走下面的严格校验。
  if (!wantDate && !wantTime) {
    const todayWin = schedule[nowDow];
    if (todayWin && nowHHMM >= todayWin[0] && nowHHMM < todayWin[1]) return { ok: true };
    const auto = nextBusinessSlot(schedule, prepMin, now);
    if (auto) return { ok: true, auto };
  }
  const targetStr = wantDate || todayStr;
  const targetDow = wantDate ? weekdayOf(wantDate) : nowDow;
  const win = schedule[targetDow];
  if (!win) return { error: `${DOW_CN[targetDow]}本店休息，请改选其他日期` };
  if (!wantTime) {   // 没选时刻＝尽快
    if (targetStr === todayStr && nowHHMM >= win[0] && nowHHMM < win[1]) return { ok: true };
    // 「只选了日期、没选几点」的自取预约是一等公民：晨报 cron、备货聚合、后台未来订单计数
    // 都不按 deliver_time 过滤，小票本来就渲染无时刻。此前这里一律拒，导致打烊后想约明天自取
    // 的顾客被拦下（而前端还写着"留空=尽快"诱导他别填时间）——转化白白流失。
    if (allowFutureDateOnly && wantDate
      && (targetStr > todayStr || (targetStr === todayStr && nowHHMM < win[1]))) return { ok: true };
    // 顾客明确选了日期却没选时刻时，不能替他制造一个履约承诺。
    const openNow = nowHHMM >= (schedule[nowDow] || ['', ''])[0] && nowHHMM < (schedule[nowDow] || ['', ''])[1];
    return { error: openNow
      ? `请选好取餐/送达时间（${DOW_CN[targetDow]}营业 ${win[0]}–${win[1]}）`
      : `现在不在营业时间，可预约——请选好取餐/送达时间（${DOW_CN[targetDow]}营业 ${win[0]}–${win[1]}）` };
  }
  if (wantTime < win[0] || wantTime >= win[1]) return { error: `请选营业时间内（${win[0]}–${win[1]}）的时间` };
  if (targetStr === todayStr) {
    const earliest = addMinutesHHMM(nowHHMM, +prepMin || 0);
    if (wantTime < earliest) return { error: `今天 ${wantTime} 来不及备餐，最早 ${earliest} 可取，请改时间或预约明天` };
  }
  return { ok: true };
}
const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function fulfilLabel(o) {
  const m = { pickup: '自取 Pickup', discount: '优惠配送', anytime: '自费随时送', delivery: '配送', route: '拼单顺路送' };
  return (m[o.fulfilment] || '自取 Pickup') + (o.address ? ' ' + o.address : '');
}

// ===== 自费随时送: courier quote only (Lalamove + uParcel, paste-a-key) =====
// Active provider + keys live in D1 app_settings (read via setting()), so the boss pastes
// them in the admin panel and they take effect with NO redeploy. The application only
// requests quotations; the boss books the actual courier manually outside this system.
async function geocodePostal(postal) {
  const p = String(postal || '').replace(/\D/g, '');
  if (p.length < 5) return null;
  try {
    const r = await fetch(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${p}&returnGeom=Y&getAddrDetails=Y`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json(); const a = (d.results || [])[0];
    if (!a) return null;
    const lat = +a.LATITUDE, lng = +a.LONGITUDE;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;   // OneMap 偶有坐标缺失记录 → 当查不到，走兜底/拦单(防 NaN 进距离/快递报价)
    return { lat, lng, postal: a.POSTAL || p,
      address: a.ADDRESS || ((a.BLK_NO ? a.BLK_NO + ' ' : '') + (a.ROAD_NAME || '')).trim() };
  } catch (e) { return null; }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function geocodePostalRetry(postal, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const geo = await geocodePostal(postal);
    if (geo) return geo;
    if (i < tries - 1) await sleep(250 * (i + 1));
  }
  return null;
}
// which courier (if any) is configured/active for anytime quotes
async function courierProvider(env) {
  const p = String((await setting(env, 'courier_provider')) || '').toLowerCase();
  if (p === 'lalamove' && (await setting(env, 'LALAMOVE_API_KEY')) && (await setting(env, 'LALAMOVE_API_SECRET'))) return 'lalamove';
  if (p === 'uparcel' && (await setting(env, 'UPARCEL_API_KEY')) && (await setting(env, 'UPARCEL_SECRET_KEY'))) return 'uparcel';
  return null;
}
function lalamoveBase(env) {
  return String((env.LALAMOVE_ENVIRONMENT || '')).toLowerCase() === 'production'
    ? 'https://rest.lalamove.com' : 'https://rest.sandbox.lalamove.com';
}
function isLalamoveQuoteRequest(method, path) {
  return String(method || '').toUpperCase() === 'POST' && path === '/v3/quotations';
}
async function lalamoveRequest(env, method, path, payload, diag) {
  // Hard safety boundary: credentials may only be used to request a price quote.
  // Even if an old dispatch call path is accidentally reintroduced, order creation,
  // cancellation and status APIs remain blocked at the transport layer.
  if (!isLalamoveQuoteRequest(method, path)) {
    if (diag) diag.error = 'Lalamove 仅用于运费报价；系统叫车已永久停用';
    return null;
  }
  const key = await setting(env, 'LALAMOVE_API_KEY'), secret = await setting(env, 'LALAMOVE_API_SECRET');
  if (!key || !secret) { if (diag) diag.error = 'Lalamove: 未填 API Key/Secret'; return null; }
  const base = String((await setting(env, 'LALAMOVE_ENVIRONMENT')) || '').toLowerCase() === 'production'
    ? 'https://rest.lalamove.com' : 'https://rest.sandbox.lalamove.com';
  const market = (await setting(env, 'LALAMOVE_MARKET')) || 'SG';
  const body = payload == null ? '' : JSON.stringify(payload);
  const ts = Date.now().toString();
  const sig = await _hmac(secret, ts + '\r\n' + method + '\r\n' + path + '\r\n\r\n' + body);
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(8000), method, body: body || undefined, headers: {
      authorization: 'hmac ' + key + ':' + ts + ':' + sig, Market: market,
      'Request-ID': crypto.randomUUID(), 'content-type': 'application/json' } });
    const text = await r.text();
    let d = {}; try { d = text ? JSON.parse(text) : {}; } catch (e) { d = { raw: text }; }
    if (!r.ok) { if (diag) { diag.error = `Lalamove ${r.status}: ${text.slice(0, 400)}`; diag.endpoint = base + path; diag.market = market; } return null; }
    return d;
  } catch (e) { if (diag) diag.error = 'Lalamove 调用异常: ' + String(e.message || e); return null; }
}
// Lalamove v3 quote. diag（可选）：失败原因写进 diag.error，供「测试连接」诊断。
async function lalamoveQuote(env, shop, dropoff, diag) {
  const d = await lalamoveRequest(env, 'POST', '/v3/quotations', { data: { serviceType: (await setting(env, 'LALAMOVE_SERVICE')) || 'MOTORCYCLE', language: 'en_SG', stops: [
    { coordinates: { lat: String(shop.lat), lng: String(shop.lng) }, address: shop.address },
    { coordinates: { lat: String(dropoff.lat), lng: String(dropoff.lng) }, address: dropoff.address },
  ] } }, diag);
  const pb = (d && d.data && d.data.priceBreakdown) || {};
  const fee = pb.total != null ? +parseFloat(pb.total) : null;
  if (!(fee != null && fee >= 0)) { if (diag && !diag.error) diag.error = 'Lalamove 返回无 priceBreakdown.total: ' + JSON.stringify(d).slice(0, 400); return null; }
  return { fee, currency: pb.currency || 'SGD', ref: (d.data && d.data.quotationId) || null, stops: (d.data && d.data.stops) || [], raw: d.data || d };
}
// uParcel quote — auth (api_key/secret_key → access_token) then POST /api/merchant/multiple-package-pricing/.
async function uparcelQuote(env, shop, dropoff) {
  const key = await setting(env, 'UPARCEL_API_KEY'), secret = await setting(env, 'UPARCEL_SECRET_KEY');
  if (!key || !secret) return null;
  const prod = String((await setting(env, 'UPARCEL_ENVIRONMENT')) || '').toLowerCase() === 'production';
  const base = (await setting(env, 'UPARCEL_BASE')) || (prod ? 'https://api.uparcel.sg' : 'https://stg.uparcel.sg');
  try {
    const auth = await (await fetch(base + '/api/merchant/auth/', { signal: AbortSignal.timeout(6000), method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key, secret_key: secret, api_platform: 'Open', domain_info: await shopDomain(env) }) })).json();
    const token = auth && auth.Data && auth.Data.access_token; if (!token) return null;
    const r = await fetch(base + '/api/merchant/multiple-package-pricing/', { signal: AbortSignal.timeout(6000), method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        merchant_info: { access_token: token },
        pickup_detail: { pickup_address: shop.address, pickup_pincode: shop.postal, vehicle_type: (await setting(env, 'UPARCEL_VEHICLE')) || 'Motorcycle' },
        delivery_package: [{ delivery_address: dropoff.address, pincode: dropoff.postal,
          delivery_type: +((await setting(env, 'UPARCEL_DELIVERY_TYPE')) || 4), weight: 1, quantity: 1, sku: 'order' }],
      }) });
    if (!r.ok) return null;
    const d = await r.json(); const tp = d && d.Data && d.Data.total_price;
    const fee = tp && tp.value != null ? +parseFloat(tp.value) : null;
    return fee != null && fee >= 0 ? { fee, currency: (tp && tp.currency) || 'SGD', ref: null } : null;
  } catch (e) { return null; }
}
// dispatch a live quote to the active courier (or null → manual S$0). shop pickup from SHOP_POSTAL (required, no default).
// diag（可选）：把失败原因写进 diag.error，供「测试连接」精确诊断。
async function courierQuote(env, dropoff, diag) {
  const prov = await courierProvider(env); if (!prov) { if (diag) diag.error = '未选择有效快递商，或 API key/secret 未填全'; return null; }
  if (!dropoff) { if (diag) diag.error = '收件地址解析失败（OneMap 查不到该邮编坐标）'; return null; }
  const shopPostal = String((await setting(env, 'SHOP_POSTAL')) || '').replace(/\D/g, '');
  if (!shopPostal) { if (diag) diag.error = '未设置店铺取货邮编（快递设置 / 店铺设置）'; return null; }
  const shop = await geocodePostalRetry(shopPostal); if (!shop) { if (diag) diag.error = `取货邮编 ${shopPostal} 解析失败（请在快递设置填正确的店铺邮编）`; return null; }
  const q = prov === 'lalamove' ? await lalamoveQuote(env, shop, dropoff, diag) : await uparcelQuote(env, shop, dropoff, diag);
  return q ? { ...q, provider: prov, shop, dropoff } : null;
}

function phoneForCourier(p) {
  const d = e164Phone(p);
  if (!d) return '';
  return '+' + d;
}
function courierRecipientPhone(customerPhone, shopPhone) {
  return phoneForCourier(customerPhone) || phoneForCourier(shopPhone);
}
function lalamoveStopId(stops, idx) {
  const s = Array.isArray(stops) ? stops[idx] : null;
  return s && (s.stopId || s.id || s.stop_id);
}
async function lalamoveCreateOrder(env, quote, order, shop, dropoff, diag) {
  const senderStopId = lalamoveStopId(quote.stops, 0), recipientStopId = lalamoveStopId(quote.stops, 1);
  if (!quote.ref || !senderStopId || !recipientStopId) { if (diag) diag.error = 'Lalamove quote 缺 quotationId/stopId，无法创建订单'; return null; }
  const m = await merchantInfo(env);
  const senderPhone = phoneForCourier(m.whatsapp || env.BOSS_PHONE);
  const recipientPhone = courierRecipientPhone(order.phone, senderPhone);   // phone is optional for signed-in users; courier can contact the shop as fallback
  const body = { data: {
    quotationId: quote.ref,
    sender: { stopId: senderStopId, name: m.nameEn || m.nameCn, phone: senderPhone },
    recipients: [{ stopId: recipientStopId, name: order.customer_name || 'Customer', phone: recipientPhone, remarks: order.note || '' }],
    metadata: { restaurant_order_id: order.id, invoice_no: order.invoice_no },
  } };
  const d = await lalamoveRequest(env, 'POST', '/v3/orders', body, diag);
  const data = d && d.data;
  if (!data) return null;
  return { id: data.orderId || data.id || data.order_id || null, status: data.status || '', share_link: data.shareLink || data.share_link || data.trackingUrl || '', raw: data };
}
async function lalamoveGetOrder(env, providerOrderId, diag) {
  if (!providerOrderId) return null;
  const d = await lalamoveRequest(env, 'GET', '/v3/orders/' + encodeURIComponent(providerOrderId), null, diag);
  return d && d.data ? d.data : null;
}
async function lalamoveCancelOrder(env, providerOrderId, reason, diag) {
  if (!providerOrderId) return null;
  return await lalamoveRequest(env, 'DELETE', '/v3/orders/' + encodeURIComponent(providerOrderId), { data: { reason: reason || 'No driver accepted in time' } }, diag);
}
function deliveryStateFromProviderStatus(status) {
  const s = String(status || '').toUpperCase();
  if (/COMPLETED|DELIVERED/.test(s)) return 'delivered';
  if (/PICKED/.test(s)) return 'picked_up';
  if (/ON_GOING|DRIVER_ASSIGNED|ASSIGNED|ACCEPTED/.test(s)) return 'rider_assigned';
  if (/ASSIGNING|MATCHING|FINDING|SEARCHING/.test(s)) return 'assigning_driver';
  if (/CANCEL|REJECT|EXPIRED|FAILED/.test(s)) return 'failed';
  return s ? 'provider_' + s.toLowerCase() : 'created';
}
function deliveryStatusText(state) {
  const map = {
    quoted: '运费已按 Lalamove 实时报价；配送由商家手动安排。',
    assigning_driver: '已通过 Lalamove 开始寻找骑手。',
    rider_assigned: '骑手已接单，正在前往餐厅取货。',
    picked_up: '骑手已取货，正在赶往顾客地址。',
    delivered: '订单已送达。',
    failed: 'Lalamove 未能完成派送，已进入退款/人工处理流程。',
    refund_starting: '系统准备进入退款流程。',
    refund_requested: '已向 Stripe 发起退款请求，等待 Stripe webhook 确认。',
    refund_confirmed: 'Stripe 已确认退款完成。',
    manual_refund_required: '无法自动原路退款，请老板人工联系顾客处理。',
    dispatch_failed: 'Lalamove 创建订单失败，请检查 API/地址/余额，系统不会静默当作已派送。',
  };
  return map[state] || String(state || '配送状态更新');
}
function deliveryMessage(order, state, extra = {}) {
  const inv = order && order.invoice_no ? order.invoice_no : (extra.invoice_no || '');
  const head = inv ? `🛵 外卖 ${inv}` : '🛵 外卖状态';
  const rider = extra.rider_name ? `\n骑手：${extra.rider_name}${extra.rider_phone ? ' ' + extra.rider_phone : ''}` : '';
  const reason = extra.reason ? `\n原因：${extra.reason}` : '';
  const refund = extra.refund_id ? `\n退款编号：${extra.refund_id}` : '';
  return `${head}\n${deliveryStatusText(state)}${reason}${refund}${rider}${extra.share_link ? '\n追踪：' + extra.share_link : ''}`;
}
async function notifyCustomerDelivery(env, order, state, extra = {}) {
  const allowed = new Set(['assigning_driver', 'rider_assigned', 'picked_up', 'delivered', 'failed', 'refund_requested', 'manual_refund_required']);
  if (!order || !normPhone(order.phone) || !allowed.has(state)) return;
  if (!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID)) return;
  const tpl = await setting(env, 'WHATSAPP_DELIVERY_TEMPLATE');
  if (!tpl) return; // Customer push requires a pre-approved Meta template.
  const domain = await shopDomain(env);
  const invoiceUrl = `https://${domain}/invoice/${order.id}`;
  await sendWhatsAppTemplate(env, order.phone, tpl, [
    order.invoice_no || order.id,
    deliveryStatusText(state),
    extra.share_link || invoiceUrl,
  ]);
}
async function notifyDelivery(env, orderId, state, extra = {}) {
  let o = null;
  try {
    o = orderId ? await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first() : null;
    await notifyTelegram(env, deliveryMessage(o, state, extra));
  } catch (e) {}
  try { await notifyCustomerDelivery(env, o, state, extra); } catch (e) {}
}
async function updateDeliveryJob(env, orderId, patch) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT id FROM delivery_jobs WHERE order_id=?').bind(orderId).first();
  if (!existing) {
    await env.DB.prepare(`INSERT INTO delivery_jobs (id,order_id,provider,provider_order_id,provider_status,state,quote_id,fee,currency,rider_name,rider_phone,share_link,dispatch_requested_at,last_event_at,raw_last,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), orderId, patch.provider || 'lalamove', patch.provider_order_id || null, patch.provider_status || null, patch.state || 'created',
      patch.quote_id || null, patch.fee || 0, patch.currency || 'SGD', patch.rider_name || null, patch.rider_phone || null, patch.share_link || null,
      patch.dispatch_requested_at || null, patch.last_event_at || now, patch.raw_last || null, now, now).run();
    return;
  }
  await env.DB.prepare(`UPDATE delivery_jobs SET
      provider_order_id=COALESCE(?,provider_order_id), provider_status=COALESCE(?,provider_status), state=COALESCE(?,state),
      quote_id=COALESCE(?,quote_id), fee=COALESCE(?,fee), currency=COALESCE(?,currency),
      rider_name=COALESCE(?,rider_name), rider_phone=COALESCE(?,rider_phone), share_link=COALESCE(?,share_link),
      dispatch_requested_at=COALESCE(?,dispatch_requested_at), assigned_at=COALESCE(?,assigned_at), picked_up_at=COALESCE(?,picked_up_at),
      delivered_at=COALESCE(?,delivered_at), cancelled_at=COALESCE(?,cancelled_at), refund_status=COALESCE(?,refund_status),
      refund_ref=COALESCE(?,refund_ref), last_event_at=COALESCE(?,last_event_at), raw_last=COALESCE(?,raw_last), updated_at=?
    WHERE order_id=?`).bind(patch.provider_order_id || null, patch.provider_status || null, patch.state || null, patch.quote_id || null,
      patch.fee == null ? null : patch.fee, patch.currency || null, patch.rider_name || null, patch.rider_phone || null, patch.share_link || null,
      patch.dispatch_requested_at || null, patch.assigned_at || null, patch.picked_up_at || null, patch.delivered_at || null, patch.cancelled_at || null,
      patch.refund_status || null, patch.refund_ref || null, patch.last_event_at || now, patch.raw_last || null, now, orderId).run();
}

function courierGeoSnapshot(g) {
  if (!g) return null;
  const lat = +g.lat, lng = +g.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    postal: String(g.postal || '').replace(/\D/g, '').slice(0, 6) || null,
    address: String(g.address || '').trim() || null,
  };
}
function deliverySnapshotPayload(s, nowIso) {
  const shop = courierGeoSnapshot(s && s.shop);
  const dropoff = courierGeoSnapshot(s && s.dropoff);
  if (!shop || !dropoff) return null;
  const q = (s && s.quote) || {};
  return {
    kind: 'checkout_snapshot',
    postal: String((s && s.postal) || dropoff.postal || '').replace(/\D/g, '').slice(0, 6) || null,
    shop,
    dropoff,
    quote: {
      provider: (s && s.provider) || q.provider || 'lalamove',
      ref: (s && s.ref) || q.ref || null,
      fee: s && s.fee != null ? +(+s.fee).toFixed(2) : (q.fee != null ? +(+q.fee).toFixed(2) : null),
      currency: (s && s.currency) || q.currency || 'SGD',
    },
    quoted_at: nowIso || new Date().toISOString(),
  };
}
function parseDeliverySnapshot(raw) {
  if (!raw) return null;
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const s = d && d.kind === 'checkout_snapshot' ? d : (d && (d.snapshot || d.checkout_snapshot));
    const shop = courierGeoSnapshot(s && s.shop);
    const dropoff = courierGeoSnapshot(s && s.dropoff);
    return shop && dropoff ? { ...s, shop, dropoff } : null;
  } catch (e) {
    return null;
  }
}
async function loadDeliverySnapshot(env, orderId) {
  const row = await env.DB.prepare('SELECT raw_last FROM delivery_jobs WHERE order_id=?').bind(orderId).first();
  return parseDeliverySnapshot(row && row.raw_last);
}
async function saveDeliverySnapshot(env, orderId, snapshot, nowIso) {
  const payload = deliverySnapshotPayload(snapshot, nowIso);
  if (!payload) return false;
  await updateDeliveryJob(env, orderId, {
    provider: payload.quote.provider || 'lalamove',
    state: 'quoted',
    quote_id: payload.quote.ref || null,
    fee: payload.quote.fee || 0,
    currency: payload.quote.currency || 'SGD',
    raw_last: JSON.stringify(payload).slice(0, 4000),
  });
  return true;
}
function dispatchFailureRaw(error, postal, snapshot, diag = {}) {
  return JSON.stringify({
    kind: 'dispatch_failed',
    error,
    postal: postal || null,
    snapshot: snapshot ? deliverySnapshotPayload(snapshot) : null,
    diag,
  }).slice(0, 4000);
}

// 两点直线距离(km)。Haversine，纯本地运算、不依赖任何 API。
function haversineKm(a, b) {
  const R = 6371, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
// 自费随时送/本店配送的运费决策（确定性，绝不静默 S$0）。
// 老板在后台选收费方式 delivery_fee_mode：courier 实时报价 | flat 一口价 | distance 按距离。
// courier 挂了落到 flat 兜底（若设了）；任何方式都算不出 → {blocked} 拦单（调用方拒绝下单）。
// 返回 {fee,label,source,...} 或 {blocked:true,reason}。
async function anytimeFee(env, postal, subtotal, diag) {
  const mode = String((await setting(env, 'delivery_fee_mode')) || 'courier').toLowerCase();
  const flat = +(await setting(env, 'selfdeliver_flat')) || 0;            // 一口价 / 兜底价
  const freeAbove = +(await setting(env, 'delivery_self_free_above')) || 0;
  const drop = await geocodePostalRetry(postal);
  const freeHit = freeAbove > 0 && subtotal >= freeAbove;                 // 满额免运费（任何模式适用；下单时按折扣后金额由调用方重判）
  const flatRes = (label, source) => ({ fee: freeHit ? 0 : +flat.toFixed(2), baseFee: +flat.toFixed(2), freeAbove, label, source });

  if (mode === 'flat') {
    return flat > 0 ? flatRes('本店配送', 'flat') : { blocked: true, reason: '本店配送运费未设置' };
  }
  if (mode === 'distance') {
    if (!drop) return flat > 0 ? flatRes('本店配送（地址解析失败·按兜底价）', 'flat_fallback') : { blocked: true, reason: '地址解析失败，且未设兜底运费' };
    const shopPostal = String((await setting(env, 'SHOP_POSTAL')) || '').replace(/\D/g, '');
    const shop = shopPostal ? await geocodePostalRetry(shopPostal) : null;
    if (!shop) return flat > 0 ? flatRes('本店配送（店铺邮编无效·按兜底价）', 'flat_fallback') : { blocked: true, reason: '店铺取货邮编解析失败' };
    const base = +(await setting(env, 'dist_base')) || 0, perKm = +(await setting(env, 'dist_per_km')) || 0;
    const detour = +(await setting(env, 'dist_detour')) || 1.3, maxFee = +(await setting(env, 'dist_max')) || 0;
    const km = haversineKm(shop, drop) * detour;
    let fee = base + perKm * km; if (maxFee > 0) fee = Math.min(fee, maxFee);
    return { fee: freeHit ? 0 : +fee.toFixed(2), baseFee: +fee.toFixed(2), freeAbove, label: `本店配送 · 约 ${km.toFixed(1)}km`, source: 'distance', km: +km.toFixed(1) };
  }
  // 默认 courier：实时报价 → 失败落 flat 兜底 → 再不行拦单
  const q = drop ? await courierQuote(env, drop, diag) : null;
  if (q) return { fee: freeHit ? 0 : +(+q.fee).toFixed(2), baseFee: +(+q.fee).toFixed(2), freeAbove, label: `即时快递 ${q.provider}`, source: 'courier', provider: q.provider, ref: q.ref || null, currency: q.currency || 'SGD', shop: q.shop || null, dropoff: q.dropoff || drop };
  if (flat > 0) return flatRes('本店配送（快递暂不可用·本店安排）', 'flat_fallback');
  return { blocked: true, reason: '快递报价暂不可用，且未设本店兜底运费' };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// HTML-escape untrusted strings before interpolating into HTML responses
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// app_settings 值序列化：对象/数组 → JSON（防 String(obj)='[object Object]' / String([{...}])='[object Object],...'
// 静默损坏 business_hours / 任何结构化设置）；其余 → 去空白字符串；null/undefined → ''。所有通用 put()/setKV 统一走它。
const settingVal = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v).trim());

// add baseline security headers to every response (CSP intentionally deferred — needs Stripe/Leaflet allowlist testing)
function withSecHeaders(resp) {
  const h = new Headers(resp.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');   // 预览页要 no-referrer，不能被这里覆盖
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// runtime-configurable settings: D1 app_settings overrides env (lets admin set Stripe keys with no redeploy)
async function setting(env, key) {
  try {
    const r = await env.DB.prepare('SELECT v FROM app_settings WHERE k=?').bind(key).first();
    if (r && r.v != null && r.v !== '') return r.v;
  } catch (e) { /* table may not exist yet */ }
  return env[key];
}

const DEFAULT_BRAND_EN = 'My Restaurant';
const DEFAULT_BRAND_CN = '我的餐厅';
// The store's public host name (no scheme, no path). Empty string when not configured.
async function shopDomain(env) {
  return String((await setting(env, 'SHOP_DOMAIN')) || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}
// Invoice numbers look like <PREFIX>-YYYYMMDD-0001. INVOICE_PREFIX is 2–6 letters/digits; default ORD.
function invoicePrefix(env) {
  const raw = String((env && env.INVOICE_PREFIX) || '').trim().toUpperCase();
  return /^[A-Z0-9]{2,6}$/.test(raw) ? raw : 'ORD';
}

// public-facing runtime config: store open/close + delivery rules. All live in
// app_settings so the boss can change them from the admin panel with NO redeploy.
const FINANCE_SETTING_KEYS = ['gst_registered', 'gst_rate', 'service_charge_enabled', 'service_charge_rate'];
const PUBLIC_SETTING_KEYS = ['store_open', 'store_closed_msg', 'delivery_enabled', 'delivery_fee', 'delivery_min', 'delivery_free_above', 'pickup_enabled', 'pickup_points', 'delivery_note', 'delivery_areas', 'refund_max_days', 'business_hours', 'shop_name', 'shop_address', 'shop_pickup_detail', 'shop_pickup_photo',
  // 英文版（可留空 → 前端回落中文）。站点是中英双语，取餐指引却只有一个字段，
  // 切到 EN 后结算页和发票页照样印中文，外国顾客看不懂怎么找取餐口。
  'shop_address_en', 'shop_pickup_detail_en', 'shop_contact_phone', 'SHOP_POSTAL', 'prep_time_min',
  'brand_logo', 'brand_name_cn', 'brand_name_en', 'brand_slogan_cn', 'brand_slogan_en', 'brand_color_primary', 'brand_color_secondary', 'brand_color_bg', 'brand_color_accent',
  ...FINANCE_SETTING_KEYS];
// 运营开关（仅后台可见可改，绝不进公开 /api/config）
const ADMIN_SETTING_KEYS = ['refund_grace_manual_min', 'block_partial_balance',
  // 收银台能不能自己退运费（'0' 关闭；缺省=开）。店员退的是真钱，老板要能一键收回这个权限。
  'pos_refund_delivery_fee',
  // 本店配送/自费随时送 收费方式：courier 实时报价 | flat 一口价 | distance 按距离
  'delivery_fee_mode', 'selfdeliver_flat', 'delivery_self_free_above',
  'dist_base', 'dist_per_km', 'dist_detour', 'dist_max',
  // 店铺取货邮编（按距离的起点）
  'SHOP_POSTAL',
  // 厨房打印：print_when=placed 下单即打 | paid 付款才打；print_token=设备令牌；print_profile=票面 preset；print_font_px=网页/kiosk 字号；KITCHEN_PASSWORD=厨房页密码
  'print_when', 'print_token', 'print_profile', 'print_font_px', 'KITCHEN_PASSWORD',
  // Telegram 来单提醒：bot token + webhook 防伪密钥 + bot 用户名（订阅者存 telegram_subscribers 表）
  'telegram_bot_token', 'telegram_webhook_secret', 'telegram_bot_username'];
async function getSettings(env, keys) {
  const out = {};
  try {
    const ph = keys.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT k,v FROM app_settings WHERE k IN (${ph})`).bind(...keys).all();
    for (const r of (results || [])) if (r.v != null && r.v !== '') out[r.k] = r.v;
  } catch (e) { /* table may not exist yet */ }
  return out;
}
function saneRate(v, def, max = 30) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 1000) / 1000 : def;
}
function money(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}
function publicContact(rawPhone) {
  // 店主没填联系电话就返回空值：页面隐藏联系入口，绝不回落到任何默认号码。
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length === 8) digits = '65' + digits;
  const local = digits.startsWith('65') ? digits.slice(2) : digits;
  const display = digits.startsWith('65') && local.length === 8
    ? `+65 ${local.slice(0, 4)} ${local.slice(4)}`
    : (digits ? '+' + digits : '');
  return {
    digits,
    local,
    display,
    tel_href: digits ? `tel:+${digits}` : '',
    whatsapp_href: digits ? `https://wa.me/${digits}` : '',
  };
}
function cleanPickupId(v, idx) {
  const s = String(v || '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || `pickup${idx + 1}`;
}
const PICKUP_PHOTO_MAX_DATA_URL_CHARS = 850000;
const PICKUP_POINTS_MAX_JSON_CHARS = 1800000;
const PICKUP_POINTS_MAX_COUNT = 20;
function pickupPhotoValidationError(value, label = '自取点照片') {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^data:/i.test(s)) {
    if (s.length > PICKUP_PHOTO_MAX_DATA_URL_CHARS) return `${label}压缩后仍过大（每张最多约 850KB）`;
    const match = s.match(/^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/]*={0,2})$/i);
    if (!match || !match[2] || match[2].length % 4 === 1) return `${label}不是有效的 JPG、PNG 或 WebP 图片`;
    return '';
  }
  if (/^\/[a-zA-Z0-9._~!$&'()*+,;=:@/-]*$/.test(s)) return '';
  if (/^https:\/\/[^\s"'<>]{1,500}$/i.test(s)) return '';
  return `${label}必须是站内路径、HTTPS 图片链接或上传后的图片`;
}
function cleanPickupPhoto(v, fallback = '') {
  const s = String(v || '').trim();
  if (!s) return fallback;
  return pickupPhotoValidationError(s) ? fallback : s;
}
function pickupPhotoVersion(value) {
  const s = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 16777619);
  return `${s.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
function pickupPhotoPublicUrl(point) {
  const photo = String(point && point.photo || '');
  return /^data:image\//i.test(photo)
    ? `/api/pickup-photo/${encodeURIComponent(point.id || 'main')}?v=${pickupPhotoVersion(photo)}`
    : photo;
}
export function validatePickupSettingsPatch(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'shop_pickup_photo')) {
    const error = pickupPhotoValidationError(body.shop_pickup_photo, '主自取点照片');
    if (error) return { ok: false, status: error.includes('过大') ? 413 : 400, error };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pickup_points')) {
    let points = body.pickup_points;
    if (typeof points === 'string') {
      try { points = JSON.parse(points || '[]'); } catch (e) { return { ok: false, status: 400, error: '额外自取点资料不是有效 JSON' }; }
    }
    if (!Array.isArray(points)) return { ok: false, status: 400, error: '额外自取点必须是数组' };
    if (points.length > PICKUP_POINTS_MAX_COUNT) return { ok: false, status: 400, error: `额外自取点最多 ${PICKUP_POINTS_MAX_COUNT} 个` };
    if (JSON.stringify(points).length > PICKUP_POINTS_MAX_JSON_CHARS) return { ok: false, status: 413, error: '自取点照片合计过大，请重新选择或裁剪后再保存' };
    for (let i = 0; i < points.length; i++) {
      const error = pickupPhotoValidationError(points[i] && points[i].photo, `第 ${i + 1} 个额外自取点照片`);
      if (error) return { ok: false, status: error.includes('过大') ? 413 : 400, error };
    }
  }
  return { ok: true };
}
const ALL_STORE_SETTING_KEYS = [...new Set([...PUBLIC_SETTING_KEYS, ...ADMIN_SETTING_KEYS])];
export async function loadStoreSettingsSnapshot(env) {
  const [stateRows, settingRows] = await env.DB.batch([
    env.DB.prepare('SELECT s.revision,p.draft_revision FROM store_settings_state s CROSS JOIN public_content_state p WHERE s.singleton=1 AND p.singleton=1'),
    env.DB.prepare(`SELECT k,v FROM app_settings WHERE k IN (${ALL_STORE_SETTING_KEYS.map(() => '?').join(',')})`).bind(...ALL_STORE_SETTING_KEYS),
  ]);
  const state = stateRows.results?.[0];
  if (!state || !state.revision) throw new Error('store_settings_state missing');
  const settings = Object.fromEntries((settingRows.results || []).map(row => [row.k, row.v]));
  return { settings, revision: String(state.revision), draft_revision: state.draft_revision };
}
// Some public draft editors also keep a collection-specific revision for their own
// form. Both revisions must move in the same D1 transaction: advancing the global
// draft first and discovering a stale collection afterwards would advertise content
// that was never written. The first statement therefore checks both old revisions;
// every child statement checks both newly committed revisions.
async function commitCollectionDraftMutation(env, {
  collectionStateTable, expectedCollectionRevision, nextCollectionRevision,
  expectedDraftRevision, timestamp, action, detail = {}, buildStatements,
}) {
  if (!new Set(['store_settings_state', 'homepage_poster_state']).has(collectionStateTable)) {
    throw new Error('unsupported draft collection state');
  }
  const draftBase = String(expectedDraftRevision || '').trim();
  if (!draftBase) return { ok: false, status: 409, code: 'draft_revision_required',
    error: '内容草稿版本已失效，请刷新后再保存' };
  const nextDraftRevision = `draft-${crypto.randomUUID()}`;
  const globalGuard = env.DB.prepare(`UPDATE public_content_state SET draft_revision=?,updated_at=?
    WHERE singleton=1 AND draft_revision=? AND active_release_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM ${collectionStateTable} WHERE singleton=1 AND revision=?)`)
    .bind(nextDraftRevision, timestamp, draftBase, expectedCollectionRevision);
  const collectionGuard = env.DB.prepare(`UPDATE ${collectionStateTable} SET revision=?,updated_at=?
    WHERE singleton=1 AND revision=?
      AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
    .bind(nextCollectionRevision, timestamp, expectedCollectionRevision, nextDraftRevision);
  const statements = buildStatements({ draftRevision: nextDraftRevision,
    collectionRevision: nextCollectionRevision, timestamp });
  const event = env.DB.prepare(`INSERT INTO public_content_events(id,release_id,action,actor,detail_json,created_at)
    SELECT ?,NULL,?,'boss',?,? WHERE EXISTS(
      SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)
      AND EXISTS(SELECT 1 FROM ${collectionStateTable} WHERE singleton=1 AND revision=?)`)
    .bind(crypto.randomUUID(), action, JSON.stringify(detail), timestamp,
      nextDraftRevision, nextCollectionRevision);
  const committed = await env.DB.batch([globalGuard, collectionGuard, ...statements, event]);
  if (!(committed?.[0]?.meta?.changes === 1)) {
    const state = await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
    if (state && !state.active_release_id) return { ok: false, status: 409, code: 'bootstrap_pending',
      error: '系统正在生成首个菜单发布（部署后约一分钟内自动完成），请稍后再保存 · The first release is being created; try again in a minute' };
    return { ok: false, status: 409, code: 'revision_conflict',
      error: '页面上的内容已经被别处改过了，请刷新后重试' };
  }
  return { ok: true, draft_revision: nextDraftRevision,
    collection_revision: nextCollectionRevision };
}

export async function saveStoreSettingsPatch(env, body = {}, timestamp = new Date().toISOString(), expectedRevision = '', draftOptions = null) {
  const checked = validatePickupSettingsPatch(body);
  if (!checked.ok) return checked;
  const baseRevision = String(expectedRevision || '').trim();
  if (!baseRevision) return { ok: false, status: 409, code: 'settings_revision_required', error: '设置页面版本已失效，请刷新后再保存' };
  let currentRevision = '';
  try {
    const state = await env.DB.prepare('SELECT revision FROM store_settings_state WHERE singleton=1').first();
    currentRevision = String(state && state.revision || '');
    if (!currentRevision) throw new Error('store_settings_state missing');
  } catch (e) {
    return { ok: false, status: 503, code: 'settings_migration_required', error: '设置功能尚未完成数据库升级' };
  }
  if (baseRevision !== currentRevision) return { ok: false, status: 409, code: 'settings_revision_conflict', error: '设置已在另一个页面被修改，请刷新后再编辑' };
  const keys = ALL_STORE_SETTING_KEYS.filter(k => Object.prototype.hasOwnProperty.call(body, k));
  const nextRevision = `settings-${crypto.randomUUID()}`;
  if (draftOptions) {
    const committed = await commitCollectionDraftMutation(env, {
      collectionStateTable: 'store_settings_state', expectedCollectionRevision: baseRevision,
      nextCollectionRevision: nextRevision, expectedDraftRevision: draftOptions.expectedRevision,
      timestamp, action: draftOptions.action || 'store_settings_saved', detail: { keys },
      buildStatements: ({ draftRevision, collectionRevision }) => keys.map(k => env.DB.prepare(`INSERT INTO app_settings (k,v,updated_at)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM store_settings_state WHERE singleton=1 AND revision=?)
          AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)
        ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`)
        .bind(k, settingVal(body[k]), timestamp, collectionRevision, draftRevision)),
    });
    if (!committed.ok) return { ...committed,
      code: committed.code === 'draft_revision_required' ? committed.code : 'settings_revision_conflict' };
    return { ok: true, count: keys.length, settings_revision: nextRevision,
      draft_revision: committed.draft_revision };
  }
  const statements = [env.DB.prepare(`UPDATE store_settings_state SET revision=?,updated_at=? WHERE singleton=1 AND revision=?`).bind(nextRevision, timestamp, baseRevision)];
  for (const k of keys) {
    statements.push(env.DB.prepare(`INSERT INTO app_settings (k,v,updated_at)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM store_settings_state WHERE singleton=1 AND revision=?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`)
      .bind(k, settingVal(body[k]), timestamp, nextRevision));
  }
  const committed = await env.DB.batch(statements);
  if (!(committed && committed[0] && committed[0].meta && committed[0].meta.changes === 1)) {
    return { ok: false, status: 409, code: 'settings_revision_conflict', error: '设置已在另一个页面被修改，请刷新后再编辑' };
  }
  return { ok: true, count: keys.length, settings_revision: nextRevision };
}
function cleanPickupPoint(raw, idx, fallback = {}) {
  const p = raw || {};
  const postal = String(p.postal || '').replace(/\D/g, '').slice(0, 6);
  return {
    id: cleanPickupId(p.id || fallback.id, idx),
    active: !(p.active === false || p.active === 0 || p.active === '0'),
    name: String(p.name || p.name_cn || fallback.name || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    name_en: String(p.name_en || fallback.name_en || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    address: String(p.address || fallback.address || (postal ? `S(${postal})` : '')).replace(/\s+/g, ' ').trim().slice(0, 240),
    postal,
    detail: String(p.detail || fallback.detail || '').trim().slice(0, 800),
    photo: cleanPickupPhoto(p.photo || fallback.photo || '', fallback.photo || ''),
  };
}
function pickupPointsFromSettings(s = {}, env = {}) {
  const postal = String(s.SHOP_POSTAL || env.SHOP_POSTAL || '').replace(/\D/g, '').slice(0, 6);
  const main = cleanPickupPoint({ id: 'main', active: s.pickup_enabled !== '0', name: s.shop_name || s.brand_name_cn || s.brand_name_en || DEFAULT_BRAND_CN,
    address: s.shop_address || (postal ? `S(${postal})` : ''), postal, detail: s.shop_pickup_detail || '',
    photo: s.shop_pickup_photo || '' }, 0);
  main.built_in = true;
  const points = [main];
  let extras = [];
  try { extras = JSON.parse(s.pickup_points || '[]'); } catch (e) { extras = []; }
  if (!Array.isArray(extras)) extras = [];
  const seen = new Set(points.map(p => p.id));
  for (let i = 0; i < extras.length; i++) {
    const p = cleanPickupPoint(extras[i], i + 1);
    if (!p.name && !p.address && !p.postal) continue;
    const baseId = (p.id || 'pickup').slice(0, 26);
    let id = p.id, n = 2;
    while (seen.has(id)) id = `${baseId}-${n++}`.slice(0, 32);
    p.id = id; seen.add(id); points.push(p);
  }
  return points;
}
export function pickupPhotoDataResponse(dataUrl, immutable = false) {
  const s = String(dataUrl || '').trim();
  const match = s.match(/^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/]*={0,2})$/i);
  if (!match || pickupPhotoValidationError(s)) return new Response('Not found', { status: 404 });
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const subtype = match[1].toLowerCase();
    return new Response(bytes, { headers: {
      'content-type': subtype === 'jpg' || subtype === 'jpeg' ? 'image/jpeg' : `image/${subtype}`,
      'content-length': String(bytes.byteLength),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    } });
  } catch (e) { return new Response('Not found', { status: 404 }); }
}

const HOMEPAGE_POSTER_MAX_COUNT = 8;
const HOMEPAGE_POSTER_TEXT_LIMITS = { title: 80, body: 360, badge: 32, cta: 60 };
const HOMEPAGE_POSTER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const HOMEPAGE_POSTER_PRODUCT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HOMEPAGE_POSTER_PROMO = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
function posterBool(v, fallback = true) { if (v == null || v === '') return fallback; return !(v === false || v === 0 || v === '0'); }
function posterText(v, limit) { const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim(); return s.length <= limit ? s : null; }
function posterDate(v) {
  const s = String(v || '').trim(); if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? s : null;
}
function posterComparable(p) { return JSON.stringify([p.title_cn,p.title_en,p.body_cn,p.body_en,p.badge,p.image,p.action_type,p.action_value,p.cta_cn,p.cta_en,p.active,p.show_on_open,p.show_on_home,String(p.starts||''),String(p.ends||'')]); }
function posterStoredImage(row) { return String(row && (row.image_data || row.image_url || row.image) || ''); }
function posterPublicImage(row) { const image = posterStoredImage(row); return row && row.image_version ? `/api/poster-image/${encodeURIComponent(row.id)}?v=${encodeURIComponent(row.image_version)}` : image; }
export function homepagePosterPublicProjection(row = {}) {
  return { id:String(row.id||''), title_cn:String(row.title_cn||''), title_en:String(row.title_en||''), body_cn:String(row.body_cn||''), body_en:String(row.body_en||''), badge:String(row.badge||''), image_url:posterPublicImage(row),
    action_type:['product','promo'].includes(row.action_type)?row.action_type:'none', action_value:String(row.action_value||''), cta_cn:String(row.cta_cn||''), cta_en:String(row.cta_en||''),
    show_on_open:posterBool(row.show_on_open), show_on_home:posterBool(row.show_on_home), revision:String(row.updated_at||'') };
}
export function validateHomepagePosterInputs(rawPosters, existingRows = [], timestamp = new Date().toISOString()) {
  if (!Array.isArray(rawPosters)) return { ok:false,status:400,error:'海报资料必须是数组' };
  if (rawPosters.length > HOMEPAGE_POSTER_MAX_COUNT) return { ok:false,status:400,error:`最多可设置 ${HOMEPAGE_POSTER_MAX_COUNT} 张海报` };
  const oldById = new Map(existingRows.map(p => [String(p.id||''), p])), seen = new Set(), posters = [];
  for (let i=0;i<rawPosters.length;i++) {
    const raw=rawPosters[i]||{}, id=String(raw.id||'').trim();
    if (!HOMEPAGE_POSTER_ID.test(id)) return { ok:false,status:400,error:`第 ${i+1} 张海报的 ID 无效（只可用英文、数字、-、_）` };
    if (seen.has(id)) return { ok:false,status:400,error:`海报 ID 重复：${id}` }; seen.add(id);
    const titleCn=posterText(raw.title_cn,80), titleEn=posterText(raw.title_en,80), bodyCn=posterText(raw.body_cn,360), bodyEn=posterText(raw.body_en,360), badge=posterText(raw.badge,32), ctaCn=posterText(raw.cta_cn,60), ctaEn=posterText(raw.cta_en,60);
    if ([titleCn,titleEn,bodyCn,bodyEn,badge,ctaCn,ctaEn].some(x=>x==null)) return { ok:false,status:400,error:`第 ${i+1} 张海报文字过长` };
    if (!titleCn && !titleEn) return { ok:false,status:400,error:`第 ${i+1} 张海报至少要填写一个标题` };
    const actionType=['none','product','promo'].includes(String(raw.action_type||'none'))?String(raw.action_type||'none'):'';
    if (!actionType) return { ok:false,status:400,error:`第 ${i+1} 张海报的点击动作无效` };
    let actionValue=String(raw.action_value||'').trim(); if (actionType==='promo') actionValue=actionValue.toUpperCase();
    if (actionType==='product'&&!HOMEPAGE_POSTER_PRODUCT.test(actionValue)) return { ok:false,status:400,error:`第 ${i+1} 张海报请选择有效商品` };
    if (actionType==='promo'&&!HOMEPAGE_POSTER_PROMO.test(actionValue)) return { ok:false,status:400,error:`第 ${i+1} 张海报请选择有效优惠码` };
    if (actionType==='none') actionValue='';
    const starts=posterDate(raw.starts), ends=posterDate(raw.ends); if (starts==null||ends==null) return { ok:false,status:400,error:`第 ${i+1} 张海报日期格式无效` }; if (starts&&ends&&starts>ends) return { ok:false,status:400,error:`第 ${i+1} 张海报结束日期不能早于开始日期` };
    const old=oldById.get(id)||null; let image=''; const imageData=String(raw.image_data||'').trim(), imageUrl=String(raw.image_url||'').trim();
    if (imageData) { const err=pickupPhotoValidationError(imageData,`第 ${i+1} 张海报图片`); if (err||!/^data:image\//i.test(imageData)) return { ok:false,status:err&&err.includes('过大')?413:400,error:err||`第 ${i+1} 张海报上传图片无效` }; image=imageData; }
    else if (raw.clear_image) image='';
    else if (imageUrl) { if (/^data:/i.test(imageUrl)) return { ok:false,status:400,error:`第 ${i+1} 张海报请通过上传按钮选择图片` }; const err=pickupPhotoValidationError(imageUrl,`第 ${i+1} 张海报图片`); if (err) return { ok:false,status:400,error:err }; image=imageUrl; }
    else if (raw.keep_image&&old) image=posterStoredImage(old);
    const poster={ id,title_cn:titleCn,title_en:titleEn,body_cn:bodyCn,body_en:bodyEn,badge:badge||(actionType==='promo'?actionValue:''),image,image_version:/^data:image\//i.test(image)?pickupPhotoVersion(image):'',action_type:actionType,action_value:actionValue,cta_cn:ctaCn,cta_en:ctaEn,active:posterBool(raw.active)?1:0,show_on_open:posterBool(raw.show_on_open)?1:0,show_on_home:posterBool(raw.show_on_home)?1:0,sort:i*10,starts,ends,created_at:String(old&&old.created_at||timestamp),updated_at:timestamp };
    if (old&&posterComparable(poster)===posterComparable({...old,image:posterStoredImage(old)})) poster.updated_at=String(old.updated_at||timestamp); posters.push(poster);
  }
  return { ok:true,posters };
}
async function posterReferenceSet(env, table, column, values) { if (!values.length) return new Set(); const ph=values.map(()=>'?').join(','); const {results}=await env.DB.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IN (${ph})`).bind(...values).all(); return new Set((results||[]).map(r=>String(r.value||''))); }
export async function saveHomepagePosters(env, rawPosters, timestamp = new Date().toISOString(), expectedRevision = '', draftOptions = null) {
  let existing,stateRevision; try { const cur=await env.DB.prepare('SELECT * FROM homepage_posters ORDER BY sort,created_at,id').all(); existing=cur.results||[]; const state=await env.DB.prepare('SELECT revision FROM homepage_poster_state WHERE singleton=1').first(); stateRevision=String(state&&state.revision||''); if(!stateRevision) throw new Error('missing'); } catch(e) { return {ok:false,status:503,error:'海报功能尚未完成数据库升级'}; }
  if (expectedRevision&&expectedRevision!==stateRevision) return {ok:false,status:409,code:'poster_revision_conflict',error:'海报已在另一个页面被修改，请刷新后再编辑'};
  const checked=validateHomepagePosterInputs(rawPosters,existing,timestamp); if(!checked.ok) return checked;
  const productValues=[...new Set(checked.posters.filter(p=>p.action_type==='product').map(p=>p.action_value))], promoValues=[...new Set(checked.posters.filter(p=>p.action_type==='promo').map(p=>p.action_value))];
  const [products,promos]=await Promise.all([posterReferenceSet(env,'products','sku',productValues),posterReferenceSet(env,'promo_codes','code',promoValues)]);
  const missingProduct=productValues.find(v=>!products.has(v)); if(missingProduct) return {ok:false,status:400,error:`找不到商品：${missingProduct}`};
  const missingPromo=promoValues.find(v=>!promos.has(v)); if(missingPromo) return {ok:false,status:400,error:`找不到优惠码：${missingPromo}`};
  const baseRevision=expectedRevision||stateRevision, nextRevision=`poster-${crypto.randomUUID()}`;
  if (draftOptions) {
    const committed = await commitCollectionDraftMutation(env, {
      collectionStateTable: 'homepage_poster_state', expectedCollectionRevision: baseRevision,
      nextCollectionRevision: nextRevision, expectedDraftRevision: draftOptions.expectedRevision,
      timestamp, action: draftOptions.action || 'homepage_posters_saved',
      detail: { count: checked.posters.length },
      buildStatements: ({ draftRevision, collectionRevision }) => {
        const statements = [env.DB.prepare(`DELETE FROM homepage_posters
          WHERE EXISTS(SELECT 1 FROM homepage_poster_state WHERE singleton=1 AND revision=?)
            AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
          .bind(collectionRevision, draftRevision)];
        for (const p of checked.posters) {
          const uploaded=/^data:image\//i.test(p.image)?p.image:'', external=uploaded?'':p.image;
          statements.push(env.DB.prepare(`INSERT INTO homepage_posters
            (id,title_cn,title_en,body_cn,body_en,badge,image_url,image_data,image_version,action_type,action_value,cta_cn,cta_en,active,show_on_open,show_on_home,sort,starts,ends,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            WHERE EXISTS(SELECT 1 FROM homepage_poster_state WHERE singleton=1 AND revision=?)
              AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
            .bind(p.id,p.title_cn,p.title_en,p.body_cn,p.body_en,p.badge,external,uploaded,p.image_version,
              p.action_type,p.action_value,p.cta_cn,p.cta_en,p.active,p.show_on_open,p.show_on_home,p.sort,
              p.starts||null,p.ends||null,p.created_at,p.updated_at,collectionRevision,draftRevision));
        }
        return statements;
      },
    });
    if (!committed.ok) return { ...committed,
      code: committed.code === 'draft_revision_required' ? committed.code : 'poster_revision_conflict' };
    return {ok:true,count:checked.posters.length,posters:checked.posters.map(homepagePosterPublicProjection),
      collection_revision:nextRevision,draft_revision:committed.draft_revision};
  }
  const statements=[env.DB.prepare('UPDATE homepage_poster_state SET revision=?,updated_at=? WHERE singleton=1 AND revision=?').bind(nextRevision,timestamp,baseRevision),env.DB.prepare('DELETE FROM homepage_posters WHERE EXISTS(SELECT 1 FROM homepage_poster_state WHERE singleton=1 AND revision=?)').bind(nextRevision)];
  for(const p of checked.posters){const uploaded=/^data:image\//i.test(p.image)?p.image:'', external=uploaded?'':p.image; statements.push(env.DB.prepare(`INSERT INTO homepage_posters (id,title_cn,title_en,body_cn,body_en,badge,image_url,image_data,image_version,action_type,action_value,cta_cn,cta_en,active,show_on_open,show_on_home,sort,starts,ends,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM homepage_poster_state WHERE singleton=1 AND revision=?)`).bind(p.id,p.title_cn,p.title_en,p.body_cn,p.body_en,p.badge,external,uploaded,p.image_version,p.action_type,p.action_value,p.cta_cn,p.cta_en,p.active,p.show_on_open,p.show_on_home,p.sort,p.starts||null,p.ends||null,p.created_at,p.updated_at,nextRevision));}
  const committed=await env.DB.batch(statements); if(!(committed&&committed[0]&&committed[0].meta&&committed[0].meta.changes===1)) return {ok:false,status:409,code:'poster_revision_conflict',error:'海报已在另一个页面被修改，请刷新后再编辑'};
  return {ok:true,count:checked.posters.length,posters:checked.posters.map(homepagePosterPublicProjection),collection_revision:nextRevision};
}
async function publicHomepagePosters(env) {
  const today=sgtTodayStr(); try { const {results}=await env.DB.prepare(`SELECT hp.id,hp.title_cn,hp.title_en,hp.body_cn,hp.body_en,hp.badge,hp.image_url,hp.image_version,hp.action_type,hp.action_value,hp.cta_cn,hp.cta_en,hp.show_on_open,hp.show_on_home,hp.updated_at FROM homepage_posters hp LEFT JOIN products pr ON hp.action_type='product' AND pr.sku=hp.action_value LEFT JOIN promo_codes pc ON hp.action_type='promo' AND pc.code=hp.action_value WHERE hp.active=1 AND (hp.starts IS NULL OR hp.starts='' OR hp.starts<=?) AND (hp.ends IS NULL OR hp.ends='' OR hp.ends>=?) AND (hp.action_type!='product' OR (pr.sku IS NOT NULL AND pr.active=1)) AND (hp.action_type!='promo' OR (pc.code IS NOT NULL AND pc.active=1 AND (pc.starts IS NULL OR pc.starts='' OR pc.starts<=?) AND (pc.ends IS NULL OR pc.ends='' OR pc.ends>=?) AND (pc.max_uses IS NULL OR pc.max_uses=0 OR pc.used<pc.max_uses))) ORDER BY hp.sort,hp.created_at,hp.id LIMIT ?`).bind(today,today,today,today,HOMEPAGE_POSTER_MAX_COUNT).all(); return (results||[]).map(homepagePosterPublicProjection); } catch(e) { return []; }
}
function pickupSnapshot(point) { if(!point) return null; const name=point.name||point.name_en||'自取点', addr=point.address||(point.postal?`S(${point.postal})`:''); return [name,addr].filter(Boolean).join(' · ')||name; }
function stripPickupNameFromSnapshot(point,snapshot) { const s=String(snapshot||'').trim(),name=String(point&&(point.name||point.name_en)||'').trim(); return name&&s.startsWith(name+' · ')?s.slice(name.length+3).trim():s; }
// 顾客看到的价、税、服务费必须来自【同一个发布】。老板改了草稿但没发布时，
// app_settings 已经变了而顾客页面还是旧发布 —— 用 app_settings 结账就会
// 「看到一个价、被扣另一个价」。所以成交一律用 quote.release_rules。
function pricingConfigFromReleaseRules(rules = {}) {
  return {
    gst_registered: !!rules.gst_registered,
    gst_rate: saneRate(rules.gst_rate, 9, 20),
    service_charge_enabled: !!rules.service_charge_enabled,
    service_charge_rate: saneRate(rules.service_charge_rate, 10, 30),
  };
}
function pricingConfigFromSettings(s = {}) {
  return {
    gst_registered: s.gst_registered === '1',
    gst_rate: saneRate(s.gst_rate, 9, 20),
    service_charge_enabled: s.service_charge_enabled === '1',
    service_charge_rate: saneRate(s.service_charge_rate, 10, 30),
  };
}
function computeOrderTotals(subtotal, deliveryFee, discount, pricing) {
  // 优惠封顶在这里也做一次：checkPromo 里那道 Math.min 是上游防线，但订单上【记下来】的
  // discount 若超过小计，报表和对账就会出现「优惠 999 / 小计 20」这种自相矛盾的行。
  // 金额只在这一个函数里定稿，封顶就该跟着定稿走。
  const discountApplied = Math.min(money(discount), money(subtotal));
  discount = discountApplied;
  const goods = Math.max(0, money(subtotal) - money(discount));
  const delivery = money(deliveryFee);
  const service_charge = pricing.service_charge_enabled ? money(goods * pricing.service_charge_rate / 100) : 0;
  const taxable = money(goods + delivery + service_charge);
  const gst = pricing.gst_registered ? money(taxable * pricing.gst_rate / 100) : 0;
  return {
    goods,
    delivery_fee: delivery,
    discount: money(discount),
    service_charge,
    service_charge_rate: pricing.service_charge_enabled ? pricing.service_charge_rate : 0,
    gst,
    gst_rate: pricing.gst_registered ? pricing.gst_rate : 0,
    gst_registered: pricing.gst_registered ? 1 : 0,
    total: money(taxable + gst),
  };
}
function balanceEligibleTotal(subtotal, discount, pricing) {
  // Stored value is shop credit. Do not let it cover courier/Lalamove delivery
  // money; if GST is enabled, the delivery-fee GST also stays in due_now.
  return computeOrderTotals(subtotal, 0, discount, pricing).total;
}
// normalize raw app_settings rows into the shape the UI + order endpoint consume.
// Defaults: store OPEN, pickup + delivery ON, fee = env.DELIVERY_FEE or S$4.
function publicConfig(env, s) {
  const feeDefault = env.DELIVERY_FEE ? +env.DELIVERY_FEE : 4;
  const points = pickupPointsFromSettings(s, env);
  const publicPoints = points.filter(p => p.active).map(p => ({
    ...p,
    photo: pickupPhotoPublicUrl(p),
    ...(p.id === 'main' ? { address_en: s.shop_address_en || '', detail_en: s.shop_pickup_detail_en || '' } : {}),
  }));
  return {
    store_open: s.store_open !== '0',          // open unless explicitly '0'
    store_closed_msg: s.store_closed_msg || '',
    pickup_enabled: publicPoints.length > 0,
    delivery: {
      enabled: s.delivery_enabled !== '0',
      fee: (s.delivery_fee != null && s.delivery_fee !== '') ? +s.delivery_fee : feeDefault,
      min: +s.delivery_min || 0,               // minimum subtotal to allow delivery (0 = none)
      free_above: +s.delivery_free_above || 0, // free delivery at/above this subtotal (0 = off)
      note: s.delivery_note || '',
      areas: s.delivery_areas || '',
    },
    // boss-configurable branding — empty value means "use the storefront built-in default"
    brand: {
      logo: s.brand_logo || '',
      name_cn: s.brand_name_cn || '', name_en: s.brand_name_en || '',
      slogan_cn: s.brand_slogan_cn || '', slogan_en: s.brand_slogan_en || '',
      color_primary: s.brand_color_primary || '', color_secondary: s.brand_color_secondary || '',
      color_bg: s.brand_color_bg || '', color_accent: s.brand_color_accent || '',
    },
    // 退款时限（天）：boss 端可设、/api/config 实时下发给 about.html（0/留空 = 尽快）
    refund_max_days: +s.refund_max_days || 0,
    // 营业时间（boss 可配）+ 当前 SGT 是否在营业中。顾客端据此显示并锁下单。
    business_hours: (() => { const h = parseBusinessHours(s.business_hours); const w = withinBusinessHours(h); return { schedule: h, open_now: w.open, today: w.today, dow: sgtNowParts().dow }; })(),
    // 店面信息（boss 可配）：自取顾客看的店名 + 取货地址
    shop: { name: s.shop_name || '', address: s.shop_address || (s.SHOP_POSTAL ? `S(${s.SHOP_POSTAL})` : ''),
      detail: s.shop_pickup_detail || '', postal: s.SHOP_POSTAL || '', photo: s.shop_pickup_photo || '',
      // 英文版留空就回落中文——宁可显示中文，也不要显示空白
      address_en: s.shop_address_en || '', detail_en: s.shop_pickup_detail_en || '', points: publicPoints },
    contact: publicContact(s.shop_contact_phone),
    // 自取备货时长（分钟）：预计可取 = 下单时间 + 此值。默认 20，老板后台可改。
    // 钳制 [0,180]：防负值(早于下单的 ETA)/超大值，绕过前端 min/max 直打 API 也拦住。
    prep_time_min: Math.min(180, Math.max(0, +s.prep_time_min || 20)),
    pricing: pricingConfigFromSettings(s),
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

function invoiceNo(now, seq) {
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return `ORD-${d}-${String(seq).padStart(4, '0')}`;
}

function uuid() { return crypto.randomUUID(); }

function normPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  // This Singapore storefront stores local mobile numbers in one canonical
  // 8-digit form, so "80000002" and "+65 8000 0002" cannot be claimed by
  // different accounts. International numbers remain E.164 digits.
  return digits.length === 10 && digits.startsWith('65') ? digits.slice(2) : digits;
}
function e164Phone(p) {
  const digits = normPhone(p);
  return digits.length === 8 ? '65' + digits : digits;
}
function cleanDateOnly(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s ? s : false;
}
function cleanAdminNote(v) {
  return String(v == null ? '' : v)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 500) || null;
}
function cleanMemberEmail(v) {
  const email = String(v == null ? '' : v).trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  return email;
}
function memberTier(spent) {
  return spent >= 500 ? '钻石 Diamond' : spent >= 200 ? '金卡 Gold' : spent >= 50 ? '银卡 Silver' : '新会员 New';
}
async function accountByPhone(env, phone) {
  const p = normPhone(phone);
  if (!p) return null;
  return env.DB.prepare(`SELECT ua.id AS user_id,ua.phone,ua.name,m.balance,m.points,m.total_spent,m.orders_count,m.archived_at
    FROM user_accounts ua LEFT JOIN members m ON m.user_id=ua.id WHERE ua.phone=?`).bind(p).first();
}
// Accrue loyalty points when an order is first confirmed paid (1 pt per S$1).
async function accruePoints(env, order) {
  if (!order.user_id) return;   // guest orders do not create/claim an account by phone
  const pts = Math.floor(order.total);
  const ts = new Date().toISOString();
  await ensureUserLedger(env, order.user_id, ts);
  await env.DB.prepare(`UPDATE members SET points=points+?, total_spent=total_spent+?, orders_count=orders_count+1, updated_at=? WHERE user_id=?`)
    .bind(pts, order.total, ts, order.user_id).run();
}
// reverse loyalty on refund (keeps points honest — "钱的事情不要玩玩")
// already = 之前的部分退款（目前只有退运费）已经扣掉的积分/消费额，避免重复扣。
// 默认值保证所有旧调用点行为完全不变。
async function reversePoints(env, order, already = { pts: 0, amount: 0 }) {
  const pts = Math.max(0, Math.floor(order.total) - (+already.pts || 0));
  const spent = Math.max(0, +(order.total - (+already.amount || 0)).toFixed(2));
  if (order.user_id) {
    await env.DB.prepare("UPDATE members SET points=MAX(0,points-?), total_spent=MAX(0,total_spent-?), orders_count=MAX(0,orders_count-1), updated_at=? WHERE user_id=?")
      .bind(pts, spent, new Date().toISOString(), order.user_id).run();
    return;
  }
  // Legacy orders created before account ids existed retain their original
  // phone-ledger reversal behavior.
  const phone = normPhone(order.phone); if (!phone) return;
  await env.DB.prepare("UPDATE members SET points=MAX(0,points-?), total_spent=MAX(0,total_spent-?), orders_count=MAX(0,orders_count-1), updated_at=? WHERE phone=? AND user_id IS NULL")
    .bind(pts, spent, new Date().toISOString(), phone).run();
}
// ===== 老板手动调整会员余额 =====
// 这个能力上一版重写时丢了 —— 生产 wallet_events 里那 16 笔 type='adjustment'（合计 −967.10）
// 就是老板以前用它扣的，功能没了之后他既扣不了款、也看不懂台账里那笔差额是哪来的。
// 身份优先按 user_id（账号模型的主键），没有账号的 legacy 会员才按 8 位手机号。
async function adjustMemberBalance(env, body, actor) {
  const amount = +(+body.amount).toFixed(2);
  const action = body.action === 'subtract' ? 'subtract' : (body.action === 'add' ? 'add' : '');
  const clientToken = String(body.client_token || '').trim();
  if (!action || !(amount > 0)) return { error: '请选择加/减并填写大于 0 的金额', _status: 400 };
  if (!clientToken) return { error: '缺少幂等令牌 client_token', _status: 400 };

  const userId = String(body.user_id || '').trim() || null;
  const phone = userId ? null : normPhone(body.phone);
  if (!userId && (!phone || phone.length < 6)) return { error: '请提供会员手机号或账号', _status: 400 };
  const where = userId ? 'user_id=?' : 'phone=? AND user_id IS NULL';
  const key = userId || phone;

  // 幂等：同 client_token 只调一次（防双击/网络重试把钱扣两遍）
  const ref = 'balance_adjust:' + clientToken.slice(0, 80);
  const dupOf = async () => env.DB.prepare("SELECT phone,user_id,amount FROM wallet_events WHERE type='adjustment' AND ref=?").bind(ref).first();
  const cur = () => env.DB.prepare(`SELECT balance,name FROM members WHERE ${where}`).bind(key).first();
  const dup = await dupOf();
  if (dup) {
    // 令牌必须绑回同一个人，否则换个人复用同一令牌会拿到假成功
    const same = userId ? dup.user_id === userId : (dup.phone === phone && !dup.user_id);
    if (!same) return { error: '这个幂等令牌已经用在另一位会员上了，请重新发起', code: 'client_token_conflict', _status: 409 };
    const m = await cur();
    return { ok: true, deduped: true, delta: +dup.amount, amount: Math.abs(+dup.amount),
      balance: +(+(m && m.balance || 0)).toFixed(2) };
  }

  const existing = await cur();
  if (!existing) return { error: '找不到这位会员', _status: 404 };
  const before = +(+(existing.balance || 0)).toFixed(2);
  const delta = action === 'subtract' ? -amount : amount;
  // 余额不许扣成负数：储值是店里欠顾客的钱，扣穿了账就成了负债倒挂
  if (delta < 0 && before < amount) {
    return { error: `会员余额不足：当前 S$${before.toFixed(2)}，不能扣 S$${amount.toFixed(2)}`, _status: 400, balance: before };
  }
  const ts = new Date().toISOString();
  const note = String(body.note || '').trim().slice(0, 240)
    || (action === 'add' ? '老板手动增加余额' : '老板手动减少余额');
  let res;
  try {
    res = await env.DB.batch([
      // 条件门写进 SQL：并发下同一时刻另一笔扣款把余额扣走了，这条就不会成功
      env.DB.prepare(`UPDATE members SET balance=round(COALESCE(balance,0)+?,2), updated_at=?
         WHERE ${where} AND (? >= 0 OR COALESCE(balance,0) >= ?)`).bind(delta, ts, key, delta, amount),
      // 流水挂在 ① 成功之上（wallet_events.ref 有 UNIQUE，再叠一层防重）
      env.DB.prepare(`INSERT INTO wallet_events(id,type,ref,order_id,phone,user_id,amount,created_at,note)
        SELECT ?, 'adjustment', ?, NULL, ?, ?, ?, ?, ?
        WHERE EXISTS(SELECT 1 FROM members WHERE ${where} AND updated_at=?)`)
        .bind(crypto.randomUUID(), ref, existing.phone || phone || null, userId,
          delta, ts, `${note}（操作人 ${actor || 'boss'}）`, key, ts),
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e.message || '')) {
      const d2 = await dupOf();
      if (d2) { const m = await cur(); return { ok: true, deduped: true, delta: +d2.amount, amount: Math.abs(+d2.amount), balance: +(+(m && m.balance || 0)).toFixed(2) }; }
    }
    throw e;
  }
  const okWrite = res && res[0] && res[0].meta && res[0].meta.changes > 0 && res[1] && res[1].meta && res[1].meta.changes > 0;
  const m = await cur();
  if (!okWrite) return { error: '余额调整未生效（可能被并发改动），请刷新后重试', _status: 409, balance: +(+(m && m.balance || 0)).toFixed(2) };
  return { ok: true, delta, amount, note, name: (m && m.name) || null,
    balance_before: before, balance: +(+(m && m.balance || 0)).toFixed(2) };
}

// 这单已经通过退款引擎退掉的、【非整单】的部分（目前只有退运费）。
// charge.refunded 用它把「Stripe 上累计退了多少」还原成「货款到底退没退」。
async function partialRefundTally(env, orderId) {
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) amt, COALESCE(SUM(stripe_amount),0) st, COALESCE(SUM(balance_amount),0) bal
     FROM order_refunds WHERE order_id=? AND status='succeeded' AND kind<>'full'`
  ).bind(orderId).first().catch(() => null);
  return {
    amount: +(+((r && r.amt) || 0)).toFixed(2),
    stripe: +(+((r && r.st) || 0)).toFixed(2),
    balance: +(+((r && r.bal) || 0)).toFixed(2),
  };
}
// ----- stored-value top-up + promo codes -----
// 充多少送多少 tiers — live in D1 app_settings('TOPUP_TIERS') overriding env, so the boss
// edits them from the admin panel with NO redeploy. Stored as JSON [[amount,bonus],...].
const TOPUP_TIERS_DEFAULT = [[500, 80], [200, 25], [100, 10], [50, 3]];
function parseTiers(raw) {
  let tiers = TOPUP_TIERS_DEFAULT;
  try { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) tiers = p; } catch (e) {}
  // sanitize (deterministic, no LLM): numeric [amount,bonus], amount>0, bonus>=0
  tiers = tiers.map(t => [Number(t && t[0]), Number(t && t[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b >= 0);
  return tiers.length ? tiers : TOPUP_TIERS_DEFAULT.slice();
}
async function topupTiers(env) {                       // app_settings overrides env
  return parseTiers(await setting(env, 'TOPUP_TIERS'));
}
async function topupBonus(env, amount) {
  const tiers = (await topupTiers(env)).slice().sort((a, b) => b[0] - a[0]);  // highest matching tier wins
  for (const [a, b] of tiers) if (amount >= a) return b;
  return 0;
}
// ---- 柜台充值的手机号护栏（只给 /api/admin/topup 与 /api/pos/topup 用；Stripe 线上充值不走这里）----
// 修前：normPhone 只删非数字，手机号 "1" 也能建出会员并立即入账真金；`["91234567"]` 也会被
// String() 成合法号收下。生产 members 实测全是 8 位，无例外。
function sgCounterPhone(raw) {                       // 新加坡手机：8 位 8/9 开头，或 65+8 位
  if (typeof raw !== 'string') return null;          // 严格类型：array/object/number 一律非法
  const d = normPhone(raw);
  if (/^[89]\d{7}$/.test(d)) return { local: d, intl: '65' + d, typed: d };
  if (/^65[89]\d{7}$/.test(d)) return { local: d.slice(2), intl: d, typed: d };
  return null;
}
// 同号判定：8 位与 65+8 位是同一个人。非 SG 形态（历史脏数据）退回纯数字串比较。
function sgIdentity(raw) {
  if (typeof raw !== 'string') return null;
  const c = sgCounterPhone(raw);
  return c ? c.intl : (normPhone(raw) || null);
}
// 幂等令牌只对「同一笔操作」有效：同身份 + 同金额 + 同渠道。
// 少比一处就会出现「收了 B 的现金、屏幕显示成功、钱进了 A 的账」。
// A 是 user_accounts 账号模型，user_id 才是身份主键：两边都有 user_id → 只比 user_id
// （账号可以改手机号，只比 phone 会把合法重放误判成冲突）；都没有 → 退回 phone 比对；
// 一边有一边没有 → 直接判定不是同一笔（fail closed）。
function sameTopupOp(prev, { userId = null, phone = null, amount, payMethod }) {
  if (!prev) return false;
  if (+(+prev.amount).toFixed(2) !== +(+amount).toFixed(2)) return false;
  if ((prev.pay_method || 'cash') !== (payMethod || 'cash')) return false;
  const prevUid = prev.user_id || null;
  if (prevUid || userId) return !!prevUid && prevUid === userId;
  const was = sgIdentity(typeof prev.phone === 'string' ? prev.phone : null);
  const now = sgIdentity(typeof phone === 'string' ? phone : null);
  return !!was && was === now;
}
// 一律不回原会员任何信息（防拿令牌探测别人的姓名/余额）
const tokenConflict = () => ({ error: '这个幂等令牌已经用在另一笔充值上了，请重新发起本笔充值', code: 'client_token_conflict', _status: 409 });

async function creditTopup(env, phone, amount, payMethod, cashier, note, clientToken, userId = null, profile = null) {
  let p = normPhone(phone); amount = +(+amount).toFixed(2);
  const profileName = String(profile && profile.name || '').trim().slice(0, 80) || null;
  const profileEmail = cleanMemberEmail(profile && profile.email);
  if (userId) {
    const ua = await env.DB.prepare('SELECT phone FROM user_accounts WHERE id=?').bind(userId).first();
    if (!ua) return { error: 'member not found', _status: 404 };
    p = ua.phone || p || '';
  }
  if ((!userId && !p) || !(amount > 0)) return { error: 'bad topup', _status: 400 };
  // 合并过的号：钱必须进【新账号】，绝不能再记进墓碑行。
  // 不做这一步，店员在同一个号上充值时下面的 `ON CONFLICT(phone) DO UPDATE SET balance=balance+?`
  // 会把新充的钱加回那条已清零的 legacy 行，顾客登录后照样看不见——合并等于白做。
  if (!userId && p) {
    const tomb = await env.DB.prepare('SELECT merged_to_user_id FROM members WHERE phone=? AND user_id IS NULL')
      .bind(p).first().catch(() => null);
    if (tomb && tomb.merged_to_user_id) userId = tomb.merged_to_user_id;
  }
  const balanceRow = () => userId
    ? env.DB.prepare('SELECT balance FROM members WHERE user_id=?').bind(userId).first()
    : env.DB.prepare('SELECT balance FROM members WHERE phone=? AND user_id IS NULL').bind(p).first();
  // 幂等：同 client_token 已入账 → 返回已有结果，绝不重复入账（防双击/网络重试双记真金负债）。
  // 但令牌必须绑回原操作（sameTopupOp：同身份 + 同金额 + 同渠道），否则「同 token 换个人/换金额」
  // 会拿到 200 假成功：收银员收了 B 的现金、屏幕显示成功、钱进了 A 的账。
  if (clientToken) {
    const dup = await env.DB.prepare('SELECT user_id,phone,amount,bonus,credited,pay_method FROM topups WHERE client_token=?').bind(clientToken).first();
    if (dup) {
      if (!sameTopupOp(dup, { userId, phone: p, amount, payMethod })) return tokenConflict();
      const mm = await balanceRow();
      return { ok: true, user_id: userId, phone: p, amount: dup.amount, bonus: dup.bonus, credited: dup.credited, balance: mm && mm.balance, deduped: true };
    }
  }
  const bonus = await topupBonus(env, amount), credited = +(amount + bonus).toFixed(2), ts = new Date().toISOString();
  // 原子：余额入账 + 充值流水写在一个 batch 事务里，任一步失败整体 rollback。
  // 这样 webhook 出错删令牌让 Stripe 重投时，重试只会成功一次（首次失败已整体回滚），杜绝重复入账。
  try {
    const writes = userId ? [
      env.DB.prepare('INSERT OR IGNORE INTO members(phone,user_id,created_at,updated_at) VALUES (?,?,?,?)').bind('account:' + userId, userId, ts, ts),
      env.DB.prepare('UPDATE members SET balance=round(balance+?,2), updated_at=? WHERE user_id=?').bind(credited, ts, userId),
      env.DB.prepare(`INSERT INTO topups (id,phone,user_id,amount,bonus,credited,pay_method,pay_status,cashier,created_at,note,client_token)
        VALUES (?,?,?,?,?,?,?, 'PAID',?,?,?,?)`).bind(crypto.randomUUID(), p, userId, amount, bonus, credited, payMethod || 'cash', cashier || null, ts, note || null, clientToken || null),
    ] : [
      // 柜台第一次给老顾客充值就是在建档：姓名 / Email 必须和余额在同一个 batch 落库。
      // 已有档案只补空白资料，不用充值动作静默覆盖老板之前维护过的姓名或 Email。
      env.DB.prepare(`INSERT INTO members (phone,name,email,balance,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(phone) DO UPDATE SET balance=round(balance+?,2),
          name=COALESCE(NULLIF(members.name,''),excluded.name),
          email=COALESCE(NULLIF(members.email,''),excluded.email),updated_at=?`)
        .bind(p, profileName, profileEmail || null, credited, ts, ts, credited, ts),
      env.DB.prepare(`INSERT INTO topups (id,phone,user_id,amount,bonus,credited,pay_method,pay_status,cashier,created_at,note,client_token)
        VALUES (?,?,NULL,?,?,?,?, 'PAID',?,?,?,?)`).bind(crypto.randomUUID(), p, amount, bonus, credited, payMethod || 'cash', cashier || null, ts, note || null, clientToken || null),
    ];
    await env.DB.batch(writes);
  } catch (e) {
    // 并发同 client_token → topups UNIQUE 冲突 → 整个 batch 回滚（余额未变）→ 查已有返回，保持幂等。
    // ⚠️ 这条是并发时输掉竞争的那一路走的后门：这里同样必须 sameTopupOp，否则
    // 「两路同 token 但不同人/不同金额并发打进来」时，输的那一路会拿到 200 假成功（钱一分没进）。
    if (clientToken && /UNIQUE|constraint/i.test(e.message || '')) {
      const dup = await env.DB.prepare('SELECT user_id,phone,amount,bonus,credited,pay_method FROM topups WHERE client_token=?').bind(clientToken).first();
      if (dup) {
        if (!sameTopupOp(dup, { userId, phone: p, amount, payMethod })) return tokenConflict();
        const mm = await balanceRow();
        return { ok: true, user_id: userId, phone: p, amount: dup.amount, bonus: dup.bonus, credited: dup.credited, balance: mm && mm.balance, deduped: true };
      }
    }
    throw e;
  }
  const m = await balanceRow();
  return { ok: true, user_id: userId, phone: p, amount, bonus, credited, balance: m && m.balance };
}
async function checkPromo(env, code, subtotal, fulfilment, phone, authed, userId = null) {
  if (!code) return { discount: 0 };
  const c = await env.DB.prepare('SELECT * FROM promo_codes WHERE code=? AND active=1').bind(String(code).trim().toUpperCase()).first();
  if (!c) return { error: '优惠码无效 Invalid code' };
  const today = sgtTodayStr();   // 优惠码起止按 SGT 营业日判断（老板按新加坡日期设码）
  if (c.starts && today < c.starts) return { error: '优惠码未开始 Not yet active' };
  if (c.ends && today > c.ends) return { error: '优惠码已过期 Expired' };
  if (c.max_uses && c.used >= c.max_uses) return { error: '优惠码已用完 Fully redeemed' };
  // 登录用户按稳定 user_id 限次；游客/POS 才退回手机号口径。
  if (c.per_account_limit > 0 && (userId || phone)) {
    let u = null;
    if (userId) {
      u = await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE promo_code=? AND user_id=? AND pay_status != 'CANCELLED'").bind(c.code, userId).first();
    } else {
      const p8 = String(phone).replace(/\D/g, '').slice(-8);
      if (p8.length === 8) u = await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE promo_code=? AND user_id IS NULL AND substr(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),-8)=? AND pay_status != 'CANCELLED'").bind(c.code, p8).first();
    }
    if (u && u.n >= c.per_account_limit) return { error: `此优惠码每账号限用 ${c.per_account_limit} 次，您已用完 · Per-account use limit reached` };
  }
  // 仅限自取码（旧维度，兼容保留）：配送/随时送单不可用。fulfilment 缺省(undefined)不拦，仅显式传非 pickup 才拦。
  if (c.pickup_only && fulfilment && fulfilment !== 'pickup') return { error: '此优惠码仅限自取 Pickup-only code' };
  // 适用方式限制（通用·可多选）：pickup=自取 / discount=拼单顺路送 / anytime=自费随时送。逗号分隔集合；''=不限。缺省 fulfilment 不拦（预览时）。
  if (c.fulfil_only && fulfilment) {
    const FN = { pickup: '自取 Pickup', discount: '拼单顺路送 Group-buy', anytime: '自费随时送 Anytime', walkin: '到店/POS Walk-in' };
    const allowed = c.fulfil_only.split(',').map(s => s.trim()).filter(Boolean);   // 允许的方式集合
    if (allowed.length && !allowed.includes(fulfilment)) {
      return { error: `此优惠码仅限「${allowed.map(x => FN[x] || x).join('、')}」使用 · code limited to ${allowed.join('/')}` };
    }
  }
  // 需登录会员：游客不可用（authed 由调用方验 session 后传入）。
  if (c.login_required && !authed) return { error: '此优惠码需登录会员后使用 · Members only — please log in' };
  // 登录用户首单按 user_id；游客/POS 才退回手机号口径。
  if (c.first_order_only && (userId || phone)) {
    let o = null;
    if (userId) {
      o = await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE user_id=? AND pay_status != 'CANCELLED'").bind(userId).first();
    } else {
      const p8 = String(phone).replace(/\D/g, '').slice(-8);
      if (p8.length === 8) o = await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE user_id IS NULL AND substr(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),-8)=? AND pay_status != 'CANCELLED'").bind(p8).first();
    }
    if (o && o.n > 0) return { error: '此优惠码仅限首单使用 · First-order only' };
  }
  if (subtotal < (c.min_spend || 0)) return { error: `需满 S$${(c.min_spend || 0).toFixed(2)} Min spend` };
  let discount = c.kind === 'percent' ? subtotal * c.value / 100 : c.value;
  discount = Math.min(+discount.toFixed(2), subtotal);
  return { discount, code: c.code, kind: c.kind, value: c.value, pickup_only: !!c.pickup_only, per_account_limit: c.per_account_limit || 0, fulfil_only: c.fulfil_only || '', first_order_only: !!c.first_order_only, login_required: !!c.login_required };
}

async function claimPromoUse(env, code) {
  if (!code) return { ok: false };
  const cl = await env.DB.prepare('UPDATE promo_codes SET used=used+1 WHERE code=? AND (max_uses IS NULL OR max_uses=0 OR used<max_uses)')
    .bind(code).run();
  if (!(cl.meta && cl.meta.changes > 0)) return { ok: false, error: '优惠码刚刚被用完，请移除优惠码后重试 · Promo code just sold out' };
  return { ok: true };
}
async function releasePromoUse(env, code) {
  if (!code) return false;
  await env.DB.prepare('UPDATE promo_codes SET used=MAX(0,used-1) WHERE code=?').bind(code).run();
  return true;
}
async function releasePromoForOrder(env, orderId, code) {
  if (!orderId || !code) return false;
  const cl = await env.DB.prepare('UPDATE orders SET promo_claimed=0 WHERE id=? AND promo_claimed=1')
    .bind(orderId).run();
  if (cl.meta && cl.meta.changes > 0) {
    await releasePromoUse(env, code);
    return true;
  }
  return false;
}

// ----- member authentication (password / session / OTP) -----
function _hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function _unhex(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
async function _hmac(secret, msg) {
  if (!secret) throw new Error('AUTH_SECRET not configured — refusing to sign/verify with empty key');   // 显式 fail-closed，不依赖 WebCrypto 对零长度 key 抛错的实现细节
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return _hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
async function _sha256Hex(msg) { return _hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg))); }
async function hashPassword(password, saltHex) {
  const salt = saltHex ? _unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, k, 256);
  return { hash: _hex(bits), salt: _hex(salt) };
}
// constant-time-ish compare
function _eq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function _b64urlBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function _b64urlText(s) { return _b64urlBytes(new TextEncoder().encode(String(s))); }
function _b64urlJson(v) { return _b64urlText(JSON.stringify(v)); }
function _b64urlDecode(s) {
  const raw = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s || '').length + 3) % 4));
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}
function _jwtParts(token) {
  const p = String(token || '').split('.');
  if (p.length !== 3) throw new Error('bad jwt');
  const text = (s) => new TextDecoder().decode(_b64urlDecode(s));
  return { header: JSON.parse(text(p[0])), payload: JSON.parse(text(p[1])), signed: new TextEncoder().encode(p[0] + '.' + p[1]), signature: _b64urlDecode(p[2]) };
}
function _randomToken(n = 32) { return _b64urlBytes(crypto.getRandomValues(new Uint8Array(n))); }
function _bearer(req) { return (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''); }
function _cookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// Member sessions carry only the stable internal user id. Phone is deliberately
// absent: it is an optional contact field and can be edited without changing
// account ownership or invalidating the session.
async function signSession(env, userId) {
  const payload = _b64urlJson({ v: 2, u: userId, exp: Date.now() + 30 * 864e5 });
  return payload + '.' + await _hmac(env.AUTH_SECRET, payload);
}
async function verifySession(env, token) {
  if (!token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  if (!_eq(await _hmac(env.AUTH_SECRET, payload), sig)) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(_b64urlDecode(payload)));
    if (d.v !== 2 || !d.u || d.exp < Date.now()) return null;
    return d.u;
  } catch (e) { return null; }
}
function genOtp() { return String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)); }

async function verifyOidcIdToken(idToken, { jwksUrl, audience, issuers, nonce }) {
  const jwt = _jwtParts(idToken);
  if (jwt.header.alg !== 'RS256' || !jwt.header.kid) throw new Error('unsupported jwt');
  const jr = await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) });
  if (!jr.ok) throw new Error('jwks unavailable');
  const jwks = await jr.json();
  const jwk = (jwks.keys || []).find(k => k.kid === jwt.header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, jwt.signed)) throw new Error('bad signature');
  const p = jwt.payload, aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(audience)) throw new Error('aud mismatch');
  if (p.azp && p.azp !== audience) throw new Error('azp mismatch');
  if (!issuers.includes(p.iss)) throw new Error('iss mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (!p.exp || p.exp < now || (p.iat && p.iat > now + 300) || (p.nbf && p.nbf > now + 300)) throw new Error('expired');
  if (nonce && p.nonce !== nonce) throw new Error('nonce mismatch');
  if (!p.sub) throw new Error('missing subject');
  return p;
}
async function verifyGoogleIdToken(env, idToken, nonce) {
  const p = await verifyOidcIdToken(idToken, {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', audience: env.GOOGLE_CLIENT_ID,
    issuers: ['accounts.google.com', 'https://accounts.google.com'], nonce,
  });
  if (p.email_verified === false || p.email_verified === 'false') throw new Error('email not verified');
  return p;
}
async function verifyAppleIdToken(env, idToken, nonce) {
  return verifyOidcIdToken(idToken, {
    jwksUrl: 'https://appleid.apple.com/auth/keys', audience: env.APPLE_CLIENT_ID,
    issuers: ['https://appleid.apple.com'], nonce,
  });
}

function _pemPkcs8(pem) {
  const b64 = String(pem || '').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  if (!b64) throw new Error('APPLE_PRIVATE_KEY not configured');
  const raw = atob(b64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0))).buffer;
}
async function appleClientSecret(env) {
  if (!env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_CLIENT_ID) throw new Error('Apple OAuth not configured');
  const now = Math.floor(Date.now() / 1000);
  const head = _b64urlJson({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' });
  const body = _b64urlJson({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 30 * 86400, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID });
  const input = head + '.' + body;
  const key = await crypto.subtle.importKey('pkcs8', _pemPkcs8(env.APPLE_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return input + '.' + _b64urlBytes(new Uint8Array(sig));
}

const OAUTH_COOKIE = '__Host-hl_oauth';
function oauthCookie(value, maxAge = 600) {
  return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
}
function redirectWithCookie(location, cookie) {
  return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie } });
}
async function oauthStart(env, provider, userId, origin) {
  if (!['google', 'apple'].includes(provider)) throw new Error('bad provider');
  if (provider === 'google' && !env.GOOGLE_CLIENT_ID) throw new Error('Google OAuth not configured');
  if (provider === 'apple' && !env.APPLE_CLIENT_ID) throw new Error('Apple OAuth not configured');
  const state = _randomToken(), nonce = _randomToken();
  const stateHash = await _sha256Hex(state), now = new Date();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(now.toISOString()),
    env.DB.prepare(`INSERT INTO oauth_states(state_hash,provider,user_id,nonce,origin,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(stateHash, provider, userId || null, nonce, origin, new Date(now.getTime() + 10 * 60000).toISOString(), now.toISOString()),
  ]);
  let auth;
  if (provider === 'google') {
    auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', `${origin}/api/auth/google/callback`);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'openid email profile');
    auth.searchParams.set('access_type', 'online');
  } else {
    auth = new URL('https://appleid.apple.com/auth/authorize');
    auth.searchParams.set('client_id', env.APPLE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', `${origin}/api/auth/apple/callback`);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('response_mode', 'form_post');
    auth.searchParams.set('scope', 'name email');
  }
  auth.searchParams.set('state', state);
  auth.searchParams.set('nonce', nonce);
  return { url: auth.toString(), cookie: oauthCookie(state) };
}
async function consumeOAuthState(env, req, provider, state) {
  if (!state || _cookie(req, OAUTH_COOKIE) !== state) return null;
  return env.DB.prepare(`DELETE FROM oauth_states
    WHERE state_hash=? AND provider=? AND expires_at>?
    RETURNING user_id,nonce,origin`).bind(await _sha256Hex(state), provider, new Date().toISOString()).first();
}
function oauthFinish(origin, fragment) {
  return redirectWithCookie(`${origin}/#${fragment}`, oauthCookie('', 0));
}
async function ensureUserLedger(env, userId, ts = new Date().toISOString()) {
  await env.DB.prepare(`INSERT OR IGNORE INTO members(phone,user_id,created_at,updated_at) VALUES (?,?,?,?)`)
    .bind('account:' + userId, userId, ts, ts).run();
}
async function completeOAuthIdentity(env, provider, identity, bindUserId) {
  const now = new Date().toISOString();
  const owner = await env.DB.prepare('SELECT user_id FROM auth_identities WHERE provider=? AND provider_sub=?')
    .bind(provider, identity.sub).first();
  if (bindUserId) {
    if (owner && owner.user_id !== bindUserId) return { error: 'identity_in_use' };
    const current = await env.DB.prepare('SELECT provider_sub FROM auth_identities WHERE user_id=? AND provider=?')
      .bind(bindUserId, provider).first();
    if (current && current.provider_sub !== identity.sub) return { error: 'provider_already_linked' };
    await env.DB.prepare(`INSERT INTO auth_identities(provider,provider_sub,user_id,email,display_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(provider,provider_sub) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,updated_at=excluded.updated_at`)
      .bind(provider, identity.sub, bindUserId, identity.email || null, identity.name || null, now, now).run();
    await env.DB.prepare('UPDATE user_accounts SET name=COALESCE(name,?), updated_at=? WHERE id=?')
      .bind(identity.name || null, now, bindUserId).run();
    return { userId: bindUserId, linked: true };
  }
  if (owner) {
    await env.DB.prepare('UPDATE auth_identities SET email=?, display_name=?, updated_at=? WHERE provider=? AND provider_sub=?')
      .bind(identity.email || null, identity.name || null, now, provider, identity.sub).run();
    return { userId: owner.user_id, linked: false };
  }
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO user_accounts(id,phone,name,birthday,created_at,updated_at) VALUES (?,NULL,?,NULL,?,?)')
      .bind(userId, identity.name || null, now, now),
    env.DB.prepare(`INSERT INTO auth_identities(provider,provider_sub,user_id,email,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(provider, identity.sub, userId, identity.email || null, identity.name || null, now, now),
    env.DB.prepare('INSERT INTO members(phone,user_id,created_at,updated_at) VALUES (?,?,?,?)')
      .bind('account:' + userId, userId, now, now),
  ]);
  return { userId, linked: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// Contract A — 资金账本与支付安全 helpers（全部确定性 TS，绝不调 LLM）
// ═══════════════════════════════════════════════════════════════════════════

// SGT 营业日紧凑格式 YYYYMMDD（对齐 invoice_no 的 <前缀>-YYYYMMDD-####）
function sgtDayCompact(now = new Date()) { return sgtTodayStr(now).replace(/-/g, ''); }

// 每日票号原子取号：替换 COUNT(*)+1，杜绝并发撞 invoice_no UNIQUE。
// daily_seq 行级原子自增（D1=SQLite 单区域串行写），RETURNING 取回新序号。
async function nextInvoiceSeq(env, dayCompact) {
  const row = await env.DB.prepare(
    `INSERT INTO daily_seq(day, seq) VALUES(?, 1)
     ON CONFLICT(day) DO UPDATE SET seq = seq + 1
     RETURNING seq`).bind(dayCompact).first();
  return (row && row.seq) || 1;
}

// POS 收银员 token：常驻明文 STAFF_TOKEN → 签名+过期（复用 _hmac/_eq/AUTH_SECRET）。
// 16h 覆盖一个营业日；过期后 POS 各端拿到 401 自动回登录页重新输 PIN。
async function signStaffToken(env, cashier) {
  const payload = btoa(JSON.stringify({ c: cashier, r: 'staff', exp: Date.now() + 16 * 3600e3 }));
  return payload + '.' + await _hmac(env.AUTH_SECRET, payload);
}
async function verifyStaffToken(env, token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!_eq(await _hmac(env.AUTH_SECRET, payload), sig)) return null;
  try { const d = JSON.parse(atob(payload)); if (d.r !== 'staff' || d.exp < Date.now()) return null; return d.c || 'pos'; } catch (e) { return null; }
}
async function signKitchenToken(env) {
  const payload = btoa(JSON.stringify({ r: 'kitchen', exp: Date.now() + 30 * 864e5 }));
  return payload + '.' + await _hmac(env.AUTH_SECRET, payload);
}
async function verifyKitchenToken(env, token) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if (!_eq(await _hmac(env.AUTH_SECRET, payload), sig)) return false;
  try { const d = JSON.parse(atob(payload)); return d.r === 'kitchen' && d.exp >= Date.now(); } catch (e) { return false; }
}

// POS PIN 校验：只查 D1 pos_pins（PBKDF2 hash，与 hashPassword 同算法）。
// 没有 D1 hash 时 fail-closed，避免 wrangler.toml 弱 PIN 兜底在生产可用。
async function verifyPosPin(env, cashier, pin) {
  if (!cashier) return false;
  let row = null;
  try { row = await env.DB.prepare('SELECT pin_hash, pin_salt FROM pos_pins WHERE cashier=?').bind(cashier).first(); } catch (e) {}
  if (row && row.pin_hash && row.pin_salt) {
    const { hash } = await hashPassword(String(pin), row.pin_salt);
    return _eq(hash, row.pin_hash);
  }
  return false;
}

async function recordAttendance(env, staff, kind, note) {
  const k = kind === 'out' ? 'out' : 'in';
  const ts = new Date().toISOString();
  const day = sgtTodayStr();
  await env.DB.prepare(`INSERT INTO attendance_records (id,staff,business_date,kind,punched_at,source,note,created_at)
    VALUES (?,?,?,?,?,'pos',?,?)
    ON CONFLICT(staff,business_date,kind) DO UPDATE SET punched_at=excluded.punched_at, note=excluded.note`)
    .bind(crypto.randomUUID(), staff, day, k, ts, note || null, ts).run();
  return { ok: true, staff, kind: k, business_date: day, punched_at: ts };
}

// ----- D1 滑动窗口限流（无 KV binding）-----
// 只读检查：当前是否锁定中。
async function throttleLocked(env, scope, id) {
  try {
    const r = await env.DB.prepare('SELECT locked_until FROM auth_throttle WHERE scope=? AND id=?').bind(scope, id).first();
    if (r && r.locked_until && new Date(r.locked_until) > new Date()) return { locked: true, until: r.locked_until };
  } catch (e) {}
  return { locked: false };
}
// 记一次命中（一次失败登录 / 一次 OTP 请求）。窗口内累计达 lockAt → 锁 lockMs。
// 原子：计数用单条 UPSERT 的 SQL 级 count+1（CASE 处理窗口过期重置），不在 JS 里 read-modify-write，
// 杜绝并发 lost-update（多个失败登录同时读到旧值各自写回导致 lockAt 永不触发）。
async function throttleHit(env, scope, id, { lockAt, windowMs, lockMs }) {
  const now = Date.now(), nowIso = new Date(now).toISOString();
  const windowFloor = new Date(now - windowMs).toISOString();   // ISO 串字典序=时间序，避免 julianday 解析风险
  const row = await env.DB.prepare(
    `INSERT INTO auth_throttle (scope, id, window_start, count, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, id) DO UPDATE SET
       count        = CASE WHEN auth_throttle.window_start < ? THEN 1 ELSE auth_throttle.count + 1 END,
       window_start = CASE WHEN auth_throttle.window_start < ? THEN ? ELSE auth_throttle.window_start END,
       updated_at   = ?
     RETURNING count`).bind(scope, id, nowIso, nowIso, windowFloor, windowFloor, nowIso, nowIso).first();
  const count = (row && row.count) || 1;
  let limited = false, until = null;
  if (count >= lockAt) {
    until = new Date(now + lockMs).toISOString();
    await env.DB.prepare('UPDATE auth_throttle SET locked_until=? WHERE scope=? AND id=?').bind(until, scope, id).run();
    limited = true;
  }
  return { limited, count, until };
}
// 成功后清零（登录成功）。
async function throttleClear(env, scope, id) {
  try { await env.DB.prepare('DELETE FROM auth_throttle WHERE scope=? AND id=?').bind(scope, id).run(); } catch (e) {}
}

// ───────────────────────────────────────────────────────────────────────────
// P0 退款核心：取消未付清订单并退回储值（一个 D1 batch() 事务，失败整体 rollback）。
// 幂等靠 SQL 级守卫：① 原子 claim（pay_status='UNPAID' 且未退过）写本次 ref/refunded_at；
// ②③ 用 WHERE EXISTS(本次 ref) 条件门，只在 claim 成功时加余额 + 写退款流水。
// 不用 UPDATE...RETURNING CTE（SQLite 不支持 data-modifying CTE）。照 PLAN 第 3 节模板。
// ───────────────────────────────────────────────────────────────────────────
async function cancelUnpaidOrderAndRefundBalance(env, orderId, reason) {
  const o = await env.DB.prepare(
    'SELECT id,user_id,phone,paid_by_balance,pay_status,balance_refunded_at,promo_code FROM orders WHERE id=?'
  ).bind(orderId).first();
  if (!o) return { claimed: false, refunded: 0, amount: 0 };
  const amount = +(((o.paid_by_balance) || 0)).toFixed(2);
  const phone = normPhone(o.phone);
  const ts = new Date().toISOString();
  const ref = `bal_refund:${orderId}:${crypto.randomUUID()}`;
  const refundBalance = o.user_id
    ? env.DB.prepare(`UPDATE members SET balance=round(balance+?,2), updated_at=?
        WHERE user_id=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND balance_refund_ref=? AND balance_refunded_at=?)`)
      .bind(amount, ts, o.user_id, orderId, ref, ts)
    : env.DB.prepare(`INSERT INTO members(phone,balance,created_at,updated_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND balance_refund_ref=? AND balance_refunded_at=?)
        ON CONFLICT(phone) DO UPDATE SET balance=round(members.balance+excluded.balance,2), updated_at=excluded.updated_at`)
      .bind(phone, amount, ts, ts, orderId, ref, ts);
  const res = await env.DB.batch([
    // ① 原子 claim：仅 UNPAID 且未退过时置 CANCELLED；有余额才写 ref/refunded_at
    env.DB.prepare(`UPDATE orders SET pay_status='CANCELLED', cancelled_at=?, cancel_reason=?,
        balance_refund_ref=CASE WHEN paid_by_balance>0 THEN ? ELSE balance_refund_ref END,
        balance_refunded_at=CASE WHEN paid_by_balance>0 THEN ? ELSE balance_refunded_at END
      WHERE id=? AND pay_status='UNPAID' AND (paid_by_balance<=0 OR balance_refunded_at IS NULL)`)
      .bind(ts, reason, ref, ts, orderId),
    // ② 仅当本次 ref claim 成功且有余额，才把钱加回 members.balance（WHERE EXISTS 条件门）
    refundBalance,
    // ③ 退款流水（独立 ledger type='refund'，不进 topups 本金/赠送）
    env.DB.prepare(`INSERT INTO wallet_events(id,type,ref,order_id,phone,user_id,amount,created_at,note)
      SELECT ?, 'refund', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND balance_refund_ref=? AND balance_refunded_at=?)`)
      .bind(crypto.randomUUID(), ref, orderId, phone, o.user_id || null, amount, ts, reason, orderId, ref, ts),
  ]);
  const claimed = (res[0].meta && res[0].meta.changes) === 1;
  return { claimed, refunded: claimed && amount > 0 ? amount : 0, amount, phone, promo_code: o.promo_code };
}

// PAID→REFUNDED 单的储值退回（charge.refunded 用）：不改 pay_status（调用方已置 REFUNDED），
// 只在 paid_by_balance>0 且未退过时退回余额，复用同一 balance_refunded_at/ref + wallet_events 幂等守卫。
// alreadyCredited：之前的部分退款（退运费）已经退回钱包的金额，这里要扣掉，否则顾客同一笔钱拿两次。
async function refundOrderBalance(env, orderId, reason, alreadyCredited = 0) {
  const o = await env.DB.prepare('SELECT id,user_id,phone,paid_by_balance,balance_refunded_at FROM orders WHERE id=?').bind(orderId).first();
  if (!o || !(+(o.paid_by_balance || 0) > 0)) return { refunded: 0 };
  const amount = +Math.max(0, (+(o.paid_by_balance) || 0) - (+alreadyCredited || 0)).toFixed(2);
  if (!(amount > 0)) return { refunded: 0 };
  const phone = normPhone(o.phone);
  const ts = new Date().toISOString();
  const ref = `bal_refund:${orderId}:${crypto.randomUUID()}`;
  const refundBalance = o.user_id
    ? env.DB.prepare(`UPDATE members SET balance=round(balance+?,2), updated_at=?
        WHERE user_id=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND balance_refund_ref=? AND balance_refunded_at=?)`)
      .bind(amount, ts, o.user_id, orderId, ref, ts)
    : env.DB.prepare(`INSERT INTO members(phone,balance,created_at,updated_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND balance_refund_ref=? AND balance_refunded_at=?)
        ON CONFLICT(phone) DO UPDATE SET balance=round(members.balance+excluded.balance,2), updated_at=excluded.updated_at`)
      .bind(phone, amount, ts, ts, orderId, ref, ts);
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET balance_refund_ref=?, balance_refunded_at=?
      WHERE id=? AND paid_by_balance>0 AND balance_refunded_at IS NULL`).bind(ref, ts, orderId),
    refundBalance,
    env.DB.prepare(`INSERT INTO wallet_events(id,type,ref,order_id,phone,user_id,amount,created_at,note)
      SELECT ?, 'refund', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND balance_refund_ref=? AND balance_refunded_at=?)`)
      .bind(crypto.randomUUID(), ref, orderId, phone, o.user_id || null, amount, ts, reason, orderId, ref, ts),
  ]);
  const claimed = (res[0].meta && res[0].meta.changes) === 1;
  return { refunded: claimed ? amount : 0 };
}

// ===================== 退款引擎 =====================
// 背景：此前 /api/admin/order-refund 对 Stripe 单【只退储值余额】却把 pay_status 置成 REFUNDED，
// 顾客卡上一分钱没退、订单又脱离了 PAID 无法再退——系统还回 ok:true。这一整块就是为了根治它，
// 并顺带支持老板真正需要的「只退运费」。

const REFUND_KINDS = { delivery_fee: '运费', full: '整单' };

// 退款怎么拆：**先退顾客真实付出去的钱（Stripe），不够的部分才退回储值余额**。
// 储值是店内负债，退回储值等于把钱继续留在店里；顾客要的是钱回到卡上。
// 抽成纯函数是为了能被单测直接钉住 —— 这段算错就是真金损失。
function planRefundSplit({ total, paidByBalance, alreadyStripe, amount, provider }) {
  // ⚠️ 只有【真的走了 Stripe】的单才有原路可退。
  // 现金 / 柜台 PayNow / 线下录入的单，顾客当初是把现钞递到柜台的 —— 硬走 Stripe 只会
  // 报「这笔订单没有可退款的 payment_intent」，把老板往 Stripe 后台带偏，而那里根本没有这笔交易。
  const isStripe = String(provider || '') === 'stripe';
  const stripePortion = isStripe ? +((+total || 0) - (+paidByBalance || 0)).toFixed(2) : 0;
  const avail = +Math.max(0, stripePortion - (+alreadyStripe || 0)).toFixed(2);
  const stripe = +Math.min(+amount || 0, avail).toFixed(2);
  const rest = +((+amount || 0) - stripe).toFixed(2);
  // 剩下的部分：顾客当初用储值抵扣过多少，就退回储值多少；再剩下的就是现金，
  // 系统只负责【记账 + 告诉老板要退多少现钞】，不假装自己能把钱变回去。
  const balance = +Math.min(rest, Math.max(0, +paidByBalance || 0)).toFixed(2);
  const cash = +(rest - balance).toFixed(2);
  return { stripePortion, stripe, balance, cash, provider: isStripe ? 'stripe' : (provider || 'cash') };
}

// charge.refunded 到底意味着什么：只退了运费？还是整单退了？
// ⚠️ 这里曾经是 `amountRefunded >= stripePortion` 就当整单退款，那是个会白送钱的坑：
// 混合支付单里 Stripe 那一笔【本来就可能只是运费】（生产真有这样一单：货款全走储值、
// Stripe 只收 19.10 运费）。这种单一退运费就会被误判成整单退 → 订单锁死 + 白退 104.16 储值。
// 正解：先把【我们自己发起的非整单退款】剥掉，剩下的才回答「货款到底退没退」。
function classifyChargeRefund({ total, paidByBalance, amountRefunded, ownStripe }) {
  const stripePortion = +((+total || 0) - (+paidByBalance || 0)).toFixed(2);
  const own = +(+ownStripe || 0).toFixed(2);
  const goodsCharge = +(stripePortion - own).toFixed(2);
  const goodsRefunded = +((+amountRefunded || 0) - own).toFixed(2);
  if (own > 0 && goodsRefunded <= 0.005) return { kind: 'fee_only', stripePortion, goodsCharge, goodsRefunded };
  if (goodsCharge > 0.005 && goodsRefunded >= goodsCharge - 0.005) return { kind: 'full', stripePortion, goodsCharge, goodsRefunded };
  return { kind: 'partial', stripePortion, goodsCharge, goodsRefunded };
}

// 拿到这单可退款的 Stripe payment_intent。
// orders.pay_txn 由 webhook 写入，但那里是 `s.payment_intent || ''`——PayNow 这类异步付款在
// checkout.session.completed 时可能还没有 PI，会存成空串。所以 pay_txn 不可用时，用 pay_ref 里的
// checkout session id 现场回查一次，别让退款因为一个空字段就走不下去。
async function stripePaymentIntentFor(env, order, SK) {
  const direct = String(order.pay_txn || '').trim();
  if (direct.startsWith('pi_')) return direct;
  const sess = String(order.pay_ref || '').trim();
  if (!sess.startsWith('cs_')) return direct || null;
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sess)}`, {
      headers: { authorization: `Bearer ${SK}` }, signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return direct || null;
    const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent && d.payment_intent.id);
    return pi || direct || null;
  } catch (e) { return direct || null; }
}

async function stripeRefundCreate(env, SK, { paymentIntent, amount, idemKey, orderId, reason }) {
  const f = new URLSearchParams();
  f.append('payment_intent', paymentIntent);
  f.append('amount', String(Math.round(amount * 100)));           // Stripe 用「分」
  f.append('metadata[order_id]', String(orderId));
  f.append('metadata[reason]', String(reason || '').slice(0, 100));
  const r = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: `Bearer ${SK}`,
      'content-type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idemKey,   // 失败重试的安全带：Stripe 认这个键，同一笔不会退第二次
    },
    body: f.toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (d.error && d.error.message) || `stripe_http_${r.status}` };
  return { ok: true, refund_id: d.id, status: d.status };
}

// 退一笔钱给顾客。kind 决定幂等键，所以「运费」每单只可能成功退一次。
// 拆分规则：**先退顾客真实付出去的钱（Stripe），不够的部分才退回储值余额**。
// 理由：储值是店内负债，退回储值等于把钱继续留在店里；顾客要的是钱回到卡上。
async function refundOrderAmount(env, order, { kind, amount, reason, actor }) {
  const idemKey = `refund:${kind}:${order.id}`;
  amount = +(+amount).toFixed(2);
  if (!(amount > 0)) return { ok: false, code: 'zero_amount', error: '退款金额必须大于 0' };

  const agg = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) amt, COALESCE(SUM(stripe_amount),0) st FROM order_refunds WHERE order_id=? AND status='succeeded'"
  ).bind(order.id).first();
  const already = +(+((agg && agg.amt) || 0)).toFixed(2);
  const alreadyStripe = +(+((agg && agg.st) || 0)).toFixed(2);
  const total = +(+order.total || 0).toFixed(2);
  const remaining = +(total - already).toFixed(2);
  if (amount - remaining > 0.005) {
    return { ok: false, code: 'exceeds_remaining', error: `这单最多还能退 S$${remaining.toFixed(2)}`, remaining };
  }

  const split = planRefundSplit({ total, paidByBalance: +order.paid_by_balance || 0, alreadyStripe, amount,
    provider: order.pay_provider });
  const plannedStripe = split.stripe;
  const plannedBalance = split.balance;
  const plannedCash = split.cash;

  // ① claim：UNIQUE(idem_key) 是并发闸门。两个老板同时点，只有一个能往下走。
  const rid = crypto.randomUUID();
  const now = new Date().toISOString();
  let claimed = true;
  try {
    await env.DB.prepare(`INSERT INTO order_refunds
      (id,order_id,kind,amount,stripe_amount,balance_amount,cash_amount,status,reason,actor,idem_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
      .bind(rid, order.id, kind, amount, plannedStripe, plannedBalance, plannedCash,
        String(reason || '').slice(0, 200), String(actor || '').slice(0, 80), idemKey, now, now).run();
  } catch (e) {
    if (!/UNIQUE|constraint/i.test(e.message || '')) throw e;
    claimed = false;
  }
  let row = null;
  if (!claimed) {
    row = await env.DB.prepare('SELECT * FROM order_refunds WHERE idem_key=?').bind(idemKey).first();
    if (!row) return { ok: false, code: 'race', error: '退款状态读取失败，请刷新重试' };
    if (row.status === 'succeeded') {
      return { ok: true, deduped: true, refund_id: row.id, amount: +row.amount, stripe_amount: +row.stripe_amount,
        balance_amount: +row.balance_amount, cash_amount: +(row.cash_amount || 0), stripe_refund_id: row.stripe_refund_id };
    }
    if (row.status === 'pending') return { ok: false, code: 'in_progress', error: '这笔退款正在处理中，请稍后刷新' };
    // failed / manual_required → 允许重试，沿用同一行与同一个 Idempotency-Key（Stripe 侧不会重复退）
  }
  const rowId = claimed ? rid : row.id;
  const useStripe = claimed ? plannedStripe : +(+row.stripe_amount || 0).toFixed(2);
  const useBalance = claimed ? plannedBalance : +(+row.balance_amount || 0).toFixed(2);
  const useAmount = claimed ? amount : +(+row.amount || 0).toFixed(2);
  const useCash = claimed ? plannedCash : +(+row.cash_amount || 0).toFixed(2);

  const fail = async (err, status = 'failed') => {
    await env.DB.prepare('UPDATE order_refunds SET status=?, error=?, updated_at=? WHERE id=?')
      .bind(status, String(err || '').slice(0, 300), new Date().toISOString(), rowId).run();
    return { ok: false, code: status, error: err, refund_id: rowId };
  };

  // ② Stripe 那部分：先退真钱。失败就整笔停下——不写余额、不动订单状态。
  // 宁可「什么都没发生」，也绝不能出现「顾客卡上没退到，系统却说退了」。
  let stripeRefundId = null;
  if (useStripe > 0) {
    const SK = await setting(env, 'STRIPE_SECRET_KEY');
    if (!SK) return await fail('Stripe 未配置密钥，无法原路退款，请到 Stripe 后台手动处理', 'manual_required');
    const pi = await stripePaymentIntentFor(env, order, SK);
    if (!pi) return await fail('这笔订单没有可退款的 Stripe payment_intent，请到 Stripe 后台手动处理', 'manual_required');
    const rf = await stripeRefundCreate(env, SK, {
      paymentIntent: pi, amount: useStripe, idemKey, orderId: order.id, reason: `${kind}:${reason || ''}`,
    });
    if (!rf.ok) return await fail(rf.error || 'stripe_refund_failed');
    stripeRefundId = rf.refund_id || null;
  }

  // ③ 储值那部分：进 members.balance + wallet_events（沿用既有 type='refund'，账本能连起来）
  const ts = new Date().toISOString();
  const phone = normPhone(order.phone);
  if (useBalance > 0 && (order.user_id || phone)) {
    const credit = order.user_id
      ? env.DB.prepare('UPDATE members SET balance=round(balance+?,2), updated_at=? WHERE user_id=?')
        .bind(useBalance, ts, order.user_id)
      : env.DB.prepare(`INSERT INTO members(phone,balance,created_at,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(phone) DO UPDATE SET balance=round(members.balance+excluded.balance,2), updated_at=excluded.updated_at`)
        .bind(phone, useBalance, ts, ts);
    await env.DB.batch([
      credit,
      env.DB.prepare(`INSERT INTO wallet_events(id,type,ref,order_id,phone,user_id,amount,created_at,note)
        VALUES (?,'refund',?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), `refund:${rowId}`, order.id, phone || null, order.user_id || null,
          useBalance, ts, `${REFUND_KINDS[kind] || kind}退款 ${reason || ''}`.trim().slice(0, 200)),
    ]);
  }

  // ④ 收尾：积分按退款比例回滚（积分本来按 floor(total) 给，运费也算在里面），并更新已退合计。
  const ptsBefore = Math.floor(Math.max(0, total - already));
  const ptsAfter = Math.floor(Math.max(0, total - already - useAmount));
  const ptsBack = Math.max(0, ptsBefore - ptsAfter);
  const writes = [
    env.DB.prepare("UPDATE order_refunds SET status='succeeded', stripe_refund_id=?, updated_at=? WHERE id=?")
      .bind(stripeRefundId, ts, rowId),
    env.DB.prepare('UPDATE orders SET refunded_total=round(COALESCE(refunded_total,0)+?,2), note=COALESCE(note,\'\')||? WHERE id=?')
      .bind(useAmount, ` [退${REFUND_KINDS[kind] || kind} S$${useAmount.toFixed(2)}${useStripe > 0 ? ` 原路${useStripe.toFixed(2)}` : ''}${useBalance > 0 ? ` 储值${useBalance.toFixed(2)}` : ''}${useCash > 0 ? ` 现金${useCash.toFixed(2)}·需当面退` : ''}]`, order.id),
  ];
  if (order.user_id && (ptsBack > 0 || useAmount > 0)) {
    writes.push(env.DB.prepare(
      'UPDATE members SET points=MAX(0,points-?), total_spent=MAX(0,total_spent-?), updated_at=? WHERE user_id=?'
    ).bind(ptsBack, useAmount, ts, order.user_id));
  }
  await env.DB.batch(writes);

  return { ok: true, refund_id: rowId, amount: useAmount, stripe_amount: useStripe,
    balance_amount: useBalance, cash_amount: useCash, stripe_refund_id: stripeRefundId, points_reversed: ptsBack,
    // 现金那部分系统退不了，必须明确告诉操作者要当面退多少，别让他以为系统已经退过了
    cash_note: useCash > 0 ? `请当面退给顾客现金 S$${useCash.toFixed(2)}（这部分系统无法原路退回）` : null };
}

// 只退运费。这是老板最常用的场景：菜送到了但送晚了/送错了，商品照收钱，运费退给顾客。
// 金额锁死为订单上的 delivery_fee，不接受调用方传金额——避免任何入口（尤其 POS）能把它当成万能退款口。
async function refundDeliveryFee(env, order, { reason, actor }) {
  const fee = +(+order.delivery_fee || 0).toFixed(2);
  if (!(fee > 0)) return { ok: false, code: 'no_delivery_fee', error: '这单没有运费，无需退' };
  if (order.pay_status !== 'PAID') {
    return { ok: false, code: 'not_paid', error: `订单当前是 ${order.pay_status}，只有已付款的单才能退运费` };
  }
  return await refundOrderAmount(env, order, { kind: 'delivery_fee', amount: fee, reason: reason || '退运费', actor });
}

// 整单退款。顺序是关键：**先把真钱退掉，成功了才改订单状态**。
// 反过来做的话，Stripe 失败时订单已经脱离 PAID —— 既退不了钱、也没法重试，
// 而系统还回 ok:true。修复前线上就是这个行为。
async function refundWholeOrder(env, order, { reason, actor }) {
  if (order.pay_status !== 'PAID') {
    return { ok: false, code: 'not_paid', error: `订单当前是 ${order.pay_status}，不能整单退款` };
  }
  const amount = +(+(+order.total || 0) - (+order.refunded_total || 0)).toFixed(2);
  if (!(amount > 0)) return { ok: false, code: 'nothing_left', error: '这单已经全额退过了' };
  const r = await refundOrderAmount(env, order, { kind: 'full', amount, reason: reason || '整单退款', actor });
  if (!r.ok) return r;                       // 钱没退成功 → 订单保持 PAID，老板可以重试
  const ts = new Date().toISOString();
  const claim = await env.DB.prepare(
    // balance_refunded_at 一并置上：Stripe 的 charge.refunded webhook 随后会到，
    // 它的 refundOrderBalance 有 `balance_refunded_at IS NULL` 守卫，置了就不会二次退储值。
    `UPDATE orders SET pay_status='REFUNDED', cancelled_at=?, cancel_reason=?,
       balance_refund_ref=COALESCE(balance_refund_ref, ?), balance_refunded_at=COALESCE(balance_refunded_at, ?)
     WHERE id=? AND pay_status='PAID'`
  ).bind(ts, String(reason || '').slice(0, 200), `refund:${r.refund_id}`, ts, order.id).run();
  if (claim.meta && claim.meta.changes === 1) {
    if (order.promo_code) await releasePromoForOrder(env, order.id, order.promo_code);
    if (order.user_id) {
      await env.DB.prepare('UPDATE members SET orders_count=MAX(0,orders_count-1), updated_at=? WHERE user_id=?')
        .bind(ts, order.user_id).run();
    }
  }
  return { ...r, status: 'REFUNDED' };
}

async function requestDeliveryFailureRefund(env, orderId, reason) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) return { ok: false, reason: 'order_not_found' };
  if (o.pay_status !== 'PAID') return { ok: true, skipped: true, reason: 'not_paid' };
  await notifyDelivery(env, orderId, 'refund_starting', { reason });
  const rf = await refundWholeOrder(env, o, { reason, actor: 'system:delivery_failure' });
  if (rf.ok) {
    await updateDeliveryJob(env, orderId, {
      state: 'refund_requested', refund_status: 'requested', refund_ref: rf.stripe_refund_id || rf.refund_id,
      raw_last: JSON.stringify({ reason, refund_id: rf.refund_id }).slice(0, 4000),
    });
    await notifyDelivery(env, orderId, 'refund_requested', { reason, refund_id: rf.refund_id });
    return rf;
  }
  await updateDeliveryJob(env, orderId, {
    refund_status: 'manual_required',
    raw_last: JSON.stringify({ reason, refund_error: rf.error }).slice(0, 4000),
  });
  await notifyDelivery(env, orderId, 'manual_refund_required', { reason: rf.error || reason });
  return rf;
}

async function handleDeliveryProviderState(env, providerOrderId, status, raw, meta = {}) {
  const job = await env.DB.prepare('SELECT * FROM delivery_jobs WHERE provider=? AND provider_order_id=?').bind('lalamove', providerOrderId).first();
  if (!job) return { ok: false, reason: 'job_not_found' };
  const state = deliveryStateFromProviderStatus(status);
  const changed = state !== job.state
    || String(status || '') !== String(job.provider_status || '')
    || (!!meta.rider_name && meta.rider_name !== job.rider_name)
    || (!!meta.rider_phone && meta.rider_phone !== job.rider_phone)
    || (!!meta.share_link && meta.share_link !== job.share_link);
  const now = new Date().toISOString();
  const patch = { provider_status: status || null, state, last_event_at: now, raw_last: JSON.stringify(raw || {}).slice(0, 4000),
    rider_name: meta.rider_name || null, rider_phone: meta.rider_phone || null, share_link: meta.share_link || null };
  if (state === 'rider_assigned') patch.assigned_at = now;
  if (state === 'picked_up') patch.picked_up_at = now;
  if (state === 'delivered') patch.delivered_at = now;
  if (state === 'failed') patch.cancelled_at = now;
  await updateDeliveryJob(env, job.order_id, patch);
  if (changed) await notifyDelivery(env, job.order_id, state, meta);
  if (state === 'failed' && (await setting(env, 'lalamove_auto_refund')) === '1') await requestDeliveryFailureRefund(env, job.order_id, 'lalamove_' + String(status || 'failed').toLowerCase());
  return { ok: true, state };
}

// create an offline / POS sale (shared by admin manual entry and POS staff app)
async function createOfflineSale(env, b, cashier, requireActive) {
  // 幂等：同 client_token 已成交 → 返回已有单，绝不重复开单（防双击/网络重试把一笔收款记两单）
  if (b.client_token) {
    const dup = await env.DB.prepare('SELECT id,invoice_no,total FROM orders WHERE client_token=?').bind(b.client_token).first();
    if (dup) return { ok: true, id: dup.id, invoice_no: dup.invoice_no, total: dup.total, deduped: true };
  }
  const dateStr = b.date || sgtTodayStr();   // SGT 营业日，与 online 票号同基准
  const ts = b.date ? `${b.date}T12:00:00.000Z` : new Date().toISOString();
  let subtotal = 0; const priced = [];
  let acceptedRevision = null, releaseRules = null;
  if (Array.isArray(b.items) && b.items.length && requireActive) {
    // 正常 POS 售卖：价格同样只认活动发布，与顾客端同源，绝不读可变草稿表。
    const quote = await quoteActiveReleaseItems(env, {
      menuRevision: b.menu_revision,
      items: b.items.map(it => ({ sku: it.sku, qty: Math.max(1, parseInt(it.qty, 10) || 1) })),
    });
    if (quote.status === 400) return { error: '购物车无效，请刷新菜单后重开此单', _status: 400 };
    if (quote.status === 503) return { error: '菜单尚未发布，请稍后再试', _status: 503 };
    if (!quote.ok) {
      return { error: 'menu_changed', code: 'menu_changed', active_revision: quote.active_revision,
        changes: quote.changes, lines: quote.lines, subtotal_cents: quote.subtotal_cents,
        release_rules: quote.release_rules, _status: 409 };
    }
    acceptedRevision = quote.revision;
    releaseRules = quote.release_rules;
    subtotal = quote.subtotal_cents / 100;
    for (const line of quote.lines) priced.push({ sku: line.sku, name: line.name_cn, qty: line.qty, unit_price: line.unit_price_cents / 100, ...pricedLineExtras(line) });
  } else if (Array.isArray(b.items) && b.items.length) {
    // 后台按商品记账：只收【已发布菜单】里在售的商品，按页面显示的那个发布作价、记组成，与顾客端、POS 同源。
    // 页面打开后菜单重新发布过、或所选商品已下架，一律拒收，让老板按当前菜单重新选择核对；未发布的草稿永远不进厨房。
    const published = await activeReleaseProductRows(env, b.items.map(it => it.sku));
    const offMenu = b.items.map(it => String(it.sku || '').trim().toUpperCase()).filter(sku => !published.bySku.get(sku)?.active);
    if (String(b.menu_revision || '') !== String(published.releaseId || '') || offMenu.length) {
      return { error: offMenu.length ? `这些商品已不在当前菜单上：${offMenu.join('、')}。请重新载入后核对再保存`
        : '菜单已重新发布，请重新载入后核对价格和组成再保存', code: 'menu_changed', active_revision: published.releaseId, _status: 409 };
    }
    for (const it of b.items) {
      const sku = String(it.sku || '').trim().toUpperCase();
      const qty = Math.max(1, parseInt(it.qty, 10) || 1);
      const live = published.bySku.get(sku);
      const unit = Number(live.price_cents) / 100;
      subtotal += unit * qty;
      priced.push({ sku, name: live.name_cn, qty, unit_price: unit, ...pricedLineExtras(live) });
    }
  } else if (b.amount) {
    subtotal = +(+b.amount).toFixed(2);
    const cnt = Math.max(1, parseInt(b.count, 10) || 1);
    priced.push({ sku: 'OFFLINE', name: b.note || '线下销售', qty: cnt, unit_price: +(subtotal / cnt).toFixed(2) });
  } else return { error: 'need items[] or amount', _status: 400 };
  if (subtotal <= 0) return { error: 'empty sale', _status: 400 };
  subtotal = +subtotal.toFixed(2);
  const mphone = normPhone(b.phone || '');
  const account = mphone ? await accountByPhone(env, mphone) : null;
  const memberUserId = account && account.user_id;
  // ----- 优惠券（服务端校验，绝不信前端折扣）：POS 单方式=walkin，渠道未含 walkin 的券会被拒。store 折扣由服务端重算。 -----
  let discount = 0, promoCode = null;
  if (b.promo_code) {
    const pr = await checkPromo(env, b.promo_code, subtotal, 'walkin', mphone, false, memberUserId);   // 柜台本身不算登录，但已登记账号时限次按 user_id
    if (pr.error) return { error: pr.error, _status: 400 };
    // 成交时强制：per-account/首单限制券必须有手机号身份，否则无身份可限（堵「无手机号现金单无限刷限领券」；checkPromo 预览仍宽松，仅成交侧严卡）
    if ((pr.per_account_limit > 0 || pr.first_order_only) && !mphone) return { error: '此优惠码需登记会员手机号才能用 · Phone required for this code', _status: 400 };
    discount = pr.discount; promoCode = pr.code;
  }
  // 正常 POS 售卖有 releaseRules（与顾客端同源）；requireActive=false 的补录没有，退回读设置。
  const pricing = releaseRules ? pricingConfigFromReleaseRules(releaseRules)
    : pricingConfigFromSettings(await getSettings(env, FINANCE_SETTING_KEYS));
  const charges = computeOrderTotals(subtotal, 0, discount, pricing);
  const total = charges.total;
  const id = crypto.randomUUID();
  // 原子取号（替换 COUNT(*)+1）。day = 显式业务日（POS/admin 可传历史 date）的紧凑形式。
  const dayCompact = dateStr.replace(/-/g, '');
  const seq = await nextInvoiceSeq(env, dayCompact);
  const inv = `${invoicePrefix(env)}-${dayCompact}-${String(seq).padStart(4, '0')}`;
  let promoClaimed = false;
  if (promoCode) {
    const pc = await claimPromoUse(env, promoCode);
    if (!pc.ok) return { error: pc.error || '优惠码已用完', _status: 409 };
    promoClaimed = true;
  }

  // ===== 余额收款分支：扣会员余额 + 建单 在单个原子 batch 内完成（条件门保证「要么都成、要么都不动」）=====
  if (b.pay_method === 'balance') {
    if (!mphone) return { error: '余额支付需会员手机号', _status: 400 };
    if (!b.client_token) return { error: '余额支付需幂等令牌 client_token（防重试重复扣款）', _status: 400 };   // 动真钱必须幂等令牌（与 /api/pos/topup 一致），缺则拒，杜绝无令牌重试双扣
    const ledgerWhere = memberUserId ? 'user_id=?' : 'phone=? AND user_id IS NULL';
    const ledgerKey = memberUserId || mphone;
    const m = await env.DB.prepare(`SELECT balance FROM members WHERE ${ledgerWhere}`).bind(ledgerKey).first();
    const bal = +((m && m.balance) || 0).toFixed(2);
    if (bal < total) return { error: `会员余额不足：当前 S$${bal.toFixed(2)}，本单需 S$${total.toFixed(2)}`, _status: 400, balance: bal };
    const token = `bal:${id}:${crypto.randomUUID()}`;   // 扣款成功标记；订单 INSERT 以「该 token 已写入」为条件门
    try {
      const res = await env.DB.batch([
        env.DB.prepare(`UPDATE members SET balance=round(balance-?,2), updated_at=? WHERE ${ledgerWhere} AND balance>=?`)
          .bind(total, token, ledgerKey, total),
        env.DB.prepare(
          `INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,discount,service_charge,service_charge_rate,gst,gst_rate,gst_registered,promo_code,promo_claimed,paid_by_balance,total,fulfilment,pay_provider,pay_ref,pay_status,paid_at,source,cashier,note,client_token)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'walkin','balance',?, 'PAID',?, 'offline',?,?,?
           WHERE EXISTS(SELECT 1 FROM members WHERE ${ledgerWhere} AND updated_at=?)`
        ).bind(id, inv, ts, b.customer_name || (account && account.name) || '到店顾客', mphone, memberUserId || null, JSON.stringify(priced),
          subtotal, charges.delivery_fee, discount, charges.service_charge, charges.service_charge_rate, charges.gst, charges.gst_rate, charges.gst_registered,
          promoCode, promoClaimed ? 1 : 0, total, total, inv, ts, cashier || null, b.note || null, b.client_token || null, ledgerKey, token),
      ]);
      // 权威成功信号 = 建单成功(res[1])。扣款(res[0]) 与 建单(res[1]) 在同一 batch 事务内被 token 条件门严格耦合：
      // SQLite 写事务串行化 + 读己写 → 两条语句间不会插入别的 commit；扣成功→写 token→INSERT 的 EXISTS(token) 必真→建成功。
      // 故 res[0]=1 ⟺ res[1]=1，不存在「扣了没建」(若 EXISTS 假→未写 token→未扣)。INSERT 真失败(NOT NULL/UNIQUE)会 throw 走 catch、整 batch 回滚。
      if (!(res[1].meta && res[1].meta.changes > 0)) {
        if (promoClaimed) await releasePromoUse(env, promoCode);
        return { error: '余额扣款失败（余额不足或并发占用），请重试', _status: 409 };
      }   // 没建=没扣，原子一致
    } catch (e) {
      if (promoClaimed) await releasePromoUse(env, promoCode);
      // 双击同令牌 → INSERT 撞 client_token UNIQUE → 整个 batch 回滚（含扣款）→ 返回已有单，绝不二次扣
      if (b.client_token && /UNIQUE|constraint/i.test(e.message || '')) {
        const dup = await env.DB.prepare('SELECT id,invoice_no,total FROM orders WHERE client_token=?').bind(b.client_token).first();
        if (dup) return { ok: true, id: dup.id, invoice_no: dup.invoice_no, total: dup.total, deduped: true };
      }
      throw e;
    }
    { const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first(); if (o) { await accruePoints(env, o); await enqueueKitchenTicket(env, o); } }
    return { ok: true, id, invoice_no: inv, total, paid_by_balance: total, pay_method: 'balance' };
  }

  // ===== 现金 / PayNow / other 分支（即时 PAID）=====
  const pm = ['paynow', 'cash', 'other'].includes(b.pay_method) ? b.pay_method : 'cash';   // 白名单：admin 线下销售的 'other' tender 不再被静默并成 cash（按 tender 分渠道对账才准）
  try {
    await env.DB.prepare(
      `INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,discount,service_charge,service_charge_rate,gst,gst_rate,gst_registered,promo_code,promo_claimed,total,
         fulfilment,pay_provider,pay_ref,pay_status,paid_at,source,cashier,note,client_token)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'walkin',?,?, 'PAID',?, 'offline',?,?,?)`
    ).bind(id, inv, ts, b.customer_name || (account && account.name) || '到店顾客', mphone, memberUserId || null, JSON.stringify(priced),
      subtotal, charges.delivery_fee, discount, charges.service_charge, charges.service_charge_rate, charges.gst, charges.gst_rate, charges.gst_registered,
      promoCode, promoClaimed ? 1 : 0, total, pm, inv, ts, cashier || null, b.note || null, b.client_token || null).run();
  } catch (e) {
    if (promoClaimed) await releasePromoUse(env, promoCode);
    // 并发同 client_token → orders UNIQUE 冲突 → 查已有单返回，保持幂等（票号已取但冲突未入库，序号偶尔不连续无害）
    if (b.client_token && /UNIQUE|constraint/i.test(e.message || '')) {
      const dup = await env.DB.prepare('SELECT id,invoice_no,total FROM orders WHERE client_token=?').bind(b.client_token).first();
      if (dup) return { ok: true, id: dup.id, invoice_no: dup.invoice_no, total: dup.total, deduped: true };
    }
    throw e;
  }
  { const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first(); if (o) { await accruePoints(env, o); await enqueueKitchenTicket(env, o); } }
  return { ok: true, id, invoice_no: inv, total };
}

// per-payment alert to the boss's WhatsApp
async function notifyBossPaid(env, order) {
  if (!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.BOSS_PHONE)) return;
  try {
    await sendWhatsAppTemplate(env, env.BOSS_PHONE, env.WHATSAPP_PAID_TEMPLATE || 'payment_received',
      [order.invoice_no, 'S$ ' + order.total.toFixed(2), order.customer_name || '-']);
  } catch (e) { /* never break the webhook on a notify failure */ }
}

// ===== Telegram 来单提醒：boss 在后台只填 bot token（chat_id 自动发现），来单自动推一条到群/聊天 =====
function renderOrderTelegram(o, bomNames = {}) {
  let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) {}
  const ful = { pickup: '🥡自取', discount: '🛵拼单顺路送', anytime: '🚚自费随时送', delivery: '🚚配送', route: '🛵拼单顺路送', walkin: '🏪到店' }[o.fulfilment] || (o.fulfilment || '');
  const when = o.created_at ? new Date(new Date(o.created_at).getTime() + SGT_OFFSET_MIN * 60000).toISOString().slice(5, 16).replace('T', ' ') : '';
  const paid = o.pay_status === 'PAID' ? '✅ 已付' : '⏳ 待付款';
  const L = [`🔔 新订单 ${o.invoice_no}`, `🕐 ${when}　${paid}`, '————————'];
  for (const i of items) {
    L.push(`· ${i.qty} × ${i.name}`);
    for (const s of kitchenLines(i, bomNames)) L.push(`　　└ ${s.qty} ${s.name}`);
  }
  L.push('————————', `💰 合计 S$${(+o.total || 0).toFixed(2)}`, `📦 ${ful}`);
  if (o.deliver_at || o.deliver_time) L.push(`⏰ ${o.fulfilment === 'pickup' ? '取餐' : '送达'}：${o.deliver_at || '今天'}${o.deliver_time ? ' ' + o.deliver_time : ''}`);
  if (o.address) L.push(`📍 ${o.fulfilment === 'pickup' ? '取餐点：' : ''}${o.address}`);
  if (o.fulfilment === 'anytime') L.push(`⚠️ 请老板手动叫车；系统仅按 Lalamove 报价收运费 S$${(+o.delivery_fee || 0).toFixed(2)}`);
  L.push(`👤 ${o.customer_name || '游客'} ${o.phone || ''}`.trim());
  return L.join('\n');
}
// Telegram CopyTextButton 的 text 硬上限是 256 —— 超了 Telegram 直接拒收整条 sendMessage。
// 所以这里做两件事：① 复制串里【备注排最前】，万一还是被截，丢的是地址尾巴而不是单号和送达时间；
// ② 真超长时不静默 .slice()，而是把「全部资料」拆成两个按钮，信息一个字不丢。
const TG_COPY_MAX = 256;
function tgCopyRows(label, body) {
  const s = String(body || '');
  if (_bytes(s).length <= TG_COPY_MAX && s.length <= TG_COPY_MAX) {
    return [[{ text: label, copy_text: { text: s } }]];
  }
  // 按行切成两段，尽量在换行处断开，避免把一个地址劈成两半
  let cut = s.lastIndexOf('\n', TG_COPY_MAX - 1);
  if (cut < TG_COPY_MAX * 0.4) cut = TG_COPY_MAX - 1;
  const a = s.slice(0, cut).trimEnd(), b = s.slice(cut).trimStart();
  return [
    [{ text: `${label}（1/2）`, copy_text: { text: a.slice(0, TG_COPY_MAX) } }],
    [{ text: `${label}（2/2）`, copy_text: { text: b.slice(0, TG_COPY_MAX) } }],
  ];
}
function manualCourierTelegramPayload(o, pickupAddress, shopPhone, domain) {
  // 复制进 Grab 地址框的必须是【干净地址】——店名重复两次 + 一段中文指路话术是搜不到的。
  // 指路话术留在消息正文里给老板看，不进复制串。
  const pickup = String(pickupAddress || '').trim() || '请在 Grab 使用已保存的店铺取货地址';
  const dropoff = [o.address, o.unit_no].filter(Boolean).join(' · ') || '订单未填写配送地址';
  const recipientPhone = phoneForCourier(o.phone) || phoneForCourier(shopPhone) || '未提供';
  const recipient = `${o.customer_name || '顾客'} · ${recipientPhone}`;
  const schedule = [o.deliver_at, o.deliver_time].filter(Boolean).join(' ') || '尽快';
  const note = `${o.invoice_no || o.id} · 食品配送 · ${schedule}`;
  const copyAll = [`备注：${note}`, `取货：${pickup}`, `送达：${dropoff}`, `收件人：${recipient}`].join('\n');
  const host = String(domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const invoiceUrl = `${host ? 'https://' + host : ''}/invoice/${encodeURIComponent(o.id)}`;
  const rows = [
    [
      { text: '🚚 打开 GrabExpress', url: 'https://express.grab.com/book/login' },
      { text: '🧾 查看订单', url: invoiceUrl },
    ],
    [{ text: '复制取货地址', copy_text: { text: pickup.slice(0, TG_COPY_MAX) } }],
    [{ text: '复制送货地址', copy_text: { text: dropoff.slice(0, TG_COPY_MAX) } }],
    [{ text: '复制收件人/电话', copy_text: { text: recipient.slice(0, TG_COPY_MAX) } }],
    ...tgCopyRows('复制全部叫车资料', copyAll),
  ];
  return {
    text: `\n\n📋 Grab 手动叫车资料\n${copyAll}`,
    rows,
    reply_markup: { inline_keyboard: rows },
  };
}
// 来单消息上的操作按钮：厨房推进 + 退运费。
// callback_data 必须短（Telegram 上限 64 字节）且格式严格 —— webhook 侧用正则死锁，
// 任何不匹配的一律丢弃，不给伪造留解析空间。
function orderActionRows(o) {
  const rows = [];
  const st = normFulfilStatus(o.fulfil_status);
  const nexts = [];
  if (st === 'new') nexts.push({ text: '👨‍🍳 开始制作', data: `k:preparing:${o.id}` });
  if (st === 'new' || st === 'preparing') nexts.push({ text: '✅ 出餐完成', data: `k:ready:${o.id}` });
  if (st === 'ready') nexts.push({ text: '📦 已交付', data: `k:done:${o.id}` });
  if (nexts.length) rows.push(nexts.map(n => ({ text: n.text, callback_data: n.data })));
  const fee = +(+o.delivery_fee || 0).toFixed(2);
  if (fee > 0 && o.pay_status === 'PAID' && !(+o.refunded_total > 0)) {
    rows.push([{ text: `💸 退运费 S$${fee.toFixed(2)}`, callback_data: `rdf:${o.id}` }]);
  }
  return rows;
}
async function notifyRefundTelegram(env, order, result, via) {
  const parts = [
    `💸 已退运费 ${order.invoice_no || ''}`.trim(),
    `退款金额 S$${(+result.amount || 0).toFixed(2)}`,
  ];
  if (+result.stripe_amount > 0) parts.push(`· 原路退回 S$${(+result.stripe_amount).toFixed(2)}（银行 3–10 个工作日到账）`);
  if (+result.balance_amount > 0) parts.push(`· 退回储值 S$${(+result.balance_amount).toFixed(2)}（立即可用）`);
  parts.push(`操作来源：${via}`);
  try { await notifyTelegram(env, parts.join('\n'), { _order_id: order.id }); } catch (e) {}
}
// Telegram 返回 400（比如 reply_markup 被拒）时 HTTP 仍是 200 且 body 里 ok:false —— 不是抛异常。
// 所以调用方的 try/catch 根本抓不到，一条已付款订单的来单提醒会静默消失，而这家店【只有 Telegram 这一个接单通道】。
// 这里把 ok:false 显式暴露出来，交给 notifyTelegram 降级重发。
async function tgApi(token, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(5000)   // Telegram 卡住时最多等 5s，防拖垮调用方
  });
  const d = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
  return d;
}
async function notifyTelegram(env, text, options = {}) {
  const token = await setting(env, 'telegram_bot_token');
  if (!token) return { sent: 0, failed: 0 };
  let subs = [];
  try { const { results } = await env.DB.prepare('SELECT chat_id FROM telegram_subscribers').all(); subs = results || []; }
  catch (e) { return { sent: 0, failed: 0 }; }
  // _order_id 只是给失败日志用的内部字段，绝不能混进发给 Telegram 的 payload
  const { _order_id: logOrderId, ...tgOptions } = options || {};
  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      const base = { chat_id: s.chat_id, text, disable_web_page_preview: true };
      let d = await tgApi(token, 'sendMessage', { ...base, ...tgOptions });
      // 降级：带按钮被拒 → 立刻重发纯文本。宁可少几个按钮，也不能让老板看不到这一单。
      if (!d.ok && tgOptions.reply_markup) d = await tgApi(token, 'sendMessage', base);
      if (d.ok) sent++; else {
        failed++;
        await appendOrderEvent(env, logOrderId || null, 'notify_failed', 'telegram', String(d.description || 'unknown'));
      }
    } catch (e) { failed++; }
  }
  return { sent, failed };
}
async function answerCallbackQuery(env, token, id, text, alert = false) {
  try { await tgApi(token, 'answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 200), show_alert: !!alert }); }
  catch (e) {}
}

// ===== 履约状态机：new → preparing → ready → done，只前进不后退 =====
const FULFIL_FLOW = ['new', 'preparing', 'ready', 'done'];
const FULFIL_LABEL = { new: '已下单', preparing: '制作中', ready: '可取餐/已出餐', done: '已完成' };
function normFulfilStatus(s) {
  // 严格要求字符串：`String(['ready'])` 会得到 'ready'，把一个数组当成合法状态收下。
  // 状态来自 callback_data / 请求体，不能给类型戏法留缝。
  if (typeof s !== 'string') return 'new';
  const v = s.trim().toLowerCase();
  return FULFIL_FLOW.includes(v) ? v : 'new';
}
// orders.note 这一列同时装着两种东西：顾客自己写的要求（「不要葱」），
// 和系统追加的记账注解（退款金额、金额不符告警等，形如 ` [退运费 S$8.00 储值8.00]`）。
// 厨房那块屏挂在墙上、人来人往，厨师需要的是前者；把退款账摊在上面既是噪音也是不必要的金额暴露。
function kitchenNote(note) {
  return String(note == null ? '' : note)
    .replace(/\s*\[(?:退|⚠|PAID_ON_CANCELLED|PARTIAL_REFUND|AMOUNT_MISMATCH)[^\]]*\]/g, '')
    .trim() || null;
}
async function appendOrderEvent(env, orderId, type, actor, message) {
  try {
    await env.DB.prepare('INSERT INTO order_events (id,order_id,actor,type,message,created_at) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), orderId, String(actor || '').slice(0, 80), String(type || '').slice(0, 40),
        String(message || '').slice(0, 300), new Date().toISOString()).run();
  } catch (e) { /* 事件流是辅助信息，写不进去不能影响主流程 */ }
}
// CAS 原子推进：UPDATE 带上「我以为的当前状态」，两个厨师同时点只有一个 changes=1。
// 目标状态不能等于或落后于当前状态 —— 状态永远只前进。
async function advanceFulfilStatus(env, orderId, next, actor) {
  const to = normFulfilStatus(next);
  const toIdx = FULFIL_FLOW.indexOf(to);
  if (toIdx <= 0) return { ok: false, code: 'bad_status', error: '未知的状态' };
  const o = await env.DB.prepare('SELECT id,invoice_no,fulfil_status FROM orders WHERE id=?').bind(orderId).first();
  if (!o) return { ok: false, code: 'not_found', error: '订单不存在' };
  const from = normFulfilStatus(o.fulfil_status);
  if (FULFIL_FLOW.indexOf(from) >= toIdx) {
    return { ok: true, noop: true, status: from, invoice_no: o.invoice_no, error: `订单已经是「${FULFIL_LABEL[from]}」` };
  }
  const ts = new Date().toISOString();
  const upd = await env.DB.prepare(
    "UPDATE orders SET fulfil_status=?, status_at=? WHERE id=? AND COALESCE(NULLIF(fulfil_status,''),'new')=?"
  ).bind(to, ts, orderId, from).run();
  if (!(upd.meta && upd.meta.changes === 1)) {
    const cur = await env.DB.prepare('SELECT fulfil_status FROM orders WHERE id=?').bind(orderId).first();
    const now = normFulfilStatus(cur && cur.fulfil_status);
    return { ok: true, noop: true, status: now, invoice_no: o.invoice_no, error: `已被其他人推进到「${FULFIL_LABEL[now]}」` };
  }
  await appendOrderEvent(env, orderId, 'fulfil:' + to, actor, `${from} → ${to}`);
  return { ok: true, status: to, from, invoice_no: o.invoice_no };
}
async function notifyNewOrderTelegram(env, orderId) {
  try {
    const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
    if (!o) return;
    let bomItems = []; try { bomItems = JSON.parse(o.items_json || '[]'); } catch (e) {}
    let text = renderOrderTelegram(o, await bomNameMap(env, bomItems));
    let rows = orderActionRows(o);   // 厨房推进 + 退运费，所有单都有
    if (o.fulfilment === 'anytime') {
      const shopName = await setting(env, 'shop_name');
      const shopAddress = await setting(env, 'shop_address');
      const shopDetail = await setting(env, 'shop_pickup_detail');
      const shopPostal = await setting(env, 'SHOP_POSTAL');
      const shopPhone = (await setting(env, 'shop_contact_phone')) || env.BOSS_PHONE;
      const domain = await shopDomain(env);
      const pickup = [shopName, shopAddress || (shopPostal ? `Singapore ${shopPostal}` : ''), shopDetail].filter(Boolean).join(' · ');
      const action = manualCourierTelegramPayload(o, pickup, shopPhone, domain);
      text += action.text;
      rows = rows.concat(action.rows);
    }
    await notifyTelegram(env, text, rows.length ? { reply_markup: { inline_keyboard: rows }, _order_id: o.id } : { _order_id: o.id });
  } catch (e) {}
}

// ===== 厨房小票自动打印：订单确认 → 入队 → 厨房设备来拉打印 =====
const PRINT_PROFILES = {
  // font_px 必须能装进 width_mm（见 maxFontPxFor）。原来 text80=12 / text58=11 都超纸宽，
  // 实纸上每根分隔线都会折行 —— 改成各自纸宽算得出的最大值。
  text80: { id: 'text80', label: '80mm 通用小票机', cols: 48, width_mm: 72, font_px: 9, line_height: 1.45 },
  text58: { id: 'text58', label: '58mm 通用小票机', cols: 32, width_mm: 48, font_px: 9, line_height: 1.4 },
  gp3120tn: { id: 'gp3120tn', label: 'GP-3120TN 76mm 标签机', cols: 32, width_mm: 76, font_px: 14, line_height: 1.45 },
};
function printProfile(id) {
  return PRINT_PROFILES[id] || PRINT_PROFILES.text80;
}
// 纸宽装得下的最大字号。等宽字体一个字符宽 ≈ 0.6em，纸宽换算 96dpi（1mm ≈ 3.7795px）。
// 不做这个钳制的后果是实纸上每一行都折行：text80 是 48 列 × 12px = 需要 346px，
// 而 72mm 只有 272px —— 溢出 28%，每根分隔线都断成两行拖个孤儿字符。
function maxFontPxFor(profile) {
  const cols = Math.max(1, +profile.cols || 48);
  const px = (+profile.width_mm || 72) * 3.7795;
  return Math.max(6, Math.floor(px / (cols * 0.6)));
}
function printFontPx(v, profile = PRINT_PROFILES.text80) {
  const cap = maxFontPxFor(profile);
  const n = Number(v);
  const want = Number.isFinite(n) && n >= 6 && n <= 16 ? Math.round(n) : (profile.font_px || 12);
  return Math.min(want, cap);   // 老板可以调小，但调不出纸宽
}
function cellWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE10 && cp <= 0xFE19) || (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6))) ? 2 : 1;
  }
  return w;
}
function cutCells(s, max) {
  let out = '', w = 0;
  for (const ch of String(s || '')) {
    const cw = cellWidth(ch);
    if (w + cw > max) break;
    out += ch; w += cw;
  }
  return out;
}
function padCells(s, width) {
  const t = String(s || '');
  return t + ' '.repeat(Math.max(0, width - cellWidth(t)));
}
function centerCells(s, width) {
  const t = cutCells(String(s || ''), width);
  const left = Math.floor(Math.max(0, width - cellWidth(t)) / 2);
  return ' '.repeat(left) + t;
}
function wrapCells(s, width, indent = '') {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const lines = [];
  let rest = clean, first = true;
  while (rest) {
    const prefix = first ? '' : indent;
    const take = cutCells(rest, Math.max(1, width - cellWidth(prefix)));
    lines.push(prefix + take);
    rest = rest.slice(take.length).trimStart();
    first = false;
  }
  return lines;
}
function receiptLine(char, width) { return char.repeat(width); }
function renderKitchenTicket(o, profile = PRINT_PROFILES.text80, bomNames = {}) {
  let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) {}
  const ful = { pickup: '自取 PICKUP', discount: '优惠配送', anytime: '本店配送/随时送', delivery: '配送', route: '拼单顺路送', walkin: '到店' }[o.fulfilment] || (o.fulfilment || '');
  const when = o.created_at ? new Date(new Date(o.created_at).getTime() + SGT_OFFSET_MIN * 60000).toISOString().slice(5, 16).replace('T', ' ') : '';
  const width = profile.cols || 48;
  const L = [receiptLine('=', width), centerCells('厨房单 KITCHEN', width), centerCells(o.pay_status === 'PAID' ? '已付款 PAID' : '待付款 UNPAID', width), receiptLine('-', width)];
  L.push(`单号 ${o.invoice_no}`);
  L.push(`下单 ${when}`);
  L.push(receiptLine('-', width));
  for (const i of items) {
    const prefix = `${i.qty} x `;
    const nameLines = wrapCells(i.name || i.sku || '商品', width - cellWidth(prefix), '  ');
    if (!nameLines.length) L.push(prefix.trim());
    else {
      L.push(prefix + nameLines[0]);
      for (const extra of nameLines.slice(1)) L.push(padCells('', cellWidth(prefix)) + extra);
    }
    // 套餐展开成分：后厨拿着这张纸就知道要做哪几样，不用回头问店主
    for (const s of kitchenLines(i, bomNames)) {
      L.push(...wrapCells(`  - ${s.qty} ${s.name}`, width, '    '));
    }
  }
  L.push(receiptLine('-', width), `方式 ${ful}`);
  if (o.deliver_at || o.deliver_time) L.push(`${o.fulfilment === 'pickup' ? '取餐' : '送达'} ${o.deliver_at || '今天'}${o.deliver_time ? ' ' + o.deliver_time : ''}`);
  if (o.address) L.push(...wrapCells(`${o.fulfilment === 'pickup' ? '取餐点' : '地址'} ${o.address}`, width, '  '));
  L.push(...wrapCells(`顾客 ${o.customer_name || '游客'} ${o.phone || ''}`.trim(), width, '  '));
  L.push(`合计 S$${(+o.total || 0).toFixed(2)}`);
  if (o.note) L.push(receiptLine('-', width), ...wrapCells(`备注 ${o.note}`, width, '  '));
  L.push(receiptLine('=', width), '', '');
  return L.join('\n');
}
function sampleKitchenOrder() {
  return {
    id: 'PREVIEW',
    invoice_no: 'ORD-20260630-0088',
    created_at: new Date().toISOString(),
    customer_name: '陈先生',
    phone: '8000 0003',
    items_json: JSON.stringify([
      { sku: 'SET1', name: '叻沙套餐 Laksa Set', qty: 1, unit_price: 10.8 },
      { sku: 'R01', name: '鸡饭 Chicken Rice', qty: 2, unit_price: 4.5 },
      { sku: 'D01', name: '冰茶 Iced Tea', qty: 1, unit_price: 2.8 },
    ]),
    total: 22.6,
    fulfilment: 'pickup',
    deliver_at: sgtTodayStr(),
    deliver_time: '12:30',
    pay_status: 'PAID',
    note: '少辣，分开打包；其中一盒不要香菜',
  };
}
// 入队（幂等：UNIQUE(order_id,kind) → 同单同类型只入一次，重复确认/重试不重复打）。打印失败绝不拖垮下单。
async function enqueueKitchenTicket(env, order) {
  if (!order || !order.id) return;
  try {
    const profile = printProfile(await setting(env, 'print_profile'));
    let ticketItems = []; try { ticketItems = JSON.parse(order.items_json || '[]'); } catch (e) {}
    const ticketNames = await bomNameMap(env, ticketItems);
    await env.DB.prepare(`INSERT INTO print_jobs (id,order_id,kind,content,status,created_at) VALUES (?,?, 'kitchen', ?, 'pending', ?)
      ON CONFLICT(order_id, kind) DO UPDATE SET content=CASE WHEN print_jobs.status='pending' THEN excluded.content ELSE print_jobs.content END`).bind(crypto.randomUUID(), order.id, renderKitchenTicket(order, profile, ticketNames), new Date().toISOString()).run();
  } catch (e) { /* 打印队列失败不影响订单 */ }
}

async function listPendingKitchenTickets(env, profile, limit = 20) {
  const printWhen = (await setting(env, 'print_when')) || 'paid';
  const paidOnly = printWhen !== 'placed' ? 1 : 0;
  const { results } = await env.DB.prepare(`SELECT pj.id,pj.order_id,pj.content,pj.created_at
    FROM print_jobs pj LEFT JOIN orders o ON o.id=pj.order_id
    WHERE pj.status='pending'
      AND (o.id IS NULL OR o.pay_status NOT IN ('CANCELLED','REFUNDED'))
      AND (?=0 OR o.id IS NULL OR o.pay_status='PAID')
    ORDER BY pj.created_at LIMIT ?`).bind(paidOnly, Math.max(1, Math.min(50, limit))).all();
  const jobs = [];
  for (const row of results || []) {
    let content = row.content || '';
    if (row.order_id && !String(row.order_id).startsWith('TEST-')) {
      const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(row.order_id).first();
      if (order) {
        let its = []; try { its = JSON.parse(order.items_json || '[]'); } catch (e) {}
        content = renderKitchenTicket(order, profile, await bomNameMap(env, its));
      }
    }
    jobs.push({ ...row, content });
  }
  return jobs;
}

// ---- admin auth: Bearer token compared to ADMIN_TOKEN secret ----
// The optional secret ADMIN_TOKEN_SECONDARY is an owner-authorised second boss login with
// the same authority, rotated or revoked on its own; it is not a user account system.
// It uses strict single-bearer parsing and ignores bindings shorter than 32 characters.
// The original ADMIN_TOKEN check is unchanged.
const ADDITIONAL_ADMIN_TOKEN_MIN_LENGTH = 32;
function isAdmin(req, env) {
  if (env && env[AGENT_ADMIN] === true) return true;   // internal call from worker/agent.js after key + scope checks
  const h = req.headers.get('authorization') || '';
  const t = h.replace(/^Bearer\s+/i, '');
  const owner = !!(env.ADMIN_TOKEN && t && _eq(t, env.ADMIN_TOKEN));   // 常量时间比较，防 token 时序侧信道
  const match = /^(?:Bearer) ([^\s]+)$/i.exec(h);
  const additional = typeof env.ADMIN_TOKEN_SECONDARY === 'string' ? env.ADMIN_TOKEN_SECONDARY : '';
  const second = !!match && additional.length >= ADDITIONAL_ADMIN_TOKEN_MIN_LENGTH && _eq(match[1], additional);
  return owner || second;
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy wallet claim —— 历史储值（members.user_id IS NULL）柜台核验后并入 OAuth 账号
//
// 【威胁模型】2026-07-30 CRITICAL 的直接后果：绝不能让顾客自报手机号决定钱归谁。
// 本流程把三件事强行绑在一起，缺一不可：
//   ① 哪一行 legacy 钱包 —— 由店员在 POS 上搜出来并发起，顾客无法指定；
//   ② 哪一个新账号       —— 由一次真实的 Google/Apple 会话证明（verifySession），手机号不参与；
//   ③ 是不是本人         —— 柜台当面，老板看着绑上来的邮箱按批准键。
// 钱只在 ③ 之后动。②③ 之间一定隔一个人。
//
// 【防重放】五层，全在 SQL 里，不靠 JS 判断：
//   L1 idx_legacy_claims_open   UNIQUE(legacy_phone) WHERE status IN ('pending','awaiting_approval')
//   L2 members 行余额 CAS       只认 changes===1 为赢家，且期望余额必须与老板屏幕一致
//   L3 idx_legacy_merges_live   UNIQUE(legacy_phone) WHERE status='committed'
//   L4 wallet_events.ref        UNIQUE（0012 已建）
//   L5 idx_legacy_merges_token  UNIQUE(client_token)
// ═══════════════════════════════════════════════════════════════════════════

const LEGACY_CLAIM_TTL_MS  = 15 * 60000;   // 票据 15 分钟过期
const LEGACY_CLAIM_MAX_TRY = 5;            // 配对码错 5 次作废
const LEGACY_BACKFILL_CAP  = 200;          // 单次回填 id 上限（防 D1 batch 语句数爆）

function maskPhoneTail(p) {
  const s = String(p || '');
  return s.length <= 4 ? '****' : s.slice(0, 2) + '****' + s.slice(-2);
}
function maskEmail(e) {
  const s = String(e || ''); const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return s[0] + '***' + s.slice(at);
}
function maskName(n) {
  const s = String(n || '').trim();
  return s ? s.slice(0, 1) + '*' : '';
}
function _pairCode() {
  // crypto 随机，不用 Math.random（与 genOtp :957 同口径）
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}

// 唯一权威取数口径：一行「活的」legacy 钱包 = user_id IS NULL 且还没被合并。
// 所有分支都走它，避免各处 WHERE 条件漂移导致「墓碑行又被当活钱包」。
async function legacyWalletRow(env, phone) {
  const p = normPhone(phone);
  if (!p) return null;
  return env.DB.prepare(
    `SELECT phone,name,balance,points,total_spent,orders_count,merged_to_user_id,merged_at,created_at,updated_at
       FROM members WHERE phone=? AND user_id IS NULL`).bind(p).first();
}

// ── 店员：查号 ─────────────────────────────────────────────────────────────
// 不新增暴露面：/api/pos/member（:1924）本来就把 legacy 余额返给 staff 了。
async function legacyLookup(env, phone) {
  const row = await legacyWalletRow(env, phone);
  if (!row) return { found: false };
  if (row.merged_to_user_id) {
    const ua = await env.DB.prepare(
      `SELECT a.id, (SELECT GROUP_CONCAT(email) FROM auth_identities WHERE user_id=a.id) email
         FROM user_accounts a WHERE a.id=?`).bind(row.merged_to_user_id).first();
    return { found: true, merged: true, phone_mask: maskPhoneTail(row.phone), balance: 0,
      merged_to_email: maskEmail(ua && ua.email), merged_at: row.merged_at,
      hint: '该手机号的历史储值已并入线上账号，请让顾客直接登录使用。' };
  }
  const open = await env.DB.prepare(
    `SELECT id,pair_code,status,expires_at,user_id FROM legacy_claims
      WHERE legacy_phone=? AND status IN ('pending','awaiting_approval')`).bind(row.phone).first();
  return { found: true, merged: false, phone_mask: maskPhoneTail(row.phone), name: maskName(row.name),
    balance: +(+(row.balance || 0)).toFixed(2), points: row.points || 0,
    open_claim: open ? { id: open.id, pair_code: open.pair_code, status: open.status, expires_at: open.expires_at } : null };
}

// ── 店员：发起认领票据 ─────────────────────────────────────────────────────
// 只创建票据，不动钱，可取消。已有未决票据 → 幂等返回它（L1 索引保证只可能有一张）。
async function legacyClaimStart(env, { phone, actor }) {
  const row = await legacyWalletRow(env, phone);
  if (!row) return { error: '未找到该手机号的历史储值会员', _status: 404 };
  if (row.merged_to_user_id) return { error: '该手机号已并入线上账号，无需再合并', _status: 409 };
  const bal = +(+(row.balance || 0)).toFixed(2);
  if (!(bal > 0)) return { error: '该手机号余额为 0，无需合并', _status: 400 };

  const now = new Date(), nowIso = now.toISOString();
  // 顺手把过期票据落终态，免得 L1 唯一索引被僵尸票占住
  await env.DB.prepare(
    `UPDATE legacy_claims SET status='expired' WHERE expires_at<=? AND status IN ('pending','awaiting_approval')`)
    .bind(nowIso).run();

  const open = await env.DB.prepare(
    `SELECT id,pair_code,status,expires_at FROM legacy_claims
      WHERE legacy_phone=? AND status IN ('pending','awaiting_approval')`).bind(row.phone).first();
  if (open) return { ok: true, deduped: true, claim_id: open.id, pair_code: open.pair_code,
    status: open.status, expires_at: open.expires_at, balance: bal, phone_mask: maskPhoneTail(row.phone) };

  const expires = new Date(now.getTime() + LEGACY_CLAIM_TTL_MS).toISOString();
  // 配对码撞车（idx_legacy_claims_code）就重摇，最多 8 次
  for (let i = 0; i < 8; i++) {
    const id = crypto.randomUUID(), code = _pairCode();
    try {
      await env.DB.prepare(
        `INSERT INTO legacy_claims(id,pair_code,legacy_phone,balance_at_start,status,created_by,expires_at,created_at)
         VALUES (?,?,?,?, 'pending',?,?,?)`).bind(id, code, row.phone, bal, actor, expires, nowIso).run();
      return { ok: true, claim_id: id, pair_code: code, status: 'pending', expires_at: expires,
        balance: bal, phone_mask: maskPhoneTail(row.phone),
        instruction: `请顾客用手机打开本店网站，用 Google 或 Apple 登录后输入 ${code}` };
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(e.message || '')) throw e;
      // 撞 idx_legacy_claims_open → 并发下别人刚建了一张，回查返回
      const race = await env.DB.prepare(
        `SELECT id,pair_code,status,expires_at FROM legacy_claims
          WHERE legacy_phone=? AND status IN ('pending','awaiting_approval')`).bind(row.phone).first();
      if (race) return { ok: true, deduped: true, claim_id: race.id, pair_code: race.pair_code,
        status: race.status, expires_at: race.expires_at, balance: bal, phone_mask: maskPhoneTail(row.phone) };
      // 否则是 pair_code 撞车，重摇
    }
  }
  return { error: '配对码生成失败，请重试', _status: 503 };
}

async function legacyClaimCancel(env, { claimId, actor }) {
  const ts = new Date().toISOString();
  const r = await env.DB.prepare(
    `UPDATE legacy_claims SET status='cancelled', decided_by=?, decided_at=?
      WHERE id=? AND status IN ('pending','awaiting_approval')`).bind(actor, ts, claimId).run();
  if (!(r.meta && r.meta.changes === 1)) return { error: '票据不存在或已终结', _status: 409 };
  return { ok: true };
}

// ── 顾客：用 6 位配对码把自己的账号绑到票据上 ───────────────────────────────
// ★ 这一步【不动一分钱】。就算配对码被猜中，也只是让老板在后台看到一个陌生邮箱，
//   老板当面一对就会拒绝。这是配对码可以只用 6 位的根本原因。
async function legacyClaimBind(env, { code, userId }) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return { error: '请输入 6 位核验码', _status: 400 };
  const nowIso = new Date().toISOString();

  const claim = await env.DB.prepare(
    `SELECT id,legacy_phone,balance_at_start,status,user_id,tries,expires_at
       FROM legacy_claims WHERE pair_code=? AND status IN ('pending','awaiting_approval')`).bind(c).first();
  // 统一话术，不区分「码不存在」和「码过期」，避免变成探测器
  if (!claim || claim.expires_at <= nowIso) return { error: '核验码无效或已过期，请让店员重新发起', _status: 404 };
  if (claim.tries >= LEGACY_CLAIM_MAX_TRY) return { error: '该核验码已作废，请让店员重新发起', _status: 429 };
  if (claim.status === 'awaiting_approval') {
    if (claim.user_id === userId) {
      return { ok: true, deduped: true, status: 'awaiting_approval',
        phone_mask: maskPhoneTail(claim.legacy_phone), balance: +(+claim.balance_at_start).toFixed(2),
        message: '已绑定，请等待店内核验通过。' };
    }
    return { error: '该核验码已被其他账号使用，请让店员重新发起', _status: 409 };
  }

  // 原子绑定：只有 status 仍是 pending 的那一路能写成功
  const r = await env.DB.prepare(
    `UPDATE legacy_claims SET status='awaiting_approval', user_id=?, bound_at=?
      WHERE id=? AND status='pending' AND expires_at>?`).bind(userId, nowIso, claim.id, nowIso).run();
  if (!(r.meta && r.meta.changes === 1)) return { error: '核验码无效或已过期，请让店员重新发起', _status: 409 };

  return { ok: true, status: 'awaiting_approval', phone_mask: maskPhoneTail(claim.legacy_phone),
    balance: +(+claim.balance_at_start).toFixed(2),
    message: '已绑定成功，请在店内让店员/老板确认后完成合并。' };
}

// 配对码输错时记一次 tries（在路由层调用，见挂载点说明）
async function legacyClaimMiss(env, code) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return;
  await env.DB.prepare(
    `UPDATE legacy_claims SET tries=tries+1 WHERE pair_code=? AND status='pending'`).bind(c).run();
}

// ── 老板：提交合并（唯一动钱的一步）─────────────────────────────────────────
async function legacyMergeCommit(env, { claimId, expectedBalance, actor, clientToken }) {
  const now = new Date().toISOString();

  // L5 幂等：同 client_token 已提交 → 回放旧结果
  if (clientToken) {
    const dup = await env.DB.prepare('SELECT * FROM legacy_merges WHERE client_token=?').bind(clientToken).first();
    if (dup) return { ok: true, deduped: true, merge_id: dup.id, legacy_phone: dup.legacy_phone,
      user_id: dup.user_id, balance_moved: +(+dup.balance_moved).toFixed(2) };
  }

  const claim = await env.DB.prepare(
    'SELECT id,legacy_phone,user_id,status,expires_at FROM legacy_claims WHERE id=?').bind(claimId).first();
  if (!claim) return { error: '认领票据不存在', _status: 404 };
  if (claim.status !== 'awaiting_approval') return { error: `票据状态为 ${claim.status}，不可合并`, _status: 409 };
  if (!claim.user_id) return { error: '顾客尚未完成 Google/Apple 登录绑定', _status: 409 };
  if (claim.expires_at <= now) return { error: '票据已过期，请让店员重新发起', _status: 410 };

  const legacy = await legacyWalletRow(env, claim.legacy_phone);
  if (!legacy) return { error: 'legacy 钱包行不存在', _status: 404 };
  if (legacy.merged_to_user_id) return { error: '该手机号已合并过', _status: 409 };

  const bal  = +(+(legacy.balance || 0)).toFixed(2);
  const want = +(+expectedBalance).toFixed(2);
  // ★ 期望余额闸门：老板批的必须是他屏幕上看见的那个数。
  //   中途有人充值/调账 → 直接作废，杜绝「批准 S$75 结果搬走 S$575」。
  if (!Number.isFinite(want)) return { error: '缺少 expected_balance', _status: 400 };
  if (Math.abs(bal - want) >= 0.005) {
    return { error: `余额已变动（你看到的 S$${want.toFixed(2)} → 实际 S$${bal.toFixed(2)}），请刷新后重新批准`,
      _status: 409, balance: bal };
  }
  if (!(bal > 0)) return { error: '该手机号余额为 0，无需合并', _status: 400 };

  const target = await env.DB.prepare('SELECT id FROM user_accounts WHERE id=?').bind(claim.user_id).first();
  if (!target) return { error: '目标账号不存在', _status: 404 };

  // ── 历史回填的 id 白名单（全部先查出来，batch 里按 id 精确 UPDATE）──────
  // orders.phone 是脏数据（生产实测：长度 8 和 10 混存，6 单带 +65/空格/横杠），
  // 不能在 SQL 里 REPLACE 硬拼 —— 取候选后用 normPhone() 在 JS 里判等。
  const { results: cand } = await env.DB.prepare(
    `SELECT id,phone FROM orders WHERE user_id IS NULL AND phone IS NOT NULL AND phone!='' LIMIT 5000`).all();
  const orderIds = (cand || []).filter(o => normPhone(o.phone) === legacy.phone)
    .map(o => o.id).slice(0, LEGACY_BACKFILL_CAP);

  // topups.phone 由 creditTopup(:782) 写入时已 normPhone，可直接等值匹配
  const { results: tu } = await env.DB.prepare(
    'SELECT id FROM topups WHERE phone=? AND user_id IS NULL LIMIT ?').bind(legacy.phone, LEGACY_BACKFILL_CAP).all();
  const topupIds = (tu || []).map(r => r.id);

  // ★ 生产里这 14 人的【消费】全部是 wallet_events(type='adjustment') 的老板手工扣减，
  //   orders.paid_by_balance 合计为 0。不回填这张表，顾客登录后只看得到「充了多少」、
  //   看不到「扣到哪去了」，余额和流水对不上，柜台必吵。
  const { results: we } = await env.DB.prepare(
    'SELECT id FROM wallet_events WHERE phone=? AND user_id IS NULL LIMIT ?').bind(legacy.phone, LEGACY_BACKFILL_CAP).all();
  const eventIds = (we || []).map(r => r.id);

  const mergeId = crypto.randomUUID();
  const ref  = `legacy_merge:${legacy.phone}:${mergeId}`;
  const note = `历史储值并入账号（票据 ${claim.id}，批准人 ${actor}，原号 ${maskPhoneTail(legacy.phone)}）`;
  const pts = legacy.points || 0;
  const spent = +(+(legacy.total_spent || 0)).toFixed(2);
  const oc = legacy.orders_count || 0;

  await ensureUserLedger(env, claim.user_id, now);   // 目标账号可能还没有 members 行

  const writes = [
    // ① L2 CAS：认领 legacy 行 —— 清零 + 打墓碑。changes===1 = 本次是唯一赢家。
    //    条件同时锁死：还是 legacy（user_id IS NULL）、没被合并过、余额恰好等于老板批的数。
    env.DB.prepare(
      `UPDATE members SET balance=0, points=0, total_spent=0, orders_count=0,
         merged_to_user_id=?, merged_at=?, updated_at=?
       WHERE phone=? AND user_id IS NULL AND merged_to_user_id IS NULL
         AND abs(round(COALESCE(balance,0),2) - ?) < 0.005`)
      .bind(claim.user_id, now, now, legacy.phone, bal),

    // ② 目标账号入账。条件门挂在 ① 的墓碑标记上（同一 batch = 同一 SQLite 写事务，
    //    读己写：① 成了 ② 的 EXISTS 必真；① 没成 ② 必不动）。
    env.DB.prepare(
      `UPDATE members SET balance=round(balance+?,2), points=points+?,
         total_spent=round(total_spent+?,2), orders_count=orders_count+?, updated_at=?
       WHERE user_id=? AND EXISTS(
         SELECT 1 FROM members WHERE phone=? AND merged_at=? AND merged_to_user_id=?)`)
      .bind(bal, pts, spent, oc, now, claim.user_id, legacy.phone, now, claim.user_id),

    // ③ L4 钱包流水（append-only）。wallet_events.ref UNIQUE（0012）兜底防重。
    env.DB.prepare(
      `INSERT INTO wallet_events(id,type,ref,order_id,phone,user_id,amount,created_at,note)
       SELECT ?, 'legacy_merge', ?, NULL, ?, ?, ?, ?, ?
        WHERE EXISTS(SELECT 1 FROM members WHERE phone=? AND merged_at=? AND merged_to_user_id=?)`)
      .bind(crypto.randomUUID(), ref, legacy.phone, claim.user_id, bal, now, note,
            legacy.phone, now, claim.user_id),

    // ④ 票据落终态
    env.DB.prepare(
      `UPDATE legacy_claims SET status='committed', decided_by=?, decided_at=?
        WHERE id=? AND status='awaiting_approval'`).bind(actor, now, claim.id),

    // ⑤ L3 合并台账（partial UNIQUE(legacy_phone) WHERE status='committed' 在这里挡第二次）
    env.DB.prepare(
      `INSERT INTO legacy_merges(id,claim_id,legacy_phone,user_id,balance_moved,points_moved,spent_moved,
         orders_moved,order_ids_json,topup_ids_json,event_ids_json,status,committed_by,committed_at,client_token)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'committed',?,?,?)`)
      .bind(mergeId, claim.id, legacy.phone, claim.user_id, bal, pts, spent, orderIds.length,
            JSON.stringify(orderIds), JSON.stringify(topupIds), JSON.stringify(eventIds),
            actor, now, clientToken || null),
  ];
  // ⑥ 历史归属回填 —— 一律按 id 白名单，绝不按 phone 模糊 UPDATE
  for (const id of orderIds) writes.push(
    env.DB.prepare('UPDATE orders SET user_id=? WHERE id=? AND user_id IS NULL').bind(claim.user_id, id));
  for (const id of topupIds) writes.push(
    env.DB.prepare('UPDATE topups SET user_id=? WHERE id=? AND user_id IS NULL').bind(claim.user_id, id));
  for (const id of eventIds) writes.push(
    env.DB.prepare('UPDATE wallet_events SET user_id=? WHERE id=? AND user_id IS NULL').bind(claim.user_id, id));

  let res;
  try {
    res = await env.DB.batch(writes);
  } catch (e) {
    // 并发第二次提交 → L3 / L4 / L5 任一 UNIQUE 冲突 → 整批 rollback（钱一分没动）
    if (/UNIQUE|constraint/i.test(e.message || '')) {
      const live = await env.DB.prepare(
        "SELECT id,legacy_phone,user_id,balance_moved FROM legacy_merges WHERE legacy_phone=? AND status='committed'")
        .bind(legacy.phone).first();
      if (live) return { ok: true, deduped: true, merge_id: live.id, legacy_phone: live.legacy_phone,
        user_id: live.user_id, balance_moved: +(+live.balance_moved).toFixed(2) };
      return { error: '合并冲突，请刷新后重试', _status: 409 };
    }
    throw e;
  }
  // 权威成功信号只看 ① 的 CAS
  if (!(res[0].meta && res[0].meta.changes === 1)) {
    return { error: '合并未生效（余额被并发改动或该号已被合并），请刷新后重试', _status: 409 };
  }

  // 尽力而为的后置动作：账号还没填手机号的话，把 legacy 号写上去，
  // 让以后店员按这个号充值能经 accountByPhone(:732) 正确落到账号上。
  // 撞 idx_user_accounts_phone UNIQUE 就算了 —— 绝不因为这一步影响已完成的合并。
  try {
    await env.DB.prepare(
      `UPDATE user_accounts SET phone=?, updated_at=? WHERE id=? AND (phone IS NULL OR phone='')`)
      .bind(legacy.phone, now, claim.user_id).run();
  } catch (e) { /* phone 已被别的账号占用，忽略 */ }

  const after = await env.DB.prepare('SELECT balance FROM members WHERE user_id=?').bind(claim.user_id).first();
  return { ok: true, merge_id: mergeId, legacy_phone: legacy.phone, phone_mask: maskPhoneTail(legacy.phone),
    user_id: claim.user_id, balance_moved: bal, points_moved: pts,
    orders_moved: orderIds.length, topups_moved: topupIds.length, events_moved: eventIds.length,
    balance_after: +(((after && after.balance) || 0)).toFixed(2) };
}

// ── 老板：撤销合并 ─────────────────────────────────────────────────────────
async function legacyMergeUndo(env, { mergeId, reason, actor }) {
  const now = new Date().toISOString();
  const m = await env.DB.prepare('SELECT * FROM legacy_merges WHERE id=?').bind(mergeId).first();
  if (!m) return { error: '合并记录不存在', _status: 404 };
  if (m.status !== 'committed') return { error: `该合并状态为 ${m.status}，无需撤销`, _status: 409 };

  const bal   = +(+(m.balance_moved || 0)).toFixed(2);
  const pts   = m.points_moved || 0;
  const spent = +(+(m.spent_moved || 0)).toFixed(2);
  const oc    = m.orders_moved || 0;

  // 先给人话报错（真正的门在 ① 的 EXISTS 里，见下）
  const cur  = await env.DB.prepare('SELECT balance FROM members WHERE user_id=?').bind(m.user_id).first();
  const have = +(((cur && cur.balance) || 0)).toFixed(2);
  if (have < bal) {
    return { error: `账号当前余额 S$${have.toFixed(2)} 少于已并入的 S$${bal.toFixed(2)}（顾客已消费），不能整单撤销；请改用逐笔余额调整处理`,
      _status: 409, balance: have };
  }

  let orderIds = [], topupIds = [], eventIds = [];
  try { orderIds = JSON.parse(m.order_ids_json || '[]'); } catch (e) {}
  try { topupIds = JSON.parse(m.topup_ids_json || '[]'); } catch (e) {}
  try { eventIds = JSON.parse(m.event_ids_json || '[]'); } catch (e) {}
  const ref = `legacy_unmerge:${m.legacy_phone}:${mergeId}`;
  const why = String(reason || '').trim().slice(0, 240) || 'boss_undo';

  const writes = [
    // ① 原子 claim 撤销权 + 把「余额够扣」的硬门写进【同一条】语句。
    //    整个 batch 是一个 SQLite 写事务，① 和 ② 之间没有别的 commit 能改 balance，
    //    所以 ①.changes===1 ⟺ ②.changes===1 —— 不存在「墓碑复活了但钱没扣回来」的半成品。
    env.DB.prepare(
      `UPDATE legacy_merges SET status='reversed', reversed_by=?, reversed_at=?, reverse_reason=?
        WHERE id=? AND status='committed'
          AND EXISTS(SELECT 1 FROM members WHERE user_id=? AND round(COALESCE(balance,0),2) >= ?)`)
      .bind(actor, now, why, mergeId, m.user_id, bal),

    // ② 账号扣回
    env.DB.prepare(
      `UPDATE members SET balance=round(balance-?,2), points=MAX(0,points-?),
         total_spent=MAX(0,round(total_spent-?,2)), orders_count=MAX(0,orders_count-?), updated_at=?
       WHERE user_id=? AND round(COALESCE(balance,0),2) >= ?
         AND EXISTS(SELECT 1 FROM legacy_merges WHERE id=? AND status='reversed' AND reversed_at=?)`)
      .bind(bal, pts, spent, oc, now, m.user_id, bal, mergeId, now),

    // ③ 墓碑复原 —— 钱回到 legacy 行，标记清掉，可以重新合并给正确的人
    env.DB.prepare(
      `UPDATE members SET balance=round(balance+?,2), points=points+?,
         total_spent=round(total_spent+?,2), orders_count=orders_count+?,
         merged_to_user_id=NULL, merged_at=NULL, updated_at=?
       WHERE phone=? AND user_id IS NULL AND merged_to_user_id=?
         AND EXISTS(SELECT 1 FROM legacy_merges WHERE id=? AND status='reversed' AND reversed_at=?)`)
      .bind(bal, pts, spent, oc, now, m.legacy_phone, m.user_id, mergeId, now),

    // ④ 补偿流水（append-only，绝不删原 legacy_merge 事件）
    env.DB.prepare(
      `INSERT INTO wallet_events(id,type,ref,order_id,phone,user_id,amount,created_at,note)
       SELECT ?, 'legacy_unmerge', ?, NULL, ?, ?, ?, ?, ?
        WHERE EXISTS(SELECT 1 FROM legacy_merges WHERE id=? AND status='reversed' AND reversed_at=?)`)
      .bind(crypto.randomUUID(), ref, m.legacy_phone, m.user_id, -bal, now,
            `撤销历史储值合并（${why}，操作人 ${actor}）`, mergeId, now),

    // ⑤ 票据回滚成 cancelled，店员可以重新发起
    env.DB.prepare(
      `UPDATE legacy_claims SET status='cancelled', decided_by=?, decided_at=? WHERE id=? AND status='committed'`)
      .bind(actor, now, m.claim_id),
  ];
  // ⑥ 历史归属回滚 —— 按 id 白名单 + 限定 user_id，绝不误伤别人的行
  for (const id of orderIds) writes.push(
    env.DB.prepare('UPDATE orders SET user_id=NULL WHERE id=? AND user_id=?').bind(id, m.user_id));
  for (const id of topupIds) writes.push(
    env.DB.prepare('UPDATE topups SET user_id=NULL WHERE id=? AND user_id=?').bind(id, m.user_id));
  for (const id of eventIds) writes.push(
    env.DB.prepare('UPDATE wallet_events SET user_id=NULL WHERE id=? AND user_id=?').bind(id, m.user_id));

  const res = await env.DB.batch(writes);
  if (!(res[0].meta && res[0].meta.changes === 1)) {
    return { error: '撤销未生效（已被撤销，或账号余额已不足以扣回）', _status: 409 };
  }
  const after = await env.DB.prepare('SELECT balance FROM members WHERE user_id=?').bind(m.user_id).first();
  return { ok: true, merge_id: mergeId, legacy_phone: m.legacy_phone, phone_mask: maskPhoneTail(m.legacy_phone),
    balance_returned: bal, balance_after: +(((after && after.balance) || 0)).toFixed(2) };
}

// ── 老板：待救名单 / 待批列表 ───────────────────────────────────────────────
async function legacyWalletsReport(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.phone, m.name, ROUND(m.balance,2) balance, m.points, m.created_at, m.updated_at,
            (SELECT COUNT(*) FROM topups t WHERE t.phone=m.phone) topups_n,
            (SELECT MAX(t.created_at) FROM topups t WHERE t.phone=m.phone) last_topup_at,
            (SELECT COUNT(*) FROM wallet_events w WHERE w.phone=m.phone) events_n,
            (SELECT c.status FROM legacy_claims c
              WHERE c.legacy_phone=m.phone AND c.status IN ('pending','awaiting_approval') LIMIT 1) open_claim,
            -- 这个手机号是不是已经有人登录在用了：有的话这个人【此刻正对着 0 余额】，要优先处理
            (SELECT a.id FROM user_accounts a WHERE a.phone=m.phone LIMIT 1) waiting_user_id,
            (SELECT GROUP_CONCAT(i.email) FROM user_accounts a JOIN auth_identities i ON i.user_id=a.id
              WHERE a.phone=m.phone) waiting_email
       FROM members m
      WHERE m.user_id IS NULL AND m.merged_to_user_id IS NULL AND m.balance>0
      ORDER BY m.balance DESC`).all();
  const rows = results || [];
  return { members: rows, count: rows.length,
    total: +rows.reduce((s, r) => s + (+r.balance || 0), 0).toFixed(2) };
}

async function legacyClaimsList(env, status) {
  const s = ['pending', 'awaiting_approval', 'committed', 'cancelled', 'expired'].includes(status) ? status : null;
  const sql = `SELECT c.id, c.pair_code, c.legacy_phone, ROUND(c.balance_at_start,2) balance, c.status,
      c.user_id, c.created_by, c.bound_at, c.decided_by, c.decided_at, c.expires_at, c.created_at,
      ua.name target_name,
      (SELECT GROUP_CONCAT(email)    FROM auth_identities WHERE user_id=c.user_id) target_email,
      (SELECT GROUP_CONCAT(provider) FROM auth_identities WHERE user_id=c.user_id) target_providers
    FROM legacy_claims c LEFT JOIN user_accounts ua ON ua.id=c.user_id
    ${s ? 'WHERE c.status=?' : "WHERE c.status IN ('pending','awaiting_approval')"}
    ORDER BY c.created_at DESC LIMIT 200`;
  const st = env.DB.prepare(sql);
  const { results } = s ? await st.bind(s).all() : await st.all();
  return { claims: results || [] };
}

// ── 顾客侧提示（安全版，见 artifact D 的泄露评估）─────────────────────────
// 判据【不是】「你填的手机号有没有 legacy 钱包」（那是探测器），
// 而是「店员是否已经为这个号发起了认领票据」。攻击者按不了店员那个键，
// 所以对他而言这个接口永远返回同一个 {pending:false}，零 oracle。
// 账号模型从「手机号是身份主键」改成「user_id 是主键」之后，members 那批行没跟着迁移：
// 钱还挂在手机号上，人却已经用 Google/Apple 登进了一个新账号 —— 于是顾客登录后看到余额 0，
// 一个字的解释都没有。这个函数让他至少知道"钱在，去店里认领"。
//
// 为什么敢把金额显示给他：这个手机号写在【他自己账号】上，而 user_accounts.phone 有 UNIQUE 索引，
// 同一个号只可能挂在一个账号上。就算有人抢注了别人的号，他也只是看到一个数字 ——
// 钱要动，仍然必须老板当面看着邮箱批准（legacyMergeCommit）。
async function legacyPendingFor(env, userId) {
  const a = await env.DB.prepare('SELECT phone FROM user_accounts WHERE id=?').bind(userId).first();
  const p = a && normPhone(a.phone);
  if (!p) return null;
  const row = await env.DB.prepare(
    `SELECT phone, COALESCE(balance,0) balance FROM members
      WHERE phone=? AND user_id IS NULL AND merged_to_user_id IS NULL AND COALESCE(balance,0) > 0.005`).bind(p).first();
  if (!row) return null;
  // ⚠️ 故意不返回金额：手机号可以在 /api/auth/profile 里随便改、且没有限流，
  // 一旦把余额数报出去，任何人都能拿一个账号循环试号，扫出"哪个号里有多少钱"。
  // 顾客知道"有一笔待认领、去店里找店员"就够了，具体数目由店员当面告诉他。
  return {
    phone_mask: maskPhoneTail(row.phone),
    message: '你这个手机号还有一笔历史储值没有并到这个账号上。请到店联系店员帮你合并，钱不会丢。',
  };
}

async function legacyHint(env, userId) {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT 1 ok FROM legacy_claims c
       JOIN user_accounts ua ON ua.phone = c.legacy_phone
      WHERE ua.id = ? AND c.status = 'pending' AND c.expires_at > ? LIMIT 1`)
    .bind(userId, now).first();
  if (!row) return { pending: false };   // 恒定形状：无票据 / 无 legacy 行 / 已合并，一律这个
  return { pending: true,
    message: '店员已为你发起历史储值核验，请在会员页输入店员给你的 6 位核验码。' };
}

const WALLET_LEDGER_TOLERANCE_CENTS = 1;   // 0.01 —— 整数分累加下只允许四舍五入级别的误差
// 脏日期（生产历史上真出现过 '15/07/2026T12:00:00.000Z' 这种）会让排序错位，
// 而排序错位算出来的 balance_after 是错的 —— 但【求和与顺序无关】，所以只校验终值发现不了它。必须单独判。
function walletIso(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}
// 从 0 正序累加，用【整数分】避免浮点漂移，最后把累加终值与 members.balance 对账。
//
// ⚠️ 这里的写法是有意的，别再"简化"成从 members.balance 倒着减：
// 倒减等于把 members.balance 当锚点无条件信任，任何差额都会被结构性地推到最老那一行的
// 隐式起始余额里，而那个值从不显示给顾客 —— 于是错账永远不可见。生产库里已经有 16 笔
// 本代码没有写入路径的 adjustment（合计 −967.10），证明"绕过账本改余额"真的发生过。
// 正序累加 + 终值对账才是错账探测器；对不上就把整列 balance_after 摘掉并标 reliable:false，
// 宁可少显示一列，也绝不给顾客看一串"数值自洽但历史错误"的余额。
// ⚠️ 排序里的 `CASE WHEN delta<0 THEN 0 ELSE 1 END`（在 SQL 侧）是必需的：
// 充值和用这笔钱下的单常常落在【同一秒】，只按 created_at 排会把充值排到消费后面，
// 逆推出来的"变动后余额"就会中途变成负数 —— 总额还是对的（reliable 仍为 true），
// 所以这种错账不会被自校验抓住，只会让顾客看到一行 S$-62.00 打电话来问。
// 倒序展示时同一秒内先列支出（它发生在后），充值垫底。
function walletLedgerWithBalances(rows, currentBalance, opts = {}) {
  const list = (rows || []).map(row => ({
    ...row,
    delta: +(+row.delta || 0).toFixed(2),
    principal: row.principal == null ? null : +(+row.principal || 0).toFixed(2),
    bonus: row.bonus == null ? null : +(+row.bonus || 0).toFixed(2),
  }));
  let dated = true;
  let cents = 0;
  const afterCents = new Array(list.length);
  // 入参按 created_at DESC；正序累加要从最老的一条开始
  for (let i = list.length - 1; i >= 0; i--) {
    if (!walletIso(list[i].created_at)) dated = false;
    cents += Math.round(list[i].delta * 100);
    afterCents[i] = cents;
  }
  const target = Math.round((+currentBalance || 0) * 100);
  // 被 LIMIT 截断时，累加的只是尾部片段，跟总余额本来就对不上 —— 这种情况没法自校验，如实降级。
  const truncated = !!opts.truncated;
  const reliable = dated && !truncated && Math.abs(cents - target) <= WALLET_LEDGER_TOLERANCE_CENTS;
  const entries = list.map((row, i) => reliable ? { ...row, balance_after: +(afterCents[i] / 100).toFixed(2) } : { ...row });
  return { entries, reliable, dated, truncated, computed_balance: +(cents / 100).toFixed(2) };
}

// 只在【第一次 Cron bootstrap 之前】使用：此时还没有任何发布，指针为 null。
// 走同一套转义模板渲染草稿，图片一律换成本地兜底图（绝不吐 data URI），
// private/no-store、不进缓存、不做任何发布写入。一旦有了活动发布就永久失效。
async function renderInitialBootstrapFallback(req, env, ctx) {
  try {
    const url = new URL(req.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : '/';
    const draft = await loadPublishableDraft(env, { contentAt: new Date() });
    const snapshot = await buildPublicSnapshot(draft, async () => '/img/product-fallback.svg');
    const pages = await renderPublicReleasePages({
      ...snapshot, release_id: 'bootstrap-pending', checksum: '', published_at: new Date().toISOString(),
    });
    const page = pages.find(candidate => candidate.path === path);
    if (!page) return privateResponse(new Response('Public release unavailable', { status: 503 }));
    return privateResponse(new Response(page.body, { headers: { 'content-type': page.contentType } }));
  } catch (error) {
    console.error('bootstrap fallback failed', error);
    return privateResponse(new Response('Public release unavailable', { status: 503 }));
  }
}

// Admin handlers an agent tool may reach through internal dispatch (worker/agent.js). Anything else is 403 for agents,
// even though the elevated env passes isAdmin: keys, payments, members, refunds and settings stay owner-only.
const AGENT_ADMIN_ROUTES = new Set([
  'GET /api/admin/publication/status', 'GET /api/admin/products',
  'POST /api/admin/menu-categories', 'POST /api/admin/product-save', 'POST /api/admin/product-image',
  'POST /api/admin/product-toggle', 'POST /api/admin/product-sort',
  'GET /api/admin/publication/draft-snapshot', 'POST /api/admin/publication/preview',
  'POST /api/admin/publication/schedule', 'POST /api/admin/publication/publish-exact',
  'GET /api/admin/orders', 'POST /api/admin/store-toggle',
]);
const POS_CASHIERS = ['pos1', 'pos2', 'pos3'];
// A rejected draft write: either someone else changed the draft, or the store's first release does not exist yet.
function draftConflict(result) {
  if (result && result.error === 'bootstrap_pending') {
    return json({ error: '系统正在生成首个菜单发布（部署后约一分钟内自动完成），请稍后再保存 · The first release is being created; try again in a minute', code: 'bootstrap_pending' }, 409);
  }
  return json({ error: '页面上的内容已经被别处改过了，请刷新后重试', code: 'revision_conflict' }, 409);
}
// Internal dispatch target for agent tools: the same fetch handler, with the elevated env built by agent-context.js.
const agentDispatch = (request, env, ctx) => worker.fetch(request, env, ctx);

const worker = {
  async fetch(req, env, ctx) {
    return withSecHeaders(await (async () => {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
        url.protocol = 'https:';
        return Response.redirect(url.toString(), 301);
      }

      // ---------- 公开发布：缓存优先，任何 D1 访问之前 ----------
      const apex = String(env.SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
      if (apex && url.hostname === 'www.' + apex) {
        const canonical = new URL(url.toString());
        canonical.hostname = apex;
        return new Response(null, { status: 308, headers: { location: canonical.toString() } });
      }
      // ---------- AI agent layer: MCP, REST, llms.txt (worker/agent.js) ----------
      if (pathname === '/mcp') return await handleMcp(req, env, ctx, agentDispatch);
      if (pathname === '/api/agent/v1' || pathname.startsWith('/api/agent/v1/')) return await handleAgentRest(req, env, ctx, agentDispatch);
      if (pathname === '/favicon.ico') return Response.redirect(url.origin + '/img/logo.svg', 301);
      if (pathname === '/llms.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = req.method === 'HEAD' ? null : await renderLlmsTxt(req, env);
        return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });
      }
      if (pathname === '/') {
        for (const [role, target] of [['boss.', '/admin'], ['pos.', '/pos'], ['kitchen.', '/kitchen']]) {
          if (url.hostname.startsWith(role)) return Response.redirect(url.origin + target, 302);
        }
      }
      const publicRead = req.method === 'GET' || req.method === 'HEAD';
      const publicRequest = req.method === 'HEAD' ? new Request(req, { method: 'GET' }) : req;
      const publicBody = response => req.method === 'HEAD'
        ? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }) : response;
      if (publicRead && /^\/public\/media\/[0-9a-f]{64}$/.test(pathname)) {
        const media = await servePublicMedia(publicRequest, env, ctx);
        if (media) return publicBody(media);
      }
      if (publicRead && classifyPublicPath(url)) {
        let publicResponse;
        try {
          publicResponse = await servePublicPage(publicRequest, env, ctx);
        } catch (error) {
          console.error('public release read failed', error);
          if (error?.code === 'bootstrap_pending') {
            try {
              const state = await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
              if (!state?.active_release_id) return publicBody(await renderInitialBootstrapFallback(publicRequest, env, ctx));
            } catch (stateError) { console.error('public bootstrap state read failed', stateError); }
          }
          return publicBody(privateResponse(new Response('Public release unavailable', { status: 503 })));
        }
        if (publicResponse) return publicBody(publicResponse);
        if (/^\/public\/releases\//.test(pathname)) return publicBody(privateResponse(new Response('Not found', { status: 404 })));
        // 不在活动发布里的商品地址：仍是 404 + private/noindex，但给顾客品牌化的回菜单页（不暗示商品存在）
        if (/^\/menu\/[a-z0-9_-]+\/?$/.test(pathname)) {
          return publicBody(privateResponse(new Response(renderMissingProductPage(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })));
        }
        return publicBody(privateResponse(new Response('Public release unavailable', { status: 503 })));
      }

      // ---------- 老板预览：签名十分钟令牌，走生产同一套渲染器 ----------
      // 令牌签草稿版本与预览内容时点；预览【绝不】改活动指针、绝不写发布行。
      if (req.method === 'GET' && pathname.startsWith('/preview/')) {
        const previewResponse = resp => {
          const out = privateResponse(resp);
          out.headers.set('referrer-policy', 'no-referrer');
          return out;
        };
        const rest = pathname.slice('/preview/'.length);
        const slash = rest.indexOf('/');
        const token = slash === -1 ? rest : rest.slice(0, slash);
        const target = slash === -1 ? '/' : (rest.slice(slash) || '/');
        const verified = await verifyPreviewToken(env.AUTH_SECRET, token);
        if (!verified.ok) return previewResponse(new Response('Preview unavailable', { status: verified.status || 404 }));
        try {
          const state = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
          if (!state || state.draft_revision !== verified.draftRevision) {
            return previewResponse(new Response('Preview is out of date', { status: 409 }));
          }
          const contentAt = verified.contentAt ? new Date(verified.contentAt) : new Date();
          const draft = await loadPublishableDraft(env, { contentAt });
          const media = new Map();
          const snapshot = await buildPublicSnapshot(draft, async value => {
            const item = await materializePublicMedia(value);
            media.set(item.hash, item);
            return `${url.origin}/preview/${token}/media/${item.hash}`;
          });
          // Loading the draft is a separate read batch. A newer edit must not
          // acquire a preview token issued for the previous revision.
          const current = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
          if (current?.draft_revision !== verified.draftRevision) {
            return previewResponse(new Response('Preview is out of date', { status: 409 }));
          }
          const imageMatch = target.match(/^\/media\/([0-9a-f]{64})$/);
          if (imageMatch) {
            const item = media.get(imageMatch[1]);
            return previewResponse(item
              ? new Response(item.bytes, { headers: { 'content-type': item.contentType,
                'content-length': String(item.byteLength), 'x-content-type-options': 'nosniff' } })
              : new Response('Not found', { status: 404 }));
          }
          const pages = await renderPublicReleasePages({ ...snapshot, release_id: `preview-${verified.nonce}`,
            checksum: '', published_at: contentAt.toISOString() });
          const wanted = target.length > 1 ? target.replace(/\/$/, '') : '/';
          const page = pages.find(candidate => candidate.path === wanted);
          if (!page) return previewResponse(new Response('Not found', { status: 404 }));
          return previewResponse(new Response(page.body, { headers: { 'content-type': page.contentType } }));
        } catch (error) {
          console.error('preview render failed', error);
          return previewResponse(new Response('Preview unavailable', { status: 503 }));
        }
      }

      if (pathname === '/api/kitchen/login' && req.method === 'POST') {
        const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
        const lk = await throttleLocked(env, 'kitchen_login', ip);
        if (lk.locked) return json({ ok: false, error: '尝试过多，请 15 分钟后再试' }, 429);
        const hit = await throttleHit(env, 'kitchen_login', ip, { lockAt: 8, windowMs: 15 * 60000, lockMs: 15 * 60000 });
        if (hit.limited) return json({ ok: false, error: '尝试过多，请 15 分钟后再试' }, 429);
        const b = await req.json().catch(() => ({}));
        const want = await setting(env, 'KITCHEN_PASSWORD');
        if (!want) return json({ ok: false, error: '厨房密码尚未配置' }, 503);
        if (!_eq(String(b.password || ''), String(want))) return json({ ok: false, error: '密码错误' }, 401);
        await throttleClear(env, 'kitchen_login', ip);
        return json({ ok: true, token: await signKitchenToken(env) });
      }

      // ================= MEMBER AUTH =================
      // Account ownership is provider-based (Google / Apple). Phone is an
      // optional, unverified contact field and never participates in login.
      if (['/api/auth/register', '/api/auth/login', '/api/auth/otp-request', '/api/auth/reset-password', '/api/auth/google-link'].includes(pathname)) {
        return json({ error: '手机号登录与 OTP 已停用，请使用 Google 或 Apple 登录。', code: 'provider_only' }, 410);
      }
      if (pathname === '/api/auth/me' && req.method === 'GET') {
        const userId = await verifySession(env, _bearer(req));
        if (!userId) return json({ error: 'unauthorized' }, 401);
        const member = await env.DB.prepare(`SELECT a.id AS user_id,a.phone,a.name,a.birthday,
            COALESCE(m.points,0) points,COALESCE(m.balance,0) balance,
            COALESCE(m.total_spent,0) total_spent,COALESCE(m.orders_count,0) orders_count
          FROM user_accounts a LEFT JOIN members m ON m.user_id=a.id WHERE a.id=?`).bind(userId).first();
        if (!member) return json({ error: 'account not found' }, 401);
        const { results: identities } = await env.DB.prepare(
          'SELECT provider,email,display_name FROM auth_identities WHERE user_id=? ORDER BY provider').bind(userId).all();
        const { results: recent } = await env.DB.prepare(
          'SELECT id,invoice_no,total,pay_status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 10').bind(userId).all();
        // One auditable wallet stream: top-ups (+), order balance spends (-),
        // and refunds/adjustments (+/-). Existing history is reconstructed from
        // the authoritative tables, so this covers transactions before this UI.
        const { results: walletRows } = await env.DB.prepare(`SELECT * FROM (
          SELECT 'topup' kind,t.id event_id,NULL order_id,NULL invoice_no,t.credited delta,
            t.amount principal,t.bonus bonus,t.pay_method method,t.pay_status status,t.created_at,t.note
          FROM topups t WHERE t.user_id=? AND t.pay_status='PAID'
          UNION ALL
          SELECT 'spend' kind,'spend:'||o.id event_id,o.id order_id,o.invoice_no,-o.paid_by_balance delta,
            NULL principal,NULL bonus,o.pay_provider method,o.pay_status status,o.created_at,o.note
          FROM orders o WHERE o.user_id=? AND o.paid_by_balance>0
          UNION ALL
          SELECT we.type kind,we.id event_id,we.order_id,o.invoice_no,we.amount delta,
            NULL principal,NULL bonus,'wallet' method,COALESCE(o.pay_status,'COMPLETED') status,we.created_at,we.note
          FROM wallet_events we LEFT JOIN orders o ON o.id=we.order_id
          -- 历史钱包并入对【这个会员】是真实的余额变动（钱进了他账上），必须显示：
          -- 藏起来会让流水累加不回余额，reliable 变 false，整列结存直接不显示。
          -- 只有全店负债汇总才排除它（会员之间转移，总额净零）。
          WHERE we.user_id=?
        ) ORDER BY created_at DESC, CASE WHEN delta<0 THEN 0 ELSE 1 END, event_id DESC LIMIT 500`).bind(userId, userId, userId).all();
        const truncated = (walletRows || []).length >= 500;
        const wallet = walletLedgerWithBalances(walletRows, member.balance || 0, { truncated });
        // 钱挂在手机号上、人已登进新账号 → 别让顾客对着一个没解释的 0
        const legacyPending = await legacyPendingFor(env, userId).catch(() => null);
        return json({ member, tier: memberTier(member.total_spent || 0), recent, providers: identities || [],
          legacy_pending: legacyPending,
          wallet: {
            entries: wallet.entries,
            truncated,
            // 前端据此决定显不显示「余额」那一列。对不上账时不显示，并提示顾客联系店家核对，
            // 而不是硬显示一个错的数字。
            balance_after_reliable: wallet.reliable,
          } });
      }
      if (pathname === '/api/auth/profile' && req.method === 'POST') {
        const userId = await verifySession(env, _bearer(req));
        if (!userId) return json({ error: 'unauthorized' }, 401);
        const b = await req.json().catch(() => ({}));
        const birthday = cleanDateOnly(b.birthday);
        if (birthday === false) return json({ error: '生日格式应为 YYYY-MM-DD' }, 400);
        const name = String(b.name == null ? '' : b.name).trim().slice(0, 80) || null;
        const rawPhone = String(b.phone == null ? '' : b.phone).trim();
        const phone = rawPhone ? normPhone(rawPhone) : null;
        if (phone && !/^\d{8,15}$/.test(phone)) return json({ error: '手机号应为 8–15 位数字 Phone must be 8–15 digits' }, 400);
        const ts = new Date().toISOString();
        try {
          await env.DB.batch([
            env.DB.prepare('UPDATE user_accounts SET phone=?,name=?,birthday=?,updated_at=? WHERE id=?').bind(phone, name, birthday, ts, userId),
            env.DB.prepare('UPDATE members SET name=?,birthday=?,updated_at=? WHERE user_id=?').bind(name, birthday, ts, userId),
          ]);
        } catch (e) {
          if (/UNIQUE|constraint/i.test(e.message || '')) return json({ error: '这个手机号已被其他账号使用 Phone already in use', code: 'phone_already_exists' }, 409);
          throw e;
        }
        return json({ ok: true, member: { user_id: userId, phone, name, birthday } });
      }
      // ---------- 历史储值合并：顾客侧（绑定账号，不动钱）----------
      // 提示的判据是「店员是否已为这个号发起了票据」，不是「你填的手机号有没有余额」——
      // 后者会变成一个「某手机号有没有钱」的探测器。攻击者按不了店员那个键，所以对他恒返 pending:false。
      if (pathname === '/api/auth/legacy-hint' && req.method === 'GET') {
        const userId = await verifySession(env, _bearer(req));
        if (!userId) return json({ error: 'unauthorized' }, 401);
        return json(await legacyHint(env, userId));
      }
      if (pathname === '/api/auth/legacy-claim' && req.method === 'POST') {
        const userId = await verifySession(env, _bearer(req));
        if (!userId) return json({ error: 'unauthorized' }, 401);
        // 每账号限速：猜码只能到 awaiting_approval（还要老板当面批），但仍不给暴力枚举留窗口
        const lk = await throttleLocked(env, 'legacy_claim', userId);
        if (lk.locked) return json({ error: '尝试过多，请 15 分钟后再试' }, 429);
        const b = await req.json().catch(() => ({}));
        const r = await legacyClaimBind(env, { code: b.code, userId });
        if (!r.ok) {
          await legacyClaimMiss(env, b.code);
          await throttleHit(env, 'legacy_claim', userId, { lockAt: 5, windowMs: 900000, lockMs: 900000 });
        } else {
          await throttleClear(env, 'legacy_claim', userId);
        }
        return json(r, r._status || 200);
      }
      if ((pathname === '/api/auth/google' || pathname === '/api/auth/apple') && req.method === 'GET') {
        const provider = pathname.endsWith('/apple') ? 'apple' : 'google';
        try {
          const start = await oauthStart(env, provider, null, url.origin);
          return redirectWithCookie(start.url, start.cookie);
        } catch (e) {
          // 顾客点的是整页跳转的 <a>，这里回 JSON 的话他会停在一张纯白页上，
          // 屏幕上只有 {"error":"google login unavailable"} —— 没品牌、没返回入口、不知道该干嘛。
          // 送回店里并带上错误标记，前端与两个 callback 分支用的是同一套处理。
          return oauthFinish(url.origin, `auth_error=${encodeURIComponent(provider + '_unavailable')}`);
        }
      }
      if (pathname === '/api/auth/link-start' && req.method === 'POST') {
        const userId = await verifySession(env, _bearer(req));
        if (!userId) return json({ error: 'unauthorized' }, 401);
        const b = await req.json().catch(() => ({}));
        if (!['google', 'apple'].includes(b.provider)) return json({ error: 'invalid provider' }, 400);
        const existing = await env.DB.prepare('SELECT 1 ok FROM auth_identities WHERE user_id=? AND provider=?').bind(userId, b.provider).first();
        if (existing) return json({ error: 'provider already linked', code: 'provider_already_linked' }, 409);
        try {
          const start = await oauthStart(env, b.provider, userId, url.origin);
          return new Response(JSON.stringify({ ok: true, url: start.url }), {
            headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': start.cookie },
          });
        } catch (e) { return json({ error: `${b.provider} link unavailable` }, 503); }
      }
      if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') || '';
        const saved = await consumeOAuthState(env, req, 'google', state);
        const origin = (saved && saved.origin) || url.origin;
        if (!saved || url.searchParams.get('error')) return oauthFinish(origin, 'auth_error=google_cancelled');
        try {
          const tr = await fetch('https://oauth2.googleapis.com/token', {
            signal: AbortSignal.timeout(8000), method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${origin}/api/auth/google/callback`, grant_type: 'authorization_code' }),
          });
          const tok = await tr.json();
          if (!tr.ok || !tok.id_token) throw new Error('token exchange failed');
          const g = await verifyGoogleIdToken(env, tok.id_token, saved.nonce);
          const done = await completeOAuthIdentity(env, 'google', { sub: g.sub, email: g.email, name: g.name || '' }, saved.user_id);
          if (done.error) return oauthFinish(origin, `auth_error=${encodeURIComponent(done.error)}`);
          if (done.linked) return oauthFinish(origin, 'auth_linked=google');
          return oauthFinish(origin, `auth_token=${encodeURIComponent(await signSession(env, done.userId))}`);
        } catch (e) { return oauthFinish(origin, 'auth_error=google_failed'); }
      }
      if (pathname === '/api/auth/apple/callback' && req.method === 'POST') {
        const form = await req.formData().catch(() => null);
        const state = form ? String(form.get('state') || '') : '';
        const saved = await consumeOAuthState(env, req, 'apple', state);
        const origin = (saved && saved.origin) || url.origin;
        if (!saved || !form || form.get('error')) return oauthFinish(origin, 'auth_error=apple_cancelled');
        try {
          const tr = await fetch('https://appleid.apple.com/auth/token', {
            signal: AbortSignal.timeout(8000), method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: String(form.get('code') || ''), client_id: env.APPLE_CLIENT_ID,
              client_secret: await appleClientSecret(env), redirect_uri: `${origin}/api/auth/apple/callback`, grant_type: 'authorization_code' }),
          });
          const tok = await tr.json();
          if (!tr.ok || !tok.id_token) throw new Error('token exchange failed');
          const a = await verifyAppleIdToken(env, tok.id_token, saved.nonce);
          let supplied = {};
          try { supplied = JSON.parse(String(form.get('user') || '{}')); } catch (e) {}
          const name = [supplied?.name?.firstName, supplied?.name?.lastName].filter(Boolean).join(' ');
          const done = await completeOAuthIdentity(env, 'apple', { sub: a.sub, email: a.email, name }, saved.user_id);
          if (done.error) return oauthFinish(origin, `auth_error=${encodeURIComponent(done.error)}`);
          if (done.linked) return oauthFinish(origin, 'auth_linked=apple');
          return oauthFinish(origin, `auth_token=${encodeURIComponent(await signSession(env, done.userId))}`);
        } catch (e) { return oauthFinish(origin, 'auth_error=apple_failed'); }
      }
      // ---------- GET /api/member?phone= : loyalty status + history ----------
      if (pathname === '/api/member' && req.method === 'GET') {
        const phone = normPhone(url.searchParams.get('phone'));
        if (phone.length < 6) return json({ error: '请输入完整手机号 · Please enter your phone number' }, 400);
        // 防枚举：未鉴权按手机号查会员要限流（SG 手机号 8 位可遍历整个会员库）
        const lk = await throttleLocked(env, 'member_lookup', phone);
        if (lk.locked) return json({ error: '请求过于频繁，请稍后再试' }, 429);
        await throttleHit(env, 'member_lookup', phone, { lockAt: 20, windowMs: 15 * 60000, lockMs: 15 * 60000 });
        const account = await accountByPhone(env, phone);
        const m = account || await env.DB.prepare('SELECT points,total_spent,orders_count FROM members WHERE phone=? AND user_id IS NULL').bind(phone).first();
        // 脱敏：未鉴权只返回 loyalty 状态（积分/等级/单数），绝不暴露姓名 + 订单历史（PII）。姓名/订单走已登录的 /api/auth/me。
        const member = { phone, points: (m && m.points) || 0, orders_count: (m && m.orders_count) || 0, is_member: !!m };
        return json({ member, tier: memberTier((m && m.total_spent) || 0) });
      }

      // ---------- POS staff (pos1/pos2/pos3) — 签名 staff token + D1 强 PIN + 失败锁定 ----------
      if (pathname === '/api/pos/login' && req.method === 'POST') {
        const { cashier, pin } = await req.json();
        // 按 cashier 全局计数（不含 IP）：cashier 名是公开固定的 pos1/2/3，若把 IP 混进键，
        // 攻击者轮换出口 IP 每个 IP 只打 4 次即可绕过锁定爆破 6 位 PIN。与 OTP 按 phone 限流一致。
        const thKey = `${cashier || '?'}`;
        const lk = await throttleLocked(env, 'pos_login', thKey);
        if (lk.locked) return json({ ok: false, error: '尝试过多，已锁定，请 15 分钟后再试' }, 429);
        // reserve-before-verify：先原子占槽（throttleHit 的计数自增是单条 D1 语句、并发被串行化），
        // 拿到 count>=5 立即 429、verifyPosPin 永不在超额时执行。
        // 若像旧版那样把计数放到 PIN 校验【之后】，并发突发请求可在锁提交前全部越过上面的只读检查、
        // 各自执行一次 verifyPosPin，把「每窗口 5 次」放大成「≈并发数 次」，绕过爆破上限。
        // 成功登录立即 throttleClear 清零，正常收银员不累积、不会误锁。
        const hit = await throttleHit(env, 'pos_login', thKey, { lockAt: 5, windowMs: 15 * 60000, lockMs: 15 * 60000 });
        if (hit.limited) return json({ ok: false, error: '尝试过多，已锁定，请 15 分钟后再试' }, 429);
        if (await verifyPosPin(env, cashier, pin)) {
          await throttleClear(env, 'pos_login', thKey);
          return json({ ok: true, token: await signStaffToken(env, cashier), cashier });
        }
        return json({ ok: false, error: '账号或密码错误' }, 401);
      }
      if (pathname === '/api/pos/sale' && req.method === 'POST') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        if (!staff) return json({ error: 'unauthorized' }, 401);
        const b = await req.json();
        // POS 只能按菜单商品开单：拒绝自填金额(amount lump-sum 后门仅供 admin 手工录入)，防一线收银员绕过 sku 定额开单
        if (!Array.isArray(b.items) || !b.items.length) return json({ error: 'POS 需按商品开单（不支持自填金额）' }, 400);
        if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);
        // 归属用已验证的 token 身份 staff，忽略请求体 b.cashier（防伪造收银员归属/栽赃对账）
        const r = await createOfflineSale(env, b, staff, true);   // POS 强制只卖在售品（防 stale 页/crafted 请求成交下架 SKU）；admin 线下销售不传 = 可清库存
        if (r.ok && !r.deduped && r.id) { if (ctx && ctx.waitUntil) ctx.waitUntil(notifyNewOrderTelegram(env, r.id)); else notifyNewOrderTelegram(env, r.id).catch(() => {}); }   // POS 现金/PayNow 成交=付款成功 → Telegram 推送（POS 在厨房，让厨房第一时间知）
        return json(r, r._status || 200);
      }
      // POS staff records a member top-up (customer pays at counter)
      if (pathname === '/api/pos/topup' && req.method === 'POST') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        if (!staff) return json({ error: 'unauthorized' }, 401);
        const b = await req.json();
        if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);   // 强制幂等：防 POS 双击/网络重试双记真金（与 /api/admin/topup 一致）。前端 posTopup 每次发 crypto.randomUUID()
        // 现场充值防护：pay_method 收敛白名单（柜台只可能 cash/paynow；stripe 仅 webhook 内部写，防伪造通道误扣 1.3% 费）；
        // 金额上限 2000 防手输多打 0（如 50→50000）误入巨额储值负债。上限值老板可调。
        const pm = b.pay_method === 'paynow' ? 'paynow' : 'cash';
        if (+b.amount > 2000) return json({ error: '单次充值上限 S$2000（手输防误，超额请分次或联系老板）' }, 400);
        // 手机号格式闸放在查库【之前】：不能"库里已有这个怪号就放行"——公开下单接口只校验非空，
        // 任何人都能先造出 phone="1" 的会员行，再让柜台把它当"历史会员"绕过格式闸。
        if (!sgCounterPhone(typeof b.phone === 'string' ? b.phone : null)) {
          return json({ error: '手机号格式不对：新加坡手机号是 8 位（8 或 9 开头），可带 +65', code: 'bad_phone' }, 400);
        }
        // 归属用已验证的 token 身份 staff，忽略请求体 b.cashier
        const account = await accountByPhone(env, b.phone);
        // 收银台必须先查一次会员（/api/pos/member）再充值，并把查到的身份回传确认。
        // 手机号现在是【顾客自填且零验证】的字段，有人抢注就能截胡别人的现金充值；
        // 这一步把"店员看到的那个人"和"钱进的那个账号"绑死，不匹配就拒绝入账。
        const expect = Object.prototype.hasOwnProperty.call(b, 'expect_user_id') ? (b.expect_user_id || null) : undefined;
        if (expect === undefined) return json({ error: '请先查询会员再充值（缺少 expect_user_id 确认）', code: 'confirm_required' }, 400);
        if ((account && account.user_id ? account.user_id : null) !== expect) {
          return json({ error: '这个手机号对应的会员已变化，请重新查询确认后再充值', code: 'member_changed' }, 409);
        }
        const r = await creditTopup(env, b.phone, b.amount, pm, staff, b.note, b.client_token, account && account.user_id);
        return json(r, r._status || 200);
      }
      // POS staff looks up a member's balance (for 用余额收款 / 充值前确认)。余额是会员资产，藏在 staff 鉴权后，不走公开 /api/member（后者刻意不返 balance 防枚举）。
      if (pathname === '/api/pos/member' && req.method === 'GET') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        if (!staff) return json({ error: 'unauthorized' }, 401);
        const phone = normPhone(url.searchParams.get('phone') || '');
        if (!phone) return json({ error: '缺少手机号' }, 400);
        const account = await accountByPhone(env, phone);
        const m = account || await env.DB.prepare('SELECT phone,name,balance,points FROM members WHERE phone=? AND user_id IS NULL').bind(phone).first();
        if (!m) return json({ found: false, user_id: null });
        // user_id 回给收银台，充值时原样回传做 expect_user_id 确认（绑死"看到的人"与"进钱的账号"）
        return json({ found: true, user_id: (account && account.user_id) || null, phone: m.phone,
          name: m.name || '', balance: +((m.balance) || 0).toFixed(2), points: m.points || 0 });
      }
      // ---------- 历史储值合并：店员侧（只发起，不动钱）----------
      // 店员/老板都能用（admin token 也走 staff 分支），但【提交合并只有老板能做】。
      if (pathname.startsWith('/api/pos/legacy-') ) {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        const actor = staff || (isAdmin(req, env) ? 'boss' : null);
        if (!actor) return json({ error: 'unauthorized' }, 401);
        if (pathname === '/api/pos/legacy-lookup' && req.method === 'GET') {
          return json(await legacyLookup(env, url.searchParams.get('phone') || ''));
        }
        if (pathname === '/api/pos/legacy-claim-start' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const r = await legacyClaimStart(env, { phone: b.phone, actor });
          return json(r, r._status || 200);
        }
        if (pathname === '/api/pos/legacy-claim-cancel' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const r = await legacyClaimCancel(env, { claimId: b.claim_id, actor });
          return json(r, r._status || 200);
        }
        return json({ error: 'not found' }, 404);
      }

      // 收银台查最近有运费的已付单（给「退运费」按钮选单用）。可按单号搜。
      if (pathname === '/api/pos/refundable-orders' && req.method === 'GET') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!await verifyStaffToken(env, tok)) return json({ error: 'unauthorized' }, 401);
        const q = String(url.searchParams.get('q') || '').trim();
        const base = `SELECT id,invoice_no,customer_name,total,delivery_fee,COALESCE(refunded_total,0) refunded_total,
            fulfilment,pay_status,created_at
          FROM orders WHERE pay_status='PAID' AND delivery_fee>0 AND COALESCE(refunded_total,0)<=0`;
        const { results } = q
          ? await env.DB.prepare(`${base} AND (invoice_no LIKE ? OR COALESCE(customer_name,'') LIKE ?) ORDER BY created_at DESC LIMIT 30`)
            .bind(`%${q}%`, `%${q}%`).all()
          : await env.DB.prepare(`${base} ORDER BY created_at DESC LIMIT 30`).all();
        // 收银界面是中文的，别把 fulfilment 的英文枚举原样丢给店员看（实测屏幕上出现过「· anytime ·」，
        // 店员看不懂也判断不出这是什么单）。标签在服务端定稿，三端不必各译一遍。
        const FUL_CN = { pickup: '自取', discount: '优惠配送', anytime: '自费随时送', delivery: '配送', route: '拼单顺路送', walkin: '到店' };
        return json({ orders: (results || []).map(o => ({ ...o, fulfilment_label: FUL_CN[o.fulfilment] || o.fulfilment || '' })) });
      }
      // 收银台退运费。金额服务端从 delivery_fee 取，店员改不了；老板可在后台关掉这个权限。
      if (pathname === '/api/pos/refund-delivery-fee' && req.method === 'POST') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        if (!staff) return json({ error: 'unauthorized' }, 401);
        if ((await setting(env, 'pos_refund_delivery_fee')) === '0') {
          return json({ error: '老板已关闭收银台退运费权限，请找老板在后台操作', code: 'pos_refund_disabled' }, 403);
        }
        const b = await req.json().catch(() => ({}));
        const oid = b.order_id || b.id;
        if (!oid) return json({ error: '缺少 order_id' }, 400);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
        if (!o) return json({ error: '订单不存在' }, 404);
        const r = await refundDeliveryFee(env, o, { reason: `收银台退运费 (${staff})`, actor: `pos:${staff}` });
        if (!r.ok) {
          const code = r.code === 'in_progress' ? 409 : (r.code === 'manual_required' ? 502 : 400);
          return json({ error: r.error, code: r.code }, code);
        }
        // 店员退了钱，老板要立刻知道
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyRefundTelegram(env, o, r, `收银台 ${staff}`));
        else notifyRefundTelegram(env, o, r, `收银台 ${staff}`).catch(() => {});
        return json({ ok: true, refunded: r.amount, stripe_amount: r.stripe_amount,
          balance_amount: r.balance_amount, deduped: !!r.deduped });
      }
      if (pathname === '/api/pos/attendance' && req.method === 'POST') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        if (!staff) return json({ error: 'unauthorized' }, 401);
        const b = await req.json().catch(() => ({}));
        return json(await recordAttendance(env, staff, b.kind, b.note));
      }
      if (pathname === '/api/pos/attendance/today' && req.method === 'GET') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const staff = await verifyStaffToken(env, tok);
        if (!staff) return json({ error: 'unauthorized' }, 401);
        const day = sgtTodayStr();
        const { results } = await env.DB.prepare('SELECT staff,business_date,kind,punched_at,source,note FROM attendance_records WHERE staff=? AND business_date=? ORDER BY punched_at')
          .bind(staff, day).all();
        return json({ staff, business_date: day, records: results || [] });
      }
      // public: member self-service top-up via Stripe (balance credited on webhook)
      if (pathname === '/api/topup/checkout' && req.method === 'POST') {
        const b = await req.json();
        const userId = await verifySession(env, _bearer(req));
        if (!userId) return json({ error: '请先使用 Google 或 Apple 登录 Login required' }, 401);
        const amount = +(+b.amount).toFixed(2);
        if (!(amount > 0)) return json({ error: '请填写充值金额' }, 400);
        const account = await env.DB.prepare('SELECT phone FROM user_accounts WHERE id=?').bind(userId).first();
        if (!account) return json({ error: 'account not found' }, 401);
        const SK = await setting(env, 'STRIPE_SECRET_KEY');
        if (!SK) return json({ error: '线上充值暂未开通，请到店充值' }, 400);
        const tb = await topupBonus(env, amount);
        const f = new URLSearchParams();
        f.append('mode', 'payment'); f.append('payment_method_types[]', 'paynow');
        f.append('line_items[0][price_data][currency]', 'sgd');
        const mInfo = await merchantInfo(env);
        f.append('line_items[0][price_data][product_data][name]', `${mInfo.nameCn} 会员充值 +S$${tb ? '送' + tb : ''}`);
        f.append('line_items[0][price_data][unit_amount]', String(Math.round(amount * 100)));
        f.append('line_items[0][quantity]', '1');
        f.append('success_url', `${url.origin}/?topup=ok`);
        f.append('cancel_url', `${url.origin}/`);
        f.append('metadata[topup]', '1'); f.append('metadata[topup_user_id]', userId); f.append('metadata[topup_phone]', account.phone || ''); f.append('metadata[topup_amount]', String(amount));
        let d;
        try {
          const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            signal: AbortSignal.timeout(8000),
            method: 'POST', headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/x-www-form-urlencoded' }, body: f.toString(),
          });
          d = await r.json();
        } catch (e) { return json({ error: '线上充值暂时不可用，请稍后再试或到店充值' }, 502); }   // Stripe 网络失败/超时友好降级，不泄露内部错误
        if (d.error) {
          // 绝不把上游支付网关的原文丢给顾客：实测会弹出
          // 「Invalid API Key provided: sk_test_********************0000」——
          // 顾客既看不懂，又顺带泄露了「用的是 Stripe」和 key 的形态。
          // 详情只记进日志给老板排查，顾客只看到一句人话。
          console.log('topup checkout failed:', String(d.error.message || '').slice(0, 200));
          return json({ error: '线上充值暂时不可用，请稍后再试或到店充值', code: 'topup_unavailable' }, 502);
        }
        return json({ ok: true, checkout_url: d.url, bonus: tb });
      }
      // public: validate a promo code against a subtotal (for the checkout UI)
      if (pathname === '/api/promo/check' && req.method === 'POST') {
        const b = await req.json();
        const userId = await verifySession(env, _bearer(req) || b.token);
        const r = await checkPromo(env, b.code, +b.subtotal || 0, b.fulfilment, b.phone, !!userId, userId);
        return json(r, r.error ? 200 : 200);   // 200 either way; UI reads .error / .discount
      }
      // top-up bonus tiers (so the UI can show "充500送80")
      if (pathname === '/api/topup-tiers' && req.method === 'GET') {
        const tiers = (await topupTiers(env)).slice().sort((a, b) => a[0] - b[0]);  // low→high for display
        return json({ tiers: tiers.map(([amount, bonus]) => ({ amount, bonus })) });
      }

      // POS staff reads its own today tally (no admin token needed)
      if (pathname === '/api/pos/today' && req.method === 'GET') {
        const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!await verifyStaffToken(env, tok)) return json({ error: 'unauthorized' }, 401);
        const cashier = url.searchParams.get('cashier');
        const day = sgtTodayStr();   // 收银员当班按 SGT 营业日
        const q = cashier
          ? env.DB.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE source='offline' AND pay_status='PAID' AND cashier=? AND substr(datetime(created_at,'+8 hours'),1,10)=?").bind(cashier, day)
          : env.DB.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE source='offline' AND pay_status='PAID' AND substr(datetime(created_at,'+8 hours'),1,10)=?").bind(day);
        const r = await q.first();
        return json({ orders: r.c, revenue: +(r.rev || 0).toFixed(2) });
      }

      // ---------- 拼单顺路送：公开路线 + OneMap 邮编查询 ----------
      if (pathname === '/api/routes' && req.method === 'GET') {
        // public projection: NO home address / precise coords / geometry / destination postal (privacy);
        // auto-hide routes whose cutoff (SGT) has passed — 截单后顾客端自动消失(数据仍在,后台照常履约)。
        const sgtNow = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const { results } = await env.DB.prepare(
          "SELECT id,name,blocks,fee,cutoff,run_at,note,areas,distance_m,duration_s FROM routes WHERE active=1 AND (cutoff IS NULL OR cutoff > ?) ORDER BY created_at DESC").bind(sgtNow).all();
        const routes = (results || []).map(r => ({
          ...r,
          areas: r.areas ? JSON.parse(r.areas) : [],
        }));
        return json({ routes });
      }
      if (pathname === '/api/onemap' && req.method === 'GET') {
        const postal = (url.searchParams.get('postal') || '').replace(/\D/g, '');
        if (postal.length < 5) return json({ error: '请输入有效邮编（至少 5 位）· Please enter a valid postal code' }, 400);
        try {
          const r = await fetch(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y`, { signal: AbortSignal.timeout(4000) });
          const d = await r.json(); const a = (d.results || [])[0];
          if (!a) return json({ found: false });
          return json({ found: true, block: a.BLK_NO, road: a.ROAD_NAME, building: a.BUILDING, address: a.ADDRESS, postal: a.POSTAL, lat: a.LATITUDE, lng: a.LONGITUDE });
        } catch (e) { return json({ error: '地址查询暂时不可用，请稍后重试 · Address lookup unavailable, please try again later' }, 502); }
      }

      // ---------- GET /api/store-status : 唯一的易变公开读取 ----------
      // 只读 store_open / store_closed_msg，private+no-store。前端只在
      // ①打开结账 ②结账可见性恢复 ③首次提交前 这三个时刻调用。
      if (pathname === '/api/store-status' && req.method === 'GET') {
        const s = await getSettings(env, ['store_open', 'store_closed_msg']);
        return privateResponse(json({
          store_open: s.store_open !== '0',
          message: s.store_closed_msg || '',
          checked_at: new Date().toISOString(),
        }));
      }

      // ---------- GET /api/menu : 从活动发布投影（旧客户端兼容） ----------
      // 只读不可变发布表；顾客公开浏览不再调用它（页面自带发布数据）。
      if (pathname === '/api/menu' && req.method === 'GET') {
        return json(await activeReleaseMenuProjection(env));
      }

      // Uploaded pickup photos stay out of /api/config; mobile clients receive a
      // small, content-versioned URL and fetch only the selected location image.
      if (pathname.startsWith('/api/pickup-photo/') && req.method === 'GET') {
        let photoId = '';
        try { photoId = decodeURIComponent(pathname.slice('/api/pickup-photo/'.length)); } catch (e) { return new Response('Not found', { status: 404 }); }
        if (!/^[a-z0-9_-]{1,32}$/i.test(photoId)) return new Response('Not found', { status: 404 });
        const pickupSettings = await getSettings(env, ['pickup_enabled', 'pickup_points', 'shop_name', 'shop_address', 'shop_pickup_detail', 'shop_pickup_photo', 'SHOP_POSTAL']);
        const point = pickupPointsFromSettings(pickupSettings, env).find(p => p.id === photoId);
        if (!point || !point.active || !/^data:image\//i.test(String(point.photo || ''))) return new Response('Not found', { status: 404 });
        const currentVersion = pickupPhotoVersion(point.photo);
        if (url.searchParams.get('v') !== currentVersion) {
          const target = new URL(req.url); target.searchParams.set('v', currentVersion);
          return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } });
        }
        return pickupPhotoDataResponse(point.photo, true);
      }
      if (pathname === '/api/posters' && req.method === 'GET') return json({ posters: await publicHomepagePosters(env) });
      if (pathname.startsWith('/api/poster-image/') && req.method === 'GET') {
        let posterId = '';
        try { posterId = decodeURIComponent(pathname.slice('/api/poster-image/'.length)); } catch (e) { return new Response('Not found', { status: 404 }); }
        if (!HOMEPAGE_POSTER_ID.test(posterId)) return new Response('Not found', { status: 404 });
        if (!(await publicHomepagePosters(env)).some(p => p.id === posterId)) return new Response('Not found', { status: 404 });
        let poster = null;
        try { poster = await env.DB.prepare('SELECT image_data,image_version FROM homepage_posters WHERE id=?').bind(posterId).first(); } catch (e) { /* migration may still be pending */ }
        if (!poster || !/^data:image\//i.test(String(poster.image_data || ''))) return new Response('Not found', { status: 404 });
        const currentVersion = poster.image_version || pickupPhotoVersion(poster.image_data);
        if (url.searchParams.get('v') !== currentVersion) {
          const target = new URL(req.url); target.searchParams.set('v', currentVersion);
          return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } });
        }
        return pickupPhotoDataResponse(poster.image_data, true);
      }

      // ---------- GET /api/config : public store status + delivery rules ----------
      if (pathname === '/api/config' && req.method === 'GET') {
        return json(publicConfig(env, await getSettings(env, PUBLIC_SETTING_KEYS)));
      }

      // Quote-only mode: no Lalamove order is created by this system, so order
      // status webhooks are intentionally retired.
      if (pathname === '/api/lalamove/webhook' && req.method === 'POST') {
        return json({ ok: true, ignored: true, reason: 'quote_only' }, 410);
      }

      // ========== Telegram webhook：bot 收到任意消息 → 发信人自动进白名单（secret_token 防伪）==========
      if (pathname === '/api/telegram/webhook' && req.method === 'POST') {
        const secret = await setting(env, 'telegram_webhook_secret');
        if (!secret || !_eq(req.headers.get('x-telegram-bot-api-secret-token') || '', secret)) return new Response('forbidden', { status: 403 });   // 常量时间比较，防 secret 时序侧信道
        const token = await setting(env, 'telegram_bot_token');
        let upd; try { upd = await req.json(); } catch (e) { return json({ ok: true }); }

        // ---- inline 按钮回调（厨房推进 / 退运费）----
        // 三层鉴权：① 上面的 webhook secret 常量时间比较 ② chat_id 必须在 telegram_subscribers 白名单里
        // ③ callback_data 严格正则，不匹配一律丢弃。任何一层不过都要 answerCallbackQuery，
        // 否则老板那边按钮会一直转圈，比报错更让人以为系统坏了。
        if (upd.callback_query) {
          const cq = upd.callback_query;
          const cqChat = cq.message && cq.message.chat && cq.message.chat.id;
          const data = String(cq.data || '');
          try {
            const allowed = cqChat == null ? null : await env.DB.prepare('SELECT chat_id FROM telegram_subscribers WHERE chat_id=?').bind(String(cqChat)).first();
            if (!allowed) { if (token) await answerCallbackQuery(env, token, cq.id, '这个会话没有操作权限', true); return json({ ok: true }); }
            const mt = /^(?:k:(preparing|ready|done)|(rdf|rdfy|rdfn)):([0-9a-fA-F-]{8,64})$/.exec(data);
            if (!mt) { if (token) await answerCallbackQuery(env, token, cq.id, '无法识别的操作'); return json({ ok: true }); }
            const kStatus = mt[1], rAction = mt[2], oid = mt[3];
            const actor = `telegram:${cqChat}`;
            const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
            if (!o) { if (token) await answerCallbackQuery(env, token, cq.id, '订单不存在', true); return json({ ok: true }); }

            if (kStatus) {
              const r = await advanceFulfilStatus(env, oid, kStatus, actor);
              if (token) {
                await answerCallbackQuery(env, token, cq.id, r.noop ? (r.error || '状态没有变化') : `已标记为「${FULFIL_LABEL[r.status]}」`);
                const fresh = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
                await tgApi(token, 'editMessageReplyMarkup', {
                  chat_id: cqChat, message_id: cq.message.message_id,
                  reply_markup: { inline_keyboard: orderActionRows(fresh) },
                });
              }
              return json({ ok: true });
            }

            const fee = +(+o.delivery_fee || 0).toFixed(2);
            if (rAction === 'rdf') {
              // 第一步只做二次确认 —— 退钱这种事不能一按就走
              if (token) {
                await answerCallbackQuery(env, token, cq.id, `确认退运费 S$${fee.toFixed(2)}？请点下方确认`, true);
                await tgApi(token, 'editMessageReplyMarkup', {
                  chat_id: cqChat, message_id: cq.message.message_id,
                  reply_markup: { inline_keyboard: [
                    [{ text: `✅ 确认退运费 S$${fee.toFixed(2)}`, callback_data: `rdfy:${oid}` }],
                    [{ text: '↩️ 取消', callback_data: `rdfn:${oid}` }],
                  ] },
                });
              }
              return json({ ok: true });
            }
            if (rAction === 'rdfn') {
              if (token) {
                await answerCallbackQuery(env, token, cq.id, '已取消');
                await tgApi(token, 'editMessageReplyMarkup', {
                  chat_id: cqChat, message_id: cq.message.message_id,
                  reply_markup: { inline_keyboard: orderActionRows(o) },
                });
              }
              return json({ ok: true });
            }
            // rdfy：真正执行退款
            const r = await refundDeliveryFee(env, o, { reason: 'Telegram 一键退运费', actor });
            if (token) {
              await answerCallbackQuery(env, token, cq.id,
                r.ok ? `已退运费 S$${(+r.amount).toFixed(2)}` : (r.error || '退款失败'), true);
              const fresh = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
              await tgApi(token, 'editMessageReplyMarkup', {
                chat_id: cqChat, message_id: cq.message.message_id,
                reply_markup: { inline_keyboard: orderActionRows(fresh) },
              });
            }
            if (r.ok && !r.deduped) await notifyRefundTelegram(env, o, r, 'Telegram');
            else if (!r.ok) await appendOrderEvent(env, oid, 'refund_failed', actor, r.error || r.code || 'unknown');
            return json({ ok: true });
          } catch (e) {
            if (token) await answerCallbackQuery(env, token, cq.id, '处理失败，请到后台操作', true);
            return json({ ok: true });
          }
        }

        const m = upd.message || upd.edited_message || (upd.my_chat_member ? { chat: upd.my_chat_member.chat, text: '' } : null);
        const chat = m && m.chat;
        if (chat && chat.id != null) {
          const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim() || chat.username || String(chat.id);
          const text = (('' + (m.text || '')).trim()).toLowerCase();
          try {
            if (text === '/stop' || text === '/unsubscribe' || text === '退订') {
              await env.DB.prepare('DELETE FROM telegram_subscribers WHERE chat_id=?').bind(String(chat.id)).run();
              if (token) try { await tgApi(token, 'sendMessage', { chat_id: chat.id, text: '已退订「来单提醒」。想重新订阅，发任意消息即可。' }); } catch (e) {}
            } else {
              const exists = await env.DB.prepare('SELECT chat_id FROM telegram_subscribers WHERE chat_id=?').bind(String(chat.id)).first();
              await env.DB.prepare('INSERT INTO telegram_subscribers (chat_id,name,added_at) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET name=excluded.name').bind(String(chat.id), name, new Date().toISOString()).run();
              if (token && !exists) try { await tgApi(token, 'sendMessage', { chat_id: chat.id, text: '✅ 已订阅「来单提醒」。以后每来一单都会发到这里。发 /stop 可退订。' }); } catch (e) {}
            }
          } catch (e) { /* webhook 永远回 200，避免 Telegram 重投风暴 */ }
        }
        return json({ ok: true });
      }

      // ========== 厨房看板：挂墙平板上直接接单/出餐 ==========
      // 之前只有 Telegram 上的按钮能推进状态，可真正出餐的人站在厨房这块平板前 ——
      // 让厨师必须掏手机找老板的群才能标「做好了」，那这套闭环在厨房是断的。
      // 鉴权复用厨房登录 token / 设备 print_token，与打印队列同一套。
      if (pathname.startsWith('/api/kitchen/board')) {
        const tok = url.searchParams.get('t') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const want = await setting(env, 'print_token');
        if (!(isAdmin(req, env) || (want && tok === want) || await verifyKitchenToken(env, tok))) return json({ error: 'unauthorized' }, 401);

        if (pathname === '/api/kitchen/board' && req.method === 'GET') {
          const day = sgtTodayStr();
          // 今天要做的：已付款、还没做完。按履约日算（预约明天的不该出现在今天的板上）。
          const { results } = await env.DB.prepare(
            `SELECT id,invoice_no,customer_name,items_json,fulfilment,deliver_at,deliver_time,
                    COALESCE(NULLIF(fulfil_status,''),'new') fulfil_status,status_at,arrived_at,note,created_at
               FROM orders
              WHERE pay_status='PAID'
                AND COALESCE(NULLIF(deliver_at,''), substr(datetime(created_at,'+8 hours'),1,10))=?
                AND COALESCE(NULLIF(fulfil_status,''),'new') <> 'done'
              ORDER BY CASE COALESCE(NULLIF(fulfil_status,''),'new')
                         WHEN 'ready' THEN 0 WHEN 'preparing' THEN 1 ELSE 2 END, created_at`).bind(day).all();
          // 先把这一板所有单的成分名一次查出来，套餐才能在板上展开成「要做哪几样」
          const boardItems = (results || []).flatMap(o => { try { return JSON.parse(o.items_json || '[]'); } catch (e) { return []; } });
          const boardNames = await bomNameMap(env, boardItems);
          const orders = (results || []).map(o => {
            let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) {}
            return {
              id: o.id, invoice_no: o.invoice_no, customer_name: o.customer_name,
              items: items.map(i => ({ name: i && i.name, qty: Number(i && i.qty) || 0,
                sub: kitchenLines(i, boardNames) })),
              fulfilment: o.fulfilment, deliver_at: o.deliver_at, deliver_time: o.deliver_time,
              fulfil_status: normFulfilStatus(o.fulfil_status), status_at: o.status_at,
              arrived: !!o.arrived_at, note: kitchenNote(o.note), created_at: o.created_at,
            };
          });
          return json({ date: day, orders, flow: FULFIL_FLOW, labels: FULFIL_LABEL });
        }
        if (pathname === '/api/kitchen/board/advance' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          if (!b.order_id) return json({ error: '缺少 order_id' }, 400);
          const r = await advanceFulfilStatus(env, b.order_id, b.to, 'kitchen');
          if (!r.ok) return json({ error: r.error || '推进失败', code: r.code }, r.code === 'not_found' ? 404 : 400);
          // 顾客那边靠轮询 /api/order/:id/status 自动看到，无需额外推送；老板侧同步一条 Telegram
          if (!r.noop) {
            const msg = `👨‍🍳 厨房：${r.invoice_no || b.order_id} → ${FULFIL_LABEL[r.status]}`;
            if (ctx && ctx.waitUntil) ctx.waitUntil(notifyTelegram(env, msg, { _order_id: b.order_id }));
            else notifyTelegram(env, msg, { _order_id: b.order_id }).catch(() => {});
          }
          return json({ ok: true, status: r.status, noop: !!r.noop, message: r.error || null });
        }
        return json({ error: 'not found' }, 404);
      }

      // ========== 厨房打印：设备来拉取/确认（print_token 鉴权）==========
      // 厨房平板 /kitchen 页 可用 kitchen session；agent/CloudPRNT 继续用 ?t=设备令牌。
      if (pathname.startsWith('/api/print/')) {
        const tok = url.searchParams.get('t') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const want = await setting(env, 'print_token');
        if (!((want && tok === want) || await verifyKitchenToken(env, tok))) return json({ error: 'unauthorized' }, 401);
        if (pathname === '/api/print/pending' && req.method === 'GET') {
          // 防止已取消/退款订单的小票还被打印（cancel 路径不删 print_jobs，靠这里 read-side 拦）。
          // o.id IS NULL 保留测试打印/TEST-% 等无对应订单的任务，照常打印。
          const profile = printProfile(await setting(env, 'print_profile'));
          const font_px = printFontPx(await setting(env, 'print_font_px'), profile);
          const jobs = await listPendingKitchenTickets(env, profile, 20);
          return json({ jobs, profile: { ...profile, font_px } });
        }
        if (pathname === '/api/print/ack' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string').slice(0, 50) : [];
          const ts = new Date().toISOString();
          for (const jid of ids) await env.DB.prepare("UPDATE print_jobs SET status='printed', printed_at=? WHERE id=? AND status='pending'").bind(ts, jid).run();
          return json({ ok: true, acked: ids.length });
        }
        // Star CloudPRNT：网络小票机直接轮询（POST 状态→回 jobReady；GET 取票面；DELETE 确认）。免电脑。
        if (pathname === '/api/print/cloudprnt') {
          if (req.method === 'POST') {
            const profile = printProfile(await setting(env, 'print_profile'));
            const job = (await listPendingKitchenTickets(env, profile, 1))[0];
            return json({ jobReady: !!job, mediaTypes: ['text/plain'] });
          }
          if (req.method === 'GET') {
            // 原子认领：UPDATE 直接命中最老 pending 单并置 printed，RETURNING 票面。
            // 只有认领成功(改到 1 行)的请求才拿到 content → 多台网络小票机并发 GET 同一张不会重复打。
            const profile = printProfile(await setting(env, 'print_profile'));
            const job = (await listPendingKitchenTickets(env, profile, 1))[0];
            if (!job) return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
            const claimed = await env.DB.prepare("UPDATE print_jobs SET status='printed', printed_at=? WHERE id=? AND status='pending' RETURNING id").bind(new Date().toISOString(), job.id).first();
            if (!claimed) return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
            return new Response(job.content + '\n\n\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
          }
          if (req.method === 'DELETE') return json({ ok: true });
        }
        return json({ error: 'not found' }, 404);
      }

      // ---------- GET /api/delivery-config : 3 tiers + postal zones (UX copy; server is authority) ----------
      if (pathname === '/api/delivery-config' && req.method === 'GET') {
        const dcfg = await deliveryConfig(env);
        return json({
          same_day_cutoff: dcfg.same_day_cutoff,
          anytime: { fee: dcfg.anytime.fee, note: dcfg.anytime.note, courier: await courierProvider(env) },
          zones: dcfg.zones.map(z => ({ id: z.id, name_cn: z.name_cn, name_en: z.name_en,
            weekdays: z.weekdays, sectors: z.sectors, free_over: z.free_over, fee: z.fee, block_below: z.block_below })),
        });
      }
      // ---------- POST /api/quote : 自费随时送 live shipping quote (Lalamove/uParcel or manual S$0) ----------
      if (pathname === '/api/quote' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const r = await anytimeFee(env, b.postal, +b.subtotal || 0);
        // 算不出运费 → 告诉前端不可下单（mode='unavailable'），不再静默返 S$0
        if (r.blocked) return json({ mode: 'unavailable', fee: 0, blocked: true, note: r.reason });
        return json({ mode: r.source, fee: r.fee, note: r.label, km: r.km || null });
      }

      // ---------- POST /api/order : create an order ----------
      // ---------- 顾客侧：制作进度 ----------
      // 订单 id（UUID）本身就是凭据，所以这里【严格字段白名单】：不返回姓名/电话/地址/金额，
      // 拿到链接的人只能看到"做到哪一步了"。
      if (/^\/api\/order\/[^/]+\/status$/.test(pathname) && req.method === 'GET') {
        const oid = decodeURIComponent(pathname.split('/')[3] || '');
        const o = await env.DB.prepare(
          `SELECT id,invoice_no,fulfil_status,status_msg,delay_minutes,arrived_at,status_at,
             fulfilment,deliver_at,deliver_time,pay_status,created_at FROM orders WHERE id=?`).bind(oid).first();
        if (!o) return json({ error: 'not found' }, 404);
        const st = normFulfilStatus(o.fulfil_status);
        return json({
          id: o.id, invoice_no: o.invoice_no, status: st, status_label: FULFIL_LABEL[st],
          status_msg: o.status_msg || null, delay_minutes: o.delay_minutes || 0,
          arrived: !!o.arrived_at, status_at: o.status_at || null,
          fulfilment: o.fulfilment, deliver_at: o.deliver_at || null, deliver_time: o.deliver_time || null,
          pay_status: o.pay_status, created_at: o.created_at,
        });
      }
      // 顾客点「我到店了」：只写一次，且加原子限流槽位防刷
      if (/^\/api\/order\/[^/]+\/arrived$/.test(pathname) && req.method === 'POST') {
        const oid = decodeURIComponent(pathname.split('/')[3] || '');
        const o = await env.DB.prepare('SELECT id,invoice_no,arrived_at,fulfil_status FROM orders WHERE id=?').bind(oid).first();
        if (!o) return json({ error: 'not found' }, 404);
        if (o.arrived_at) return json({ ok: true, arrived: true, deduped: true });
        // reserve-before-act：先查锁，再记一次命中；两者顺序反了就会给并发留出爆破窗口
        const lock = await throttleLocked(env, 'arrived', oid);
        if (lock.locked) return json({ error: '请求过于频繁，请稍后再试' }, 429);
        const hit = await throttleHit(env, 'arrived', oid, { lockAt: 5, windowMs: 60000, lockMs: 300000 });
        if (hit.limited) return json({ error: '请求过于频繁，请稍后再试' }, 429);
        const ts = new Date().toISOString();
        const upd = await env.DB.prepare('UPDATE orders SET arrived_at=? WHERE id=? AND arrived_at IS NULL').bind(ts, oid).run();
        if (upd.meta && upd.meta.changes === 1) {
          await appendOrderEvent(env, oid, 'arrived', 'customer', '顾客点了「我到店了」');
          const msg = `🙋 顾客到店 ${o.invoice_no || oid}\n当前状态：${FULFIL_LABEL[normFulfilStatus(o.fulfil_status)]}`;
          if (ctx && ctx.waitUntil) ctx.waitUntil(notifyTelegram(env, msg, { _order_id: oid }));
          else notifyTelegram(env, msg, { _order_id: oid }).catch(() => {});
        }
        return json({ ok: true, arrived: true });
      }

      if (pathname === '/api/order' && req.method === 'POST') {
        const body = await req.json();
        const items = Array.isArray(body.items) ? body.items : [];
        const userId = await verifySession(env, _bearer(req) || body.token);
        const account = userId ? await env.DB.prepare('SELECT phone,name FROM user_accounts WHERE id=?').bind(userId).first() : null;
        if (userId && !account) return json({ error: 'account not found' }, 401);
        const submittedPhone = normPhone(body.phone || '');
        const orderPhone = submittedPhone || (account && account.phone) || '';
        const existingOrderResponse = async () => {
          if (!body.client_token) return null;
          const dup = await env.DB.prepare('SELECT id,invoice_no,total,paid_by_balance,pay_status FROM orders WHERE client_token=?').bind(body.client_token).first();
          if (!dup) return null;
          const dn = Math.max(0, +(dup.total - (dup.paid_by_balance || 0)).toFixed(2));
          return json({ ok: true, id: dup.id, invoice_no: dup.invoice_no, total: dup.total, paid_by_balance: dup.paid_by_balance || 0, due_now: dn, paid: dup.pay_status === 'PAID', invoice_url: `${url.origin}/invoice/${dup.id}`, deduped: true });
        };
        if (!items.length) return json({ error: 'missing items' }, 400);
        if (!userId && !orderPhone) return json({ error: '游客下单请填写联系电话 Phone required for guest checkout' }, 400);
        if (orderPhone && !/^\d{8,15}$/.test(orderPhone)) return json({ error: '联系电话应为 8–15 位数字 Invalid phone number' }, 400);
        // 幂等查重必须早于营业状态/优惠码校验：重试已有订单时，即使店铺状态变了或券已被首请求占用，也应返回原订单。
        { const dupResp = await existingOrderResponse(); if (dupResp) return dupResp; }
        // ---- store open/close gate: boss can pause online ordering from the admin
        // panel. Enforced server-side so a direct POST can't bypass a "closed" site.
        // (POS / offline sales are unaffected — only this public endpoint is gated.)
        const storeState = await getSettings(env, ['store_open', 'store_closed_msg']);
        if (storeState.store_open === '0') {
          return json({ error: storeState.store_closed_msg || '小店暂停接单，请稍后再来 🙏 Online ordering is paused', closed: true }, 503);
        }
        // ---- 权威定价：价格只认【活动发布】，客户端报的价一律忽略 ----
        // 一条查询同时拿到活动指针、该发布的交易规则和涉及 SKU 的当前/历史行；
        // 之后整笔交易都不再解析活动指针，避免中途激活把两套规则拌在一起。
        for (const it of items) {
          const rawQty = parseInt(it.qty, 10);
          if (Number.isFinite(rawQty) && rawQty > 99) return json({ error: `数量超出上限（每项最多 99）qty per item max 99` }, 400);
        }
        const quote = await quoteActiveReleaseItems(env, {
          menuRevision: body.menu_revision,
          items: items.map(it => ({ sku: it.sku, qty: Math.max(1, parseInt(it.qty, 10) || 1) })),
        });
        if (quote.status === 400) return json({ error: '购物车无效，请刷新菜单后重试 · Invalid cart — please refresh the menu and retry' }, 400);
        if (quote.status === 503) return json({ error: '菜单尚未发布，请稍后再试 · Menu is not published yet' }, 503);
        if (!quote.ok) {
          // 菜单已变：在【任何写入之前】把差异如实返回，等顾客明确按新价格确认。
          // 这里只用只读逻辑算一个预览合计；运费与优惠码要等顾客选完才成立，故为 0。
          const previewSubtotal = quote.subtotal_cents / 100;
          const preview = computeOrderTotals(previewSubtotal, 0, 0, {
            gst_registered: quote.release_rules.gst_registered, gst_rate: quote.release_rules.gst_rate,
            service_charge_enabled: quote.release_rules.service_charge_enabled,
            service_charge_rate: quote.release_rules.service_charge_rate,
          });
          const cents = value => Math.round(Number(value || 0) * 100);
          return json({
            error: 'menu_changed', code: 'menu_changed',
            active_revision: quote.active_revision,
            changes: quote.changes, lines: quote.lines, subtotal_cents: quote.subtotal_cents,
            release_rules: quote.release_rules,
            current_total: {
              subtotal_cents: quote.subtotal_cents,
              delivery_fee_cents: cents(preview.delivery_fee),
              discount_cents: cents(preview.discount),
              service_charge_cents: cents(preview.service_charge),
              gst_cents: cents(preview.gst),
              total_cents: cents(preview.total),
            },
          }, 409);
        }
        const priced = quote.lines.map(line => ({ sku: line.sku, name: line.name_cn, qty: line.qty, unit_price: line.unit_price_cents / 100, ...pricedLineExtras(line) }));
        const subtotal = quote.subtotal_cents / 100;
        const acceptedRevision = quote.revision;
        if (subtotal <= 0) return json({ error: '订单金额无效 invalid order amount' }, 400);   // 防商品价被改成 0/负 → 免费单（offline 路径已有同款守卫 @649）
        // ----- fulfilment tier: pickup 自取 | discount 优惠配送(自有车·按片区) | anytime 自费随时送(快递报价) -----
        // Money/eligibility recomputed here; client copy is UX-only. Store gate already enforced above.
        const tier = body.fulfilment || 'pickup';
        if (!['pickup', 'discount', 'anytime'].includes(tier)) return json({ error: '配送方式无效 invalid fulfilment' }, 400);
        // Only the emergency switch is mutable. Check the accepted release before its hours or pickup rules can reject a stale cart.
        const releaseRules = quote.release_rules;
        let wantDate0 = (typeof body.deliver_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.deliver_at)) ? body.deliver_at : null;
        let wantTime0 = (typeof body.deliver_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.deliver_time)) ? body.deliver_time : null;
        if (tier === 'pickup' || tier === 'anytime') {
          const ft = checkFulfilTime(releaseRules.business_hours_schedule, releaseRules.prep_time_min, wantDate0, wantTime0, new Date(), tier === 'pickup');
          if (ft.error) return json({ error: ft.error, closed: true, off_hours: true }, 503);
          if (ft.auto) { wantDate0 = ft.auto.date; wantTime0 = ft.auto.time; }
        }
        // 配送片区与截单时间同样来自这一单接受的发布 —— 顾客看到的「满 S$100 免运」
        // 与结账实收必须是同一份规则。老板改了片区但没发布时，不能按新规则收钱。
        const dcfg = releaseRules.delivery;
        const postal = (body.postal || '').replace(/\D/g, '') || null;
        // deliver_at 强制 YYYY-MM-DD 格式（非法/含 HTML 一律置 null）：防匿名顾客把 <img onerror> 存进订单 → 老板后台存储型 XSS。
        let deliveryFee = 0, tierNote = null, deliverAtFinal = wantDate0;   // 复用上面已校验的日期
        let courierSnapshot = null;
        let pickupPoint = null;
        let freeOverThreshold = 0, freeBaseFee = 0;   // 免运费门槛 + 不免时的运费 —— 折扣算出后按"折扣后金额"重判免运（老板定：门槛算折扣后）
        const deliverTime = wantTime0;                                       // 复用上面已校验的时刻（HH:MM，已防 XSS）
        const routeId = null;                              // legacy 拼单 corridor model retired for postal zones
        if (tier === 'pickup') {
          if (!releaseRules.pickup_enabled) return json({ error: '自取暂未开放 Pickup is currently unavailable' }, 400);
          const activePoints = releaseRules.pickup_display;
          const requestedPointId = String(body.pickup_point_id || body.unit_no || '').trim();
          pickupPoint = activePoints.find(p => p.id === requestedPointId) || (!requestedPointId ? activePoints[0] : null);
          if (!pickupPoint) return json({ error: '请选择仍在开放的自取点 Please select an available pickup location', code: 'pickup_point_unavailable' }, 400);
          if (deliverAtFinal && deliverAtFinal < sgtTodayStr()) return json({ error: '取餐日期不能早于今天，请重选日期' }, 400);   // 补 tier parity：discount(1062)/anytime(1069) 都拒过去日期，pickup 原先漏（防 crafted 请求/跨时区客户端提交过去取餐日）
        } else if (tier === 'discount') {                  // 老板自有车 · 按片区预约出发
          if (!releaseRules.delivery_enabled) return json({ error: '优惠配送暂未开放，请选择自取或自费随时送' }, 400);
          if (!dcfg || !Array.isArray(dcfg.zones) || !dcfg.zones.length) return json({ error: '此发布的配送规则不可用，请选择自取或自费随时送 · Delivery rules unavailable', code: 'delivery_rules_unavailable' }, 400);
          if (!postal) return json({ error: '请填写配送邮编 Postal code required' }, 400);
          const zone = findZone(dcfg, postal);
          if (!zone) return json({ error: '该地址不在优惠配送范围，请改用「自费随时送」' }, 400);
          const fee = zoneFee(zone, subtotal);
          if (fee.blocked) return json({ error: `${zone.name_cn}未满 S$${fee.min}，请改用「自费随时送」` }, 400);
          // 防超收/TOCTOU：老板若在顾客下单瞬间改了片区运费，显示费≠收费 → 让顾客确认后重下（仿 anytime 档）。比的是片区"基础运费"，与免运门槛无关。
          if (body.quoted_fee != null && Math.abs((+zone.fee || 0) - +(+body.quoted_fee).toFixed(2)) > 0.01) return json({ error: `运费已更新为 S$${(+zone.fee || 0).toFixed(2)}，请确认后重新下单`, new_fee: +zone.fee || 0 }, 409);
          if (zone.free_over > 0) { freeOverThreshold = zone.free_over; freeBaseFee = +zone.fee || 0; }   // 捕获免运门槛+基础费，折扣后重判
          const dateStr = wantDate0 || sgtTodayStr();   // 用已校验日期(L1195)，不复用未校验的 body.deliver_at
          if (dateStr < sgtTodayStr()) return json({ error: '配送日期不能早于今天，请重选日期' }, 400);
          if (!zone.weekdays.includes(weekdayOf(dateStr))) return json({ error: `${zone.name_cn}仅在指定星期配送，请重选日期` }, 400);
          if (dateStr === sgtTodayStr() && pastSgtCutoff(dcfg.same_day_cutoff)) return json({ error: `当日 ${dcfg.same_day_cutoff} 已截单，请改选下一个可送日期` }, 400);
          deliveryFee = fee.fee; deliverAtFinal = dateStr;  // persist the date we actually validated
          tierNote = `优惠配送 · ${zone.name_cn} · 邮编${postal}`;
        } else if (tier === 'anytime') {                    // 本店配送/自费随时送：报价|一口价|按距离，绝不静默 S$0
          if (!postal) return json({ error: '请填写配送邮编 Postal code required' }, 400);
          if (deliverAtFinal && deliverAtFinal < sgtTodayStr()) return json({ error: '配送日期不能早于今天，请重选日期' }, 400);
          const r = await anytimeFee(env, postal, subtotal);
          // 算不出运费 → 拦单（不允许 S$0 静默成交）；顾客可改自取或稍后再试
          if (r.blocked) return json({ error: `${r.reason}。请改为「自取」，或稍后再试 / 联系本店。`, delivery_unavailable: true }, 503);
          if (r.source === 'courier') {   // 只有实时快递报价才做"防超收"二次确认
            const shown = body.quoted_fee != null ? +(+body.quoted_fee).toFixed(2) : null;
            if (shown != null && Math.abs(r.fee - shown) > 0.01) return json({ error: `运费已更新为 S$${r.fee.toFixed(2)}，请确认后重新下单`, new_fee: r.fee }, 409);
            courierSnapshot = { postal, provider: r.provider || 'lalamove', ref: r.ref || null, fee: r.baseFee, currency: r.currency || 'SGD', shop: r.shop || null, dropoff: r.dropoff || null };
          }
          if (r.freeAbove > 0) { freeOverThreshold = r.freeAbove; freeBaseFee = +r.baseFee || 0; }   // 捕获免运门槛+基础费，折扣后重判
          deliveryFee = r.fee;
          tierNote = `${r.label} · 邮编${postal}`;
        }
        // 配送单必须有街道地址：只填邮编(扇区)司机找不到人 → 拒。pickup 到店取无需地址。
        if (tier !== 'pickup' && !((typeof body.address === 'string' ? body.address : '').trim())) {
          return json({ error: '请填写配送地址 Delivery address required' }, 400);
        }
        // 顾客特殊要求优先入 note（厨房小票打印）；方式/地址/送达已单独打印，tierNote 仅在无顾客备注时兜底保留配送档调试信息。
        const customerNote = (typeof body.note === 'string' ? body.note : '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const noteFinal = customerNote || tierNote || null;
        // promo code (server-validated; never trust client discount)
        let discount = 0, promoCode = null;
        if (body.promo_code) {
          const pr = await checkPromo(env, body.promo_code, subtotal, tier, orderPhone, !!userId, userId);
          if (pr.error) { const dupResp = await existingOrderResponse(); if (dupResp) return dupResp; return json({ error: pr.error }, 400); }
          discount = pr.discount; promoCode = pr.code;
        }
        // 免运费门槛按"折扣后金额"判定（老板定）：折扣后掉出门槛 → 取消免运、补收基础运费；够门槛 → 免运。
        if (freeOverThreshold > 0) {
          const effSub = Math.max(0, +(subtotal - discount).toFixed(2));
          deliveryFee = effSub >= freeOverThreshold ? 0 : freeBaseFee;
        }
        // 税与服务费来自这一单接受的那个发布，不是可变草稿。
        const pricing = pricingConfigFromReleaseRules(quote.release_rules);
        const charges = computeOrderTotals(subtotal, deliveryFee, discount, pricing);
        const total = charges.total;
        const balanceCap = Math.min(total, balanceEligibleTotal(subtotal, discount, pricing));

        const now = new Date();
        // 原子取号（替换 COUNT(*)+1，杜绝并发撞 invoice_no UNIQUE）。day = SGT 营业日。
        const dayCompact = sgtDayCompact(now);
        const seq = await nextInvoiceSeq(env, dayCompact);
        const inv = `${invoicePrefix(env)}-${dayCompact}-${String(seq).padStart(4, '0')}`;
        const id = uuid();
        const payRef = invoicePrefix(env) + inv.slice(-4);

        // ----- 储值余额抵扣意向（先只读判定，先不扣；只认稳定 user_id）-----
        let wantBalance = 0, sessOk = false;
        if (body.use_balance) {
          if (!userId) return json({ error: '使用储值余额需先登录会员账户 Login required to use balance' }, 401);
          sessOk = true;
          const m = await env.DB.prepare('SELECT balance FROM members WHERE user_id=?').bind(userId).first();
          wantBalance = Math.min(+((m?.balance) || 0).toFixed(2), balanceCap);
          if (!(wantBalance > 0)) return json({ error: '当前会员没有可用储值余额可抵扣（配送费不可用余额支付）No usable stored value balance', balance_payable: balanceCap }, 400);
          // 紧急止血开关（default off）：临时禁「余额抵扣 + 仍需补付」的部分抵扣单。
          // 开启后余额不足以覆盖整单时不抵扣，顾客付全额（余额够付整单仍可全额抵扣）。
          const blockPartial = (await setting(env, 'block_partial_balance')) === '1';
          if (blockPartial && wantBalance > 0 && wantBalance < +(total - 0.005).toFixed(2)) wantBalance = 0;
        }

        // 并发兜底：首请求可能在前面的早查之后才完成 INSERT，这里入库前再查一次。
        { const dupResp = await existingOrderResponse(); if (dupResp) return dupResp; }
        let promoClaimed = false;
        if (promoCode) {
          const pc = await claimPromoUse(env, promoCode);
          if (!pc.ok) { const dupResp = await existingOrderResponse(); if (dupResp) return dupResp; return json({ error: pc.error || '优惠码已用完' }, 409); }
          promoClaimed = true;
        }
        // ----- 先建单（provisional：未扣余额、UNPAID、manual_qr），杜绝「扣了钱单没建成」-----
        try {
          await env.DB.prepare(
            `INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,
               subtotal,delivery_fee,discount,service_charge,service_charge_rate,gst,gst_rate,gst_registered,promo_code,promo_claimed,paid_by_balance,total,fulfilment,address,deliver_at,deliver_time,route_id,unit_no,note,pay_provider,pay_ref,pay_status,paid_at,client_token,menu_revision)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(id, inv, now.toISOString(), (body.customer_name || '').trim() || (account && account.name) || '游客', orderPhone, userId, JSON.stringify(priced),
            +subtotal.toFixed(2), charges.delivery_fee, discount, charges.service_charge, charges.service_charge_rate, charges.gst, charges.gst_rate, charges.gst_registered,
            promoCode, promoClaimed ? 1 : 0, 0, total, tier,
            tier === 'pickup' ? pickupSnapshot(pickupPoint) : (body.address || null),
            deliverAtFinal, (tier === 'discount' ? null : deliverTime), routeId,
            tier === 'pickup' ? pickupPoint.id : (body.unit_no || null), noteFinal,
            'manual_qr', payRef, 'UNPAID', null, body.client_token || null, acceptedRevision).run();
        } catch (e) {
          if (promoClaimed) await releasePromoUse(env, promoCode);
          // 并发同 client_token → orders UNIQUE 冲突 → 查已有单返回，保持幂等
          if (body.client_token && /UNIQUE|constraint/i.test(e.message || '')) {
            const dupResp = await existingOrderResponse(); if (dupResp) return dupResp;
          }
          throw e;
        }
        if (courierSnapshot && courierSnapshot.provider === 'lalamove') {
          try { await saveDeliverySnapshot(env, id, courierSnapshot, now.toISOString()); } catch (e) {}
        }

        // ----- 余额扣款移到建单之后：一个 batch 事务原子完成「扣余额 + 记到订单」 -----
        // ① 仅 balance>=want 时扣，并把 members.updated_at 写成唯一 token 作成功标记；
        // ② 订单更新 WHERE EXISTS(该 token) 条件门，只在扣成功时落 paid_by_balance/状态。
        let paidByBalance = 0;
        if (sessOk && wantBalance > 0) {
          const ts2 = new Date().toISOString();
          const token = `bal:${id}:${crypto.randomUUID()}`;
          const fp = wantBalance >= +(total - 0.005).toFixed(2);   // 余额够付整单 → 直接 PAID
          const res = await env.DB.batch([
            env.DB.prepare('UPDATE members SET balance=round(balance-?,2), updated_at=? WHERE user_id=? AND balance>=?')
              .bind(wantBalance, token, userId, wantBalance),
            env.DB.prepare(`UPDATE orders SET paid_by_balance=?, pay_status=?, paid_at=?, pay_provider=?
              WHERE id=? AND EXISTS(SELECT 1 FROM members WHERE user_id=? AND updated_at=?)`)
              .bind(wantBalance, fp ? 'PAID' : 'UNPAID', fp ? ts2 : null, fp ? 'balance' : 'manual_qr', id, userId, token),
          ]);
          paidByBalance = (res[0].meta && res[0].meta.changes > 0) ? wantBalance : 0;
        }
        const dueNow = +(total - paidByBalance).toFixed(2);
        const fullyPaid = dueNow <= 0.005;

        // 厨房小票自动入队：默认与 Telegram 一样只在付款成功后打；显式设为 placed 才下单即打。
        const printWhen = (await setting(env, 'print_when')) || 'paid';
        if (fullyPaid || printWhen !== 'paid') {
          const oForPrint = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
          await enqueueKitchenTicket(env, oForPrint);
        }
        // Telegram 来单提醒已移到"付款成功"各点（储值全额付 / Stripe webhook 确认 / 手动标付）——下单未付不再推，只推已付款的真单。

        const invoiceUrl = `${url.origin}/invoice/${id}`;

        // fully paid by stored-value balance → confirm immediately
        if (fullyPaid) {
          const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
          if (o) { await accruePoints(env, o); await notifyBossPaid(env, o); if (ctx && ctx.waitUntil) ctx.waitUntil(notifyNewOrderTelegram(env, id)); else notifyNewOrderTelegram(env, id).catch(() => {}); }   // 储值全额付=即时付款成功 → Telegram 推送；配送由老板手动叫车
          return json({ ok: true, id, invoice_no: inv, total, discount, paid_by_balance: paidByBalance, due_now: 0, paid: true, invoice_url: invoiceUrl });
        }

        // ----- Stripe charges the remaining amount due (after discount + balance) -----
        const PAYMODE = await setting(env, 'PAY_MODE');
        const STRIPE_SK = await setting(env, 'STRIPE_SECRET_KEY');
        if (PAYMODE === 'stripe' && STRIPE_SK) {
          try {
            const sess = await stripeCreateCheckout(env, { order_id: id, inv, amountDue: dueNow, origin: url.origin });
            await env.DB.prepare("UPDATE orders SET pay_provider='stripe', pay_ref=? WHERE id=?").bind(sess.id, id).run();
            return json({ ok: true, id, invoice_no: inv, total, discount, paid_by_balance: paidByBalance, due_now: dueNow, checkout_url: sess.url, invoice_url: invoiceUrl });
          } catch (e) { /* fall through to manual PayNow if Stripe call fails */ }
        }
        if ((PAYMODE === 'aipfintech' || PAYMODE === 'allinpay') && (await setting(env, 'AIPFINTECH_ENABLED')) === '1') {
          try {
            const sess = await aipfintechCreateCheckout(env, { order_id: id, inv, amountDue: dueNow, origin: url.origin });
            await env.DB.prepare("UPDATE orders SET pay_provider='aipfintech', pay_ref=? WHERE id=?").bind(sess.orderId || sess.accessOrderId || '', id).run();
            return json({ ok: true, id, invoice_no: inv, total, discount, paid_by_balance: paidByBalance, due_now: dueNow, checkout_url: sess.payUrl, invoice_url: invoiceUrl });
          } catch (e) { /* fall through to manual PayNow if AIP/Allinpay call fails */ }
        }

        // ----- Manual PayNow fallback (no gateway) -----
        // Auto-send the invoice + PayNow instructions to WhatsApp now (if configured).
        if (orderPhone && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
          try {
            // dueNow (= total − balance applied) is what the customer must PayNow, not the gross total
            await sendWhatsAppInvoice(env, { phone: orderPhone, invoice_no: inv, total: dueNow, invoice_url: invoiceUrl });
            await env.DB.prepare('UPDATE orders SET wa_sent_at=? WHERE id=?')
              .bind(new Date().toISOString(), id).run();
          } catch (e) { /* never fail the order because WhatsApp send failed */ }
        }
        return json({
          ok: true, id, invoice_no: inv, total, discount, paid_by_balance: paidByBalance, due_now: dueNow, pay_ref: payRef,
          paynow_uen: env.PAYNOW_UEN || null,
          invoice_url: invoiceUrl,
        });
      }

      // ---------- GET /invoice/:id : public invoice page (HTML) ----------
      if (pathname.startsWith('/invoice/') && req.method === 'GET') {
        const id = pathname.split('/')[2];
        const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
        if (!o) { const m = await merchantInfo(env); return privateResponse(new Response(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>未找到订单 Order not found</title><style>body{font-family:system-ui,'Noto Sans CJK SC',sans-serif;max-width:520px;margin:0 auto;padding:48px 18px;color:#33301F;background:#F6EFE0;text-align:center}h1{color:#1C4A3A;font-size:20px;margin:0 0 8px}.muted{color:#6E6650;font-size:14px;line-height:1.7}a.btn{display:inline-block;margin-top:18px;background:#1C4A3A;color:#F4E7C8;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700}</style></head><body><h1>${esc(m.nameCn)} ${esc(m.nameEn)}</h1><p class="muted">未找到这张订单 / 发票，链接可能已失效或输入有误。<br>Order / invoice not found — the link may be invalid or expired.</p><a class="btn" href="${url.origin}/">返回点单 Back to menu</a></body></html>`, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })); }
        // 发票页含顾客姓名、电话、地址与订单明细：绝不能被中间缓存或爬虫收录。
        return privateResponse(new Response(await renderInvoice(o, env), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }));
      }

      // ---------- Allinpay/AIP hosted checkout return + async notify ----------
      if (pathname === '/api/payment/aipfintech-return' && (req.method === 'GET' || req.method === 'POST')) {
        let orderId = url.searchParams.get('order_id') || '';
        if (req.method === 'POST') {
          const form = await req.formData().catch(() => null);
          const accessOrderId = form && String(form.get('accessOrderId') || '');
          if (!orderId && accessOrderId) {
            const o = await env.DB.prepare('SELECT id FROM orders WHERE invoice_no=? OR id=?').bind(accessOrderId, accessOrderId).first();
            orderId = o && o.id || '';
          }
        }
        return Response.redirect(`${url.origin}/invoice/${orderId || ''}?payment_return=1`, 302);
      }

      if (pathname === '/api/webhook/aipfintech' && req.method === 'POST') {
        const raw = await req.text();
        let params = {};
        try {
          const ct = req.headers.get('content-type') || '';
          if (ct.includes('application/json')) params = await JSON.parse(raw);
          else for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
        } catch (e) { return new Response('FAIL', { status: 400 }); }

        try { await aipfintechVerifyParams(env, params); }
        catch (e) { return new Response('FAIL', { status: 400 }); }

        const accessOrderId = String(params.accessOrderId || '');
        const gatewayOrderId = String(params.orderId || '');
        const eventId = 'aipfintech:' + await _sha256Hex(raw);
        const ins = await env.DB.prepare('INSERT OR IGNORE INTO payment_events (event_id,type,created_at,raw) VALUES (?,?,?,?)')
          .bind(eventId, 'aipfintech.notify', new Date().toISOString(), raw.slice(0, 6000)).run();
        if (!(ins.meta && ins.meta.changes > 0)) return new Response('SUCCESS', { headers: { 'content-type': 'text/plain; charset=utf-8' } });

        let action = 'IGNORED', amount = +(params.amount || 0);
        let orderId = '';
        try {
          const o = await env.DB.prepare('SELECT * FROM orders WHERE invoice_no=? OR id=?').bind(accessOrderId, accessOrderId).first();
          if (o) {
            orderId = o.id;
            const expected = +(o.total - (o.paid_by_balance || 0)).toFixed(2);
            if (String(params.resultCode || '') === '0000' && Math.abs(amount - expected) <= 0.005) {
              const upd = await env.DB.prepare("UPDATE orders SET pay_status='PAID', paid_at=?, pay_txn=?, raw_webhook=? WHERE id=? AND pay_status='UNPAID'")
                .bind(new Date().toISOString(), gatewayOrderId, raw.slice(0, 4000), o.id).run();
              if (upd.meta && upd.meta.changes > 0) {
                action = 'PAID';
                await accruePoints(env, o);
                await notifyBossPaid(env, o);
                await enqueueKitchenTicket(env, o);
                if (ctx && ctx.waitUntil) ctx.waitUntil(notifyNewOrderTelegram(env, o.id)); else notifyNewOrderTelegram(env, o.id).catch(() => {});
              } else action = 'PAID_DUP';
            } else if (String(params.resultCode || '') === '0000') {
              action = 'MISMATCH';
              await env.DB.prepare("UPDATE orders SET note=COALESCE(note,'')||? WHERE id=?")
                .bind(` [AIP_AMOUNT_MISMATCH paid=${amount.toFixed(2)} expected=${expected.toFixed(2)}]`, o.id).run();
            } else action = 'FAILED';
          }
          await env.DB.prepare('UPDATE payment_events SET order_id=?, amount=?, status=? WHERE event_id=?')
            .bind(orderId || null, amount || null, action, eventId).run();
        } catch (e) {
          try { await env.DB.prepare('DELETE FROM payment_events WHERE event_id=?').bind(eventId).run(); } catch (e2) {}
          return new Response('FAIL', { status: 500 });
        }
        return new Response('SUCCESS', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }

      // ---------- POST /api/webhook/stripe : payment STATE MACHINE ----------
      // UNPAID -> PAID (amount-verified) | FAILED | EXPIRED ; PAID -> REFUNDED.
      // Idempotent on Stripe event id; never double-counts money.
      if (pathname === '/api/webhook/stripe' && req.method === 'POST') {
        const raw = await req.text();
        let event;
        try { event = await stripeVerify(raw, req.headers.get('stripe-signature'), await setting(env, 'STRIPE_WEBHOOK_SECRET')); }
        catch (e) { return json({ error: 'bad signature' }, 400); }

        // idempotency: first INSERT of this event_id wins; retries are no-ops
        const ins = await env.DB.prepare('INSERT OR IGNORE INTO payment_events (event_id,type,created_at,raw) VALUES (?,?,?,?)')
          .bind(event.id, event.type, new Date().toISOString(), raw.slice(0, 6000)).run();
        if (!(ins.meta && ins.meta.changes > 0)) return json({ received: true, duplicate: true });

        const s = event.data.object || {};
        let orderId = s.metadata?.order_id || s.client_reference_id || null;
        let action = 'IGNORED', amount = null;
        const setEvt = (act, amt) => env.DB.prepare('UPDATE payment_events SET order_id=?, amount=?, status=? WHERE event_id=?')
          .bind(orderId, amt, act, event.id).run();

        try {
          // member self-service top-up paid via Stripe → credit balance (idempotent via event log)
          // 入账以 Stripe 实收 amount_total 为准；creditTopup 内部 topupBonus(实收) 重算赠送；
          // 绝不信 metadata.topup_amount（仅用其 topup_phone 定位会员）。
          if (s.metadata && s.metadata.topup === '1' && (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && s.payment_status === 'paid') {
            const paid = +(((s.amount_total || 0) / 100)).toFixed(2);
            amount = paid;
            const topupUserId = s.metadata.topup_user_id || null;
            const account = topupUserId ? await env.DB.prepare('SELECT phone FROM user_accounts WHERE id=?').bind(topupUserId).first() : null;
            const tr = paid > 0 && (!topupUserId || account)
              ? await creditTopup(env, (account && account.phone) || s.metadata.topup_phone, paid, 'stripe', 'online', '线上充值', 'cs_' + s.id, topupUserId)
              : { error: topupUserId ? 'account not found' : 'zero amount' };   // client_token=checkout session id → 每个充值 session 只入账一次
            action = tr.ok ? 'TOPUP' : 'TOPUP_FAIL';
          } else if (orderId && (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && s.payment_status === 'paid') {
            amount = (s.amount_total || 0) / 100;
            const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
            const expected = o ? +(o.total - (o.paid_by_balance || 0)).toFixed(2) : 0;  // amount Stripe should charge
            if (!o) action = 'IGNORED';
            else if (Math.abs(amount - expected) > 0.005) {        // money guard: amount must match amount-due
              action = 'MISMATCH';
              await env.DB.prepare("UPDATE orders SET note=COALESCE(note,'')||? WHERE id=?")
                .bind(` [⚠AMOUNT_MISMATCH paid=${amount.toFixed(2)} expected=${expected.toFixed(2)}]`, orderId).run();
            } else {
              // 只允许 UNPAID→PAID（收紧 from !='PAID'）：防被 cron/webhook 退款置 CANCELLED 的单
              // 被迟到的 Stripe 付款复活成 PAID（届时余额已退，会造成顾客白嫖）。
              const upd = await env.DB.prepare("UPDATE orders SET pay_status='PAID', paid_at=?, pay_txn=?, raw_webhook=? WHERE id=? AND pay_status='UNPAID'")
                .bind(new Date().toISOString(), s.payment_intent || '', raw.slice(0, 4000), orderId).run();
              if (upd.meta && upd.meta.changes > 0) {
                action = 'PAID';
                await accruePoints(env, o);
                await notifyBossPaid(env, o);
                await enqueueKitchenTicket(env, o);   // 付款确认 → 厨房小票入队（幂等，下单已入则不重复）
                if (ctx && ctx.waitUntil) ctx.waitUntil(notifyNewOrderTelegram(env, o.id)); else notifyNewOrderTelegram(env, o.id).catch(() => {});   // Stripe 付款成功 → Telegram 推送
                if (normPhone(o.phone) && !o.wa_sent_at && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
                  try {
                    await sendWhatsAppInvoice(env, { phone: o.phone, invoice_no: o.invoice_no, total: o.total, invoice_url: `${url.origin}/invoice/${o.id}` });
                    await env.DB.prepare('UPDATE orders SET wa_sent_at=? WHERE id=?').bind(new Date().toISOString(), o.id).run();
                  } catch (e) {}
                }
              } else {
                // changes=0：要么本已 PAID（良性重复），要么已被退款链置 CANCELLED（顾客却真付了钱）。
                // 后者是真实资金错配（已 capture 但单已退储值），必须打 note + 区分 action 给老板对账，绝不静默。
                const cur = await env.DB.prepare('SELECT pay_status, balance_refunded_at FROM orders WHERE id=?').bind(orderId).first();
                if (cur && (cur.pay_status === 'CANCELLED' || cur.balance_refunded_at)) {
                  action = 'PAID_ON_CANCELLED';
                  await env.DB.prepare("UPDATE orders SET note=COALESCE(note,'')||? WHERE id=?")
                    .bind(` [⚠PAID_ON_CANCELLED Stripe实收 ${(amount || 0).toFixed(2)} txn=${s.payment_intent || ''} 单已取消/已退储值·请人工退款或履约]`, orderId).run();
                  try { await notifyBossPaid(env, o); } catch (e) {}
                } else action = 'PAID_DUP';
              }
            }
          } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
            // 放弃/过期：直接走统一退款链 → pay_status='CANCELLED' + 退回已扣储值（幂等）。
            // Stripe 具体态（expired/failed）记进 payment_events.status，不再单独先置 FAILED/EXPIRED。
            const reason = event.type === 'checkout.session.expired' ? 'stripe_expired' : 'stripe_failed';
            if (orderId) {
              const r = await cancelUnpaidOrderAndRefundBalance(env, orderId, reason);
              // 保留原有 promo 名额释放：放弃单不应耗占限量码（首次 claim 成功才释放，幂等）
              if (r.claimed && r.promo_code) await releasePromoForOrder(env, orderId, r.promo_code);
            }
            action = event.type === 'checkout.session.expired' ? 'EXPIRED' : 'FAILED';
          } else if (event.type === 'charge.refunded') {
            const pi = s.payment_intent || s.id;
            amount = (s.amount_refunded || 0) / 100;                         // 累计已退金额
            const o = await env.DB.prepare('SELECT * FROM orders WHERE pay_txn=?').bind(pi).first();
            if (o) {
              orderId = o.id;
              const stripePortion = +(o.total - (o.paid_by_balance || 0)).toFixed(2);   // Stripe 当初应收的那部分
              // ⚠️ 这里曾经是 `amount >= stripePortion` 就当整单退款 —— 那是个会白送钱的坑：
              // 混合支付单里 Stripe 那一笔【本来就可能只是运费】（生产真有这样一单：货款全走储值、
              // Stripe 只收了 19.10 运费）。这种单一退运费，累计已退就等于 stripePortion，
              // 于是被误判成整单退 → 置 REFUNDED（订单锁死）+ 退掉顾客 104.16 储值 + 扣光积分。
              // 正解：先把【我们自己发起的非整单退款】剥掉，剩下的才回答「货款到底退没退」。
              const own = await partialRefundTally(env, o.id);
              const cls = classifyChargeRefund({ total: o.total, paidByBalance: o.paid_by_balance || 0,
                amountRefunded: amount, ownStripe: own.stripe });
              const feeOnly = cls.kind === 'fee_only';
              const fullRefund = cls.kind === 'full';
              if (feeOnly) {
                // 只退了运费 → 订单保持 PAID，不退储值、不扣积分（退运费时已各自结过账）
                action = 'FEE_REFUND_CONFIRMED';
              } else if (fullRefund) {
                const upd = await env.DB.prepare("UPDATE orders SET pay_status='REFUNDED' WHERE id=? AND pay_status='PAID'").bind(o.id).run();
                if (upd.meta && upd.meta.changes > 0) {
                  action = 'REFUNDED';
                  // 退运费时已经按比例扣过积分/消费额了，这里要减掉那一份，否则同一笔钱扣两遍
                  await reversePoints(env, o, {
                    pts: own.amount > 0 ? Math.max(0, Math.floor(o.total) - Math.floor(Math.max(0, o.total - own.amount))) : 0,
                    amount: own.amount,
                  });
                  // 整单退款释放优惠码名额（与放弃/超时单 1274/1856 对称；在 changes>0 守卫内，REFUND_DUP 重复 webhook 不重复释放）
                  if (o.promo_code) await releasePromoForOrder(env, o.id, o.promo_code);
                  // 整单退款才退回已扣的 paid_by_balance（同一 balance_refunded_at/ref + wallet_events 幂等守卫）
                  // 已经通过退运费退回钱包的那部分要扣掉，否则顾客拿两次
                  await refundOrderBalance(env, o.id, 'stripe_charge_refunded', own.balance);
                  const dj = await env.DB.prepare('SELECT id FROM delivery_jobs WHERE order_id=?').bind(o.id).first();
                  if (dj) {
                    await updateDeliveryJob(env, o.id, { state: 'refund_confirmed', refund_status: 'confirmed', refund_ref: s.id || pi });
                    await notifyDelivery(env, o.id, 'refund_confirmed', { refund_id: s.id || pi });
                  }
                } else action = 'REFUND_DUP';
              } else {
                // 部分退款：金额对不齐，绝不自动退储值/置 REFUNDED 终态。打可见 note + 记 PARTIAL_REFUND 交人工对账。
                action = 'PARTIAL_REFUND';
                await env.DB.prepare("UPDATE orders SET note=COALESCE(note,'')||? WHERE id=?")
                  .bind(` [⚠PARTIAL_REFUND refunded=${amount.toFixed(2)}/stripe=${stripePortion.toFixed(2)} 储值未自动退·请人工对账]`, o.id).run();
              }
            }
          }
        } catch (e) {
          // 处理中真异常（D1 报错等）：释放幂等令牌并返回非 200，让 Stripe 重试重新处理，
          // 修「INSERT OR IGNORE 已占坑 + 吞 ERROR 仍返 200 → 永久丢事件」。
          try { await env.DB.prepare('DELETE FROM payment_events WHERE event_id=?').bind(event.id).run(); } catch (e2) {}
          return json({ error: 'processing failed', request_id: event.id }, 500);
        }
        await setEvt(action, amount);
        return json({ received: true, action });
      }

      // ---------- admin (token-protected) ----------
      if (pathname.startsWith('/api/admin/')) {
        if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        if (env[AGENT_ADMIN] === true && !AGENT_ADMIN_ROUTES.has(`${req.method} ${pathname}`)) {
          return json({ error: 'not available to agents', code: 'agent_route_forbidden' }, 403);
        }

        // ---------- AI agent keys + audit (owner only; agents can never manage keys) ----------
        if (pathname === '/api/admin/agent-keys' && req.method === 'GET') {
          return json({ keys: await listAgentKeys(env), scopes: AGENT_SCOPES });
        }
        if (pathname === '/api/admin/agent-keys' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          try { return json({ ok: true, ...(await createAgentKey(env, { name: b.name, scopes: b.scopes })) }); }
          catch (e) { if (e instanceof ToolError) return json({ error: e.message, code: e.code }, 400); throw e; }
        }
        if (pathname === '/api/admin/agent-keys/revoke' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          return (await revokeAgentKey(env, b.id)) ? json({ ok: true }) : json({ error: 'key not found or already revoked', code: 'not_found' }, 404);
        }
        if (pathname === '/api/admin/agent-audit' && req.method === 'GET') {
          return json({ entries: await listAgentAudit(env, url.searchParams.get('limit')) });
        }

        // ---------- menu categories (draft content: published with the menu) ----------
        if (pathname === '/api/admin/menu-categories' && req.method === 'GET') {
          const state = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
          return json({ categories: await loadMenuCategories(env), draft_revision: state?.draft_revision || null });
        }
        if (pathname === '/api/admin/menu-categories' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          let categories;
          try { categories = validateMenuCategories(b.categories); }
          catch (e) { if (e instanceof MenuCategoryError) return json({ error: e.message, code: 'invalid_categories' }, 400); throw e; }
          const keys = new Set(categories.map(c => c.key));
          const { results: used } = await env.DB.prepare('SELECT category, COUNT(*) n FROM products GROUP BY category').all();
          const orphaned = (used || []).filter(r => !keys.has(r.category));
          if (orphaned.length) {
            return json({ error: `这些分类仍有商品，不能删除：${orphaned.map(r => `${r.category}（${r.n} 个）`).join('、')} · still used by products`,
              code: 'category_in_use', in_use: orphaned }, 400);
          }
          const value = JSON.stringify(categories);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            actor: actorOf(env), action: 'menu_categories_saved', detail: { count: categories.length },
            buildStatements: ({ revision, now }) => [env.DB.prepare(`INSERT INTO app_settings (k,v,updated_at)
                SELECT 'menu_categories', ?, ? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)
                ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`).bind(value, now, revision)],
          });
          return result.ok ? json({ ok: true, categories, draft_revision: result.draft_revision })
            : draftConflict(result);
        }

        // ---------- POS cashier PINs (stored as PBKDF2 hashes; never returned) ----------
        if (pathname === '/api/admin/pos-pins' && req.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT cashier, updated_at FROM pos_pins ORDER BY cashier').all();
          return json({ cashiers: POS_CASHIERS.map(c => ({ cashier: c, has_pin: (results || []).some(r => r.cashier === c),
            updated_at: ((results || []).find(r => r.cashier === c) || {}).updated_at || null })) });
        }
        if (pathname === '/api/admin/pos-pins' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const cashier = String(b.cashier || '');
          if (!POS_CASHIERS.includes(cashier)) return json({ error: `cashier 必须是 ${POS_CASHIERS.join(' / ')}` }, 400);
          if (b.pin === null) {
            await env.DB.prepare('DELETE FROM pos_pins WHERE cashier=?').bind(cashier).run();
            return json({ ok: true, cashier, has_pin: false });
          }
          const pin = String(b.pin || '');
          if (!/^\d{6,12}$/.test(pin)) return json({ error: 'PIN 需为 6–12 位数字 · PIN must be 6–12 digits' }, 400);
          const { hash, salt } = await hashPassword(pin);
          await env.DB.prepare(`INSERT INTO pos_pins (cashier,pin_hash,pin_salt,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(cashier) DO UPDATE SET pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt, updated_at=excluded.updated_at`)
            .bind(cashier, hash, salt, new Date().toISOString()).run();
          await throttleClear(env, 'pos_login', cashier);
          return json({ ok: true, cashier, has_pin: true });
        }

        // 发布相关的内容校验失败（PublicContentError）要变成可读的 400，
        // 不能变成 500 —— 老板看到 500 只会以为系统坏了，而不是「营业时间填坏了」。
        const publicationGuard = async run => {
          try { return await run(); }
          catch (error) {
            if (error && error.name === 'PublicContentError') {
              console.error('publication content invalid', error.field, error.message);
              return json({ error: error.message, field: error.field, code: 'content_invalid' }, 400);
            }
            throw error;
          }
        };

        // ---------- 内容标签库 ----------
        if (pathname === '/api/admin/tags' && req.method === 'GET') {
          const [tags, products, assignments, state] = await env.DB.batch([
            env.DB.prepare('SELECT id,label_cn,label_en,tone,icon,active,sort FROM product_tags ORDER BY sort,id'),
            env.DB.prepare('SELECT sku,name_cn FROM products ORDER BY sort,sku'),
            env.DB.prepare('SELECT sku,tag_id FROM product_tag_assignments ORDER BY sku,sort,tag_id'),
            env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1'),
          ]);
          return json({ tags: tags.results || [], products: products.results || [], assignments: assignments.results || [],
            draft_revision: state.results?.[0]?.draft_revision || null });
        }
        if (pathname === '/api/admin/tags' && (req.method === 'POST' || req.method === 'PATCH')) {
          const b = await req.json().catch(() => ({}));
          const normalized = normalizeProductTagInput(b);
          if (!normalized.ok) return json({ error: normalized.error, field: normalized.field }, normalized.status || 400);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            action: 'tag_saved', detail: { id: normalized.tag.id },
            buildStatements: ({ revision, now }) => tagUpsertStatements(env, { revision, now, tag: normalized.tag }),
          });
          return result.ok ? json({ ok: true, draft_revision: result.draft_revision, tag: normalized.tag })
            : draftConflict(result);
        }
        if (pathname.startsWith('/api/admin/tags/') && req.method === 'DELETE') {
          const tagId = decodeURIComponent(pathname.slice('/api/admin/tags/'.length));
          if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(tagId)) return json({ error: '标签 ID 无效' }, 400);
          const inUse = await env.DB.prepare('SELECT COUNT(*) AS n FROM product_tag_assignments WHERE tag_id=?').bind(tagId).first();
          if (inUse?.n) return json({ error: '这个标签还挂在商品上，先取消关联或改为停用', code: 'tag_in_use' }, 409);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(url.searchParams.get('base_revision') || req.headers.get('if-match') || ''),
            action: 'tag_deleted', detail: { id: tagId },
            buildStatements: ({ revision }) => tagDeleteStatements(env, { revision, tagId }),
          });
          return result.ok ? json({ ok: true, draft_revision: result.draft_revision })
            : draftConflict(result);
        }
        if (/^\/api\/admin\/products\/[^/]+\/tags$/.test(pathname) && req.method === 'PUT') {
          const sku = decodeURIComponent(pathname.split('/')[4]);
          const b = await req.json().catch(() => ({}));
          const tagIds = Array.isArray(b.tag_ids) ? b.tag_ids.map(String) : null;
          if (!tagIds || tagIds.length > 12 || new Set(tagIds).size !== tagIds.length) return json({ error: '标签列表无效（最多 12 个且不可重复）' }, 400);
          const product = await env.DB.prepare('SELECT sku FROM products WHERE sku=?').bind(sku).first();
          if (!product) return json({ error: '商品不存在' }, 404);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            action: 'tags_assigned', detail: { sku, tag_ids: tagIds },
            buildStatements: ({ revision }) => productTagAssignmentStatements(env, { revision, sku, tagIds }),
          });
          return result.ok ? json({ ok: true, draft_revision: result.draft_revision })
            : draftConflict(result);
        }

        // ---------- 发布工作流 ----------
        if (pathname === '/api/admin/publication/status' && req.method === 'GET') {
          return json(await publicationStatus(env));
        }
        if (pathname === '/api/admin/publication/preview' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const state = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
          if (!state) return json({ error: '发布状态尚未初始化' }, 503);
          if (b.base_revision && b.base_revision !== state.draft_revision) {
            return json({ error: '页面上的内容已经被别处改过了，请刷新后重试', code: 'revision_conflict' }, 409);
          }
          const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();   // 十分钟
          const contentAt = b.content_at === undefined ? new Date().toISOString() : b.content_at;
          if (typeof contentAt !== 'string' || !Number.isFinite(Date.parse(contentAt))) return json({ error: '预览内容时间无效', code: 'invalid_content_at' }, 400);
          const token = await signPreviewToken(env.AUTH_SECRET, {
            draftRevision: state.draft_revision, expiresAt, nonce: crypto.randomUUID(), contentAt });
          return privateResponse(json({ ok: true, preview_url: `/preview/${token}/`, expires_at: expiresAt,
            draft_revision: state.draft_revision, content_at: contentAt }));
        }
        if (pathname === '/api/admin/publication/schedule' && req.method === 'POST') {
          return publicationGuard(async () => {
          const b = await req.json().catch(() => ({}));
          const effectiveAtUtc = b.effective_at_utc || sgtDateTimeLocalToUtc(b.effective_at_sgt);
          if (!effectiveAtUtc) return json({ error: '生效时间无效（用 SGT 的 YYYY-MM-DDTHH:MM）' }, 400);
          const result = await schedulePublicRelease(env, { expectedRevision: String(b.base_revision || ''),
            expectedActiveId: String(b.expected_active_release_id || ''), expectedChecksum: String(b.expected_draft_checksum || ''),
            effectiveAtUtc, actor: actorOf(env), pageBuilder: renderPublicReleasePages });
          return result.ok ? json({ ok: true, release_id: result.release_id, checksum: result.checksum, effective_at: effectiveAtUtc })
            : json({ error: '页面上的内容已经被别处改过了，请刷新后重试', code: result.code || 'revision_conflict' }, result.status || 409);
          });
        }
        if (pathname === '/api/admin/publication/cancel' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const result = await cancelScheduledRelease(env, { releaseId: String(b.release_id || ''), actor: actorOf(env) });
          return result.ok ? json({ ok: true, release_id: result.release_id })
            : json({ error: '这个发布已经生效或不存在，取消不了', code: result.code || 'cancel_rejected' }, result.status || 409);
        }
        if (pathname === '/api/admin/publication/publish-now' && req.method === 'POST') {
          return publicationGuard(async () => {
          const b = await req.json().catch(() => ({}));
          const result = await publishExactDraft(env, { expectedRevision: String(b.base_revision || ''),
            expectedActiveId: String(b.expected_active_release_id || ''), expectedChecksum: String(b.expected_draft_checksum || ''),
            actor: actorOf(env), pageBuilder: renderPublicReleasePages });
          return result.ok ? json(result)
            : json({ error: '核对之后内容或线上版本已变化，请重新预览核对', code: result.code }, result.status);
          });
        }
        if (pathname === '/api/admin/publication/rollback' && req.method === 'POST') {
          return publicationGuard(async () => {
          const b = await req.json().catch(() => ({}));
          if (!b.expected_active_release_id) return json({ error: '缺少核对时的线上版本，请重新加载核对', code: 'active_release_required' }, 409);
          const result = await rollbackExactRelease(env, { sourceReleaseId: String(b.release_id || ''),
            expectedActiveId: String(b.expected_active_release_id), actor: actorOf(env), pageBuilder: renderPublicReleasePages });
          return result.ok ? json({ ok: true, release_id: result.release_id, rolled_back_to: String(b.release_id) })
            : json({ error: '回滚没成功，请刷新后重试', code: result.code || 'publication_conflict' }, result.status || 409);
          });
        }

        // ---------- 受保护的目录更新与精确发布（catalog-guard-v1） ----------
        // 老板后台与目录调用方都使用已读取/已核对的基线。核对之后整行、
        // 草稿快照、活动发布或待生效排程任何一项变了，整批不写、返回 409（规则见 worker/publication.js）。
        if (pathname === '/api/admin/publication/draft-snapshot' && req.method === 'GET') {
          return publicationGuard(async () => {
            const when = url.searchParams.get('effective_at_sgt');
            const utc = when ? sgtDateTimeLocalToUtc(when) : new Date().toISOString();
            if (!utc) return json({ error: '生效时间无效', code: 'invalid_effective_at' }, 400);
            const result = await draftSnapshotComparison(env, { now: new Date(utc) });
            return privateResponse(json(result, result.ok ? 200 : result.status));
          });
        }
        if (pathname === '/api/admin/publication/publish-exact' && req.method === 'POST') {
          return publicationGuard(async () => {
            const b = await req.json().catch(() => ({}));
            const result = await publishExactDraft(env, { expectedActiveId: String(b.expected_active_release_id || ''),
              expectedChecksum: String(b.expected_draft_checksum || ''),
              ...(b.base_revision !== undefined ? { expectedRevision: String(b.base_revision) } : {}),
              actor: actorOf(env), pageBuilder: renderPublicReleasePages });
            return result.ok ? json({ ok: true, release_id: result.release_id, checksum: result.checksum, published_at: result.published_at })
              : json({ error: '核对之后草稿、活动发布或排程已经变化，未发布；请重新读取核对', code: result.code }, result.status);
          });
        }
        if (pathname === '/api/admin/publication/rollback-exact' && req.method === 'POST') {
          return publicationGuard(async () => {
            const b = await req.json().catch(() => ({}));
            const result = await rollbackExactRelease(env, { sourceReleaseId: String(b.release_id || ''),
              expectedActiveId: String(b.expected_active_release_id || ''), actor: actorOf(env), pageBuilder: renderPublicReleasePages });
            return result.ok ? json({ ok: true, release_id: result.release_id, checksum: result.checksum, rolled_back_to: String(b.release_id) })
              : json({ error: result.error || '活动发布已经变化或来源发布无效，未回滚；请重新读取核对', code: result.code }, result.status);
          });
        }
        if (pathname === '/api/admin/catalog/product-text' && req.method === 'POST') {
          const b = await req.json().catch(() => null);
          const set = b && b.set && typeof b.set === 'object' && !Array.isArray(b.set) ? b.set : null;
          const sku = typeof b?.sku === 'string' ? b.sku : '';
          const baseRowSha256 = typeof b?.base_row_sha256 === 'string' ? b.base_row_sha256 : '';
          if (!/^[A-Z0-9_-]{2,16}$/.test(sku) || !/^[0-9a-f]{64}$/.test(baseRowSha256) || !set
              || Object.keys(set).sort().join() !== [...PRODUCT_TEXT_FIELDS].sort().join()) {
            return json({ error: '需要 sku、base_row_sha256 与恰好 7 个文案 / 价格字段', code: 'invalid_request' }, 400);
          }
          // 与 product-save 同一套清洗规则；清洗会改动任何字段就拒绝，保证落库的正是调用方核对过的字。
          const values = {
            name_cn: cleanProductText(set.name_cn, 120), name_en: cleanProductText(set.name_en, 160),
            price: Math.round(Number(set.price) * 100) / 100,
            description_cn: cleanProductText(set.description_cn, 240), description_en: cleanProductText(set.description_en, 300),
            detail_cn: cleanProductLongText(set.detail_cn, 2000), detail_en: cleanProductLongText(set.detail_en, 2400),
          };
          const priceOk = (typeof set.price === 'number' ? Number.isFinite(set.price)
            : typeof set.price === 'string' && /^\d{1,3}(\.\d{1,2})?$/.test(set.price))
            && values.price > 0 && values.price <= 999 && Math.abs(values.price - Number(set.price)) < 1e-9;
          const altered = PRODUCT_TEXT_FIELDS.filter(field => field === 'price' ? !priceOk
            : typeof set[field] !== 'string' || values[field] !== set[field] || (field.startsWith('name_') && !values[field]));
          if (altered.length) return json({ error: '字段不符合商品保存规则，未写入', code: 'field_not_normalized', fields: altered }, 400);
          const result = await commitProductTextExact(env, { sku, baseRowSha256, values });
          return result.ok ? json({ ok: true, sku, draft_revision: result.draft_revision, row_sha256: result.row_sha256 })
            : json({ error: result.status === 404 ? '商品不存在' : '这件商品在读取之后已被改动，未写入；请重新读取核对', code: result.code },
              result.status);
        }

        if (pathname === '/api/admin/orders' && req.method === 'GET') {
          const status = url.searchParams.get('status'), source = url.searchParams.get('source');
          // 动态拼 WHERE：status / source 任意组合（source=offline 让"线下销售"页只拿线下单，不混线上）
          const where = [], bind = [];
          if (status) { where.push('pay_status=?'); bind.push(status); }
          if (source) { where.push('source=?'); bind.push(source); }
          const orderBy = url.searchParams.get('sort') === 'fulfilment'
            ? "COALESCE(NULLIF(deliver_at,''),date(created_at,'+8 hours')) ASC, COALESCE(NULLIF(deliver_time,''),'24:00') ASC, id ASC"
            : 'created_at DESC';
          const sql = 'SELECT * FROM orders' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY ' + orderBy + ' LIMIT 500';
          const { results } = await env.DB.prepare(sql).bind(...bind).all();
          return json({ orders: results });
        }

        if (pathname === '/api/admin/attendance' && req.method === 'GET') {
          const day = url.searchParams.get('date') || sgtTodayStr();
          const { results } = await env.DB.prepare(`SELECT staff,business_date,kind,punched_at,source,note
            FROM attendance_records WHERE business_date=? ORDER BY staff, punched_at`).bind(day).all();
          const byStaff = {};
          for (const r of (results || [])) {
            if (!byStaff[r.staff]) byStaff[r.staff] = { staff: r.staff, in: null, out: null };
            byStaff[r.staff][r.kind] = r.punched_at;
          }
          return json({ date: day, records: results || [], staff: Object.values(byStaff) });
        }

        if (pathname === '/api/admin/delivery-jobs' && req.method === 'GET') {
          const { results } = await env.DB.prepare(`SELECT dj.*, o.invoice_no, o.customer_name, o.phone, o.address, o.total, o.pay_status
            FROM delivery_jobs dj LEFT JOIN orders o ON o.id=dj.order_id
            ORDER BY dj.updated_at DESC LIMIT 100`).all();
          return json({ jobs: results || [] });
        }
        if (pathname === '/api/admin/delivery-retry' && req.method === 'POST') {
          return json({ error: '系统叫车已停用；Lalamove 仅用于运费报价，请老板手动叫车。', code: 'quote_only' }, 410);
        }

        if (pathname === '/api/admin/mark-paid' && req.method === 'POST') {
          const { id } = await req.json();
          // 只允许把仍 UNPAID 且未退过储值的单标已付：防 CANCELLED/EXPIRED/已退储值的单被误标 PAID。
          const upd = await env.DB.prepare("UPDATE orders SET pay_status='PAID', paid_at=? WHERE id=? AND pay_status='UNPAID' AND balance_refunded_at IS NULL")
            .bind(new Date().toISOString(), id).run();
          if (upd.meta && upd.meta.changes > 0) {
            const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
            if (o) { await accruePoints(env, o); await enqueueKitchenTicket(env, o); if (ctx && ctx.waitUntil) ctx.waitUntil(notifyNewOrderTelegram(env, id)); else notifyNewOrderTelegram(env, id).catch(() => {}); }   // loyalty + 厨房小票 + 手动标付=付款成功 → Telegram 推送；配送由老板手动叫车
            return json({ ok: true });
          }
          // 没改动：要么不存在、要么已是终态（PAID/CANCELLED）或已退储值 → 明确拒绝并提示人工处理
          const cur = await env.DB.prepare('SELECT pay_status FROM orders WHERE id=?').bind(id).first();
          return json({ ok: false, error: cur ? `订单当前状态为 ${cur.pay_status}，不能标为已付（已取消/已退储值的单请重新下单）` : '订单不存在', pay_status: cur ? cur.pay_status : null }, cur ? 409 : 404);
        }

        // 退款 / 作废订单：补齐「PAID 余额单」的退款路径（原退款机器只覆盖 UNPAID 余额单 + Stripe，POS/线上全额储值单无法退）。
        // UNPAID→CANCELLED：复用 cancelUnpaidOrderAndRefundBalance（退余额+wallet_events）；PAID→REFUNDED：refundOrderBalance 退余额(幂等) + 原子 claim 状态防并发双退 + 释放 promo 名额。
        if (pathname === '/api/admin/order-refund' && req.method === 'POST') {
          const b = await req.json();
          const oid = b.order_id || b.id;
          if (!oid) return json({ error: '缺少 order_id' }, 400);
          const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
          if (!o) return json({ error: '订单不存在' }, 404);
          if (o.pay_status === 'CANCELLED' || o.pay_status === 'REFUNDED') return json({ error: `订单已是 ${o.pay_status}`, already: true }, 409);
          // 操作人已经单独记在 order_refunds.actor 里，reason 不必再带 'admin:' 前缀，
          // 否则订单详情里「操作人 admin / 原因 admin:xxx」看着像重复了一遍
          const reason = String(b.reason || '整单退款').slice(0, 200);
          if (o.pay_status === 'UNPAID') {
            const r = await cancelUnpaidOrderAndRefundBalance(env, oid, reason);
            if (!r.claimed) return json({ error: '订单状态已变化，请刷新重试' }, 409);
            if (r.promo_code) await releasePromoForOrder(env, oid, r.promo_code);
            return json({ ok: true, status: 'CANCELLED', refunded: r.refunded });
          }
          // PAID：走统一退款引擎 —— Stripe 那部分【真的调 /v1/refunds 原路退回】，储值部分退回余额，
          // 两边都成了才置 REFUNDED。修复前这里只退储值却照样置 REFUNDED，顾客卡上一分钱没退。
          const r = await refundWholeOrder(env, o, { reason, actor: 'admin' });
          if (!r.ok) {
            const code = r.code === 'in_progress' ? 409 : (r.code === 'manual_required' ? 502 : 400);
            return json({ error: r.error || '退款失败', code: r.code, order_status: o.pay_status }, code);
          }
          return json({ ok: true, status: r.status || 'REFUNDED', refunded: r.amount,
            stripe_amount: r.stripe_amount, balance_amount: r.balance_amount,
            stripe_refund_id: r.stripe_refund_id, refund_id: r.refund_id, deduped: !!r.deduped });
        }

        // 只退运费。老板最常用的场景：菜送到了但送晚/送错，商品照收钱，运费退回去。
        // 金额由服务端从 orders.delivery_fee 取，不接受请求体传金额。
        if (pathname === '/api/admin/refund-delivery-fee' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const oid = b.order_id || b.id;
          if (!oid) return json({ error: '缺少 order_id' }, 400);
          const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
          if (!o) return json({ error: '订单不存在' }, 404);
          const r = await refundDeliveryFee(env, o, { reason: String(b.reason || '老板后台退运费').slice(0, 200), actor: 'admin' });
          if (!r.ok) {
            const code = r.code === 'in_progress' ? 409 : (r.code === 'manual_required' ? 502 : 400);
            return json({ error: r.error, code: r.code }, code);
          }
          if (ctx && ctx.waitUntil) ctx.waitUntil(notifyRefundTelegram(env, o, r, '老板后台'));
          return json({ ok: true, refunded: r.amount, stripe_amount: r.stripe_amount,
            balance_amount: r.balance_amount, stripe_refund_id: r.stripe_refund_id, deduped: !!r.deduped });
        }

        // ---------- 历史储值合并：老板侧（唯一动钱的一步）----------
        // 为什么店员不能提交：staff token 由 6 位 PIN 派生、pos1/pos2/pos3 是共用账号，出事查不到具体人；
        // 而合并是把【已存在】的负债转给一个可能错的人，无对价，比店员自填金额更危险。
        if (pathname === '/api/admin/legacy-wallets' && req.method === 'GET') {
          return json(await legacyWalletsReport(env));
        }
        if (pathname === '/api/admin/legacy-claims' && req.method === 'GET') {
          return json(await legacyClaimsList(env, url.searchParams.get('status') || ''));
        }
        // 一键合并：手机号已经写在某个已登录账号上（那个人此刻正对着 0 余额）。
        // 老板权限足够高 —— 不设确认邮箱、不设期望余额这些仪式，ADMIN_TOKEN 本身就是授权。
        // 换来的代价用【审计】兜底：legacy_merges 记 committed_by/committed_at/balance_moved/
        // 动过哪些 order/topup/event 的 id 白名单，wallet_events 再记一笔 type='legacy_merge'，
        // 都是 append-only 且可撤销（/api/admin/legacy-merge-undo）。
        if (pathname === '/api/admin/legacy-merge-direct' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);   // 防双击搬两次，不是权限门
          const phone = normPhone(b.phone);
          if (!phone) return json({ error: '请提供手机号' }, 400);
          const legacy = await legacyWalletRow(env, phone);
          if (!legacy) return json({ error: '找不到这个手机号的历史储值' }, 404);
          if (legacy.merged_to_user_id) return json({ error: '这个号已经合并过了' }, 409);
          const acct = await env.DB.prepare(
            `SELECT a.id, (SELECT GROUP_CONCAT(email) FROM auth_identities WHERE user_id=a.id) email
               FROM user_accounts a WHERE a.phone=?`).bind(phone).first();
          if (!acct) return json({ error: '这个手机号还没有对应的登录账号，请让顾客先用 Google/Apple 登录一次', code: 'no_account' }, 409);
          const bal = +(+(legacy.balance || 0)).toFixed(2);
          const now = new Date().toISOString();
          const claimId = crypto.randomUUID();
          try {
            await env.DB.prepare(
              `INSERT INTO legacy_claims(id,pair_code,legacy_phone,balance_at_start,status,user_id,created_by,bound_at,expires_at,created_at)
               VALUES (?,?,?,?, 'awaiting_approval', ?, 'boss:direct', ?, ?, ?)`)
              .bind(claimId, 'DIRECT' + String(Date.parse(now)).slice(-6), phone, bal, acct.id, now,
                new Date(Date.parse(now) + 600000).toISOString(), now).run();
          } catch (e) {
            if (/UNIQUE|constraint/i.test(e.message || '')) return json({ error: '这个号已有进行中的认领，请到「待认领」列表处理', code: 'claim_exists' }, 409);
            throw e;
          }
          const r = await legacyMergeCommit(env, { claimId, expectedBalance: bal, actor: 'boss:direct', clientToken: b.client_token });
          return json({ ...r, merged_to_email: acct.email || null }, r._status || 200);
        }

        // 老板直接把一个 legacy 手机号绑到某个登录账号上。
        // 场景：老顾客到店说"我以前充过钱"，当面用手机登录一次 Google/Apple，老板在后台
        // 把这个账号和他的手机号绑起来 —— 顾客侧没有任何自助入口，**身份由老板当面认**。
        // 这是唯一能证明"他是他自己"的办法：手机号没做过验证，任何人都能填别人的号。
        if (pathname === '/api/admin/legacy-bind' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);
          const phone = normPhone(b.phone);
          const userId = String(b.user_id || '').trim();
          if (!phone) return json({ error: '请提供 legacy 手机号' }, 400);
          if (!userId) return json({ error: '请提供要绑定的账号 user_id（让顾客当面登录一次）' }, 400);
          const acct = await env.DB.prepare(
            `SELECT a.id, a.phone, (SELECT GROUP_CONCAT(email) FROM auth_identities WHERE user_id=a.id) email
               FROM user_accounts a WHERE a.id=?`).bind(userId).first();
          if (!acct) return json({ error: '找不到这个账号' }, 404);
          const legacy = await legacyWalletRow(env, phone);
          if (!legacy) return json({ error: '找不到这个手机号的历史储值' }, 404);
          if (legacy.merged_to_user_id) return json({ error: '这个号已经并过了' }, 409);

          const ts = new Date().toISOString();
          // 把手机号写到账号上（顾客以后自己也认得出）。被别人占了就跳过，不影响合并。
          try {
            await env.DB.prepare('UPDATE user_accounts SET phone=?, updated_at=? WHERE id=?').bind(phone, ts, userId).run();
          } catch (e) { /* idx_user_accounts_phone 冲突 → 忽略，合并照做 */ }

          const claimId = crypto.randomUUID();
          try {
            await env.DB.prepare(
              `INSERT INTO legacy_claims(id,pair_code,legacy_phone,balance_at_start,status,user_id,created_by,bound_at,expires_at,created_at)
               VALUES (?,?,?,?, 'awaiting_approval', ?, 'boss:bind', ?, ?, ?)`)
              .bind(claimId, 'BIND' + String(Date.parse(ts)).slice(-6), phone, +legacy.balance, userId, ts,
                new Date(Date.parse(ts) + 600000).toISOString(), ts).run();
          } catch (e) {
            if (/UNIQUE|constraint/i.test(e.message || '')) return json({ error: '这个号已有进行中的认领，请到「待认领」列表处理', code: 'claim_exists' }, 409);
            throw e;
          }
          const r = await legacyMergeCommit(env, {
            claimId, expectedBalance: +legacy.balance, actor: 'boss:bind', clientToken: b.client_token,
          });
          return json({ ...r, bound_email: acct.email || null }, r._status || 200);
        }

        // 找账号：老板要绑定时，按邮箱/姓名/手机号把顾客刚登录出来的账号找出来
        if (pathname === '/api/admin/find-account' && req.method === 'GET') {
          const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
          if (!q) return json({ accounts: [] });
          const like = `%${q}%`;
          const digits = q.replace(/\D/g, '');
          const { results } = await env.DB.prepare(
            `SELECT a.id user_id, a.phone, a.name, substr(a.created_at,1,10) created_at,
                    (SELECT GROUP_CONCAT(provider) FROM auth_identities WHERE user_id=a.id) providers,
                    (SELECT GROUP_CONCAT(email) FROM auth_identities WHERE user_id=a.id) email,
                    (SELECT ROUND(COALESCE(balance,0),2) FROM members WHERE user_id=a.id) balance
               FROM user_accounts a
              WHERE COALESCE(a.name,'') LIKE ?
                 OR (? <> '' AND COALESCE(a.phone,'') LIKE ?)
                 OR EXISTS(SELECT 1 FROM auth_identities i WHERE i.user_id=a.id AND COALESCE(i.email,'') LIKE ?)
              ORDER BY a.created_at DESC LIMIT 20`).bind(like, digits, `%${digits}%`, like).all();
          return json({ accounts: results || [] });
        }

        if (pathname === '/api/admin/legacy-merge' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);
          const r = await legacyMergeCommit(env, {
            claimId: b.claim_id, expectedBalance: b.expected_balance,
            actor: actorOf(env), clientToken: b.client_token,
          });
          return json(r, r._status || 200);
        }
        if (pathname === '/api/admin/legacy-merge-undo' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const r = await legacyMergeUndo(env, { mergeId: b.merge_id, reason: b.reason, actor: actorOf(env) });
          return json(r, r._status || 200);
        }

        // 退款记录（订单详情/对账用）
        if (pathname === '/api/admin/order-refunds' && req.method === 'GET') {
          const oid = url.searchParams.get('order_id') || '';
          const { results } = oid
            ? await env.DB.prepare('SELECT * FROM order_refunds WHERE order_id=? ORDER BY created_at DESC').bind(oid).all()
            : await env.DB.prepare('SELECT * FROM order_refunds ORDER BY created_at DESC LIMIT 200').all();
          return json({ refunds: results || [] });
        }

        // record a walk-in / offline sale (already paid) — itemized OR lump-sum amount
        // production plan: explode today's orders (combos→component buns) into per-bun counts
        if (pathname === '/api/admin/production' && req.method === 'GET') {
          const day = url.searchParams.get('date') || sgtTodayStr();   // 备货单按 SGT 营业日
          const { results } = await env.DB.prepare(
            // 备货按【履约日】算：预约单用 deliver_at，当天即时单(deliver_at NULL)回退下单 SGT 日。
            // 原来只看 created_at → 预约明天的单算进今天、昨天约今天的单漏掉，厨房备错天。
            "SELECT items_json FROM orders WHERE COALESCE(NULLIF(deliver_at,''), substr(datetime(created_at,'+8 hours'),1,10))=? AND pay_status IN ('PAID','UNPAID')").bind(day).all();
          // 名称和「是不是饮品」取订单行下单时记下的值（与厨房看板同源）；按 SKU + 下单时名称分行，
          // 不同发布下同一 SKU 改了名就分开列，不会被并成某一批的名称。只有旧订单（没记名称/分类）才回查 products 表。
          const rows = new Map(); let gifts = 0; let drinks = 0;
          for (const o of results || []) {
            let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) {}
            for (const it of items) {
              const n = Number(it && it.qty) || 0;
              const self = { sku: it.sku, name: it.name, qty: 1, ...(typeof it.category === 'string' ? { category: it.category } : {}) };
              const fromOrder = kitchenLinesFromItem({ ...it, qty: 1 });
              const parts = fromOrder ? (fromOrder.length ? fromOrder : [self]) : [{ sku: it.sku, qty: 1 }];
              for (const part of parts) {
                if (part.sku === 'GIFT') { gifts += part.qty * n; continue; }
                if (part.sku === 'DRINK') { drinks += part.qty * n; continue; }
                if (part.sku === 'OFFLINE') continue;
                const frozenName = fromOrder && part.name ? String(part.name) : null;
                const key = part.sku + '\u0000' + (frozenName ?? '');
                const row = rows.get(key) || { sku: part.sku, name: frozenName, category: undefined, qty: 0 };
                row.qty += part.qty * n;
                if (row.category === undefined && fromOrder && typeof part.category === 'string') row.category = part.category;
                rows.set(key, row);
              }
            }
          }
          const unknown = [...new Set([...rows.values()].filter(r => r.name == null || r.category === undefined).map(r => r.sku))];
          const current = {};
          if (unknown.length) {
            const ph = unknown.map(() => '?').join(',');
            const { results: pr } = await env.DB.prepare(`SELECT sku,name_cn,category FROM products WHERE sku IN (${ph})`).bind(...unknown).all();
            for (const r of pr || []) current[r.sku] = r;
          }
          // 旧单（回查得名）和新单（冻结名）名称相同就合并成一行，厨房不会看到两行同名同 SKU
          const merged = new Map();
          for (const r of rows.values()) {
            const name = r.name ?? current[r.sku]?.name_cn ?? r.sku;
            const isDrink = (r.category ?? current[r.sku]?.category) === 'drink';
            const key = `${r.sku}\u0000${name}\u0000${isDrink ? 1 : 0}`;
            const row = merged.get(key) || { sku: r.sku, name, qty: 0, ...(isDrink ? { drink: true } : {}) };
            row.qty += r.qty;
            merged.set(key, row);
          }
          const buns = [...merged.values()];
          // 单点饮品不是要备的单品：留在明细里，但计入 drinks，不计入「今日需备单品」
          for (const b of buns) if (b.drink) drinks += b.qty;
          buns.sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));
          return json({ date: day, buns, gifts, drinks, total: buns.reduce((sum, b) => sum + (b.drink ? 0 : b.qty), 0) });
        }

        if (pathname === '/api/admin/offline-sale' && req.method === 'POST') {
          const b = await req.json();
          if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);
          const r = await createOfflineSale(env, b, b.cashier || 'boss');
          return json(r, r._status || 200);
        }

        if (pathname === '/api/admin/audit' && req.method === 'GET') {
          // range=day|week|month (default day). Uses paid_at date window.
          const range = url.searchParams.get('range') || 'day';
          const anchor = url.searchParams.get('date') || sgtTodayStr();   // 营收按 SGT 营业日窗口
          let since = anchor, label = anchor;
          if (range === 'week') { const d = new Date(anchor + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 6); since = d.toISOString().slice(0, 10); label = `${since} ~ ${anchor}`; }
          else if (range === 'month') { since = anchor.slice(0, 7) + '-01'; label = anchor.slice(0, 7); }
          // 日期分组用 SGT(paid_at/created_at 存 UTC，+8h 后取日)，与单号营业日口径一致
          const bySrc = (src) => env.DB.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev, COALESCE(SUM(gst),0) gst, COALESCE(SUM(service_charge),0) svc FROM orders WHERE pay_status='PAID' AND source=? AND substr(datetime(COALESCE(paid_at,created_at),'+8 hours'),1,10) BETWEEN ? AND ?").bind(src, since, anchor).first();
          const on = await bySrc('online'), off = await bySrc('offline');
          const unpaid = await env.DB.prepare("SELECT COUNT(*) c FROM orders WHERE pay_status='UNPAID' AND substr(datetime(created_at,'+8 hours'),1,10) BETWEEN ? AND ?").bind(since, anchor).first();
          const revenue = +((on.rev || 0) + (off.rev || 0)).toFixed(2);
          const gst = +((on.gst || 0) + (off.gst || 0)).toFixed(2);
          const service_charge = +((on.svc || 0) + (off.svc || 0)).toFixed(2);
          return json({
            range, label, since, until: anchor,
            paid_orders: on.c + off.c, revenue, gst, service_charge, net_before_gst: +(revenue - gst).toFixed(2),
            online: { orders: on.c, revenue: +(on.rev || 0).toFixed(2) },
            offline: { orders: off.c, revenue: +(off.rev || 0).toFixed(2) },
            unpaid: unpaid.c,
          });
        }

        if (pathname === '/api/admin/members' && req.method === 'GET') {
          const query = String(url.searchParams.get('q') || '').trim().slice(0, 100);
          const binds = [];
          const filters = [];
          if (query) {
            const textNeedle = `%${query}%`;
            const digits = query.replace(/\D/g, '');
            if (digits) {
              filters.push("COALESCE(phone,'') LIKE ?");
              binds.push(`%${digits}%`);
              // Singapore numbers are stored without +65. Searching either
              // "+65 8000 0002" or "80000002" must find the same account.
              if (digits.startsWith('65') && digits.length > 2) {
                filters.push("COALESCE(phone,'') LIKE ?");
                binds.push(`%${digits.slice(2)}%`);
              }
            }
            for (const column of ['name', 'email', 'providers', 'user_id', 'admin_note']) {
              filters.push(`COALESCE(${column},'') LIKE ?`);
              binds.push(textNeedle);
            }
          }
          // 已归档的会员默认不出现在列表里（老板眼里就是"删掉了"），加 ?include_archived=1 才显示。
          // 行本身永远留着 —— 历史订单还挂在上面，删了账就对不上。
          const includeArchived = url.searchParams.get('include_archived') === '1';
          const archClause = includeArchived ? '' : ' AND m.archived_at IS NULL';
          const sql = `SELECT * FROM (
            SELECT a.id user_id,a.phone,a.name,a.birthday,COALESCE(m.points,0) points,COALESCE(m.total_spent,0) total_spent,
              COALESCE(m.orders_count,0) orders_count,COALESCE(m.balance,0) balance,m.archived_at,
              m.admin_note,GROUP_CONCAT(i.email) email,GROUP_CONCAT(i.provider) providers
            FROM user_accounts a LEFT JOIN members m ON m.user_id=a.id LEFT JOIN auth_identities i ON i.user_id=a.id
            WHERE 1=1${includeArchived ? '' : ' AND (m.archived_at IS NULL OR m.phone IS NULL)'} GROUP BY a.id
            UNION ALL
            SELECT NULL user_id,m.phone,m.name,m.birthday,m.points,m.total_spent,m.orders_count,m.balance,m.archived_at,
              m.admin_note,m.email,'legacy_phone' providers
            FROM members m WHERE m.user_id IS NULL${archClause}
          )${filters.length ? ` WHERE ${filters.join(' OR ')}` : ''} ORDER BY points DESC LIMIT 500`;
          const statement = env.DB.prepare(sql);
          const { results } = filters.length ? await statement.bind(...binds).all() : await statement.all();
          return json({ members: results, include_archived: includeArchived });
        }
        // 审计日志：老板权限拉满的对价 —— 每一笔动过钱/动过账的操作都在这里查得到。
        // 汇总四条 append-only 的流水：余额调整、退款、历史储值合并、履约状态推进。
        if (pathname === '/api/admin/audit-log' && req.method === 'GET') {
          const days = Math.min(365, Math.max(1, +(url.searchParams.get('days') || 30)));
          const since = new Date(Date.now() - days * 86400000).toISOString();
          const { results: money } = await env.DB.prepare(
            `SELECT we.created_at, we.type kind, we.amount, we.note, we.phone, we.user_id, we.order_id,
                    o.invoice_no
               FROM wallet_events we LEFT JOIN orders o ON o.id=we.order_id
              WHERE we.created_at >= ? ORDER BY we.created_at DESC LIMIT 300`).bind(since).all();
          const { results: refunds } = await env.DB.prepare(
            `SELECT r.created_at, r.kind, r.amount, r.stripe_amount, r.balance_amount, r.cash_amount,
                    r.status, r.reason, r.actor, r.error, o.invoice_no
               FROM order_refunds r LEFT JOIN orders o ON o.id=r.order_id
              WHERE r.created_at >= ? ORDER BY r.created_at DESC LIMIT 300`).bind(since).all();
          const { results: merges } = await env.DB.prepare(
            `SELECT committed_at created_at, legacy_phone, user_id, balance_moved, status,
                    committed_by, reversed_by, reversed_at, reverse_reason
               FROM legacy_merges WHERE committed_at >= ? ORDER BY committed_at DESC LIMIT 100`).bind(since).all();
          const { results: fulfil } = await env.DB.prepare(
            `SELECT e.created_at, e.type, e.actor, e.message, o.invoice_no
               FROM order_events e LEFT JOIN orders o ON o.id=e.order_id
              WHERE e.created_at >= ? ORDER BY e.created_at DESC LIMIT 200`).bind(since).all();
          return json({ since, days,
            wallet_events: money || [], refunds: refunds || [], legacy_merges: merges || [], order_events: fulfil || [] });
        }

        // 老板手动加/减会员余额。真金操作：强制幂等令牌 + 余额不许扣成负数 + 每笔写 wallet_events。
        if (pathname === '/api/admin/member-balance-adjust' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const r = await adjustMemberBalance(env, b, 'boss');
          return json(r, r._status || 200);
        }

        // 单个会员的完整消费记录：充值 / 消费 / 退款 / 手动调整 + 订单流水。
        // 老板端此前只有会员列表，看不到"这个人在我这儿花了什么"，顾客拿着手机来对账时无从查起。
        if (pathname === '/api/admin/member-ledger' && req.method === 'GET') {
          const userId = String(url.searchParams.get('user_id') || '').trim() || null;
          const phone = userId ? null : normPhone(url.searchParams.get('phone') || '');
          if (!userId && !phone) return json({ error: '请提供 user_id 或 phone' }, 400);
          const where = userId ? 'user_id=?' : 'phone=? AND user_id IS NULL';
          const key = userId || phone;
          const m = await env.DB.prepare(
            `SELECT phone,user_id,name,COALESCE(balance,0) balance,COALESCE(points,0) points,
                    COALESCE(total_spent,0) total_spent,COALESCE(orders_count,0) orders_count,
                    archived_at,created_at FROM members WHERE ${where}`).bind(key).first();
          if (!m) return json({ error: '找不到这位会员' }, 404);

          // 账本口径与顾客端 /api/auth/me 完全一致 —— 两边看到的必须是同一本账，
          // 否则顾客拿着手机来对，老板屏幕上是另一个数字，谁也说不清。
          const idCol = userId ? 'user_id' : 'phone';
          // ⚠️ orders.phone 是【顾客直填原样入库】的脏数据：生产里 +65 / 空格 / 横杠都有。
          // 按 phone 精确等值匹配会漏单 —— 会员列表写着「订单数 1、累计消费 164.70」，
          // 点进消费记录却是「还没下过单」，同一屏两个数字自相矛盾。所以订单一律按【后 8 位】比。
          const last8 = `substr(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),-8)=substr(?,-8)`;
          const ordWhere = userId ? 'user_id=?' : last8;
          const { results: rows } = await env.DB.prepare(`SELECT * FROM (
              SELECT 'topup' kind,t.id event_id,NULL order_id,NULL invoice_no,t.credited delta,
                t.amount principal,t.bonus bonus,t.pay_method method,t.pay_status status,t.created_at,t.note
              FROM topups t WHERE t.${idCol}=? AND t.pay_status='PAID'
              UNION ALL
              SELECT 'spend' kind,'spend:'||o.id event_id,o.id order_id,o.invoice_no,-o.paid_by_balance delta,
                NULL principal,NULL bonus,o.pay_provider method,o.pay_status status,o.created_at,o.note
              FROM orders o WHERE ${userId ? 'o.user_id=?' : `substr(REPLACE(REPLACE(REPLACE(o.phone,'+',''),' ',''),'-',''),-8)=substr(?,-8)`} AND o.paid_by_balance>0
              UNION ALL
              SELECT we.type kind,we.id event_id,we.order_id,o.invoice_no,we.amount delta,
                NULL principal,NULL bonus,'wallet' method,COALESCE(o.pay_status,'COMPLETED') status,we.created_at,we.note
              FROM wallet_events we LEFT JOIN orders o ON o.id=we.order_id
              -- 同上：单个会员的流水必须含转移，否则结存列会整列消失
              WHERE we.${idCol}=?
            ) ORDER BY created_at DESC, CASE WHEN delta<0 THEN 0 ELSE 1 END, event_id DESC LIMIT 500`).bind(key, key, key).all();
          const truncated = (rows || []).length >= 500;
          const wallet = walletLedgerWithBalances(rows, m.balance, { truncated });

          // 消费记录不止储值单：现金/PayNow/Stripe 付的单也要看得到
          const { results: orders } = await env.DB.prepare(
            `SELECT id,invoice_no,created_at,total,delivery_fee,COALESCE(refunded_total,0) refunded_total,
                    paid_by_balance,fulfilment,pay_provider,pay_status,COALESCE(NULLIF(fulfil_status,''),'new') fulfil_status
               FROM orders WHERE ${ordWhere} ORDER BY created_at DESC LIMIT 100`).bind(key).all();
          return json({
            member: m, orders: orders || [],
            wallet: { entries: wallet.entries, truncated, balance_after_reliable: wallet.reliable,
              computed_balance: wallet.computed_balance },
          });
        }

        // 「删除会员」= 归档，不是 DELETE。理由见 migrations/0034_member_archive.sql。
        if (pathname === '/api/admin/member-archive' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const userId = String(b.user_id || '').trim() || null;
          const phone = userId ? null : normPhone(b.phone);
          if (!userId && !phone) return json({ error: '请提供 user_id 或 phone' }, 400);
          const where = userId ? 'user_id=?' : 'phone=? AND user_id IS NULL';
          const key = userId || phone;
          const m = await env.DB.prepare(`SELECT phone,COALESCE(balance,0) balance,archived_at FROM members WHERE ${where}`).bind(key).first();
          if (!m) return json({ error: '找不到这位会员' }, 404);
          const ts = new Date().toISOString();

          if (b.restore) {
            await env.DB.prepare(`UPDATE members SET archived_at=NULL, archive_reason=NULL, archived_by=NULL, updated_at=? WHERE ${where}`).bind(ts, key).run();
            return json({ ok: true, archived: false });
          }
          // 有余额的会员不许直接归档：那是店里欠顾客的钱，归档只会让这笔负债从视野里消失、
          // 而储值台账照样把它算进负债合计 —— 老板会看到一个"查不到人的欠款"。
          // 要归档就先把余额处理掉（退给顾客或手动扣减），钱的去向必须留下痕迹。
          // 老板说了算：有余额也能归档。但那是店里欠顾客的钱，不能就这么从视野里消失 ——
          // 把归档时的余额原样写进归档原因，储值台账也照样把它算进负债合计，随时查得回来。
          const bal = +(+m.balance || 0).toFixed(2);
          const reasonWithBal = (String(b.reason || '').slice(0, 200) || '老板归档')
            + (bal > 0.005 ? `（归档时余额 S$${bal.toFixed(2)}，仍计入储值负债）` : '');
          const r = await env.DB.prepare(
            `UPDATE members SET archived_at=?, archive_reason=?, archived_by='boss', updated_at=? WHERE ${where} AND archived_at IS NULL`)
            .bind(ts, reasonWithBal, ts, key).run();
          if (!(r.meta && r.meta.changes === 1)) return json({ ok: true, archived: true, deduped: true });
          return json({ ok: true, archived: true, archived_at: ts, balance_at_archive: bal,
            warn: bal > 0.005 ? `这位会员归档时还有 S$${bal.toFixed(2)} 储值，仍计入负债，随时可恢复` : null });
        }

        if (pathname === '/api/admin/member-save' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const phone = normPhone(b.phone);
          if (phone && !/^\d{8,15}$/.test(phone)) return json({ error: 'phone must be 8–15 digits' }, 400);
          const birthday = cleanDateOnly(b.birthday);
          if (birthday === false) return json({ error: '生日格式应为 YYYY-MM-DD' }, 400);
          const name = String(b.name == null ? '' : b.name).trim().slice(0, 80) || null;
          const hasAdminNote = Object.prototype.hasOwnProperty.call(b, 'admin_note');
          const adminNote = cleanAdminNote(b.admin_note);
          const ts = new Date().toISOString();
          let upd;
          try {
            if (b.user_id) {
              const res = await env.DB.batch([
                env.DB.prepare('UPDATE user_accounts SET phone=?,name=?,birthday=?,updated_at=? WHERE id=?').bind(phone || null, name, birthday, ts, b.user_id),
                env.DB.prepare('UPDATE members SET name=?,birthday=?,admin_note=CASE WHEN ?=1 THEN ? ELSE admin_note END,updated_at=? WHERE user_id=?')
                  .bind(name, birthday, hasAdminNote ? 1 : 0, adminNote, ts, b.user_id),
              ]);
              upd = res[0];
            } else {
              if (!phone) return json({ error: 'phone required for legacy member' }, 400);
              upd = await env.DB.prepare('UPDATE members SET name=?, birthday=?, admin_note=CASE WHEN ?=1 THEN ? ELSE admin_note END, updated_at=? WHERE phone=? AND user_id IS NULL')
                .bind(name, birthday, hasAdminNote ? 1 : 0, adminNote, ts, phone).run();
            }
          } catch (e) {
            if (/UNIQUE|constraint/i.test(e.message || '')) return json({ error: 'phone already in use', code: 'phone_already_exists' }, 409);
            throw e;
          }
          if (!upd.meta || upd.meta.changes < 1) return json({ error: 'member not found' }, 404);
          return json({ ok: true, member: { user_id: b.user_id || null, phone: phone || null, name, birthday,
            ...(hasAdminNote ? { admin_note: adminNote } : {}) } });
        }

        // admin records a member top-up
        if (pathname === '/api/admin/topup' && req.method === 'POST') {
          const b = await req.json();
          const pm = b.pay_method === 'paynow' ? 'paynow' : 'cash';   // 白名单：现场充值只 cash/paynow（stripe 仅 webhook 内部）
          if (+b.amount > 2000) return json({ error: '单次充值上限 S$2000，超额请分次' }, 400);
          // 强制幂等令牌：充值是真金负债，缺令牌则后端去重索引失效 → 双击/重试/直连会重复入账。
          // 前端 doTopup 已每次随机生成 client_token；此处拒绝无令牌请求，确保 idx_topups_client_token 必然生效。
          if (!b.client_token) return json({ error: '缺少幂等令牌 client_token' }, 400);
          const requestedUserId = typeof b.user_id === 'string' ? b.user_id.trim().slice(0, 100) : '';
          const name = String(b.name == null ? '' : b.name).trim().replace(/\s+/g, ' ').slice(0, 80) || null;
          const email = cleanMemberEmail(b.email);
          if (email === false) return json({ error: 'Email 格式不对', code: 'bad_email' }, 400);

          let phone = typeof b.phone === 'string' ? b.phone : '';
          let account = null;
          let legacy = null;
          if (requestedUserId) {
            // 从姓名 / Email 搜到的线上会员可能没有手机号；选中结果后以稳定 user_id 入账，不能再强迫补手机号。
            account = await env.DB.prepare(`SELECT a.id user_id,a.phone,a.name,m.archived_at
              FROM user_accounts a LEFT JOIN members m ON m.user_id=a.id WHERE a.id=?`).bind(requestedUserId).first();
            if (!account) return json({ error: '找不到选中的会员，请重新搜索', code: 'member_not_found' }, 404);
            phone = account.phone || '';
          } else {
            // 新建或按手机号直接充值仍沿用柜台手机号护栏，防 phone="1" 之类的脏会员档案。
            const validPhone = sgCounterPhone(phone);
            if (!validPhone) {
              return json({ error: '手机号格式不对：新加坡手机号是 8 位（8 或 9 开头），可带 +65', code: 'bad_phone' }, 400);
            }
            phone = validPhone.local;
            account = await accountByPhone(env, phone);
            if (!account) {
              legacy = await env.DB.prepare(`SELECT phone,name,email,archived_at FROM members
                WHERE phone=? AND user_id IS NULL`).bind(phone).first();
              if (legacy && legacy.archived_at) {
                return json({ error: '这位会员已归档，请先到会员页恢复后再充值', code: 'member_archived' }, 409);
              }
              if (!legacy && !name) return json({ error: '新建会员请填写姓名', code: 'name_required' }, 400);
            }
          }
          if (account && account.archived_at) {
            return json({ error: '这位会员已归档，请先到会员页恢复后再充值', code: 'member_archived' }, 409);
          }
          const userId = account && account.user_id || null;
          const createdMember = !userId && !legacy;
          const r = await creditTopup(env, phone, b.amount, pm, b.cashier || 'boss', b.note, b.client_token,
            userId, userId ? null : { name, email });
          return json({ ...r, created_member: !!(r.ok && createdMember), member: r.ok ? {
            user_id: userId, phone: r.phone || phone || null,
            name: (account && account.name) || (legacy && legacy.name) || name || null,
            email: (legacy && legacy.email) || email || null,
          } : undefined }, r._status || 200);
        }
        // recent top-ups (audit)
        if (pathname === '/api/admin/topups' && req.method === 'GET') {
          const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
          const requestedMethod = String(url.searchParams.get('method') || '').trim();
          const method = ['stripe', 'paynow', 'cash'].includes(requestedMethod) ? requestedMethod : '';
          const sinceRaw = url.searchParams.get('since');
          const untilRaw = url.searchParams.get('until');
          const since = cleanDateOnly(sinceRaw);
          const until = cleanDateOnly(untilRaw);
          if (since === false || until === false) return json({ error: '日期格式应为 YYYY-MM-DD' }, 400);
          if (since && until && since > until) return json({ error: '开始日期不能晚于结束日期' }, 400);
          const limit = Math.min(200, Math.max(1, Math.floor(+(url.searchParams.get('limit') || 200)) || 200));
          const offset = Math.min(100000, Math.max(0, Math.floor(+(url.searchParams.get('offset') || 0)) || 0));
          const clauses = [], values = [];
          if (q) {
            const textLike = `%${q}%`;
            const digits = /^[+\d\s().-]+$/.test(q) ? q.replace(/\D/g, '') : '';
            const localDigits = digits.startsWith('65') && digits.length > 2 ? digits.slice(2) : digits;
            const matches = [
              "COALESCE(t.phone,'') LIKE ?", "COALESCE(t.id,'') LIKE ?", "COALESCE(t.note,'') LIKE ?",
              "COALESCE(t.cashier,'') LIKE ?", "COALESCE(t.user_id,'') LIKE ?", "COALESCE(a.name,'') LIKE ?",
              "COALESCE(lm.name,'') LIKE ?", "COALESCE(a.phone,'') LIKE ?",
              "EXISTS (SELECT 1 FROM auth_identities aiq WHERE aiq.user_id=t.user_id AND COALESCE(aiq.email,'') LIKE ?)",
            ];
            values.push(textLike, textLike, textLike, textLike, textLike, textLike, textLike, textLike, textLike);
            if (digits) { matches.push("COALESCE(t.phone,'') LIKE ?"); values.push(`%${localDigits}%`); }
            clauses.push(`(${matches.join(' OR ')})`);
          }
          if (method) { clauses.push('t.pay_method=?'); values.push(method); }
          if (since) { clauses.push("substr(datetime(t.created_at,'+8 hours'),1,10)>=?"); values.push(since); }
          if (until) { clauses.push("substr(datetime(t.created_at,'+8 hours'),1,10)<=?"); values.push(until); }
          const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
          const from = ` FROM topups t LEFT JOIN user_accounts a ON a.id=t.user_id
            LEFT JOIN members lm ON t.user_id IS NULL AND lm.user_id IS NULL AND lm.phone=t.phone`;
          const summaryStmt = env.DB.prepare(`SELECT COUNT(*) count,COALESCE(SUM(t.amount),0) principal,
              COALESCE(SUM(t.bonus),0) bonus,COALESCE(SUM(t.credited),0) credited${from}${where}`);
          const summary = values.length ? await summaryStmt.bind(...values).first() : await summaryStmt.first();
          const page = await env.DB.prepare(`SELECT t.*,
              a.name AS account_name,a.phone AS account_phone,COALESCE(am.balance,lm.balance) AS current_balance,
              (SELECT ai.email FROM auth_identities ai WHERE ai.user_id=t.user_id ORDER BY ai.provider LIMIT 1) AS account_email
            ${from}
            LEFT JOIN members am ON am.user_id=t.user_id
            ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).bind(...values, limit + 1, offset).all();
          const topups = page.results || [];
          const hasMore = topups.length > limit;
          if (hasMore) topups.pop();
          return json({ topups, summary: summary || { count: 0, principal: 0, bonus: 0, credited: 0 },
            has_more: hasMore, filters: { q, method, since, until, limit, offset } });
        }
        // 充多少送多少 tiers: read / save (D1 app_settings, overrides env, no redeploy)
        if (pathname === '/api/admin/topup-config' && req.method === 'GET') {
          const tiers = (await topupTiers(env)).slice().sort((a, b) => a[0] - b[0]);
          let stored = null; try { stored = await env.DB.prepare("SELECT v FROM app_settings WHERE k='TOPUP_TIERS'").first(); } catch (e) {}
          return json({ tiers: tiers.map(([amount, bonus]) => ({ amount, bonus })), source: (stored && stored.v) ? 'custom' : 'default' });
        }
        if (pathname === '/api/admin/topup-config' && req.method === 'POST') {
          const body = await req.json().catch(() => ({}));
          // validate hard (money rule = deterministic TS, never LLM): accept [{amount,bonus}] or [[amount,bonus]]
          const clean = [];
          for (const t of (Array.isArray(body.tiers) ? body.tiers : [])) {
            const amount = Number(Array.isArray(t) ? t[0] : t && t.amount);
            const bonus = Number(Array.isArray(t) ? t[1] : t && t.bonus);
            if (!Number.isFinite(amount) || !Number.isFinite(bonus) || amount <= 0 || bonus < 0) continue;
            clean.push([Math.round(amount * 100) / 100, Math.round(bonus * 100) / 100]);
          }
          if (!clean.length) return json({ error: '请至少配置一个有效档位（充值额 > 0）' }, 400);
          const byAmt = new Map(); for (const [a, b] of clean) byAmt.set(a, b);   // dedupe by amount, last wins
          const tiers = [...byAmt.entries()].sort((x, y) => y[0] - x[0]);          // store high→low
          await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at')
            .bind('TOPUP_TIERS', JSON.stringify(tiers), new Date().toISOString()).run();
          return json({ ok: true, tiers: tiers.slice().sort((x, y) => x[0] - y[0]).map(([amount, bonus]) => ({ amount, bonus })) });
        }
        // ---------- 品牌设置 brand: logo / slogan / 配色 (D1-backed, applied live on the storefront) ----------
        if (pathname === '/api/admin/brand-config' && req.method === 'GET') {
          const keys = ['brand_logo', 'brand_name_cn', 'brand_name_en', 'brand_slogan_cn', 'brand_slogan_en', 'brand_color_primary', 'brand_color_secondary', 'brand_color_bg', 'brand_color_accent'];
          const [rows, state] = await env.DB.batch([
            env.DB.prepare(`SELECT k,v FROM app_settings WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys),
            env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1'),
          ]);
          const s = Object.fromEntries((rows.results || []).map(row => [row.k, row.v]));
          return json({
            draft_revision: state.results?.[0]?.draft_revision || null,
            brand: {
              logo: s.brand_logo || '', name_cn: s.brand_name_cn || '', name_en: s.brand_name_en || '',
              slogan_cn: s.brand_slogan_cn || '', slogan_en: s.brand_slogan_en || '',
              color_primary: s.brand_color_primary || '', color_secondary: s.brand_color_secondary || '',
              color_bg: s.brand_color_bg || '', color_accent: s.brand_color_accent || '',
            },
            defaults: { name_cn: DEFAULT_BRAND_CN, name_en: env.BRAND || DEFAULT_BRAND_EN, slogan_cn: '', slogan_en: '', color_primary: '#1C4A3A', color_secondary: '#B98A2F', color_bg: '#F6EFE0', color_accent: '#A23B2D', logo: '/img/logo.svg' },
          });
        }
        if (pathname === '/api/admin/brand-config' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const map = { logo: 'brand_logo', name_cn: 'brand_name_cn', name_en: 'brand_name_en', slogan_cn: 'brand_slogan_cn', slogan_en: 'brand_slogan_en', color_primary: 'brand_color_primary', color_secondary: 'brand_color_secondary', color_bg: 'brand_color_bg', color_accent: 'brand_color_accent' };
          const isColor = (v) => v === '' || /^#[0-9a-fA-F]{3,8}$/.test(v);   // #hex or empty to clear
          const entries = [];
          for (const [field, key] of Object.entries(map)) {
            if (!(field in b)) continue;
            const v = (b[field] == null ? '' : String(b[field])).trim();
            if (field.startsWith('color_') && !isColor(v)) return json({ error: `颜色格式应为 #RRGGBB：${field}` }, 400);
            if (field === 'logo' && v) {   // logo 格式校验，与 product-image 同口径(只收 data:image/ 或 /相对路径，挡 javascript:/data:text/html/属性逃逸串)
              if (v.length > 900000) return json({ error: 'logo 文件过大，请换更小的图（约 <600KB）' }, 400);
              if (/^data:/i.test(v)) {
                try { await materializePublicMedia(v); }
                catch { return json({ error: 'logo 不是有效的 JPG、PNG 或 WebP 图片' }, 400); }
              } else if (!/^\/(?!\/)[a-zA-Z0-9._\/-]*$/.test(v)) return json({ error: 'logo 格式错误：应为上传图片或 /相对路径' }, 400);
            }
            entries.push([key, settingVal(v)]);
          }
          if (!entries.length) return json({ error: '没有可保存的品牌字段' }, 400);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            action: 'brand_config_saved', detail: { keys: entries.map(([key]) => key) },
            buildStatements: ({ revision, now }) => entries.map(([key, value]) => env.DB.prepare(`INSERT INTO app_settings (k,v,updated_at)
              SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)
              ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`)
              .bind(key, value, now, revision)),
          });
          return result.ok ? json({ ok: true, draft_revision: result.draft_revision })
            : draftConflict(result);
        }

        // ---------- 储值台账 wallet ledger: 本金/通道费(API)/赠送/已消费/余额 (deterministic, no LLM) ----------
        if (pathname === '/api/admin/wallet-audit' && req.method === 'GET') {
          const range = url.searchParams.get('range') || 'all';
          const anchor = url.searchParams.get('date') || sgtTodayStr();   // 储值台账按 SGT 营业日窗口
          let since = '0000-01-01', until = '9999-12-31', label = '全部 All-time';
          if (range === 'day') { since = until = anchor; label = anchor; }
          else if (range === 'week') { const d = new Date(anchor + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 6); since = d.toISOString().slice(0, 10); until = anchor; label = `${since} ~ ${anchor}`; }
          else if (range === 'month') { since = anchor.slice(0, 7) + '-01'; until = anchor; label = anchor.slice(0, 7); }
          // top-ups grouped by channel. Only the online Stripe channel incurs a processor (API) fee.
          const FEE = { stripe: 0.013, paynow: 0, cash: 0 };   // SG: Stripe PayNow 1.3%; in-store UEN PayNow & cash 0
          const tu = await env.DB.prepare("SELECT COALESCE(pay_method,'cash') m, COUNT(*) c, COALESCE(SUM(amount),0) principal, COALESCE(SUM(bonus),0) bonus FROM topups WHERE pay_status='PAID' AND substr(datetime(created_at,'+8 hours'),1,10) BETWEEN ? AND ? GROUP BY pay_method").bind(since, until).all();
          let principal_in = 0, bonus_given = 0, processor_fee = 0; const channels = {};
          for (const r of (tu.results || [])) {
            const m = r.m || 'cash', rate = FEE[m] || 0, fee = +((r.principal || 0) * rate).toFixed(2);
            principal_in += r.principal || 0; bonus_given += r.bonus || 0; processor_fee += fee;
            channels[m] = { count: r.c, principal: +(r.principal || 0).toFixed(2), bonus: +(r.bonus || 0).toFixed(2), fee_rate: rate, fee };
          }
          principal_in = +principal_in.toFixed(2); bonus_given = +bonus_given.toFixed(2); processor_fee = +processor_fee.toFixed(2);
          const net_cash = +(principal_in - processor_fee).toFixed(2);
          const consumedRow = await env.DB.prepare("SELECT COALESCE(SUM(paid_by_balance),0) s FROM orders WHERE pay_status='PAID' AND paid_by_balance>0 AND substr(datetime(COALESCE(paid_at,created_at),'+8 hours'),1,10) BETWEEN ? AND ?").bind(since, until).first();
          const consumed = +(((consumedRow && consumedRow.s) || 0)).toFixed(2);
          // ── 对账：判定必须来自【一条】SQL ────────────────────────────────
          // 多次独立查询没有一致性快照：并发写入下可能读到「旧的实际 + 新的账面」，
          // 两个都不是同一时刻的真相，却恰好相等 —— 于是服务端宣称账平。
          // 所以把判定要用的每一个量都放进同一条语句；下面的分组明细只用于展示。
          //
          // 分类【白名单】而不是黑名单：未知 type、NULL type、NULL 金额、
          // 关联不到订单的退款，一律落进 unresolved（fail closed）。猜一边就是拿钱赌。
          // 分类【只定义一次】，汇总和明细共用同一个 CASE。
          // 用 CASE...ELSE 而不是三个 NOT(...) 的合取：SQL 是三值逻辑，
          // w.type IS NULL 时三个条件都是 UNKNOWN，NOT(UNKNOWN) 还是 UNKNOWN，
          // WHERE 只选 TRUE —— 那一行会从判定里【彻底消失】，既不计入也不挂起，
          // 而展示又把它显示成 unresolved，汇总与明细自相矛盾。CASE 的 ELSE 是全覆盖的。
          //
          // counted 是白名单：类型必须是已知的，金额必须真的是数字
          // （SQLite 动态类型，TEXT 也能塞进 REAL 列，SUM 会当 0 处理）。
          const BUCKET_CASE = `CASE
              WHEN w.type IN ('legacy_merge','legacy_unmerge') THEN 'transfer'
              -- 整单退储值：把这笔事件排除，前提是它确实等于「消费抵扣」里被剔掉的那一笔。
              -- 只看订单状态就排除，等于把这个前提当成公理。金额对不上时不许排除，
              -- 否则账面会凭空平掉一个真实差额（独立复核给的反例）。
              WHEN w.type = 'refund' AND o.id IS NOT NULL AND o.balance_refunded_at IS NOT NULL
                   AND typeof(w.amount) IN ('integer','real')
                   -- 精确相等，不做四舍五入：两边各自 ROUND 到同一个分位，
                   -- 会把 30.004 与 29.996 判成一致，亚分差就被抹掉了。
                   -- 这两个值在代码里来自同一个变量，精确相等本就该成立；
                   -- 不成立就说明有人绕过代码写过库，那正是要挂起的情况。
                   AND w.amount = o.paid_by_balance THEN 'order_refunded'
              WHEN typeof(w.amount) IN ('integer','real') AND (
                     w.type = 'adjustment'
                     OR (w.type = 'refund' AND o.id IS NOT NULL AND o.balance_refunded_at IS NULL)
                   ) THEN 'counted'
              ELSE 'unresolved' END`;
          const WALLET_CTE = `WITH we AS (
              SELECT w.amount AS amount, ${BUCKET_CASE} AS bucket
              FROM wallet_events w LEFT JOIN orders o ON o.id = w.order_id)`;

          // members 一次扫描算出四个量，别为每个量各扫一遍
          const snap = await env.DB.prepare(`${WALLET_CTE}
            SELECT
              (SELECT COALESCE(SUM(amount),0) FROM topups WHERE pay_status='PAID') AS principal,
              (SELECT COALESCE(SUM(bonus),0)  FROM topups WHERE pay_status='PAID') AS bonus,
              (SELECT COALESCE(SUM(paid_by_balance),0) FROM orders
                 WHERE paid_by_balance>0 AND balance_refunded_at IS NULL) AS consumed,
              m.net, m.positive, m.negative, m.negative_members, m.members_with_balance,
              (SELECT COALESCE(SUM(amount),0) FROM we WHERE bucket='counted')    AS wallet_counted,
              (SELECT COUNT(*)                FROM we WHERE bucket='unresolved') AS unresolved_rows,
              (SELECT COALESCE(SUM(amount),0) FROM we WHERE bucket='unresolved') AS unresolved_amount
            FROM (SELECT COALESCE(SUM(balance),0) net,
                    COALESCE(SUM(CASE WHEN balance>0 THEN balance ELSE 0 END),0) positive,
                    COALESCE(SUM(CASE WHEN balance<0 THEN -balance ELSE 0 END),0) negative,
                    COUNT(CASE WHEN balance<0 THEN 1 END) negative_members,
                    COUNT(CASE WHEN balance>0 THEN 1 END) members_with_balance
                  FROM members) m`).first();

          const r2 = v => Math.round((+v || 0) * 100) / 100;
          // 快照缺失或有非有限数 → 直接判不平。把异常静默变成 0 就是 fail open。
          const snapFields = ['principal','bonus','consumed','net','positive','negative',
            'wallet_counted','unresolved_rows','unresolved_amount'];
          const snapUsable = !!snap && snapFields.every(k => Number.isFinite(Number(snap[k])));
          const credited_all = r2((snap?.principal || 0) + (snap?.bonus || 0));
          const consumed_all = r2(snap?.consumed);
          const consumed_net = consumed_all;
          const outstanding = r2(snap?.positive);
          const net_outstanding = r2(snap?.net);
          const negative_outstanding = r2(snap?.negative);
          const negative_members = snap?.negative_members || 0;
          const liaRow = { s: outstanding, c: snap?.members_with_balance || 0 };
          const wallet_counted = r2(snap?.wallet_counted);
          const unresolved_rows = snapUsable ? Number(snap.unresolved_rows) : -1;
          const expected_outstanding = r2(credited_all - consumed_net + wallet_counted);
          const reconciled = snapUsable && unresolved_rows === 0
            && Math.abs(expected_outstanding - net_outstanding) < 0.005;

          // ── 以下仅供展示：分组明细，不参与判定 ──────────────────────────
          const wRows = await env.DB.prepare(`SELECT COALESCE(w.type,'(未标类型)') AS type,
              ${BUCKET_CASE} AS bucket,
              COUNT(*) AS c, COALESCE(SUM(w.amount),0) AS s
            FROM wallet_events w LEFT JOIN orders o ON o.id = w.order_id
            GROUP BY w.type, bucket`).all();
          const LABEL = { adjustment: '人工调整', refund: '退款回补余额' };
          const counted = [], excluded = [], unresolved = [];
          const mergeInto = (list, key, label, reason, r) => {
            const hit = list.find(x => x.key === key);
            if (hit) { hit.rows += r.c; hit.amount = r2(hit.amount + r.s); }
            else list.push({ key, label, rows: r.c, amount: r2(r.s), ...(reason ? { reason } : {}) });
          };
          for (const r of (wRows.results || [])) {
            const label = LABEL[r.type] || r.type || '(未标类型)';
            if (r.bucket === 'counted') mergeInto(counted, r.type || 'unknown', label, null, r);
            else if (r.bucket === 'transfer') mergeInto(excluded, 'transfer', '会员间余额转移（历史钱包并入）',
              '只是把余额从一个会员挪到另一个，总额不变，计入即重复', r);
            else if (r.bucket === 'order_refunded') mergeInto(excluded, 'order_refunded', `${label}（整单已退储值）`,
              '该订单已退出「已消费」口径，消费抵扣里已经不含它了', r);
            else mergeInto(unresolved, 'unresolved', `${label}（关联不到订单或类型未知）`,
              '无法判断这笔钱是否已在别处记过，需人工核对', r);
          }
          return json({
            range, label, since, until,
            principal_in, bonus_given, processor_fee, net_cash, consumed,
            channels,
            liability: { outstanding, members_with_balance: (liaRow && liaRow.c) || 0 },
            reconciliation: {
              topup_principal: r2(snap?.principal),
              topup_bonus: r2(snap?.bonus),
              credited_all_time: credited_all,
              consumed_all_time: consumed_net,
              counted,
              excluded,
              unresolved,
              expected_outstanding,
              actual_outstanding: net_outstanding,
              positive_outstanding: outstanding,
              negative_outstanding, negative_members,
              reconciled,
              diff: +(expected_outstanding - net_outstanding).toFixed(2) },
            fee_note: '通道费(API)=在线 Stripe 充值额 ×1.3%（SG PayNow 实际费率）；在店 PayNow(UEN 直收)与现金 0 费。',
            acct_note: '充值进店是预收负债，不是营收；赠送是营销支出；只有顾客消费时才确认营收。',
          });
        }

        // promo codes: list / save / toggle
        if (pathname === '/api/admin/promos' && req.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
          return json({ promos: results });
        }
        if (pathname === '/api/admin/promo-save' && req.method === 'POST') {
          const b = await req.json();
          const code = String(b.code || '').trim().toUpperCase();
          if (!code || !['percent', 'fixed'].includes(b.kind) || !(b.value > 0)) return json({ error: 'code/kind/value required' }, 400);
          if (!/^[A-Z0-9_-]{1,32}$/.test(code)) return json({ error: '优惠码只能含 字母/数字/_-（1-32 位）' }, 400);   // 防注入 + code 进 admin onclick JS 字符串上下文
          if (b.kind === 'percent' && +b.value > 100) return json({ error: '百分比折扣不能超过 100%（如要固定额请选 fixed）' }, 400);  // 防手滑把 value=150 建成免单码
          if (b.starts && b.ends && b.ends < b.starts) return json({ error: '结束日不能早于开始日' }, 400);  // 防永久失效死码
          const minSpend = Math.max(0, +b.min_spend || 0), maxUses = Math.max(0, +b.max_uses || 0), perAcct = Math.max(0, +b.per_account_limit || 0);   // 负值钳到非负（防 max_uses<0 一建即"已用完"死码）
          const FULFIL_VALID = ['pickup', 'discount', 'anytime', 'walkin'];   // 适用渠道白名单（可多选；walkin=到店/POS）
          const fulfilArr = Array.isArray(b.fulfil_only) ? b.fulfil_only : String(b.fulfil_only || '').split(',');   // 接受数组或逗号串
          const fulfilOnly = [...new Set(fulfilArr.map(s => String(s).trim()).filter(x => FULFIL_VALID.includes(x)))].join(',');   // 去重+过滤非法值，逗号分隔；空=不限
          const firstOrderOnly = b.first_order_only ? 1 : 0, loginRequired = b.login_required ? 1 : 0;
          await env.DB.prepare(
            `INSERT INTO promo_codes (code,kind,value,min_spend,starts,ends,max_uses,per_account_limit,active,note,pickup_only,fulfil_only,first_order_only,login_required,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, value=excluded.value, min_spend=excluded.min_spend,
               starts=excluded.starts, ends=excluded.ends, max_uses=excluded.max_uses, per_account_limit=excluded.per_account_limit, active=excluded.active, note=excluded.note, pickup_only=excluded.pickup_only,
               fulfil_only=excluded.fulfil_only, first_order_only=excluded.first_order_only, login_required=excluded.login_required`
          ).bind(code, b.kind, +b.value, minSpend, b.starts || null, b.ends || null, maxUses, perAcct,
            b.active === 0 ? 0 : 1, b.note || null, b.pickup_only ? 1 : 0, fulfilOnly, firstOrderOnly, loginRequired, new Date().toISOString()).run();
          return json({ ok: true, code });
        }
        if (pathname === '/api/admin/promo-toggle' && req.method === 'POST') {
          const { code, active } = await req.json();
          await env.DB.prepare('UPDATE promo_codes SET active=? WHERE code=?').bind(active ? 1 : 0, String(code).trim().toUpperCase()).run();
          return json({ ok: true });
        }
        if (pathname === '/api/admin/promo-delete' && req.method === 'POST') {
          const { code } = await req.json().catch(() => ({}));
          const c = String(code || '').trim().toUpperCase();
          if (!/^[A-Z0-9_-]{1,32}$/.test(c)) return json({ error: 'code required' }, 400);
          const del = await env.DB.prepare('DELETE FROM promo_codes WHERE code=?').bind(c).run();
          if (!del.meta || del.meta.changes < 1) return json({ error: 'promo not found' }, 404);
          return json({ ok: true, code: c });
        }

        // 拼单路线管理
        if (pathname === '/api/admin/routes' && req.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT * FROM routes ORDER BY created_at DESC').all();
          return json({ routes: results });
        }
        if (pathname === '/api/admin/route-save' && req.method === 'POST') {
          const b = await req.json();
          const areas = Array.isArray(b.areas) ? b.areas.filter(Boolean) : [];
          // 名称：优先用户输入，否则用「首区 → 末区 顺路」
          const name = b.name || (areas.length ? `${areas[0]} → ${areas[areas.length - 1]} 顺路` : '顺风车路线');
          const blocks = b.blocks || (areas.length ? areas.join('、') : null);
          const geometry = b.geometry ? (typeof b.geometry === 'string' ? b.geometry : JSON.stringify(b.geometry)) : null;
          const areasJson = areas.length ? JSON.stringify(areas) : null;
          const id = b.id || crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO routes (id,name,blocks,fee,cutoff,run_at,note,active,created_at,
               from_postal,to_postal,from_addr,to_addr,from_lat,from_lng,to_lat,to_lng,geometry,areas,distance_m,duration_s)
             VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, blocks=excluded.blocks, fee=excluded.fee, cutoff=excluded.cutoff,
               run_at=excluded.run_at, note=excluded.note, active=excluded.active,
               from_postal=excluded.from_postal, to_postal=excluded.to_postal, from_addr=excluded.from_addr, to_addr=excluded.to_addr,
               from_lat=excluded.from_lat, from_lng=excluded.from_lng, to_lat=excluded.to_lat, to_lng=excluded.to_lng,
               geometry=excluded.geometry, areas=excluded.areas, distance_m=excluded.distance_m, duration_s=excluded.duration_s`
          ).bind(
            id, name, blocks, +b.fee || 0, b.cutoff || null, b.run_at || null, b.note || null, b.active === 0 ? 0 : 1, new Date().toISOString(),
            b.from_postal || null, b.to_postal || null, b.from_addr || null, b.to_addr || null,
            b.from_lat != null ? +b.from_lat : null, b.from_lng != null ? +b.from_lng : null,
            b.to_lat != null ? +b.to_lat : null, b.to_lng != null ? +b.to_lng : null,
            geometry, areasJson, b.distance_m != null ? +b.distance_m : null, b.duration_s != null ? +b.duration_s : null
          ).run();
          return json({ ok: true, id, name, areas });
        }
        if (pathname === '/api/admin/route-toggle' && req.method === 'POST') {
          const { id, active } = await req.json();
          await env.DB.prepare('UPDATE routes SET active=? WHERE id=?').bind(active ? 1 : 0, id).run();
          return json({ ok: true });
        }

        // all products incl. inactive (for the shelf manager)
        if (pathname === '/api/admin/products' && req.method === 'GET') {
          const [rows, state] = await env.DB.batch([
            env.DB.prepare('SELECT sku,name_cn,name_en,price,category,kcal,img,description_cn,description_en,detail_cn,detail_en,active,sort,components FROM products ORDER BY sort'),
            env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1'),
          ]);
          return json({ products: (rows.results || []).map(r => ({ ...r, components: parseStoredComponents(r.components) })),
            categories: await loadMenuCategories(env),
            draft_revision: state.results?.[0]?.draft_revision || null });
        }
        if (pathname === '/api/admin/product-save' && req.method === 'POST') {
          const b = await req.json();
          const existing = await env.DB.prepare('SELECT sku,name_cn,name_en,price,category,kcal,img,description_cn,description_en,detail_cn,detail_en,active,sort FROM products WHERE sku=?')
            .bind(String(b.sku || '').trim().toUpperCase()).first();
          const n = normalizeProductInput({ ...existing, ...b }, new Set((await loadMenuCategories(env)).map(c => c.key)));
          if (n.error) return json({ error: n.error }, 400);
          const p = n.product;
          // 组成：不传 = 不改；传了就整体替换（顾客菜单和厨房出餐都读这一列）
          let components = null;
          if (b.components !== undefined) {
            const { results: drafts } = await env.DB.prepare('SELECT sku,components FROM products').all();
            try {
              components = componentsToStored(normalizeComponentsInput(b.components, { selfSku: p.sku, drafts: drafts || [] }));
            } catch (e) {
              if (e instanceof ComponentsError) return json({ error: e.message, field: 'components' }, 400);
              throw e;
            }
          }
          const maxSort = existing ? null : await env.DB.prepare('SELECT COALESCE(MAX(sort),0)+1 AS next_sort FROM products').first();
          const sort = p.sort == null ? (existing ? existing.sort : (maxSort?.next_sort || 1)) : p.sort;
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            action: 'product_saved', detail: { sku: p.sku, created: !existing },
            buildStatements: ({ revision }) => [existing
              ? env.DB.prepare(`UPDATE products
                  SET name_cn=?,name_en=?,price=?,category=?,kcal=?,img=?,description_cn=?,description_en=?,
                    detail_cn=?,detail_en=?,active=?,sort=?,components=COALESCE(?,components)
                  WHERE sku=? AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
                .bind(p.name_cn,p.name_en,p.price,p.category,p.kcal,p.img,p.description_cn,p.description_en,
                  p.detail_cn,p.detail_en,p.active,sort,components,p.sku,revision)
              : env.DB.prepare(`INSERT INTO products
                  (sku,name_cn,name_en,price,category,kcal,img,description_cn,description_en,detail_cn,detail_en,active,sort,components)
                  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
                  WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
                .bind(p.sku,p.name_cn,p.name_en,p.price,p.category,p.kcal,p.img,p.description_cn,p.description_en,
                  p.detail_cn,p.detail_en,p.active,sort,components || '',revision)],
          });
          return result.ok ? json({ ok: true, sku: p.sku, created: !existing,
            draft_revision: result.draft_revision })
            : draftConflict(result);
        }

        // ---------- GET /api/admin/export-platform-csv : 外卖平台上架价导出 ----------
        // 平台价 = 直营价 / rate(默认 0.78,覆盖 22% 抽成);
        // 建议上架价 = 向上进位到 step(默认 0.10),保证抽成后到手 >= 直营价。
        // 可用 ?rate= / ?step= 临时覆盖。导出实时反映 products 表(前端改价/详情后自动同步)。
        if (pathname === '/api/admin/export-platform-csv' && req.method === 'GET') {
            let rate = parseFloat(url.searchParams.get('rate')); if (!(rate > 0 && rate <= 1)) rate = 0.78;
          let step = parseFloat(url.searchParams.get('step')); if (!(step > 0)) step = 0.10;
          const CATS = Object.fromEntries((await loadMenuCategories(env)).map(c => [c.key, [c.cn, c.en]]));
          const { results } = await env.DB.prepare('SELECT sku,name_cn,name_en,price,category,kcal,img,description_cn,description_en,detail_cn,detail_en,active,sort,components FROM products ORDER BY sort').all();
          const r2 = (n) => Math.round(n * 100) / 100;
          // CSV 转义 + Excel/Sheets 公式注入防护：前导 =+-@/Tab/CR 加单引号当文本（导出列均为正数价/文本，无负数列，不误伤）
          const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
          const header = ['分类(中)', '分类(英)', 'SKU', '商品名(中)', '商品名(英)', '直营价 SGD', '平台价(÷' + rate + ')', '建议上架价(进位' + step.toFixed(2) + ')', '热量 kcal', '图片', '在售', '短描述(中)', '短描述(英)', '详情(中)', '详情(英)'];
          const lines = [header.map(cell).join(',')];
          for (const p of results) {
            const base = Number(p.price) || 0;
            const exact = r2(base / rate);
            const sug = r2(Math.ceil(base / rate / step - 1e-9) * step);
            const c = CATS[p.category] || [p.category, p.category];
            // 组成与顾客菜单同源，平台上架文字也带上，避免平台菜单与店内组成不一致
            let parts = []; try { parts = resolveSnapshotComponents(p.components, results, p.sku); } catch (e) { parts = []; }
            const inclCn = componentsDisplayText(parts, 'cn'), inclEn = componentsDisplayText(parts, 'en');
            const descCn = [inclCn && `含：${inclCn}`, p.description_cn].filter(Boolean).join(' ');
            const descEn = [inclEn && `Incl: ${inclEn}`, p.description_en].filter(Boolean).join(' ');
            lines.push([c[0], c[1], p.sku, p.name_cn, p.name_en, base.toFixed(2), exact.toFixed(2), sug.toFixed(2), p.kcal == null ? '' : p.kcal, p.img || '', p.active ? '在售' : '下架', descCn, descEn, p.detail_cn || '', p.detail_en || ''].map(cell).join(','));
          }
          const csv = '﻿' + lines.join('\r\n') + '\r\n';
          return new Response(csv, {
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': 'attachment; filename="platform-menu.csv"',
              'cache-control': 'no-store',
            },
          });
        }
        // take a product offline / online (active 0/1) — hides it from the customer menu instantly
        if (pathname === '/api/admin/product-toggle' && req.method === 'POST') {
          const b = await req.json();
          const { sku, active } = b;
          if (!sku) return json({ error: 'sku required' }, 400);
          const nextActive = active === true || active === 1 || active === '1' ? 1 : 0;
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            action: 'product_availability_saved', detail: { sku: String(sku), active: nextActive },
            buildStatements: ({ revision }) => [env.DB.prepare(`UPDATE products SET active=? WHERE sku=?
              AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
              .bind(nextActive, sku, revision)],
          });
          return result.ok ? json({ ok: true, sku, active: nextActive, draft_revision: result.draft_revision })
            : draftConflict(result);
        }
        // reorder menu items (boss menu tool): order[]=skus in sequence → sort 1..N, or {sku,sort}
        if (pathname === '/api/admin/product-sort' && req.method === 'POST') {
          const b = await req.json();
          if (Array.isArray(b.order) && b.order.length) {
            const order = b.order.map(sku => String(sku || '').trim());
            if (order.some(sku => !sku) || new Set(order).size !== order.length) {
              return json({ error: 'order[] contains blank or duplicate SKU' }, 400);
            }
            const orderJson = JSON.stringify(order);
            const result = await commitDraftMutation(env, {
              expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
              action: 'product_sort_saved', detail: { count: order.length },
              buildStatements: ({ revision }) => [env.DB.prepare(`UPDATE products
                SET sort=(SELECT CAST(key AS INTEGER)+1 FROM json_each(?) WHERE value=products.sku)
                WHERE sku IN (SELECT value FROM json_each(?))
                  AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
                .bind(orderJson, orderJson, revision)],
            });
            return result.ok ? json({ ok: true, n: order.length, draft_revision: result.draft_revision })
              : draftConflict(result);
          }
          if (b.sku && b.sort != null) {
            const sort = Number(b.sort);
            if (!Number.isFinite(sort)) return json({ error: 'sort must be a number' }, 400);
            const result = await commitDraftMutation(env, {
              expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
              action: 'product_sort_saved', detail: { sku: String(b.sku), sort },
              buildStatements: ({ revision }) => [env.DB.prepare(`UPDATE products SET sort=? WHERE sku=?
                AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
                .bind(sort, b.sku, revision)],
            });
            return result.ok ? json({ ok: true, draft_revision: result.draft_revision })
              : draftConflict(result);
          }
          return json({ error: 'order[] or {sku,sort} required' }, 400);
        }
        // set a product photo: boss uploads → stored as a data URL in products.img (no external storage)
        if (pathname === '/api/admin/product-image' && req.method === 'POST') {
          const b = await req.json();
          if (!b.sku || !b.dataurl) return json({ error: 'sku + dataurl required' }, 400);
          if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(b.dataurl)) return json({ error: 'invalid image data' }, 400);
          if (b.dataurl.length > 900000) return json({ error: '图片过大，请压缩后再传（约 <600KB）' }, 400);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || req.headers.get('if-match') || ''),
            action: 'product_image_saved', detail: { sku: String(b.sku) },
            buildStatements: ({ revision }) => [env.DB.prepare(`UPDATE products SET img=? WHERE sku=?
              AND EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)`)
              .bind(b.dataurl, b.sku, revision)],
          });
          return result.ok ? json({ ok: true, draft_revision: result.draft_revision })
            : draftConflict(result);
        }

        // ---------- Stripe / payment config (admin-set, stored in D1; no redeploy needed) ----------
        if (pathname === '/api/admin/stripe-config' && req.method === 'GET') {
          const g = async (k) => { const r = await env.DB.prepare('SELECT v FROM app_settings WHERE k=?').bind(k).first(); return (r && r.v) || ''; };
          const mask = (s) => s ? (s.slice(0, 8) + '••••' + s.slice(-4)) : '';
          const sk = await g('STRIPE_SECRET_KEY'), wh = await g('STRIPE_WEBHOOK_SECRET'), pk = await g('STRIPE_PK'), pm = await g('PAY_MODE');
          const aipEnv = (await g('AIPFINTECH_ENV')) || 'test';
          const aipGateway = (await g('AIPFINTECH_GATEWAY_URL')) || (aipEnv === 'prod' ? 'https://oats.allinpay.com/gateway' : 'https://test.allinpayhk.com/gateway');
          const aipMcht = await g('AIPFINTECH_MCHT_ID');
          const aipPrivate = await g('AIPFINTECH_PRIVATE_KEY');
          const aipPublic = await g('AIPFINTECH_PUBLIC_KEY');
          return json({
            pay_mode: pm || env.PAY_MODE || 'stripe',
            secret_set: !!sk, secret_mask: mask(sk), secret_live: sk.startsWith('sk_live_'),
            webhook_set: !!wh,
            pk: pk || '', pk_live: (pk || env.STRIPE_PK || '').startsWith('pk_live_'),
            aipfintech: {
              enabled: (await g('AIPFINTECH_ENABLED')) === '1',
              env: aipEnv,
              gateway_url: aipGateway,
              mcht_id: aipMcht,
              mcht_mask: mask(aipMcht),
              inst_no: await g('AIPFINTECH_INST_NO'),
              sign_type: (await g('AIPFINTECH_SIGN_TYPE')) || 'RSA2',
              private_key_set: !!aipPrivate,
              public_key_set: !!aipPublic,
              fallback_email: await g('AIPFINTECH_FALLBACK_EMAIL'),
              language: (await g('AIPFINTECH_LANGUAGE')) || 'en',
              pay_page_style: (await g('AIPFINTECH_PAY_PAGE_STYLE')) || 'DEFAULT',
              trans_type: (await g('AIPFINTECH_TRANS_TYPE')) || 'CashierPay',
              checkout_ready: !!(aipMcht && aipPrivate && aipPublic),
              webhook_ready: !!aipPublic,
              notify_url: `${url.origin}/api/webhook/aipfintech`,
              return_url: `${url.origin}/api/payment/aipfintech-return`,
            },
          });
        }
        if (pathname === '/api/admin/stripe-config' && req.method === 'POST') {
          const b = await req.json();
          const ts = new Date().toISOString();
          const put = async (k, v) => { if (v != null && settingVal(v) !== '') await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(k, settingVal(v), ts).run(); };
          const putRaw = async (k, v) => env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(k, settingVal(v), ts).run();
          await put('STRIPE_SECRET_KEY', b.stripe_secret_key);
          await put('STRIPE_WEBHOOK_SECRET', b.stripe_webhook_secret);
          await put('STRIPE_PK', b.stripe_pk);
          if (['stripe', 'manual', 'aipfintech', 'allinpay'].includes(String(b.pay_mode || ''))) await put('PAY_MODE', b.pay_mode);
          if ('aipfintech_enabled' in b) await putRaw('AIPFINTECH_ENABLED', b.aipfintech_enabled ? '1' : '0');
          if (['test', 'prod'].includes(String(b.aipfintech_env || ''))) await put('AIPFINTECH_ENV', b.aipfintech_env);
          await put('AIPFINTECH_GATEWAY_URL', b.aipfintech_gateway_url);
          await put('AIPFINTECH_MCHT_ID', b.aipfintech_mcht_id);
          await put('AIPFINTECH_INST_NO', b.aipfintech_inst_no);
          if (['RSA2'].includes(String(b.aipfintech_sign_type || ''))) await put('AIPFINTECH_SIGN_TYPE', b.aipfintech_sign_type);
          await put('AIPFINTECH_PRIVATE_KEY', b.aipfintech_private_key);
          await put('AIPFINTECH_PUBLIC_KEY', b.aipfintech_public_key);
          await put('AIPFINTECH_FALLBACK_EMAIL', b.aipfintech_fallback_email);
          if (['zh', 'en', 'zh-hant', 'ja', 'kr', 'fr', 'es', 'ar'].includes(String(b.aipfintech_language || ''))) await put('AIPFINTECH_LANGUAGE', b.aipfintech_language);
          if (['DEFAULT', 'TINY'].includes(String(b.aipfintech_pay_page_style || ''))) await put('AIPFINTECH_PAY_PAGE_STYLE', b.aipfintech_pay_page_style);
          if (['CashierPay', 'Pay'].includes(String(b.aipfintech_trans_type || ''))) await put('AIPFINTECH_TRANS_TYPE', b.aipfintech_trans_type);
          return json({ ok: true });
        }

        // ---------- store open/close + delivery config (admin-set, D1-backed, no redeploy) ----------
        if (pathname === '/api/admin/settings' && req.method === 'GET') {
          try {
            const snapshot = await loadStoreSettingsSnapshot(env);
            return json({ raw: snapshot.settings, config: publicConfig(env, snapshot.settings), settings_revision: snapshot.revision,
              draft_revision: snapshot.draft_revision });
          } catch (e) { return json({ error: '设置功能尚未完成数据库升级', code: 'settings_migration_required' }, 503); }
        }
        if (pathname === '/api/admin/settings' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const hasPublicContent = Object.keys(b).some(key => DRAFT_PUBLIC_SETTING_KEYS.has(key));
          const saved = await saveStoreSettingsPatch(env, b, new Date().toISOString(),
            b.settings_revision || (hasPublicContent ? '' : b.base_revision),
            hasPublicContent ? { expectedRevision: String(b.base_revision || '') } : null);
          if (!saved.ok) return json({ ok: false, error: saved.error, code: saved.code }, saved.status || 400);
          const s = await getSettings(env, [...PUBLIC_SETTING_KEYS, ...ADMIN_SETTING_KEYS]);
          return json({ ok: true, config: publicConfig(env, s), settings_revision: saved.settings_revision,
            draft_revision: saved.draft_revision || null });
        }
        if (pathname === '/api/admin/posters' && req.method === 'GET') {
          try {
            const [stateRows, posterRows] = await env.DB.batch([
              env.DB.prepare('SELECT s.revision,p.draft_revision FROM homepage_poster_state s CROSS JOIN public_content_state p WHERE s.singleton=1 AND p.singleton=1'),
              env.DB.prepare(`SELECT id,title_cn,title_en,body_cn,body_en,badge,image_url,image_version,
                action_type,action_value,cta_cn,cta_en,active,show_on_open,show_on_home,sort,starts,ends,created_at,updated_at
                FROM homepage_posters ORDER BY sort,created_at,id`),
            ]);
            const state = stateRows.results?.[0];
            if (!state || !state.revision) throw new Error('homepage_poster_state missing');
            const results = posterRows.results;
            const posters = (results || []).map(row => ({ ...homepagePosterPublicProjection(row), active: posterBool(row.active),
              starts: row.starts || '', ends: row.ends || '', has_uploaded_image: !!row.image_version }));
            return json({ posters, collection_revision: String(state.revision), draft_revision: state.draft_revision });
          } catch (e) { return json({ error: '海报功能尚未完成数据库升级', posters: [] }, 503); }
        }
        if (pathname === '/api/admin/posters' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          if (!b.base_revision || !b.collection_revision) return json({ ok: false, code: 'revision_conflict', error: '缺少内容或海报版本，请重新加载并核对' }, 409);
          const saved = await saveHomepagePosters(env, b.posters, new Date().toISOString(), b.collection_revision,
            { expectedRevision: String(b.base_revision) });
          return json(saved.ok ? saved : { ok: false, error: saved.error, code: saved.code }, saved.ok ? 200 : (saved.status || 400));
        }
        // quick on/off switch for the dashboard button
        if (pathname === '/api/admin/store-toggle' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const open = b.open ? '1' : '0';
          await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('store_open', open, new Date().toISOString()).run();
          return json({ ok: true, store_open: open === '1' });
        }

        // ---------- 优惠配送片区编辑（DELIVERY_ZONES 覆盖 + 当日截单时间），老板手动按订单量调整 ----------
        if (pathname === '/api/admin/delivery-zones' && req.method === 'GET') {
          const before = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
          const dcfg = await deliveryConfig(env);
          const isCustom = !!(await setting(env, 'DELIVERY_ZONES'));
          const after = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
          if (!before || before.draft_revision !== after?.draft_revision) return json({ error: '内容已变化，请重新加载核对', code: 'revision_conflict' }, 409);
          return json({ zones: dcfg.zones, same_day_cutoff: dcfg.same_day_cutoff, is_custom: isCustom, draft_revision: before.draft_revision });
        }
        if (pathname === '/api/admin/delivery-zones' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          // 确定性清洗（钱/规则不信前端原样）：只收合法字段，金额/星期数值化
          const clean = [];
          for (const z of (Array.isArray(b.zones) ? b.zones : [])) {
            const sectors = String(z.sectors || '').split(/[,，\s]+/).map(s => s.replace(/\D/g, '').slice(0, 2)).filter(s => s.length === 2);
            const weekdays = (Array.isArray(z.weekdays) ? z.weekdays : []).map(Number).filter(d => d >= 0 && d <= 6);
            const name_cn = String(z.name_cn || '').slice(0, 40).trim();
            if (!name_cn || !sectors.length || !weekdays.length) continue;   // 名称/邮区/配送日缺一不可
            clean.push({ id: z.id || ('z' + clean.length), name_cn, name_en: String(z.name_en || name_cn).slice(0, 40),
              weekdays: [...new Set(weekdays)], sectors: [...new Set(sectors)],
              fee: Math.max(0, +(+z.fee || 0).toFixed(2)), free_over: Math.max(0, +(+z.free_over || 0).toFixed(2)), block_below: Math.max(0, +(+z.block_below || 0).toFixed(2)) });
          }
          if (!clean.length) return json({ error: '请至少配置一个有效片区（名称 + 邮区 + 配送日）' }, 400);
          const entries = [['DELIVERY_ZONES', JSON.stringify(clean)]];
          if (b.same_day_cutoff && /^([01]?\d|2[0-3]):[0-5]\d$/.test(b.same_day_cutoff)) entries.push(['SAME_DAY_CUTOFF', b.same_day_cutoff]);
          const result = await commitDraftMutation(env, {
            expectedRevision: String(b.base_revision || ''), action: 'delivery_zones_saved', detail: { count: clean.length },
            buildStatements: ({ revision, now }) => entries.map(([key, value]) => env.DB.prepare(`INSERT INTO app_settings (k,v,updated_at)
              SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM public_content_state WHERE singleton=1 AND draft_revision=?)
              ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`).bind(key, value, now, revision)),
          });
          return result.ok ? json({ ok: true, zones: clean, draft_revision: result.draft_revision })
            : json({ error: '内容已变化，请重新加载并核对', code: 'revision_conflict' }, 409);
        }

        // ---------- Telegram 来单提醒：boss 填 token → 自动设 webhook；谁私聊 bot 谁自动进白名单；来单广播 ----------
        if (pathname === '/api/admin/telegram-config' && req.method === 'GET') {
          const token = await setting(env, 'telegram_bot_token');
          const username = await setting(env, 'telegram_bot_username');
          let subs = [];
          try { const { results } = await env.DB.prepare('SELECT chat_id,name,added_at FROM telegram_subscribers ORDER BY added_at').all(); subs = results || []; } catch (e) {}
          let webhook = null;
          if (token) { try { const wi = await tgApi(token, 'getWebhookInfo', {}); if (wi && wi.ok) webhook = { set: !!wi.result.url, pending: wi.result.pending_update_count || 0, last_error: wi.result.last_error_message || '' }; } catch (e) {} }
          return json({ has_token: !!token, token_masked: token ? token.slice(0, 7) + '…' + token.slice(-4) : '', bot_username: username || '', webhook, subscribers: subs, count: subs.length });
        }
        if (pathname === '/api/admin/telegram-save' && req.method === 'POST') {
          const b = await req.json();
          const token = String(b.token || '').trim();
          const ts = new Date().toISOString();
          const put = async (k, v) => { await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(k, v, ts).run(); };
          if (!token) {
            const old = await setting(env, 'telegram_bot_token');
            if (old) { try { await tgApi(old, 'deleteWebhook', {}); } catch (e) {} }
            await env.DB.prepare("DELETE FROM app_settings WHERE k='telegram_bot_token' OR k='telegram_webhook_secret' OR k='telegram_bot_username'").run();
            return json({ ok: true, disabled: true });
          }
          if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) return json({ error: 'Token 格式不对（应形如 123456789:ABCdef…，从 @BotFather 复制）' }, 400);
          let me; try { me = await tgApi(token, 'getMe', {}); } catch (e) { return json({ error: '无法连接 Telegram（网络问题）' }, 502); }
          if (!me || !me.ok) return json({ error: 'Bot Token 无效，请到 @BotFather 核对后重填' }, 400);
          const secret = _hex(crypto.getRandomValues(new Uint8Array(16)));   // webhook 防伪密钥
          let wh; try { wh = await tgApi(token, 'setWebhook', { url: `${url.origin}/api/telegram/webhook`, secret_token: secret, allowed_updates: ['message', 'my_chat_member', 'callback_query'] }); } catch (e) { return json({ error: '设置 webhook 失败（网络）' }, 502); }
          if (!wh || !wh.ok) return json({ error: 'Telegram 设置 webhook 失败：' + ((wh && wh.description) || '未知') }, 400);
          await put('telegram_bot_token', token); await put('telegram_webhook_secret', secret); await put('telegram_bot_username', me.result.username);
          return json({ ok: true, bot: me.result.username, link: 'https://t.me/' + me.result.username });
        }
        if (pathname === '/api/admin/telegram-test' && req.method === 'POST') {
          const token = await setting(env, 'telegram_bot_token');
          if (!token) return json({ error: '尚未配置 token' }, 400);
          let subs = [];
          try { const { results } = await env.DB.prepare('SELECT chat_id FROM telegram_subscribers').all(); subs = results || []; } catch (e) {}
          if (!subs.length) return json({ error: '还没有人订阅。让店员私聊 @' + ((await setting(env, 'telegram_bot_username')) || 'bot') + ' 发句话即可订阅。' }, 400);
          let sent = 0;
          for (const s of subs) { try { const r = await tgApi(token, 'sendMessage', { chat_id: s.chat_id, text: '🔔 这是一条「来单提醒」测试消息。收到即表示配置成功。' }); if (r && r.ok) sent++; } catch (e) {} }
          return json({ ok: true, sent, total: subs.length });
        }
        if (pathname === '/api/admin/telegram-remove' && req.method === 'POST') {
          const b = await req.json();
          await env.DB.prepare('DELETE FROM telegram_subscribers WHERE chat_id=?').bind(String(b.chat_id || '')).run();
          return json({ ok: true });
        }

        // ---------- 厨房打印配置：令牌（设备访问）+ print_when（下单即打/付款才打）+ 队列概况 ----------
        if (pathname === '/api/admin/print-config' && req.method === 'GET') {
          let tok = await setting(env, 'print_token');
          if (!tok) { tok = 'kp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16); await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('print_token', tok, new Date().toISOString()).run(); }
          const pend = await env.DB.prepare("SELECT COUNT(*) c FROM print_jobs WHERE status='pending'").first();
          const done = await env.DB.prepare("SELECT COUNT(*) c FROM print_jobs WHERE status='printed' AND substr(datetime(printed_at,'+8 hours'),1,10)=?").bind(sgtTodayStr()).first();
          const profile = printProfile(await setting(env, 'print_profile'));
          const font_px = printFontPx(await setting(env, 'print_font_px'), profile);
          const kitchenOrigin = url.origin;
          return json({ token: tok, print_when: (await setting(env, 'print_when')) || 'paid', print_profile: profile.id, print_font_px: font_px, profiles: Object.values(PRINT_PROFILES), pending: pend.c, printed_today: done.c, kitchen_url: `${kitchenOrigin}/kitchen`, agent_url: `${url.origin}/kitchen?t=${tok}`, cloudprnt_url: `${url.origin}/api/print/cloudprnt?t=${tok}` });
        }
        if (pathname === '/api/admin/print-preview' && req.method === 'GET') {
          const profile = printProfile(url.searchParams.get('profile') || await setting(env, 'print_profile'));
          const font_px = printFontPx(url.searchParams.get('font_px') || await setting(env, 'print_font_px'), profile);
          return json({ profile: { ...profile, font_px }, content: renderKitchenTicket(sampleKitchenOrder(), profile) });
        }
        if (pathname === '/api/admin/print-config' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const ts = new Date().toISOString();
          if (b.print_when === 'placed' || b.print_when === 'paid') await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('print_when', b.print_when, ts).run();
          if (b.print_profile && PRINT_PROFILES[b.print_profile]) await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('print_profile', b.print_profile, ts).run();
          const fontPx = printFontPx(b.print_font_px, printProfile(b.print_profile || await setting(env, 'print_profile')));
          if (b.print_font_px != null) await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('print_font_px', String(fontPx), ts).run();
          if (b.regen) await env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('print_token', 'kp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), ts).run();
          if (b.test) {   // 测试打印：先清掉旧测试单（厨房平板没开时 TEST 行会无限累积、每次轮询重打——这是历史残留根因），再入一张样例
            await env.DB.prepare("DELETE FROM print_jobs WHERE order_id LIKE 'TEST-%'").run();
            const profile = printProfile(b.print_profile || await setting(env, 'print_profile'));
            await env.DB.prepare(`INSERT INTO print_jobs (id,order_id,kind,content,status,created_at) VALUES (?,?, 'kitchen', ?, 'pending', ?)`)
              .bind(crypto.randomUUID(), 'TEST-' + Date.now(), [receiptLine('=', profile.cols), centerCells('测试小票 TEST', profile.cols), centerCells(profile.label, profile.cols), '厨房打印连通测试 OK', receiptLine('=', profile.cols), '', ''].join('\n'), ts).run();
          }
          return json({ ok: true });
        }

        // ---------- 自费随时送 courier config: paste Lalamove / uParcel keys, hot-swap, no redeploy ----------
        if (pathname === '/api/admin/courier-config' && req.method === 'GET') {
          const g = async (k) => { const r = await env.DB.prepare('SELECT v FROM app_settings WHERE k=?').bind(k).first(); return (r && r.v) || ''; };
          const mask = (s) => s ? (s.slice(0, 4) + '••••' + s.slice(-3)) : '';
          const lk = await g('LALAMOVE_API_KEY'), ls = await g('LALAMOVE_API_SECRET');
          const uk = await g('UPARCEL_API_KEY'), us = await g('UPARCEL_SECRET_KEY');
          return json({
            provider: (await g('courier_provider')) || 'none',
            active: await courierProvider(env),
            shop_postal: (await g('SHOP_POSTAL')) || '',
            lalamove: { key_set: !!lk, key_mask: mask(lk), secret_set: !!ls, env: (await g('LALAMOVE_ENVIRONMENT')) || 'sandbox', service: (await g('LALAMOVE_SERVICE')) || 'MOTORCYCLE',
              quote_only: true, auto_dispatch: false, auto_refund: false },
            uparcel: { key_set: !!uk, key_mask: mask(uk), secret_set: !!us, env: (await g('UPARCEL_ENVIRONMENT')) || 'staging' },
            // 本店配送/自费随时送 收费方式
            fee: { mode: (await g('delivery_fee_mode')) || 'courier', flat: (await g('selfdeliver_flat')) || '', free_above: (await g('delivery_self_free_above')) || '',
              dist_base: (await g('dist_base')) || '', dist_per_km: (await g('dist_per_km')) || '', dist_detour: (await g('dist_detour')) || '1.3', dist_max: (await g('dist_max')) || '' },
          });
        }
        if (pathname === '/api/admin/courier-config' && req.method === 'POST') {
          const b = await req.json(); const ts = new Date().toISOString();
          const setKV = async (k, v) => env.DB.prepare('INSERT INTO app_settings (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(k, settingVal(v), ts).run();
          const put = async (k, v) => { if (v != null && settingVal(v) !== '') await setKV(k, v); };   // blank = keep existing
          if (b.provider) await setKV('courier_provider', String(b.provider));
          await put('SHOP_POSTAL', b.shop_postal);
          await put('LALAMOVE_API_KEY', b.lalamove_api_key); await put('LALAMOVE_API_SECRET', b.lalamove_api_secret);
          if (b.lalamove_env) await setKV('LALAMOVE_ENVIRONMENT', b.lalamove_env);
          // Quote-only is an invariant, not a UI preference. Old clients cannot
          // re-enable dispatch/refund by posting legacy fields.
          await setKV('lalamove_auto_dispatch', '0');
          await setKV('lalamove_auto_refund', '0');
          await put('UPARCEL_API_KEY', b.uparcel_api_key); await put('UPARCEL_SECRET_KEY', b.uparcel_secret_key);
          if (b.uparcel_env) await setKV('UPARCEL_ENVIRONMENT', b.uparcel_env);
          // 收费方式（可空=清除该项，按值覆盖）
          if (b.fee_mode) await setKV('delivery_fee_mode', b.fee_mode);
          if ('flat' in b) await setKV('selfdeliver_flat', b.flat);
          if ('free_above' in b) await setKV('delivery_self_free_above', b.free_above);
          if ('dist_base' in b) await setKV('dist_base', b.dist_base);
          if ('dist_per_km' in b) await setKV('dist_per_km', b.dist_per_km);
          if ('dist_detour' in b) await setKV('dist_detour', b.dist_detour);
          if ('dist_max' in b) await setKV('dist_max', b.dist_max);
          return json({ ok: true, active: await courierProvider(env), fee_mode: (await env.DB.prepare("SELECT v FROM app_settings WHERE k='delivery_fee_mode'").first())?.v || 'courier' });
        }
        // live "test connection" for the configured courier (boss clicks to verify keys before going live)
        if (pathname === '/api/admin/courier-test' && req.method === 'POST') {
          const prov = await courierProvider(env);
          if (!prov) return json({ ok: false, error: '未配置有效的快递 API key（或未选择快递商）' });
          const drop = await geocodePostalRetry('018956');            // a known CBD postal as a test dropoff
          const diag = {};
          const q = await courierQuote(env, drop, diag);              // diag 收集真实失败原因
          return q ? json({ ok: true, provider: prov, sample_fee: q.fee, currency: q.currency })
                   : json({ ok: false, provider: prov, error: diag.error || '报价失败：请检查 key / 环境 / 取货邮编', endpoint: diag.endpoint, market: diag.market });
        }

        if (pathname === '/api/admin/summary' && req.method === 'GET') {
          const today = sgtTodayStr();   // 未来订单按 SGT 营业日界定
          const paid = await env.DB.prepare(
            "SELECT COUNT(*) c, COALESCE(SUM(total),0) rev, COALESCE(SUM(gst),0) gst, COALESCE(SUM(service_charge),0) svc FROM orders WHERE pay_status='PAID'").first();
          const future = await env.DB.prepare(
            'SELECT COUNT(*) c FROM orders WHERE deliver_at >= ?').bind(today).first();
          return json({ paid_orders: paid.c, paid_revenue: paid.rev, paid_gst: +(paid.gst || 0).toFixed(2), paid_service_charge: +(paid.svc || 0).toFixed(2), future_orders: future.c });
        }
      }

      // ---------- static assets (menu + cart site) ----------
      // /admin、/pos、/kitchen 这些静态页也是私有面：不允许被缓存或索引。
      if (/^\/(admin|pos|kitchen)(\/|$)/.test(pathname)) {
        return privateResponse(await env.ASSETS.fetch(req));
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error('unhandled error', e && e.stack || e);   // 服务端记日志(wrangler tail 可见)，不把原始异常文本泄漏给顾客
      return json({ error: '服务器开小差了，请稍后再试 · Something went wrong on our side — please try again later' }, 500);
    }
    })());
  },

  // ---- scheduled jobs (Cloudflare Cron Triggers) ----
  // 必须按 cron 表达式分流，别让清理 tick 误跑日报：
  //   */5 * * * *   → Lalamove quote-only 模式，无自动订单可轮询
  //   */30 * * * *  → 清理：兜底退款被放弃的余额抵扣单
  //   0 0 * * *  (08:00 SGT) → 预定提醒；  0 13 * * *  (21:00 SGT) → 日报
  async scheduled(event, env, ctx) {
    const WA = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.BOSS_PHONE;

    // 一分钟 Cron：把到期的发布切上去；指针为空时【只有这里】允许创建首个 bootstrap 发布。
    if (event.cron === '* * * * *') {
      ctx.waitUntil(ensureActiveRelease(env, { actor: 'system:cron', allowBootstrap: true,
        pageBuilder: renderPublicReleasePages }).catch((e) => console.log('publication cron error', String(e && e.message || e))));
      return;
    }

    if (event.cron === '*/5 * * * *') {
      console.log('Lalamove quote-only: automatic dispatch/status/refund jobs disabled');
      return;
    }

    // 清理 cron：兜底退款（manual_qr 超时 45min；stripe 24h backstop）。只扫安全系统上线后的单。
    if (event.cron === '*/30 * * * *') {
      ctx.waitUntil(sweepAbandonedBalanceOrders(env).catch((e) => console.log('sweep error', String(e && e.message || e))));
      // 清理已打印超 7 天的厨房小票 + 未消费的旧测试单（防 print_jobs 表无限增长）
      ctx.waitUntil(env.DB.prepare("DELETE FROM print_jobs WHERE (status='printed' AND printed_at < datetime('now','-7 days')) OR (order_id LIKE 'TEST-%' AND created_at < datetime('now','-1 day'))").run().catch((e) => console.log('print cleanup error', String(e && e.message || e))));
      return;
    }

    const today = sgtTodayStr();   // 晨报/日报按 SGT 营业日(不依赖 cron 恰好落在 UTC==SGT 同日)

    if (event.cron === '0 0 * * *') {
      const { results } = await env.DB.prepare(
        "SELECT customer_name,total,fulfilment FROM orders WHERE COALESCE(NULLIF(deliver_at,''), substr(datetime(created_at,'+8 hours'),1,10))=? AND pay_status IN ('PAID','UNPAID') ORDER BY created_at").bind(today).all();
      const n = (results || []).length;
      const detail = (results || []).map(o => `${o.customer_name || '-'}${o.fulfilment === 'pickup' ? '(取)' : '(送)'}S$${o.total.toFixed(2)}`).join('；') || '无';
      if (WA) ctx.waitUntil(sendWhatsAppTemplate(env, env.BOSS_PHONE, env.WHATSAPP_MORNING_TEMPLATE || 'morning_bookings',
        [today, String(n), detail.slice(0, 240)]).catch(() => {}));
      console.log('morning reminder', today, n);
      return;
    }

    if (event.cron === '0 13 * * *') {
      const bySrc = (src) => env.DB.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE pay_status='PAID' AND source=? AND substr(datetime(COALESCE(paid_at,created_at),'+8 hours'),1,10)=?").bind(src, today).first();
      const on = await bySrc('online'), off = await bySrc('offline');
      const rev = ((on.rev || 0) + (off.rev || 0)).toFixed(2);
      if (WA) ctx.waitUntil(sendWhatsAppTemplate(env, env.BOSS_PHONE, env.WHATSAPP_DAILY_TEMPLATE || 'daily_report',
        [today, String(on.c + off.c), 'S$ ' + rev, `线上${on.c}/线下${off.c}`]).catch(() => {}));
      console.log('daily audit', today, rev);
      return;
    }
    // 未知 cron：什么都不做（避免清理 tick 误跑日报）
  },
};
export default worker;

// ---- 清理 cron 兜底：退款被放弃的余额抵扣单 ----
// 只扫安全系统上线（payment_safety_since）之后创建的单 → 历史欠退单不自动退（D5 须老板单独决定）。
// provider 分流：manual_qr（无 webhook，老板人工 mark-paid）默认 180min 才退——必须 > 老板核对 PayNow
//   的现实窗口，否则会把"顾客已扫码付了但老板还没核对"的单误取消+退储值；可经 app_settings
//   refund_grace_manual_min 调整（老板拍板）。stripe（有 24h 会话）只在 24h backstop 退，正常由
//   Stripe expired webhook 退，避免与"顾客晚付"撞车。幂等靠 cancelUnpaid 的 SQL 守卫。
async function sweepAbandonedBalanceOrders(env) {
  const now = new Date();
  const since = (await setting(env, 'payment_safety_since')) || '9999-12-31';  // 无标记则不扫（fail-safe）
  const manualMin = Math.max(45, +(await setting(env, 'refund_grace_manual_min')) || 180);  // 默认 3h，下限 45
  const cutManual = new Date(now.getTime() - manualMin * 60000).toISOString();
  const cut24h = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM orders
     WHERE pay_status='UNPAID' AND paid_by_balance>0 AND balance_refunded_at IS NULL
       AND created_at >= ?
       AND ( (COALESCE(pay_provider,'manual_qr') != 'stripe' AND created_at < ?)
             OR (pay_provider='stripe' AND created_at < ?) )
     ORDER BY created_at LIMIT 200`).bind(since, cutManual, cut24h).all();
  let refunded = 0;
  for (const row of (results || [])) {
    const r = await cancelUnpaidOrderAndRefundBalance(env, row.id, 'cron_timeout');
    if (r.claimed) {
      refunded++;
      if (r.promo_code) await releasePromoForOrder(env, row.id, r.promo_code);
    }
  }
  console.log('sweep abandoned balance orders:', (results || []).length, 'candidates,', refunded, 'refunded');
  return refunded;
}

async function sweepDeliveryStatuses(env) {
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const { results } = await env.DB.prepare(`SELECT * FROM delivery_jobs
    WHERE provider='lalamove' AND provider_order_id IS NOT NULL
      AND state NOT IN ('delivered','failed','dispatch_failed','refund_requested')
      AND created_at >= ?
    ORDER BY updated_at LIMIT 30`).bind(since).all();
  let updated = 0;
  for (const j of (results || [])) {
    const diag = {};
    const live = await lalamoveGetOrder(env, j.provider_order_id, diag);
    const liveStatus = live && (live.status || live.orderStatus || live.providerStatus);
    if (!liveStatus) continue;
    const before = String(j.state || '') + '|' + String(j.provider_status || '');
    const state = deliveryStateFromProviderStatus(liveStatus);
    await handleDeliveryProviderState(env, j.provider_order_id, liveStatus, live || {});
    const after = String(state || '') + '|' + String(liveStatus || '');
    if (after !== before) updated++;
  }
  console.log('delivery status sweep:', (results || []).length, 'active,', updated, 'changed');
  return updated;
}

async function sweepDeliveryTimeouts(env) {
  const min = Math.max(5, +(await setting(env, 'lalamove_no_driver_timeout_min')) || 15);
  const cut = new Date(Date.now() - min * 60000).toISOString();
  const { results } = await env.DB.prepare(`SELECT * FROM delivery_jobs
    WHERE provider='lalamove' AND state='assigning_driver' AND dispatch_requested_at IS NOT NULL AND dispatch_requested_at < ?
      AND COALESCE(refund_status,'') NOT IN ('requested','balance_refunded','manual_required')
    ORDER BY dispatch_requested_at LIMIT 20`).bind(cut).all();
  let handled = 0;
  for (const j of (results || [])) {
    const diag = {};
    const live = await lalamoveGetOrder(env, j.provider_order_id, diag);
    const liveStatus = live && (live.status || live.orderStatus || live.providerStatus);
    const state = deliveryStateFromProviderStatus(liveStatus || j.provider_status);
    if (state && state !== 'assigning_driver' && state !== 'created') {
      await handleDeliveryProviderState(env, j.provider_order_id, liveStatus || j.provider_status, live || {});
      continue;
    }
    await lalamoveCancelOrder(env, j.provider_order_id, 'No driver accepted within ' + min + ' minutes', diag);
    await updateDeliveryJob(env, j.order_id, { state: 'failed', provider_status: liveStatus || j.provider_status || 'NO_DRIVER_TIMEOUT', cancelled_at: new Date().toISOString(), raw_last: JSON.stringify({ timeout_min: min, diag }).slice(0, 4000) });
    await notifyDelivery(env, j.order_id, 'failed', {});
    if ((await setting(env, 'lalamove_auto_refund')) === '1') await requestDeliveryFailureRefund(env, j.order_id, 'lalamove_no_driver_timeout');
    handled++;
  }
  console.log('delivery timeout sweep:', (results || []).length, 'candidates,', handled, 'handled');
  return handled;
}

// ---- WhatsApp send — Meta Cloud API ----
// Called right after an order is placed (Phase 1) and again on payment (Phase 2).
// The customer ordered on the website (no open 24h service window), so this MUST be
// a pre-approved UTILITY template. Create a template named `order_invoice` with 3
// body params: {{1}} invoice_no, {{2}} amount, {{3}} invoice link. e.g.
//   "您好，您的订单 {{1}} 已生成，金额 {{2}}。查看发票与 PayNow 付款：{{3}}"
async function sendWhatsAppInvoice(env, order) {
  const to = e164Phone(order.phone);
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: env.WHATSAPP_TEMPLATE || 'order_invoice',
      language: { code: env.WHATSAPP_TEMPLATE_LANG || 'zh_CN' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: order.invoice_no },
          { type: 'text', text: 'S$ ' + order.total.toFixed(2) },
          { type: 'text', text: order.invoice_url },
        ],
      }],
    },
  };
  const r = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('whatsapp send failed: ' + (await r.text()));
  return r.json();
}

// Generic WhatsApp template send (used by the daily audit + future notices).
async function sendWhatsAppTemplate(env, to, template, bodyParams) {
  const payload = {
    messaging_product: 'whatsapp', to: e164Phone(to), type: 'template',
    template: {
      name: template, language: { code: env.WHATSAPP_TEMPLATE_LANG || 'zh_CN' },
      components: [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: t })) }],
    },
  };
  const r = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('wa template failed: ' + (await r.text()));
  return r.json();
}

function aipfintechDefaultGateway(mode) {
  return String(mode || '').toLowerCase() === 'prod' ? 'https://oats.allinpay.com/gateway' : 'https://test.allinpayhk.com/gateway';
}
function _pemToBytes(pem, expected) {
  const s = String(pem || '').trim();
  if (!s) throw new Error(expected + ' not configured');
  if (expected === 'private key' && /BEGIN RSA PRIVATE KEY/.test(s)) {
    throw new Error('AIPFINTECH_PRIVATE_KEY must be PKCS8 (BEGIN PRIVATE KEY), not PKCS1 (BEGIN RSA PRIVATE KEY)');
  }
  const b64 = s.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function _b64ToBytes(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function aipfintechCanonical(params) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && params[k] != null && String(params[k]).trim() !== '')
    .sort()
    .map(k => `${k}=${String(params[k]).trim()}`)
    .join('&');
}
async function aipfintechRsa2Sign(privatePem, canonical) {
  const key = await crypto.subtle.importKey('pkcs8', _pemToBytes(privatePem, 'private key'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return _bytesToB64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(canonical)));
}
async function aipfintechVerifyParams(env, params) {
  const signType = String(params.signType || await setting(env, 'AIPFINTECH_SIGN_TYPE') || 'RSA2').toUpperCase();
  if (signType !== 'RSA2') throw new Error('unsupported AIP signType');
  const sig = String(params.sign || '');
  if (!sig) throw new Error('AIP signature missing');
  const mchtId = await setting(env, 'AIPFINTECH_MCHT_ID');
  if (mchtId && String(params.mchtId || '') !== String(mchtId)) throw new Error('AIP merchant mismatch');
  const publicPem = await setting(env, 'AIPFINTECH_PUBLIC_KEY');
  const key = await crypto.subtle.importKey('spki', _pemToBytes(publicPem, 'public key'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, _b64ToBytes(sig), new TextEncoder().encode(aipfintechCanonical(params)));
  if (!ok) throw new Error('AIP signature mismatch');
  return true;
}
async function aipfintechCreateCheckout(env, { order_id, inv, amountDue, origin }) {
  const mode = (await setting(env, 'AIPFINTECH_ENV')) || 'test';
  const gateway = ((await setting(env, 'AIPFINTECH_GATEWAY_URL')) || aipfintechDefaultGateway(mode)).replace(/\/+$/, '');
  const mchtId = await setting(env, 'AIPFINTECH_MCHT_ID');
  const privateKey = await setting(env, 'AIPFINTECH_PRIVATE_KEY');
  const publicKey = await setting(env, 'AIPFINTECH_PUBLIC_KEY');
  if (!mchtId || !privateKey || !publicKey) throw new Error('AIP/Allinpay merchant id, private key or public key not configured');
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(order_id).first();
  const mInfo = await merchantInfo(env);
  let email = await setting(env, 'AIPFINTECH_FALLBACK_EMAIL') || '';
  if (!email && o) {
    const m = o.user_id
      ? await env.DB.prepare('SELECT email FROM auth_identities WHERE user_id=? AND email IS NOT NULL ORDER BY provider LIMIT 1').bind(o.user_id).first()
      : await env.DB.prepare('SELECT email FROM members WHERE phone=? AND user_id IS NULL').bind(normPhone(o.phone)).first();
    email = m && m.email || '';
  }
  if (!email) email = (await setting(env, 'MERCHANT_EMAIL')) || (mInfo.domain ? 'orders@' + mInfo.domain : '');
  const productInfo = JSON.stringify([{
    sku: inv || order_id.slice(0, 16),
    productName: `${mInfo.nameEn} Order ${inv || ''}`.trim().slice(0, 128),
    price: (+amountDue).toFixed(2),
    quantity: '1',
  }]);
  const params = {
    version: 'V2.0.0',
    mchtId,
    transType: (await setting(env, 'AIPFINTECH_TRANS_TYPE')) || 'CashierPay',
    accessOrderId: inv,
    currency: (await setting(env, 'AIPFINTECH_CURRENCY')) || 'SGD',
    amount: (+amountDue).toFixed(2),
    language: (await setting(env, 'AIPFINTECH_LANGUAGE')) || 'en',
    payPageStyle: (await setting(env, 'AIPFINTECH_PAY_PAGE_STYLE')) || 'DEFAULT',
    email,
    returnUrl: `${origin}/api/payment/aipfintech-return?order_id=${encodeURIComponent(order_id)}`,
    notifyUrl: `${origin}/api/webhook/aipfintech`,
    productInfo,
    signType: 'RSA2',
  };
  params.sign = await aipfintechRsa2Sign(privateKey, aipfintechCanonical(params));
  const r = await fetch(`${gateway}/cnp/quickpay`, {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error('AIP/Allinpay returned non-JSON'); }
  await aipfintechVerifyParams(env, d);
  if (!r.ok || d.resultCode !== '0000' || !d.payUrl) throw new Error(d.resultDesc || d.message || 'AIP/Allinpay checkout failed');
  return d;
}

// ---- Stripe PayNow Checkout (form-encoded REST, no SDK) ----
// Charges the exact amount due (after promo discount + balance) as one line item,
// so the webhook's amount check stays correct.
async function stripeCreateCheckout(env, { order_id, inv, amountDue, origin }) {
  const f = new URLSearchParams();
  f.append('mode', 'payment');
  f.append('payment_method_types[]', 'paynow');
  f.append('line_items[0][price_data][currency]', 'sgd');
  const mInfo = await merchantInfo(env);
  f.append('line_items[0][price_data][product_data][name]', `${mInfo.nameCn} 订单 ${inv || ''}`.trim());
  f.append('line_items[0][price_data][unit_amount]', String(Math.round(amountDue * 100)));
  f.append('line_items[0][quantity]', '1');
  f.append('success_url', `${origin}/invoice/${order_id}?paid=1`);
  f.append('cancel_url', `${origin}/invoice/${order_id}`);
  f.append('client_reference_id', order_id);
  f.append('metadata[order_id]', order_id);
  const SK = await setting(env, 'STRIPE_SECRET_KEY');
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    signal: AbortSignal.timeout(8000),   // 超时抛错 → 调用处 try-catch 降级到 manual PayNow
    method: 'POST',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: f.toString(),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

// Verify a Stripe webhook signature (HMAC-SHA256 over `${t}.${rawBody}`).
async function stripeVerify(raw, sigHeader, secret) {
  // fail-closed：缺密钥显式拒签（不依赖 WebCrypto 对零长度 key 抛错的实现细节，与 _hmac 一致）
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured — refusing to verify');
  const parts = {};
  for (const kv of (sigHeader || '').split(',')) { const [k, v] = kv.split('='); parts[k] = v; }
  if (!parts.v1) throw new Error('stripe signature missing v1');   // 也避免下面 _eq(hex, undefined) 取 .length 抛错
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${raw}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!_eq(hex, parts.v1)) throw new Error('signature mismatch');   // 恒时比较，与 token 校验一致
  return JSON.parse(raw);
}

// ---- server-side invoice HTML (mirrors the brand invoice template) ----
// 法人/品牌身份单一源：所有对外展示（发票 H1/页脚、收据、未找到页等）统一从这里取，
// 杜绝各处写死同一事实导致漂移。
// 来源：brand_name_* 设置(可后台改) → 内置默认；SHOP_DOMAIN 设置 → 默认；env.BOSS_PHONE/MERCHANT/PAYNOW_UEN(wrangler)。
async function merchantInfo(env) {
  const s = await getSettings(env, ['brand_name_cn', 'brand_name_en']);
  const contact = publicContact(await setting(env, 'shop_contact_phone'));
  return {
    nameCn: s.brand_name_cn || s.brand_name_en || DEFAULT_BRAND_CN,
    nameEn: s.brand_name_en || env.BRAND || DEFAULT_BRAND_EN,
    domain: await shopDomain(env),
    whatsapp: contact.local,
    contact,
    operator: env.MERCHANT || s.brand_name_en || env.BRAND || DEFAULT_BRAND_EN,
    uen: env.PAYNOW_UEN || '',
  };
}

async function renderInvoice(o, env) {
  const m = await merchantInfo(env);
  const items = JSON.parse(o.items_json || '[]');
  // 单价字段异常（历史数据/脏行）不能让整张发票 500 —— 这是顾客【付完钱】落地的页面，
  // 500 意味着他既看不到单号也扫不到付款码。缺价就显示「—」，如实留白而不是编一个 0.00。
  const rows = items.map(i => {
    const up = Number(i && (i.unit_price != null ? i.unit_price : i.price));
    const okPrice = Number.isFinite(up);
    const qty = Number(i && i.qty);
    const q = Number.isFinite(qty) ? qty : 0;
    return `<tr><td>${esc(i && i.name)}</td><td style="text-align:center">${q}</td>
     <td style="text-align:right">${okPrice ? up.toFixed(2) : '—'}</td>
     <td style="text-align:right">${okPrice ? (up * q).toFixed(2) : '—'}</td></tr>`;
  }).join('');
  const paid = o.pay_status === 'PAID';
  const refunded = o.pay_status === 'REFUNDED';
  const serviceCharge = +(o.service_charge || 0);
  const gst = +(o.gst || 0);
  // 已取消 / 已退款 / 已退回储值 → 不再渲染 PayNow QR（防退款/取消后顾客照旧扫码付款）。
  // REFUNDED 必须靠 pay_status 独立拦截：纯 Stripe 退款单可能没有 balance_refunded_at，
  // 否则会落到「待付款 + PayNow QR」分支，顾客可能对已退款的单重复付款。
  const cancelled = o.pay_status === 'CANCELLED' || (!!o.balance_refunded_at && !refunded);
  const voided = cancelled || refunded;            // 终止态：一律不显示 PayNow QR
  const refundedAmt = +(o.paid_by_balance || 0);
  const badgeClass = voided ? 'CANCELLED' : o.pay_status;
  const badgeText = paid ? '已付款 PAID' : (refunded ? '已退款 REFUNDED' : (cancelled ? '已取消 CANCELLED' : '待付款 UNPAID'));
  const pickupSettings = await getSettings(env, ['pickup_enabled','pickup_points','shop_name','shop_address','shop_pickup_detail','shop_pickup_photo','SHOP_POSTAL']);
  const allPickupPoints = pickupPointsFromSettings(pickupSettings, env);
  const selectedPickup = allPickupPoints.find(p => p.id === o.unit_no) || allPickupPoints[0];
  const pickupName = (selectedPickup && (selectedPickup.name || selectedPickup.name_en)) || `${m.nameCn} ${m.nameEn}`;
  const pickupAddress = stripPickupNameFromSnapshot(selectedPickup, o.address) || (selectedPickup && (selectedPickup.address || (selectedPickup.postal ? `S(${selectedPickup.postal})` : ''))) || '';
  const pickupDetail = selectedPickup && selectedPickup.detail;
  const pickupPhoto = selectedPickup ? pickupPhotoPublicUrl(selectedPickup) : '';
  const pickupMap = pickupAddress ? ` <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pickupAddress)}" target="_blank" rel="noopener" style="color:#1C4A3A;font-weight:700">打开地图 Open map</a>` : '';
  const pickupHtml = o.fulfilment === 'pickup' ? `<div class="pickup">
    ${pickupPhoto ? `<img src="${esc(pickupPhoto)}" alt="Pickup entrance" class="pickup-img">` : ''}
    <div style="font-weight:800;color:#1C4A3A;margin-bottom:3px">🥡 取餐地址 Pickup Address</div>
    <div><b>${esc(pickupName)}</b></div>
    <div>${pickupAddress ? esc(pickupAddress) + pickupMap : `取餐地址待确认，请到店前查看 WhatsApp 确认信息。Please check WhatsApp before visiting.`}</div>
    ${pickupDetail ? `<div class="pickup-detail">${esc(pickupDetail)}</div>` : ''}
    <div class="contact-actions"><a href="${esc(m.contact.whatsapp_href)}" target="_blank" rel="noopener">WhatsApp 发消息</a><a href="${esc(m.contact.tel_href)}">一键拨号 ${esc(m.contact.display)}</a></div>
  </div>` : '';
  // 预计时间(ETA)：自取即时单 = 下单时间 + 备货时长(默认 20min,老板可调,硬编码确定性)；
  // 预约/配送有日期 → 日期已在履约行显示；自费随时送(快递) → 以快递报价 ETA 为准(待集成,先提示)。
  const prepMin = Math.max(0, +(await setting(env, 'prep_time_min')) || 20);
  let etaHtml = '';
  // ETA 只对「今日新鲜、未终止」的单显示：voided(已取消/已退款)不显示，与 PayNow QR 同口径；
  // 旧单(非今日 SGT)也不显示 —— 货早已取走，再显示「预计可取 HH:MM」(无日期)会被误读成今天。
  const createdSgt = o.created_at ? new Date(new Date(o.created_at).getTime() + SGT_OFFSET_MIN * 60000).toISOString().slice(0, 10) : '';
  const todaySgt = new Date(Date.now() + SGT_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  if (!voided && o.created_at && createdSgt === todaySgt) {
    if (o.fulfilment === 'pickup' && !o.deliver_at) {
      const eta = new Date(new Date(o.created_at).getTime() + SGT_OFFSET_MIN * 60000 + prepMin * 60000);
      etaHtml = `<div class="eta">🍽️ 预计可取 Ready ~ ${eta.toISOString().slice(11, 16)} <span style="font-weight:400;color:#6E6650">（约 ${prepMin} 分钟）</span></div>`;
    } else if (o.fulfilment === 'anytime' && !o.deliver_at) {
      etaHtml = `<div class="eta">🛵 安排配送中 · 送达时间以快递通知为准</div>`;
    }
  }
  let deliveryHtml = '';
  if (!voided && o.fulfilment === 'anytime') {
    const dj = await env.DB.prepare(`SELECT state,provider_status,rider_name,rider_phone,share_link,updated_at
      FROM delivery_jobs WHERE order_id=? ORDER BY updated_at DESC LIMIT 1`).bind(o.id).first();
    if (dj) {
      const status = deliveryStatusText(dj.state || dj.provider_status);
      const rider = dj.rider_name ? `<br><span class="muted">骑手 ${esc(dj.rider_name)}${dj.rider_phone ? ' · ' + esc(dj.rider_phone) : ''}</span>` : '';
      const track = dj.share_link ? `<br><a href="${esc(dj.share_link)}" target="_blank" rel="noopener" style="color:#1C4A3A;font-weight:700">查看骑手位置 Tracking</a>` : '';
      deliveryHtml = `<div class="eta">🛵 ${esc(status)}${rider}${track}</div>`;
    }
  }
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${o.invoice_no}</title>
<style>body{font-family:system-ui,'Noto Sans CJK SC',sans-serif;max-width:520px;margin:0 auto;padding:18px;color:#33301F;background:#F6EFE0}
h1{color:#1C4A3A;font-size:20px;margin:0}.muted{color:#6E6650;font-size:13px}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
th{background:#1C4A3A;color:#F4E7C8;padding:8px;text-align:left}td{padding:8px;border-bottom:1px solid #D8B45F}
.tot{font-size:20px;font-weight:700;color:#1C4A3A;text-align:right}
.badge{display:inline-block;padding:4px 12px;border-radius:14px;font-weight:700;font-size:13px}
.UNPAID{background:#F6E4C4;color:#A23B2D;border:1px solid #A23B2D}.PAID{background:#DDEBDD;color:#1C4A3A;border:1px solid #1C4A3A}
.CANCELLED{background:#EFE2E0;color:#A23B2D;border:1px solid #A23B2D}
.pay{background:#FBF7EC;border:1px solid #D8B45F;border-radius:8px;padding:14px;margin-top:10px;font-size:14px}
.cancelled-note{background:#FBF1EF;border:1px solid #A23B2D;border-radius:8px;padding:14px;margin-top:10px;font-size:14px;color:#A23B2D;text-align:center}
.pickup{background:#FBF7EC;border:1px solid #D8B45F;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:14px;line-height:1.55}
.pickup-img{width:100%;border-radius:7px;margin-bottom:9px;display:block}
.pickup-detail{white-space:pre-line;color:#6E6650;margin-top:5px}
.contact-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.contact-actions a{display:inline-block;background:#1C4A3A;color:#F4E7C8;text-decoration:none;border-radius:18px;padding:8px 12px;font-weight:700;font-size:13px}
.eta{background:#FFF8EC;border:1px solid #D8B45F;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:16px;font-weight:700;color:#1C4A3A}</style></head>
<body>
<h1>${esc(m.nameCn)} ${esc(m.nameEn)} <span class="badge ${badgeClass}">${badgeText}</span></h1>
<div class="muted">${esc(m.domain)} · <a href="${esc(m.contact.whatsapp_href)}" target="_blank" rel="noopener">WhatsApp ${esc(m.contact.display)}</a> · <a href="${esc(m.contact.tel_href)}">拨打 Call</a></div>
<p class="muted">单号 ${o.invoice_no} · ${o.created_at ? new Date(new Date(o.created_at).getTime() + SGT_OFFSET_MIN * 60000).toISOString().slice(0, 16).replace('T', ' ') : ''}<br>
客户 ${esc(o.customer_name)} · ${esc(o.phone)}<br>${o.fulfilment === 'pickup' ? `自取 Pickup · ${esc(o.address || pickupSnapshot(selectedPickup) || '')}` : (({ discount: '优惠配送', anytime: '自费随时送', delivery: '配送', route: '拼单顺路送' }[o.fulfilment] || '配送') + ' ' + esc(o.address || ''))}${(o.deliver_at || o.deliver_time) ? ' · ' + esc(((o.deliver_at || '今天') + ' ' + (o.deliver_time || '')).trim()) : ''}</p>
${pickupHtml}
${etaHtml}
${deliveryHtml}
${(paid || o.pay_status === 'PAID') && !voided ? `<div class="contact-actions"><a href="/?order=${encodeURIComponent(o.id)}">🍳 查看制作进度 Track my order</a></div>` : ''}
<table><thead><tr><th>商品 Item</th><th style="text-align:center">数量</th><th style="text-align:right">单价</th><th style="text-align:right">小计</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="muted" style="text-align:right;line-height:1.7">
  小计 S$ ${o.subtotal.toFixed(2)} &nbsp; 配送 S$ ${o.delivery_fee.toFixed(2)}${+o.discount > 0 ? ` &nbsp; 优惠 −S$ ${(+o.discount).toFixed(2)}` : ''}<br>
  ${serviceCharge > 0 ? `服务费 ${(+o.service_charge_rate || 0).toFixed(1)}% S$ ${serviceCharge.toFixed(2)}<br>` : ''}
  ${gst > 0 ? `GST ${(+o.gst_rate || 0).toFixed(1)}% S$ ${gst.toFixed(2)}<br>` : ''}
</div>
<div class="tot">合计 TOTAL &nbsp; S$ ${o.total.toFixed(2)}</div>
${+o.paid_by_balance > 0 ? `<div class="muted" style="text-align:right">储值抵扣 −S$ ${(+o.paid_by_balance).toFixed(2)} &nbsp; 应付 S$ ${(o.total - o.paid_by_balance).toFixed(2)}</div>` : ''}
${voided ? `<div class="cancelled-note">
    <div style="font-weight:700;margin-bottom:4px">${refunded ? '订单已退款 Order Refunded' : '订单已取消 Order Cancelled'}</div>
    ${refundedAmt > 0 ? `已退回储值 S$ ${refundedAmt.toFixed(2)} 到您的会员账户，` : ''}${refunded ? '如有疑问请联系本店 WhatsApp。' : '请重新下单 Please place a new order。'}</div>`
  : (paid ? '' : (() => {
  const uen = m.uen, merchant = m.operator;   // 单一源(merchantInfo)：不再各处直读 env，杜绝收款商户名/UEN 与发票头漂移
  const bal = +(o.paid_by_balance || 0);
  const dueAmt = +(o.total - bal).toFixed(2);   // PayNow only collects the amount still owed after balance
  // QR 构建失败（如配错 UEN/商户名超 99 字节）不能 500 整个发票页：降级为不出码，
  // 下方 UEN+金额+备注 文本仍在，顾客可手动 PayNow 转账。
  let qr = '';
  const payNote = payNoteFor(o);
  try { if (uen) qr = paynowQrSvg(uen, dueAmt, payNote, merchant); } catch (e) { qr = ''; }
  return `<div class="pay" style="text-align:center">
    <div style="font-weight:700;color:#1C4A3A;margin-bottom:6px">PayNow · 扫码付款 Scan to Pay</div>
    ${bal > 0 ? `<div class="muted" style="margin-bottom:6px">合计 S$ ${o.total.toFixed(2)} − 储值抵扣 S$ ${bal.toFixed(2)} = 应付 S$ ${dueAmt.toFixed(2)}</div>` : ''}
    <div style="max-width:220px;margin:0 auto">${qr}</div>
    <div style="margin-top:6px">收款 <b>${esc(merchant)}</b> · UEN <b>${esc(uen || '—')}</b><br>
    应付 <b style="font-size:18px">S$ ${dueAmt.toFixed(2)}</b>（已锁定）· 备注 <b style="color:#A23B2D">${esc(payNote)}</b><br>
    <span class="muted">扫码后金额自动带入；付款后我们确认订单。</span></div></div>`;
})())}
</body></html>`;
}

// Named exports are used only by the local authentication regression tests.
// Cloudflare continues to invoke the default Worker export above.
export {
  PRINT_PROFILES,
  appleClientSecret,
  checkFulfilTime,
  nextBusinessSlot,
  classifyChargeRefund,
  computeOrderTotals,
  courierRecipientPhone,
  e164Phone,
  isLalamoveQuoteRequest,
  manualCourierTelegramPayload,
  kitchenNote,
  maxFontPxFor,
  normFulfilStatus,
  normPhone,
  printFontPx,
  orderActionRows,
  planRefundSplit,
  payNoteFor,
  paynowPayload,
  sameTopupOp,
  sgCounterPhone,
  signSession,
  signStaffToken,
  signKitchenToken,
  stripeVerify,
  tgCopyRows,
  verifyOidcIdToken,
  verifySession,
  walletLedgerWithBalances,
  FULFIL_FLOW,
};
