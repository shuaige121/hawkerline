#!/usr/bin/env node
// Clicks through the four surfaces of a running local Hawkerline in headless Chrome and saves screenshots.
// Usage: node tools/ui-smoke.mjs http://localhost:8787 [outDir]   (reads ADMIN_TOKEN from env or .dev.vars)
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { findChrome } from '../tests/find-chrome.mjs';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const OUT = process.argv[3] || '_qa/ui';
mkdirSync(OUT, { recursive: true });
let ADMIN = process.env.ADMIN_TOKEN || '';
if (!ADMIN && existsSync('.dev.vars')) ADMIN = (readFileSync('.dev.vars', 'utf8').match(/^ADMIN_TOKEN=(.+)$/m) || [])[1] || '';
const PIN = String(100000 + Math.floor(Math.random() * 899999));

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
const errors = [];
const page = async (width = 1280, height = 900) => {
  const p = await browser.newPage();
  await p.setViewport({ width, height });
  p.on('pageerror', e => errors.push(`${p.url()}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(`${p.url()}: ${m.text()}`); });
  p.on('dialog', d => { errors.push(`unexpected dialog: ${d.message()}`); d.dismiss(); });
  return p;
};
const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
try {
  // storefront, phone width
  const s = await page(390, 844);
  await s.goto(BASE + '/menu', { waitUntil: 'networkidle0' });
  await s.waitForSelector('#menu .card, #menu .product');
  const header = await s.$eval('header .b', n => n.textContent.trim());
  assert.ok(header.length > 0, 'brand name shown in header');
  const overflow = await s.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal scroll on phones (overflow ${overflow}px)`);
  await shot(s, '1-storefront-menu-390');
  const add = await s.$('#menu [onclick*="add"], #menu button[data-add-sku], #menu .add');
  if (add) { await add.click(); await shot(s, '2-storefront-cart-390'); }
  const legal = await page(390, 844);
  await legal.goto(BASE + '/about', { waitUntil: 'networkidle0' });
  assert.ok(!(await legal.content()).match(/poxiaoman|KEEVAN|坡晓馒/i), 'about page carries no previous brand');
  await shot(legal, '3-about-390');

  // admin
  const a = await page();
  await a.goto(BASE + '/admin', { waitUntil: 'networkidle0' });
  await a.waitForSelector('input[type=password], #tok, input');
  const tokenInput = await a.$('input[type=password]') || await a.$('input');
  await tokenInput.type(ADMIN);
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => /销售后台/.test(document.body.innerText), { timeout: 15000 });
  await shot(a, '4-admin-dashboard');
  await a.evaluate(() => agentView());
  await a.waitForFunction(() => /新建 agent key/.test(document.body.innerText));
  await a.type('#agName', 'UI smoke');
  await a.evaluate(() => createAgentKey());
  await a.waitForFunction(() => /hlk_[0-9a-f]{40}/.test(document.body.innerText));
  await shot(a, '5-admin-ai-agents-new-key');
  await a.evaluate(() => categoriesView());
  await a.waitForFunction(() => /菜单分类/.test(document.body.innerText));
  await shot(a, '6-admin-categories');
  await a.evaluate(() => posPinsView());
  await a.waitForSelector('#pin-pos1');
  await a.type('#pin-pos1', PIN);
  await a.evaluate(() => savePosPin('pos1'));
  await a.waitForFunction(() => /已设置/.test(document.body.innerText));
  await shot(a, '7-admin-pos-pins');
  await a.evaluate(() => productsView());
  await a.waitForSelector('#prodCat');
  const options = await a.$$eval('#prodCat option', os => os.map(o => o.textContent));
  assert.ok(options.length > 0, 'category select is filled from the server');
  await shot(a, '8-admin-products');

  // POS
  const pos = await page(1024, 768);
  await pos.goto(BASE + '/pos', { waitUntil: 'networkidle0' });
  await pos.waitForSelector('#pin');
  await pos.select('#cashier', 'pos1');
  await pos.type('#pin', PIN);
  await pos.keyboard.press('Enter');
  await pos.waitForSelector('.tile', { timeout: 15000 });
  await shot(pos, '9-pos');

  // kitchen
  const k = await page(1024, 768);
  await k.goto(BASE + '/kitchen', { waitUntil: 'networkidle0' });
  await shot(k, '10-kitchen-login');
} finally {
  await browser.close();
}
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK — screenshots in ${OUT}`);
