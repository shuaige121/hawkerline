import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import worker, { isLalamoveQuoteRequest, manualCourierTelegramPayload } from '../worker/index.js';

test('Lalamove credentials are restricted to quotation requests', () => {
  assert.equal(isLalamoveQuoteRequest('POST', '/v3/quotations'), true);
  assert.equal(isLalamoveQuoteRequest('POST', '/v3/orders'), false);
  assert.equal(isLalamoveQuoteRequest('GET', '/v3/orders/order-1'), false);
  assert.equal(isLalamoveQuoteRequest('DELETE', '/v3/orders/order-1'), false);
});

test('manual courier Telegram action opens Grab and offers copy buttons', () => {
  const action = manualCourierTelegramPayload({
    id: 'order-1', invoice_no: 'ORD-20260808-0001', fulfilment: 'anytime',
    address: '1 Example Road Singapore 123456', unit_no: '#01-01',
    customer_name: 'Customer', phone: '80000002', deliver_at: '2026-08-08', deliver_time: '12:00',
  }, 'Demo Dim Sum · 1 Shop Road Singapore 654321', '80000001', 'shop.example');

  assert.match(action.text, /Grab 手动叫车资料/);
  assert.match(action.text, /1 Example Road/);
  const buttons = action.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button => button.url === 'https://express.grab.com/book/login'));
  assert.ok(buttons.some(button => button.copy_text?.text.includes('1 Example Road')));
  assert.ok(buttons.some(button => button.copy_text?.text.includes('+6580000002')));
  for (const button of buttons.filter(button => button.copy_text)) assert.ok(button.copy_text.text.length <= 256);
});

test('retired admin dispatch endpoint cannot create a courier order', async () => {
  const response = await worker.fetch(new Request('http://localhost/api/admin/delivery-retry', {
    method: 'POST', headers: { authorization: 'Bearer unit-admin', 'content-type': 'application/json' }, body: '{}',
  }), { ADMIN_TOKEN: 'unit-admin' }, {});
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, 'quote_only');
});

test('admin courier UI has quote-only controls and no dispatch action', () => {
  const html = fs.readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
  assert.match(html, /仅用于实时报价/);
  assert.doesNotMatch(html, /id="cvLaAuto"/);
  assert.doesNotMatch(html, /window\.retryDelivery/);
});
