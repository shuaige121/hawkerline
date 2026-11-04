// Menu categories are configurable (worker/menu-categories.js). No surface may keep its own hard-coded
// category table: a missing key would silently hide products from customers or staff.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_MENU_CATEGORIES, MenuCategoryError, parseMenuCategories, validateMenuCategories } from '../worker/menu-categories.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('defaults are generic and include drink (the DRINK choice draws from it)', () => {
  assert.deepEqual(DEFAULT_MENU_CATEGORIES.map(c => c.key), ['set', 'main', 'side', 'dessert', 'drink']);
  assert.deepEqual(parseMenuCategories(''), DEFAULT_MENU_CATEGORIES);
  assert.deepEqual(parseMenuCategories('not json'), DEFAULT_MENU_CATEGORIES, 'a broken stored value falls back');
});

test('validation normalises labels and rejects bad keys, duplicates and empty lists', () => {
  assert.deepEqual(validateMenuCategories([{ key: 'Noodles', en: 'Noodles' }]), [{ key: 'noodles', cn: 'Noodles', en: 'Noodles' }]);
  for (const bad of [[], [{ key: '1x', cn: 'a' }], [{ key: 'a', cn: 'x' }, { key: 'a', cn: 'y' }], [{ key: 'a' }], '{"key":"a"}']) {
    assert.throws(() => validateMenuCategories(bad), MenuCategoryError, JSON.stringify(bad));
  }
  assert.throws(() => validateMenuCategories(Array.from({ length: 31 }, (_, i) => ({ key: `c${i}`, cn: 'x' }))), MenuCategoryError);
});

test('storefront, admin, POS and the CSV export read categories from the server, not a literal table', () => {
  const sources = { storefront: read('web/storefront.js'), admin: read('web/admin.html'), pos: read('web/pos.html'), worker: read('worker/index.js') };
  for (const [name, src] of Object.entries(sources)) {
    assert.doesNotMatch(src, /\b(?:combo|protein|lowcal)\s*:\s*['"\[]/, `${name} still has a hard-coded category table`);
  }
  assert.match(sources.storefront, /menu_categories/);
  assert.match(sources.admin, /catsMap\(/);
  assert.match(sources.pos, /d\.categories/);
  assert.match(sources.worker, /loadMenuCategories\(env\)/);
});
