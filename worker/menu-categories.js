// Menu categories are owner-configurable: app_settings.menu_categories = JSON [{key, cn, en}].
// The list is published with the menu release, so the storefront, POS, admin and agents all read one source.
// `drink` keeps one special meaning: a set's "any drink" component (DRINK) offers the on-sale items of category `drink`.

export const DEFAULT_MENU_CATEGORIES = Object.freeze([
  { key: 'set', cn: '套餐', en: 'Set Meals' },
  { key: 'main', cn: '主食', en: 'Mains' },
  { key: 'side', cn: '小食', en: 'Sides' },
  { key: 'dessert', cn: '甜品', en: 'Desserts' },
  { key: 'drink', cn: '饮品', en: 'Drinks' },
]);

export const MAX_MENU_CATEGORIES = 30;
const KEY_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const clean = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

export class MenuCategoryError extends Error {
  constructor(message) { super(message); this.name = 'MenuCategoryError'; }
}

// Strict: used when an owner or agent saves the list. Throws MenuCategoryError with a readable message.
export function validateMenuCategories(input) {
  let list = input;
  if (typeof input === 'string') {
    try { list = JSON.parse(input); } catch { throw new MenuCategoryError('分类必须是 JSON 数组 · categories must be a JSON array'); }
  }
  if (!Array.isArray(list) || !list.length) throw new MenuCategoryError('至少需要一个分类 · at least one category is required');
  if (list.length > MAX_MENU_CATEGORIES) throw new MenuCategoryError(`最多 ${MAX_MENU_CATEGORIES} 个分类 · at most ${MAX_MENU_CATEGORIES} categories`);
  const seen = new Set();
  return list.map((item, index) => {
    const key = clean(item && item.key, 24).toLowerCase();
    if (!KEY_RE.test(key)) throw new MenuCategoryError(`第 ${index + 1} 个分类的 key 无效（小写字母开头，可含数字 _ -，最长 24）· invalid key "${key}"`);
    if (seen.has(key)) throw new MenuCategoryError(`分类 key 重复：${key} · duplicate key`);
    seen.add(key);
    const cn = clean(item.cn ?? item.name_cn, 40);
    const en = clean(item.en ?? item.name_en, 60);
    if (!cn && !en) throw new MenuCategoryError(`分类 ${key} 需要中文或英文名称 · needs a cn or en label`);
    return { key, cn: cn || en, en: en || cn };
  });
}

// Lenient: used when reading stored settings. A missing or broken value falls back to the defaults.
export function parseMenuCategories(raw) {
  if (raw == null || raw === '') return DEFAULT_MENU_CATEGORIES.map(c => ({ ...c }));
  try { return validateMenuCategories(raw); } catch { return DEFAULT_MENU_CATEGORIES.map(c => ({ ...c })); }
}

export async function loadMenuCategories(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='menu_categories'").first();
    return parseMenuCategories(row && row.v);
  } catch { return parseMenuCategories(null); }
}
