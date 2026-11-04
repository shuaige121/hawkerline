// 套餐 / 单人餐 / N 粒装的「组成」——顾客菜单和厨房出餐共用的唯一来源。
//
// 存储：products.components = canonical JSON 数组 [{"sku":"S01","qty":1}, …]，空串 = 单品不展开。
// 发布：每个商品都带 components（单品为 []），并带上成分当时的名称、分类和据此生成的「含：…」文字。
// 下单：订单行记下下单那一刻的组成（单品为 []）；厨房看板、小票、Telegram、备货单都按订单行展开。
//       订单行没有 components 字段时按单品出餐，不展开。
// DRINK = 「任选饮品」：发布时把在售的 drink 分类商品列为可选项。
// 组成只能是一层：被别的商品当作组成的商品不能再有组成，有组成的商品也不能被当作组成。

export const DRINK_CHOICE = 'DRINK';
const SKU_RE = /^[A-Z0-9_-]{2,16}$/;
const MAX_PARTS = 20;
const MAX_QTY = 99;

export class ComponentsError extends Error {
  constructor(message) { super(message); this.name = 'ComponentsError'; }
}

const isQty = q => Number.isInteger(q) && q >= 1 && q <= MAX_QTY;

// 后台提交 → 规范化的 [{sku,qty}]。drafts：当前草稿全部商品 [{sku, components(存储串)}]。
export function normalizeComponentsInput(raw, { selfSku, drafts }) {
  if (raw == null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { throw new ComponentsError('组成格式无效'); }
  }
  if (!Array.isArray(list)) throw new ComponentsError('组成必须是列表');
  if (list.length > MAX_PARTS) throw new ComponentsError(`组成最多 ${MAX_PARTS} 项`);
  const self = String(selfSku || '').trim().toUpperCase();
  const bySku = new Map((drafts || []).map(p => [String(p.sku), p]));
  const seen = new Set(), out = [];
  for (const part of list) {
    const sku = String(part?.sku ?? '').trim().toUpperCase();
    const qty = part?.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw new ComponentsError(`组成数量必须是 0–${MAX_QTY} 的整数：${sku || '（空）'}`);
    if (qty === 0) continue;
    if (!SKU_RE.test(sku)) throw new ComponentsError(`组成里的商品编号无效：${sku || '（空）'}`);
    if (sku === self) throw new ComponentsError('套餐不能包含自己');
    if (seen.has(sku)) throw new ComponentsError(`组成里重复：${sku}`);
    seen.add(sku);
    if (sku !== DRINK_CHOICE) {
      const target = bySku.get(sku);
      if (!target) throw new ComponentsError(`组成里的商品不存在：${sku}`);
      if (parseComponentsStrict(target.components, sku).length) throw new ComponentsError(`${sku} 本身是套餐，不能再放进别的套餐`);
    }
    out.push({ sku, qty });
  }
  if (out.length) {
    const parents = (drafts || []).filter(p => String(p.sku) !== self && safeParse(p.components).some(c => c.sku === self));
    if (parents.length) throw new ComponentsError(`${self} 已是 ${parents.map(p => p.sku).join('、')} 的组成，不能再设组成`);
  }
  return out;
}

export const componentsToStored = list => (list.length ? JSON.stringify(list.map(({ sku, qty }) => ({ sku, qty }))) : '');

// 发布用：存储值必须完全合法，否则抛错阻断发布（不静默丢项）。
export function parseComponentsStrict(text, sku = '') {
  if (text == null || text === '') return [];
  let list;
  try { list = JSON.parse(text); } catch { throw new ComponentsError(`${sku} 组成数据损坏（不是合法 JSON）`); }
  if (!Array.isArray(list)) throw new ComponentsError(`${sku} 组成数据损坏（不是列表）`);
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p.sku !== 'string' || !SKU_RE.test(p.sku)) throw new ComponentsError(`${sku} 组成里有无效的商品编号`);
    if (typeof p.qty !== 'number' || !isQty(p.qty)) throw new ComponentsError(`${sku} 组成里 ${p.sku} 的数量无效`);
    if (seen.has(p.sku)) throw new ComponentsError(`${sku} 组成里重复：${p.sku}`);
    seen.add(p.sku);
  }
  return list.map(p => ({ sku: p.sku, qty: p.qty }));
}

function safeParse(text) { try { return parseComponentsStrict(text); } catch { return []; } }

// 后台列表展示用：坏数据显示为空，不让页面崩（发布时会被 parseComponentsStrict 拦下）。
export const parseStoredComponents = safeParse;

// 发布：把 [{sku,qty}] 解析成带名称、分类的快照组成。draftProducts 含已下架商品（套餐可以引用不单独售卖的单品）。
export function resolveSnapshotComponents(stored, draftProducts, sku = '') {
  const bySku = new Map((draftProducts || []).map(p => [String(p.sku), p]));
  const drinks = (draftProducts || []).filter(p => +p.active && p.category === 'drink')
    .sort((a, b) => (+a.sort || 0) - (+b.sort || 0) || String(a.sku).localeCompare(String(b.sku)))
    .map(p => ({ sku: String(p.sku), name_cn: String(p.name_cn || ''), name_en: String(p.name_en || '') }));
  return parseComponentsStrict(stored, sku).map(({ sku: part, qty }) => {
    if (part === DRINK_CHOICE) return { sku: part, qty, name_cn: '任选饮品', name_en: 'Drink of choice', category: 'drink', options: drinks };
    const p = bySku.get(part);
    return { sku: part, qty, name_cn: String(p?.name_cn || ''), name_en: String(p?.name_en || ''), category: String(p?.category || '') };
  });
}

// 商品名里写的粒数（如「6粒装」「(3粒装)」「(3pcs)」）必须等于组成里单品件数的合计（不含饮品）。
// 成分自身名称写了粒数的（如「饺子 (4粒装)」）按它计；没写的按 1 粒计。
export function namedPieces(name) {
  const m = /(\d+)\s*粒/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}
export function namedPiecesEn(name) {
  const m = /(\d+)\s*(?:pcs|pieces|pc)\b/i.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}
export function componentPieces(list) {
  return (list || []).filter(p => p.sku !== DRINK_CHOICE && p.category !== 'drink')
    .reduce((sum, p) => sum + p.qty * (namedPieces(p.name_cn) ?? 1), 0);
}

export function validateSnapshotComponents(product, bySku) {
  const list = product.components;
  if (list === undefined) return null;          // 本功能上线前的旧快照
  if (!Array.isArray(list)) return `${product.sku} 组成必须是列表`;
  const seen = new Set();
  for (const part of list) {
    if (!part || !SKU_RE.test(String(part.sku || ''))) return `${product.sku} 组成里的商品编号无效`;
    if (!isQty(part.qty)) return `${product.sku} 组成数量无效`;
    if (part.sku === product.sku) return `${product.sku} 不能包含自己`;
    if (seen.has(part.sku)) return `${product.sku} 组成重复：${part.sku}`;
    seen.add(part.sku);
    if (part.sku === DRINK_CHOICE) {
      // 没有在售饮品时 options 为空：照常发布，顾客和厨房只看到「任选饮品」，不阻断老板发布菜单。
      if (!Array.isArray(part.options)) return `${product.sku} 任选饮品格式无效`;
      continue;
    }
    const target = bySku.get(part.sku);
    if (!target) return `${product.sku} 组成里的商品不存在：${part.sku}`;
    if (Array.isArray(target.components) && target.components.length) return `${product.sku} 的组成 ${part.sku} 本身也是套餐（组成只能一层）`;
    if (!String(part.name_cn || '').trim()) return `${product.sku} 组成里的 ${part.sku} 缺少中文名`;
  }
  const total = componentPieces(list);
  const pieces = namedPieces(product.name_cn), piecesEn = namedPiecesEn(product.name_en);
  if (list.length && pieces != null && pieces !== total) return `${product.sku}「${product.name_cn}」名称写 ${pieces} 粒，组成合计 ${total} 粒`;
  if (list.length && piecesEn != null && piecesEn !== total) return `${product.sku}「${product.name_en}」英文名写 ${piecesEn} pcs，组成合计 ${total} 粒`;
  // 显示文字必须由组成生成，不能和组成各说各的。
  // 兼容：本功能第一版（2026-11-03 测试站）只有一种成分时不生成文字，那样的历史快照仍可回滚。
  const cn = product.contents_cn ?? '', en = product.contents_en ?? '';
  const firstFormat = list.length === 1 && cn === '' && en === '';
  if (!firstFormat && (cn !== componentsDisplayText(list, 'cn') || en !== componentsDisplayText(list, 'en'))) {
    return `${product.sku} 组成文字与组成不一致`;
  }
  return null;
}

// 顾客看到的组成文字：只要有组成就显示（包括只有一种的 N 粒装），让顾客看到的就是厨房要做的。
export function componentsDisplayText(list, lang = 'cn') {
  if (!Array.isArray(list) || !list.length) return '';
  const en = lang === 'en';
  return list.map(part => {
    const name = en ? (part.name_en || part.name_cn) : (part.name_cn || part.name_en);
    const options = Array.isArray(part.options) && part.options.length
      ? (en ? ` (${part.options.map(o => o.name_en || o.name_cn).join(' / ')})` : `（${part.options.map(o => o.name_cn || o.name_en).join(' / ')}）`)
      : '';
    return `${name}×${part.qty}${options}`;
  }).join(' · ');
}

// 订单行里记的组成：名称和分类在下单时固定，厨房不看草稿。
// 不是数组（旧发布没有组成数据）返回 undefined；空数组原样返回 []，表示「明确不展开」。
export function orderLineComponents(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map(part => ({
    sku: part.sku, qty: part.qty, name: part.name_cn || part.sku,
    ...(part.category ? { category: part.category } : {}),
    ...(Array.isArray(part.options) && part.options.length ? { options: part.options.map(o => o.name_cn || o.sku) } : {}),
  }));
}

// 厨房展开：订单行带组成（含空数组）就只按它；没有该字段返回 null，调用方按单品出餐。
export function kitchenLinesFromItem(item) {
  const list = item && Array.isArray(item.components) ? item.components : null;
  if (!list) return null;
  const n = Math.max(0, +item.qty || 0);
  if (!n) return [];
  return list.map(part => {
    const qty = Math.max(0, (+part.qty || 0) * n);
    const name = part.sku === DRINK_CHOICE
      ? `任选饮品${Array.isArray(part.options) && part.options.length ? `（${part.options.join(' / ')}）` : ''}`
      : String(part.name || part.sku);
    // 第一版订单的成分没有记分类：保持「未知」，备货单再去查，不能当成「不是饮品」
    return { sku: String(part.sku), name, qty, ...(typeof part.category === 'string' ? { category: part.category } : {}) };
  }).filter(line => line.qty > 0);
}
