import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 店面行为已拆成 index.html（外壳）+ storefront.js（行为）；断言要看浏览器实际拿到的整体。
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  + '\n' + fs.readFileSync(new URL('../web/storefront.js', import.meta.url), 'utf8');

test('member UI exposes both providers and no phone-link registration flow', () => {
  assert.match(html, /href="\/api\/auth\/google"/);
  assert.match(html, /href="\/api\/auth\/apple"/);
  assert.match(html, /id="profilePhone"/);
  assert.match(html, /window\.linkProvider/);
  assert.doesNotMatch(html, /window\.googleLinkPhone/);
  assert.doesNotMatch(html, /\/api\/auth\/google-link/);
});

test('inline storefront scripts parse successfully', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new Function(script);
});
