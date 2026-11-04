// Hawkerline agent layer: lets an AI agent operate the store through MCP (/mcp) or REST (/api/agent/v1).
//
// Model: the owner issues scoped agent keys in /admin. A call is authenticated by key hash, checked against
// the tool's scope, rate limited, then executed by the SAME admin handlers the owner's back office uses
// (internal dispatch with an elevated env, see agent-context.js). Every validation, draft revision check
// (compare-and-swap) and publication guard therefore applies to agents exactly as it does to the owner.
// Every call is written to agent_audit.
//
// Safety rails that matter for "let the AI run the menu":
//   * edits only change the draft; customers see nothing until publish_menu
//   * publish_menu requires the draft checksum returned by preview_menu (no blind publishing)
//   * keys carry scopes; tools/list only shows what the key may call; the owner can revoke a key instantly

import { elevatedAgentEnv } from './agent-context.js';

export const AGENT_API_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const AGENT_SCOPES = Object.freeze({
  'menu:read': 'Read products, categories, publication status and preview the draft',
  'menu:write': 'Create and edit draft products, images, order and categories',
  'menu:publish': 'Publish the previewed draft menu to customers (now or scheduled)',
  'orders:read': 'Read orders and the kitchen board',
  'orders:write': 'Move orders through the kitchen flow (new → preparing → ready → done)',
  'store:write': 'Open or close the store for new orders',
  'reports:read': 'Read sales summaries',
});
const KEY_RE = /^hlk_[0-9a-f]{40}$/;
const RATE_LIMIT_PER_MINUTE = 120;
const MAX_IMAGE_BYTES = 640 * 1024;
const MAX_BULK = 100;

// ───────────────────────────────────────────────────────────── helpers
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
const nowIso = () => new Date().toISOString();

export class ToolError extends Error {
  constructor(message, { status = 400, code = 'tool_error', details } = {}) {
    super(message); this.name = 'ToolError'; this.status = status; this.code = code; this.details = details;
  }
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  return m ? m[1] : '';
}

// ───────────────────────────────────────────────────────────── keys (owner-side management)
export function normalizeScopes(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const scopes = [...new Set(list.map(s => String(s).trim()).filter(Boolean))];
  const unknown = scopes.filter(s => !Object.hasOwn(AGENT_SCOPES, s));
  if (unknown.length) throw new ToolError(`Unknown scope: ${unknown.join(', ')}`, { code: 'invalid_scope' });
  if (!scopes.length) throw new ToolError('Choose at least one scope', { code: 'invalid_scope' });
  return scopes;
}

export async function createAgentKey(env, { name, scopes }) {
  const label = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!label) throw new ToolError('Key name is required', { code: 'invalid_name' });
  const granted = normalizeScopes(scopes);
  const key = 'hlk_' + hex(crypto.getRandomValues(new Uint8Array(20)));
  const row = { id: crypto.randomUUID(), name: label, key_prefix: key.slice(0, 12), scopes: granted.join(' '), created_at: nowIso() };
  await env.DB.prepare('INSERT INTO agent_keys (id,name,key_hash,key_prefix,scopes,created_at) VALUES (?,?,?,?,?,?)')
    .bind(row.id, row.name, await sha256Hex(key), row.key_prefix, row.scopes, row.created_at).run();
  return { ...row, scopes: granted, key };
}

export async function listAgentKeys(env) {
  const { results } = await env.DB.prepare(
    'SELECT id,name,key_prefix,scopes,created_at,last_used_at,revoked_at FROM agent_keys ORDER BY created_at DESC').all();
  return (results || []).map(r => ({ ...r, scopes: String(r.scopes || '').split(' ').filter(Boolean) }));
}

export async function revokeAgentKey(env, id) {
  const r = await env.DB.prepare('UPDATE agent_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(nowIso(), String(id || '')).run();
  return (r.meta && r.meta.changes) === 1;
}

export async function listAgentAudit(env, limit = 100) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const { results } = await env.DB.prepare(
    'SELECT id,key_id,key_name,channel,tool,ok,status,summary,created_at FROM agent_audit ORDER BY id DESC LIMIT ?').bind(n).all();
  return results || [];
}

export async function authenticateAgent(req, env) {
  const token = bearer(req);
  if (!KEY_RE.test(token)) return null;
  const row = await env.DB.prepare('SELECT id,name,scopes FROM agent_keys WHERE key_hash=? AND revoked_at IS NULL')
    .bind(await sha256Hex(token)).first();
  if (!row) return null;
  return { id: row.id, name: row.name, scopes: new Set(String(row.scopes || '').split(' ').filter(Boolean)) };
}

// ───────────────────────────────────────────────────────────── tiny JSON-schema check (the subset our tools use)
function checkArgs(schema, value, path = 'arguments') {
  const errors = [];
  const walk = (s, v, p) => {
    if (v === undefined) return;
    const types = [].concat(s.type || []);
    const typeOk = !types.length || types.some(t => t === 'integer' ? Number.isInteger(v)
      : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : t === 'array' ? Array.isArray(v)
      : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
      : t === 'null' ? v === null : typeof v === t);
    if (!typeOk) { errors.push(`${p} must be ${types.join(' or ')}`); return; }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p} must be one of ${s.enum.join(', ')}`);
    if (typeof v === 'string' && s.maxLength && v.length > s.maxLength) errors.push(`${p} is longer than ${s.maxLength}`);
    if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) errors.push(`${p} must be ≥ ${s.minimum}`);
    if (typeof v === 'number' && s.maximum !== undefined && v > s.maximum) errors.push(`${p} must be ≤ ${s.maximum}`);
    if (Array.isArray(v)) {
      if (s.maxItems && v.length > s.maxItems) errors.push(`${p} has more than ${s.maxItems} items`);
      if (s.minItems && v.length < s.minItems) errors.push(`${p} needs at least ${s.minItems} items`);
      if (s.items) v.forEach((item, i) => walk(s.items, item, `${p}[${i}]`));
    }
    if (s.type === 'object' && v && typeof v === 'object') {
      for (const req of s.required || []) if (v[req] === undefined) errors.push(`${p}.${req} is required`);
      for (const [k, sub] of Object.entries(s.properties || {})) walk(sub, v[k], `${p}.${k}`);
      if (s.additionalProperties === false) {
        for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties || {}, k)) errors.push(`${p}.${k} is not a known field`);
      }
    }
  };
  walk(schema, value ?? {}, path);
  return errors;
}

// ───────────────────────────────────────────────────────────── tool kit (what a tool can do)
function toolkit({ req, env, ctx, dispatch, key }) {
  const origin = new URL(req.url).origin;
  const elevated = elevatedAgentEnv(env, key);
  async function call(method, path, body) {
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await dispatch(new Request(origin + path, init), elevated, ctx);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
  }
  async function expectOk(method, path, body) {
    const r = await call(method, path, body);
    if (r.status >= 400 || (r.data && r.data.ok === false)) {
      throw new ToolError(String(r.data?.error || `Request failed (HTTP ${r.status})`), {
        status: r.status, code: r.data?.code || (r.status === 409 ? 'conflict' : 'rejected'),
        details: r.data?.field ? { field: r.data.field } : undefined });
    }
    return r.data;
  }
  async function draftRevision() {
    const row = await env.DB.prepare('SELECT draft_revision FROM public_content_state WHERE singleton=1').first();
    if (!row) throw new ToolError('Publication state is not initialised; apply the database migrations first', { status: 503, code: 'not_initialised' });
    return row.draft_revision;
  }
  // Menu writes before the first release would be published by the bootstrap job without a preview, so agents wait.
  async function requireLiveRelease() {
    const row = await env.DB.prepare('SELECT active_release_id FROM public_content_state WHERE singleton=1').first();
    if (!row || !row.active_release_id) throw new ToolError('The store has no live release yet. The first release is created automatically within about a minute of deployment; try again then.', { status: 409, code: 'bootstrap_pending' });
  }
  async function productExists(sku) {
    return !!(await env.DB.prepare('SELECT 1 FROM products WHERE sku=?').bind(sku).first());
  }
  return { req, env, origin, key, call, expectOk, draftRevision, productExists, requireLiveRelease };
}

// ───────────────────────────────────────────────────────────── product helpers
const PRODUCT_FIELDS = ['sku', 'name_cn', 'name_en', 'price', 'category', 'kcal', 'active', 'sort',
  'description_cn', 'description_en', 'detail_cn', 'detail_en', 'components'];
const componentSchema = {
  type: 'array', maxItems: 20, description: 'Items included in a set/combo, e.g. [{"sku":"S01","qty":2}]. Use sku "DRINK" for "any drink" (customer picks an on-sale item of category drink). Empty array = sold as a single item. Omit to keep unchanged.',
  items: { type: 'object', required: ['sku', 'qty'], properties: { sku: { type: 'string', maxLength: 16 }, qty: { type: 'integer', minimum: 0, maximum: 99 } } },
};
const productSchema = {
  type: 'object', required: ['sku'], additionalProperties: false,
  properties: {
    sku: { type: 'string', maxLength: 16, description: 'Stable product code, 2–16 chars A–Z 0–9 _ -. Creates the product if it does not exist yet.' },
    name_cn: { type: 'string', maxLength: 120, description: 'Chinese name (falls back to name_en)' },
    name_en: { type: 'string', maxLength: 160, description: 'English name (falls back to name_cn)' },
    price: { type: 'number', minimum: 0.01, maximum: 999, description: 'Price in SGD, e.g. 6.5' },
    category: { type: 'string', maxLength: 24, description: 'A category key from list_categories' },
    description_cn: { type: 'string', maxLength: 240 }, description_en: { type: 'string', maxLength: 300 },
    detail_cn: { type: 'string', maxLength: 2000 }, detail_en: { type: 'string', maxLength: 2400 },
    kcal: { type: ['integer', 'null'], minimum: 0, maximum: 9999 },
    active: { type: 'boolean', description: 'true = on sale after the next publish' },
    sort: { type: 'integer', minimum: 0 },
    components: componentSchema,
    image_url: { type: 'string', maxLength: 2000, description: 'Optional https URL of a PNG/JPEG/WebP photo (≤ 640 KB) to use as the product image' },
  },
};
function productBody(args) {
  const body = {};
  for (const f of PRODUCT_FIELDS) if (args[f] !== undefined) body[f] = args[f];
  if (body.sku !== undefined) body.sku = String(body.sku).trim().toUpperCase();
  if (body.active !== undefined) body.active = body.active ? 1 : 0;
  return body;
}
function publicProduct(p) {
  const img = String(p.img || '');
  return {
    sku: p.sku, name_cn: p.name_cn, name_en: p.name_en, price: p.price, category: p.category, active: !!p.active, sort: p.sort,
    kcal: p.kcal ?? null, description_cn: p.description_cn || '', description_en: p.description_en || '',
    detail_cn: p.detail_cn || '', detail_en: p.detail_en || '', components: p.components || [],
    image: img.startsWith('data:') ? 'uploaded' : (img || null),
  };
}

const b64 = bytes => { let s = ''; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
function sniffImage(bytes) {
  const a = new Uint8Array(bytes.slice(0, 12));
  if (a[0] === 0x89 && a[1] === 0x50 && a[2] === 0x4e && a[3] === 0x47) return 'image/png';
  if (a[0] === 0xff && a[1] === 0xd8 && a[2] === 0xff) return 'image/jpeg';
  if (a[0] === 0x52 && a[1] === 0x49 && a[2] === 0x46 && a[3] === 0x46 && a[8] === 0x57 && a[9] === 0x45 && a[10] === 0x42 && a[11] === 0x50) return 'image/webp';
  return null;
}
// Downloads at most MAX_IMAGE_BYTES over https only: redirects are followed by hand (max 3) and every hop must be
// https without credentials; the body is read as a stream and cancelled as soon as it exceeds the limit.
async function downloadImage(start) {
  let u = start;
  const deadline = AbortSignal.timeout(10000);
  for (let hop = 0; hop <= 3; hop++) {
    if (u.protocol !== 'https:' || u.username || u.password) throw new ToolError('image_url must be a plain https:// URL (redirects included)', { code: 'invalid_image' });
    let res;
    try { res = await fetch(u.toString(), { redirect: 'manual', signal: deadline, headers: { accept: 'image/png,image/jpeg,image/webp' } }); }
    catch { throw new ToolError('Could not download the image (network error or timeout)', { code: 'image_download_failed' }); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try { u = new URL(res.headers.get('location'), u); } catch { throw new ToolError('Image redirect is invalid', { code: 'image_download_failed' }); }
      try { await res.body?.cancel(); } catch {}
      continue;
    }
    if (!res.ok || !res.body) throw new ToolError(`Could not download the image (HTTP ${res.status})`, { code: 'image_download_failed' });
    if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) {
      try { await res.body.cancel(); } catch {}
      throw new ToolError(`Image is larger than ${MAX_IMAGE_BYTES / 1024} KB; send a smaller one`, { code: 'image_too_large' });
    }
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      let part;
      try { part = await reader.read(); } catch { throw new ToolError('Could not download the image (network error or timeout)', { code: 'image_download_failed' }); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_IMAGE_BYTES) { try { await reader.cancel(); } catch {} throw new ToolError(`Image is larger than ${MAX_IMAGE_BYTES / 1024} KB; send a smaller one`, { code: 'image_too_large' }); }
      chunks.push(part.value);
    }
    const out = new Uint8Array(size); let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out.buffer;
  }
  throw new ToolError('Too many redirects', { code: 'image_download_failed' });
}
async function imageDataUrl({ image_url, image_base64 }) {
  let bytes;
  if (image_base64) {
    const clean = String(image_base64).replace(/^data:image\/[a-z]+;base64,/i, '').replace(/\s+/g, '');
    try { bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0)).buffer; } catch { throw new ToolError('image_base64 is not valid base64', { code: 'invalid_image' }); }
  } else {
    let u; try { u = new URL(String(image_url)); } catch { throw new ToolError('image_url is not a valid URL', { code: 'invalid_image' }); }
    bytes = await downloadImage(u);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ToolError(`Image is larger than ${MAX_IMAGE_BYTES / 1024} KB; send a smaller one`, { code: 'image_too_large' });
  const mime = sniffImage(bytes);
  if (!mime) throw new ToolError('Only PNG, JPEG or WebP images are accepted', { code: 'invalid_image' });
  return `data:${mime};base64,${b64(bytes)}`;
}

// What changed between the live release and the draft, in a form an agent (or a human) can check quickly.
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);
function snapshotDiff(active, draft) {
  const fields = ['name_cn', 'name_en', 'price_cents', 'category', 'active', 'sort', 'description_cn', 'description_en', 'detail_cn', 'detail_en', 'kcal', 'image_url'];
  const before = new Map(((active && active.products) || []).map(p => [p.sku, p]));
  const after = new Map(((draft && draft.products) || []).map(p => [p.sku, p]));
  const added = [], removed = [], changed = [];
  for (const [sku, p] of after) {
    const old = before.get(sku);
    if (!old) { added.push({ sku, name_en: p.name_en, name_cn: p.name_cn, price: p.price_cents / 100, active: !!p.active }); continue; }
    const diff = {};
    for (const f of fields) if (canon(old[f] ?? null) !== canon(p[f] ?? null)) diff[f] = { from: old[f] ?? null, to: p[f] ?? null };
    if (JSON.stringify((old.components || []).map(c => [c.sku, c.qty])) !== JSON.stringify((p.components || []).map(c => [c.sku, c.qty]))) {
      diff.components = { from: (old.components || []).map(c => `${c.sku}×${c.qty}`), to: (p.components || []).map(c => `${c.sku}×${c.qty}`) };
    }
    if (Object.keys(diff).length) changed.push({ sku, changes: diff });
  }
  for (const [sku, p] of before) if (!after.has(sku)) removed.push({ sku, name_en: p.name_en });
  const settingsChanged = [];
  const a = (active && active.settings) || {}, d = (draft && draft.settings) || {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(d)])) if (canon(a[k] ?? null) !== canon(d[k] ?? null)) settingsChanged.push(k);
  return { products_added: added, products_removed: removed, products_changed: changed, settings_changed: settingsChanged.sort(),
    has_changes: !!(added.length || removed.length || changed.length || settingsChanged.length) };
}

function maskPhone(p) { const s = String(p || ''); return s.length > 4 ? '•••' + s.slice(-4) : s; }
function orderView(o, includeContact) {
  let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch {}
  return {
    id: o.id, invoice_no: o.invoice_no, created_at: o.created_at, source: o.source || 'online',
    pay_status: o.pay_status, fulfil_status: o.fulfil_status || 'new', fulfilment: o.fulfilment,
    deliver_at: o.deliver_at || null, deliver_time: o.deliver_time || null,
    total: o.total, subtotal: o.subtotal, delivery_fee: o.delivery_fee, discount: o.discount || 0,
    customer_name: o.customer_name || '', phone: includeContact ? o.phone : maskPhone(o.phone),
    ...(includeContact ? { address: o.address || '', unit_no: o.unit_no || '' } : {}),
    note: o.note || '', items: items.map(i => ({ sku: i && i.sku, name: i && i.name, qty: Number(i && i.qty) || 0, unit_price: i && (i.unit_price ?? i.price) })),
  };
}
const sgtDate = (d = new Date()) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const sgtLocal = d => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ───────────────────────────────────────────────────────────── tools
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const rw = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'get_store_overview', title: 'Store overview', scope: 'menu:read', annotations: ro,
    description: 'Start here. Returns the store name, whether it is accepting orders, menu categories, product counts, the live release and the current draft revision.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(t) {
      const [rows, status, products] = await Promise.all([
        t.env.DB.prepare("SELECT k,v FROM app_settings WHERE k IN ('brand_name_cn','brand_name_en','store_open')").all(),
        t.expectOk('GET', '/api/admin/publication/status'), t.expectOk('GET', '/api/admin/products')]);
      const raw = Object.fromEntries((rows.results || []).map(r => [r.k, r.v]));
      const list = products.products || [];
      return {
        store: { name_cn: raw.brand_name_cn || '', name_en: raw.brand_name_en || '', accepting_orders: raw.store_open !== '0',
          domain: new URL(t.req.url).host },
        categories: products.categories || [],
        products: { total: list.length, on_sale_in_draft: list.filter(p => p.active).length },
        publication: { live_release_id: status.active_release_id, draft_revision: status.draft_revision,
          scheduled: (status.releases || []).filter(r => r.status === 'scheduled').map(r => ({ id: r.id, effective_at: r.effective_at })) },
        your_scopes: [...t.key.scopes],
        next_steps: 'Edit the draft with upsert_product / bulk_upsert_products, check with preview_menu, then publish_menu with the returned checksum.',
      };
    },
  },
  {
    name: 'list_categories', title: 'List menu categories', scope: 'menu:read', annotations: ro,
    description: 'Menu categories (key, Chinese label, English label) and how many draft products use each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(t) {
      const data = await t.expectOk('GET', '/api/admin/products');
      const counts = {};
      for (const p of data.products || []) counts[p.category] = (counts[p.category] || 0) + 1;
      return { categories: (data.categories || []).map(c => ({ ...c, products: counts[c.key] || 0 })), draft_revision: data.draft_revision };
    },
  },
  {
    name: 'set_categories', title: 'Replace menu categories', scope: 'menu:write', annotations: rw,
    description: 'Replace the whole category list (order = display order). A category still used by a product cannot be removed; move those products first. Takes effect for customers after publish_menu.',
    inputSchema: { type: 'object', required: ['categories'], additionalProperties: false, properties: {
      categories: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', required: ['key'], properties: {
        key: { type: 'string', maxLength: 24, description: 'lowercase id, e.g. "noodles"' }, cn: { type: 'string', maxLength: 40 }, en: { type: 'string', maxLength: 60 } } } },
      base_revision: { type: 'string', description: 'Optional draft revision for strict compare-and-swap' } } },
    async run(t, a) {
      return t.expectOk('POST', '/api/admin/menu-categories', { categories: a.categories, base_revision: a.base_revision || await t.draftRevision() });
    },
  },
  {
    name: 'list_products', title: 'List products', scope: 'menu:read', annotations: ro,
    description: 'All draft products (including ones not on sale) with price in SGD, category, components and image status. The draft is what the next publish will show.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      category: { type: 'string', maxLength: 24, description: 'Only this category' },
      only_on_sale: { type: 'boolean', description: 'Only products marked active' } } },
    async run(t, a) {
      const data = await t.expectOk('GET', '/api/admin/products');
      let list = (data.products || []).map(publicProduct);
      if (a.category) list = list.filter(p => p.category === a.category);
      if (a.only_on_sale) list = list.filter(p => p.active);
      return { draft_revision: data.draft_revision, count: list.length, products: list };
    },
  },
  {
    name: 'upsert_product', title: 'Create or update a product', scope: 'menu:write', annotations: rw,
    description: 'Create a product, or update only the fields you pass on an existing one (matched by sku). Changes go to the draft. New products need name, price and category.',
    inputSchema: { ...productSchema, properties: { ...productSchema.properties, base_revision: { type: 'string', description: 'Optional draft revision for strict compare-and-swap; omitted = use the current draft' } } },
    async run(t, a) {
      const body = productBody(a);
      body.base_revision = a.base_revision || await t.draftRevision();
      const saved = await t.expectOk('POST', '/api/admin/product-save', body);
      let image = null;
      if (a.image_url) {
        const dataurl = await imageDataUrl({ image_url: a.image_url });
        await t.expectOk('POST', '/api/admin/product-image', { sku: saved.sku, dataurl, base_revision: await t.draftRevision() });
        image = 'uploaded';
      }
      return { sku: saved.sku, created: !!saved.created, image, draft_revision: await t.draftRevision() };
    },
  },
  {
    name: 'bulk_upsert_products', title: 'Create or update many products', scope: 'menu:write', annotations: rw,
    description: `Create/update up to ${MAX_BULK} products in one call, e.g. a whole menu read from a photo or PDF. Processed in order: put single items before the sets whose components reference them. Each item has the same fields as upsert_product. Returns a result per sku; failed items do not stop the rest unless stop_on_error is true.`,
    inputSchema: { type: 'object', required: ['products'], additionalProperties: false, properties: {
      products: { type: 'array', minItems: 1, maxItems: MAX_BULK, items: productSchema },
      stop_on_error: { type: 'boolean' } } },
    async run(t, a) {
      const results = [];
      for (const item of a.products) {
        const sku = String(item.sku || '').trim().toUpperCase();
        try {
          const body = productBody(item);
          body.base_revision = await t.draftRevision();
          const saved = await t.expectOk('POST', '/api/admin/product-save', body);
          let image = null;
          if (item.image_url) {
            try {
              const dataurl = await imageDataUrl({ image_url: item.image_url });
              await t.expectOk('POST', '/api/admin/product-image', { sku: saved.sku, dataurl, base_revision: await t.draftRevision() });
              image = 'uploaded';
            } catch (e) { image = `failed: ${e.message}`; }
          }
          results.push({ sku: saved.sku, ok: true, created: !!saved.created, ...(image ? { image } : {}) });
        } catch (e) {
          results.push({ sku, ok: false, error: e.message, ...(e.details ? { details: e.details } : {}) });
          if (a.stop_on_error) break;
        }
      }
      return { saved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results,
        draft_revision: await t.draftRevision() };
    },
  },
  {
    name: 'set_product_availability', title: 'Put a product on or off sale', scope: 'menu:write', annotations: rw,
    description: 'Mark a product on sale (active=true) or off sale in the draft. Customers see it after publish_menu.',
    inputSchema: { type: 'object', required: ['sku', 'active'], additionalProperties: false, properties: {
      sku: { type: 'string', maxLength: 16 }, active: { type: 'boolean' } } },
    async run(t, a) {
      const sku = String(a.sku).trim().toUpperCase();
      if (!await t.productExists(sku)) throw new ToolError(`No product with sku ${sku}`, { status: 404, code: 'not_found' });
      const r = await t.expectOk('POST', '/api/admin/product-toggle', { sku, active: a.active ? 1 : 0, base_revision: await t.draftRevision() });
      return { sku, active: !!r.active, draft_revision: r.draft_revision };
    },
  },
  {
    name: 'set_product_image', title: 'Set a product photo', scope: 'menu:write', annotations: rw,
    description: `Set the product image from an https image URL or base64 data (PNG, JPEG or WebP, ≤ ${MAX_IMAGE_BYTES / 1024} KB).`,
    inputSchema: { type: 'object', required: ['sku'], additionalProperties: false, properties: {
      sku: { type: 'string', maxLength: 16 }, image_url: { type: 'string', maxLength: 2000 },
      image_base64: { type: 'string', maxLength: 900000, description: 'Raw base64 or a data:image/...;base64, URL' } } },
    async run(t, a) {
      const sku = String(a.sku).trim().toUpperCase();
      if (!a.image_url && !a.image_base64) throw new ToolError('Pass image_url or image_base64', { code: 'invalid_image' });
      if (!await t.productExists(sku)) throw new ToolError(`No product with sku ${sku}`, { status: 404, code: 'not_found' });
      const dataurl = await imageDataUrl(a);
      const r = await t.expectOk('POST', '/api/admin/product-image', { sku, dataurl, base_revision: await t.draftRevision() });
      return { sku, image: 'uploaded', bytes: Math.round((dataurl.length - dataurl.indexOf(',') - 1) * 3 / 4), draft_revision: r.draft_revision };
    },
  },
  {
    name: 'reorder_products', title: 'Reorder the menu', scope: 'menu:write', annotations: rw,
    description: 'Set the display order: pass skus in the order they should appear (positions 1..N). Products not listed keep their current position number.',
    inputSchema: { type: 'object', required: ['order'], additionalProperties: false, properties: {
      order: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 16 } } } },
    async run(t, a) {
      const order = a.order.map(s => String(s).trim().toUpperCase());
      return t.expectOk('POST', '/api/admin/product-sort', { order, base_revision: await t.draftRevision() });
    },
  },
  {
    name: 'preview_menu', title: 'Preview the draft menu', scope: 'menu:read', annotations: ro,
    description: 'Compare the draft with the live menu and get a 10-minute preview link. Returns draft_checksum and live_release_id, which publish_menu requires. To schedule a release, pass the same effective_at_sgt here and to publish_menu (date-limited posters depend on it). Show the changes to the owner before publishing when in doubt.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      effective_at_sgt: { type: 'string', maxLength: 16, description: 'Optional YYYY-MM-DDTHH:MM (Singapore time) the release will take effect' } } },
    async run(t, a) {
      let contentAt;
      if (a.effective_at_sgt) {
        const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.effective_at_sgt) ? new Date(`${a.effective_at_sgt}:00+08:00`) : null;
        if (!when || !Number.isFinite(when.getTime()) || sgtLocal(when) !== a.effective_at_sgt) throw new ToolError('effective_at_sgt must be a real time, YYYY-MM-DDTHH:MM (Singapore)', { code: 'invalid_time' });
        contentAt = when.toISOString();
      }
      const snap = await t.expectOk('GET', '/api/admin/publication/draft-snapshot' + (a.effective_at_sgt ? `?effective_at_sgt=${encodeURIComponent(a.effective_at_sgt)}` : ''));
      const diff = snapshotDiff(snap.active && snap.active.snapshot, snap.draft && snap.draft.snapshot);
      let preview = null;
      try {
        const p = await t.expectOk('POST', '/api/admin/publication/preview', { base_revision: snap.draft_revision, ...(contentAt ? { content_at: contentAt } : {}) });
        preview = { url: t.origin + p.preview_url, expires_at: p.expires_at };
      } catch (e) { preview = { error: e.message }; }
      return {
        draft_checksum: snap.draft.checksum, live_release_id: snap.active ? snap.active.release_id : null,
        ...(a.effective_at_sgt ? { effective_at_sgt: a.effective_at_sgt } : {}),
        draft_revision: snap.draft_revision, scheduled_release_ids: snap.scheduled_release_ids || [],
        ...diff, preview,
        note: snap.active ? undefined : 'No live release yet: the first release is created automatically by the scheduled job within about a minute of deployment. Call preview_menu again after that.',
      };
    },
  },
  {
    name: 'publish_menu', title: 'Publish the previewed draft', scope: 'menu:publish',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Publish exactly the draft you previewed: pass draft_checksum and live_release_id from preview_menu. If anything changed since the preview, nothing is published and you must preview again. Optional effective_at_sgt (YYYY-MM-DDTHH:MM, Singapore time) schedules the release instead; preview with the same effective_at_sgt first.',
    inputSchema: { type: 'object', required: ['draft_checksum', 'live_release_id'], additionalProperties: false, properties: {
      draft_checksum: { type: 'string', maxLength: 128 }, live_release_id: { type: ['string', 'null'], maxLength: 128 },
      effective_at_sgt: { type: 'string', maxLength: 16, description: 'Optional, e.g. 2026-12-01T09:00' } } },
    async run(t, a) {
      if (!a.live_release_id) throw new ToolError('There is no live release yet; wait for the first automatic release, then preview again', { status: 409, code: 'bootstrap_pending' });
      const body = { expected_active_release_id: a.live_release_id, expected_draft_checksum: a.draft_checksum };
      if (a.effective_at_sgt) {
        const r = await t.expectOk('POST', '/api/admin/publication/schedule', { ...body, base_revision: await t.draftRevision(), effective_at_sgt: a.effective_at_sgt });
        return { scheduled: true, release_id: r.release_id, effective_at: r.effective_at };
      }
      const r = await t.expectOk('POST', '/api/admin/publication/publish-exact', body);
      return { published: true, release_id: r.release_id, published_at: r.published_at, menu_url: t.origin + '/menu' };
    },
  },
  {
    name: 'list_orders', title: 'List orders', scope: 'orders:read', annotations: ro,
    description: 'Recent orders, newest first (or by fulfilment time). Phone numbers are masked unless include_contact is true.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      pay_status: { type: 'string', enum: ['PAID', 'UNPAID', 'CANCELLED', 'REFUNDED'] },
      source: { type: 'string', enum: ['online', 'offline'] },
      sort: { type: 'string', enum: ['recent', 'fulfilment'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      include_contact: { type: 'boolean', description: 'Include full phone and delivery address' } } },
    async run(t, a) {
      const q = new URLSearchParams();
      if (a.pay_status) q.set('status', a.pay_status);
      if (a.source) q.set('source', a.source);
      if (a.sort === 'fulfilment') q.set('sort', 'fulfilment');
      const data = await t.expectOk('GET', '/api/admin/orders' + (q.toString() ? '?' + q : ''));
      const list = (data.orders || []).slice(0, a.limit || 30).map(o => orderView(o, !!a.include_contact));
      return { count: list.length, orders: list };
    },
  },
  {
    name: 'get_kitchen_board', title: 'Kitchen board', scope: 'orders:read', annotations: ro,
    description: "Today's paid orders that are not done yet, with set components expanded, in kitchen priority order.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(t) { return t.expectOk('GET', '/api/kitchen/board'); },
  },
  {
    name: 'advance_order', title: 'Advance an order in the kitchen', scope: 'orders:write', annotations: rw,
    description: 'Move a paid order to the next kitchen status (new → preparing → ready → done), or to a specific later status with "to".',
    inputSchema: { type: 'object', required: ['order_id'], additionalProperties: false, properties: {
      order_id: { type: 'string', maxLength: 64 }, to: { type: 'string', enum: ['preparing', 'ready', 'done'] } } },
    async run(t, a) {
      let to = a.to;
      if (!to) {
        const row = await t.env.DB.prepare('SELECT fulfil_status FROM orders WHERE id=?').bind(a.order_id).first();
        if (!row) throw new ToolError(`No order with id ${a.order_id}`, { status: 404, code: 'not_found' });
        const flow = ['new', 'preparing', 'ready', 'done'];
        const at = Math.max(0, flow.indexOf(row.fulfil_status || 'new'));
        if (at >= flow.length - 1) return { ok: true, noop: true, status: 'done', message: 'Order is already done' };
        to = flow[at + 1];
      }
      return t.expectOk('POST', '/api/kitchen/board/advance', { order_id: a.order_id, to });
    },
  },
  {
    name: 'set_store_open', title: 'Open or close the store', scope: 'store:write', annotations: rw,
    description: 'Pause (open=false) or resume (open=true) new online orders immediately. This is not part of the menu draft.',
    inputSchema: { type: 'object', required: ['open'], additionalProperties: false, properties: { open: { type: 'boolean' } } },
    async run(t, a) { return t.expectOk('POST', '/api/admin/store-toggle', { open: !!a.open }); },
  },
  {
    name: 'get_sales_summary', title: 'Sales summary', scope: 'reports:read', annotations: ro,
    description: 'Paid orders, revenue (SGD), GST, service charge and top items for a Singapore-time date range (default: today).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      from: { type: 'string', maxLength: 10, description: 'YYYY-MM-DD (SGT), default today' },
      to: { type: 'string', maxLength: 10, description: 'YYYY-MM-DD (SGT), default = from' } } },
    async run(t, a) {
      const from = a.from || sgtDate(), to = a.to || from;
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new ToolError('from/to must be YYYY-MM-DD and from ≤ to', { code: 'invalid_range' });
      const { results } = await t.env.DB.prepare(
        `SELECT source,total,gst,service_charge,items_json FROM orders
          WHERE pay_status='PAID' AND substr(datetime(created_at,'+8 hours'),1,10) BETWEEN ? AND ?`).bind(from, to).all();
      const rows = results || [];
      const money = n => Math.round(n * 100) / 100;
      const items = new Map(); const bySource = {};
      for (const o of rows) {
        const src = o.source || 'online';
        bySource[src] = bySource[src] || { orders: 0, revenue: 0 };
        bySource[src].orders++; bySource[src].revenue = money(bySource[src].revenue + (Number(o.total) || 0));
        let list = []; try { list = JSON.parse(o.items_json || '[]'); } catch {}
        for (const i of list) {
          const k = String(i && i.sku || '?'); const row = items.get(k) || { sku: k, name: i && i.name, qty: 0 };
          row.qty += Number(i && i.qty) || 0; items.set(k, row);
        }
      }
      return {
        from, to, timezone: 'Asia/Singapore', paid_orders: rows.length,
        revenue: money(rows.reduce((s, o) => s + (Number(o.total) || 0), 0)),
        gst: money(rows.reduce((s, o) => s + (Number(o.gst) || 0), 0)),
        service_charge: money(rows.reduce((s, o) => s + (Number(o.service_charge) || 0), 0)),
        by_source: bySource, top_items: [...items.values()].sort((x, y) => y.qty - x.qty).slice(0, 10),
      };
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

function describeTool(tool) {
  return { name: tool.name, title: tool.title, description: `${tool.description} [scope: ${tool.scope}]`,
    inputSchema: tool.inputSchema, annotations: { title: tool.title, ...tool.annotations } };
}

function auditSummary(args, result, error) {
  // URLs are reduced to scheme + host: paths and query strings of signed links can carry credentials.
  const hostOnly = v => { try { const u = new URL(String(v).trim()); return `${u.protocol}//${u.host}/…`; } catch { return '[url]'; } };
  const looksLikeUrl = v => /^\s*[a-z][a-z0-9+.-]*:/i.test(v) && /\/\/|^\s*data:/i.test(v);
  const strip = (v, key = '') => {
    if (key === 'image_base64') return '[image data]';
    if (typeof v === 'string') {
      if (key === 'image_url' || looksLikeUrl(v)) return /^\s*data:/i.test(v) ? '[data url]' : hostOnly(v);
      return v.length > 120 ? v.slice(0, 117) + '…' : v;
    }
    if (Array.isArray(v)) return v.length > 12 ? [...v.slice(0, 12).map(x => strip(x)), `…+${v.length - 12}`] : v.map(x => strip(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x, k)]));
    return v;
  };
  const out = { args: strip(args || {}) };
  if (error) out.error = error;
  else if (result && typeof result === 'object') {
    for (const k of ['sku', 'created', 'saved', 'failed', 'release_id', 'published', 'scheduled', 'status', 'count', 'store_open', 'draft_checksum'])
      if (result[k] !== undefined) (out.result ||= {})[k] = result[k];
  }
  return JSON.stringify(out).slice(0, 800);
}

// Reserves one call in this minute's bucket with a single atomic UPSERT, so concurrent calls cannot all pass.
async function rateLimited(env, key) {
  const bucket = Math.floor(Date.now() / 60000);
  const [row] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO agent_rate (key_id,bucket,count) VALUES (?,?,1)
      ON CONFLICT(key_id,bucket) DO UPDATE SET count=count+1 RETURNING count`).bind(key.id, bucket),
    env.DB.prepare('DELETE FROM agent_rate WHERE key_id=? AND bucket<?').bind(key.id, bucket - 2),
  ]);
  const count = (row && row.results && row.results[0] && row.results[0].count) || 1;
  return count > RATE_LIMIT_PER_MINUTE;
}

// Runs one tool for an authenticated key. Returns {ok, status, result | error, code, details}.
export async function runTool({ req, env, ctx, dispatch, key, channel, name, args }) {
  const tool = TOOL_BY_NAME.get(name);
  const record = async (ok, status, summary) => {
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO agent_audit (key_id,key_name,channel,tool,ok,status,summary,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(key.id, key.name, channel, name || '?', ok ? 1 : 0, status, summary, nowIso()),
        env.DB.prepare('UPDATE agent_keys SET last_used_at=? WHERE id=?').bind(nowIso(), key.id),
      ]);
    } catch (e) { console.error('agent audit write failed', e); }
  };
  if (!tool) { await record(false, 404, auditSummary(args, null, 'unknown tool')); return { ok: false, status: 404, error: `Unknown tool: ${name}`, code: 'unknown_tool' }; }
  if (!key.scopes.has(tool.scope)) {
    await record(false, 403, auditSummary(args, null, `missing scope ${tool.scope}`));
    return { ok: false, status: 403, error: `This key lacks the ${tool.scope} scope required by ${name}`, code: 'insufficient_scope' };
  }
  if (await rateLimited(env, key)) return { ok: false, status: 429, error: `Rate limit: ${RATE_LIMIT_PER_MINUTE} calls per minute per key`, code: 'rate_limited' };
  const problems = checkArgs(tool.inputSchema, args);
  if (problems.length) {
    await record(false, 400, auditSummary(args, null, problems.join('; ')));
    return { ok: false, status: 400, error: `Invalid arguments: ${problems.join('; ')}`, code: 'invalid_arguments' };
  }
  try {
    const kit = toolkit({ req, env, ctx, dispatch, key });
    if (tool.scope === 'menu:write') await kit.requireLiveRelease();
    const result = await tool.run(kit, args || {});
    await record(true, 200, auditSummary(args, result));
    return { ok: true, status: 200, result };
  } catch (e) {
    const status = e instanceof ToolError ? e.status : 500;
    const message = e instanceof ToolError ? e.message : 'Internal error while running the tool';
    if (!(e instanceof ToolError)) console.error('agent tool failed', name, e && e.stack || e);
    await record(false, status, auditSummary(args, null, message));
    return { ok: false, status, error: message, code: e instanceof ToolError ? e.code : 'internal_error', ...(e.details ? { details: e.details } : {}) };
  }
}

// ───────────────────────────────────────────────────────────── MCP (Streamable HTTP, JSON responses)
const MCP_INSTRUCTIONS = `You are operating a restaurant's Hawkerline store (online ordering, kitchen, menu, POS).
Menu edits change a DRAFT; customers only see them after publish_menu.
Workflow: get_store_overview → (set_categories) → upsert_product / bulk_upsert_products → preview_menu → confirm the changes with the owner if they are large → publish_menu with draft_checksum and live_release_id from preview_menu.
Prices are SGD. SKUs are 2–16 characters A–Z 0–9 _ -. In bulk imports, list single items before sets that reference them as components.
Never invent prices or items the owner did not give you.`;

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }; }

function unauthorized(req) {
  const origin = new URL(req.url).origin;
  return json({ error: 'Missing or invalid agent key. Create one in /admin → AI agents and send it as "Authorization: Bearer hlk_…".' }, 401,
    { 'www-authenticate': `Bearer realm="${origin}", error="invalid_token"` });
}

export async function handleMcp(req, env, ctx, dispatch) {
  if (req.method !== 'POST') return json({ error: 'Use POST with JSON-RPC messages (Streamable HTTP, JSON responses).' }, 405, { allow: 'POST' });
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return json(rpcError(null, -32600, 'Cross-origin MCP requests are not allowed'), 403);
  const version = req.headers.get('mcp-protocol-version');
  if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version}. Supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}`), 400);
  }
  const key = await authenticateAgent(req, env);
  if (!key) return unauthorized(req);
  let body;
  try { body = await req.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
  // JSON-RPC 2.0 as used by MCP: a request (method + string/integer id), a notification (method, no id) or a
  // response (string/integer id + exactly one of result/error). params, when present, must be an object.
  const validId = id => typeof id === 'string' || Number.isInteger(id);
  const isMessage = m => {
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0') return false;
    if (typeof m.method === 'string') {
      if (m.params !== undefined && (m.params === null || typeof m.params !== 'object' || Array.isArray(m.params))) return false;
      return m.id === undefined || validId(m.id);
    }
    const hasResult = m.result !== undefined, hasError = m.error !== undefined;
    if (!validId(m.id) || hasResult === hasError) return false;
    return !hasError || (m.error && typeof m.error === 'object' && Number.isInteger(m.error.code) && typeof m.error.message === 'string');
  };
  if (Array.isArray(body) ? (!body.length || body.length > 20 || !body.every(isMessage)) : !isMessage(body)) {
    return json(rpcError(null, -32600, 'Invalid request: expected a JSON-RPC 2.0 message (batches: 1–20 messages)'), 400);
  }
  const handle = async msg => {
    const isRequest = typeof msg.method === 'string' && msg.id !== undefined;
    if (!isRequest) return null;                       // notifications and client responses need no reply
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize': {
        const asked = String(p.protocolVersion || '');
        return rpcResult(msg.id, {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hawkerline', title: 'Hawkerline store', version: AGENT_API_VERSION },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case 'ping': return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: TOOLS.filter(tool => key.scopes.has(tool.scope)).map(describeTool) });
      case 'tools/call': {
        if (!TOOL_BY_NAME.has(p.name)) return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
        const out = await runTool({ req, env, ctx, dispatch, key, channel: 'mcp', name: p.name, args: p.arguments || {} });
        if (out.ok) return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(out.result, null, 1) }], structuredContent: out.result, isError: false });
        const detail = { error: out.error, code: out.code, ...(out.details ? { details: out.details } : {}) };
        return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(detail) }], isError: true });
      }
      default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };
  if (Array.isArray(body)) {
    const out = [];
    for (const msg of body) { const r = await handle(msg); if (r) out.push(r); }   // sequential: shares the per-key rate limit
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(body);
  return out ? json(out) : new Response(null, { status: 202 });
}

// ───────────────────────────────────────────────────────────── REST + OpenAPI
export function openApiDocument(origin) {
  const paths = {};
  for (const tool of TOOLS) {
    paths[`/api/agent/v1/tools/${tool.name}`] = { post: {
      operationId: tool.name, summary: tool.title, description: `${tool.description}\n\nRequired scope: \`${tool.scope}\`.`,
      tags: [tool.scope.split(':')[0]], security: [{ agentKey: [tool.scope] }],
      requestBody: { required: true, content: { 'application/json': { schema: tool.inputSchema } } },
      responses: {
        200: { description: 'Tool result', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, result: { type: 'object' } } } } } },
        400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' },
        403: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' },
        409: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' },
      },
    } };
  }
  paths['/api/agent/v1/tools'] = { get: { operationId: 'list_tools', summary: 'Tools available to this key', security: [{ agentKey: [] }],
    responses: { 200: { description: 'Tool list' }, 401: { $ref: '#/components/responses/Error' } } } };
  return {
    openapi: '3.1.0',
    info: { title: 'Hawkerline Agent API', version: AGENT_API_VERSION,
      description: 'Operate this restaurant store from an AI agent: menu, publishing, orders, kitchen and store status. The same tools are available over MCP at /mcp. Menu edits change a draft; customers see them only after publish_menu with the checksum from preview_menu.' },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { agentKey: { type: 'http', scheme: 'bearer', description: 'Agent key (hlk_…) created by the owner in /admin → AI agents' } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: {
        ok: { const: false }, error: { type: 'string' }, code: { type: 'string' }, details: { type: 'object' } } } } } } },
    },
    paths,
  };
}

export async function handleAgentRest(req, env, ctx, dispatch) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/agent/v1/openapi.json' && req.method === 'GET') return json(openApiDocument(url.origin));
  if (path === '/api/agent/v1' && req.method === 'GET') {
    return json({ name: 'Hawkerline Agent API', version: AGENT_API_VERSION, mcp: `${url.origin}/mcp`,
      openapi: `${url.origin}/api/agent/v1/openapi.json`, llms_txt: `${url.origin}/llms.txt`, scopes: AGENT_SCOPES });
  }
  const key = await authenticateAgent(req, env);
  if (!key) return unauthorized(req);
  if (path === '/api/agent/v1/tools' && req.method === 'GET') {
    return json({ tools: TOOLS.filter(tool => key.scopes.has(tool.scope)).map(describeTool), scopes: [...key.scopes] });
  }
  const m = /^\/api\/agent\/v1\/tools\/([a-z_]+)$/.exec(path);
  if (m && req.method === 'POST') {
    let args = {};
    const text = await req.text();
    if (text.trim()) { try { args = JSON.parse(text); } catch { return json({ ok: false, error: 'Body must be JSON', code: 'invalid_json' }, 400); } }
    const out = await runTool({ req, env, ctx, dispatch, key, channel: 'rest', name: m[1], args });
    return out.ok ? json({ ok: true, result: out.result })
      : json({ ok: false, error: out.error, code: out.code, ...(out.details ? { details: out.details } : {}) }, out.status);
  }
  return json({ ok: false, error: 'Not found', code: 'not_found' }, 404);
}

// ───────────────────────────────────────────────────────────── llms.txt
export async function renderLlmsTxt(req, env) {
  const origin = new URL(req.url).origin;
  let name = '';
  try {
    const rows = await env.DB.prepare("SELECT k,v FROM app_settings WHERE k IN ('brand_name_cn','brand_name_en')").all();
    const s = Object.fromEntries((rows.results || []).map(r => [r.k, r.v]));
    name = [s.brand_name_en, s.brand_name_cn].filter(Boolean).join(' / ');
  } catch {}
  const title = name || new URL(req.url).host;
  const tools = TOOLS.map(t => `- \`${t.name}\` (${t.scope}): ${t.description.split('. ')[0].replace(/\.$/, '')}.`).join('\n');
  return `# ${title}

> ${title} takes food orders online at ${origin}. The store runs on Hawkerline, a restaurant ordering, kitchen display, menu and POS system that an AI agent can operate. This file tells AI agents how to read the menu and, with a key issued by the owner, how to run the store.

## Menu (public, no key needed)

- [Menu page](${origin}/menu): server-rendered HTML with every item on sale.
- [Machine-readable menu](${origin}/public/catalog.json): products with \`price_cents\` (SGD), \`category\`, components of sets, tags, pickup points and the category list in \`settings.menu_categories\`.

## Operating the store (agent key required)

The owner creates scoped agent keys in ${origin}/admin → AI agents. Send the key as \`Authorization: Bearer hlk_…\`.

- MCP endpoint: \`${origin}/mcp\` (Streamable HTTP, JSON-RPC over POST).
- REST: \`POST ${origin}/api/agent/v1/tools/<tool>\` with a JSON body.
- [OpenAPI 3.1 description](${origin}/api/agent/v1/openapi.json)

Rules: menu edits change a draft. Customers see them only after \`publish_menu\`, which needs the \`draft_checksum\` and \`live_release_id\` returned by \`preview_menu\`. Every call is logged for the owner.

## Tools

${tools}
`;
}
