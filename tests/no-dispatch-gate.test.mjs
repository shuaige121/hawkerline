// 「Lalamove 只报价、绝不叫车」的结构性闸门。
//
// 老板的口径很明确：**只拿金额问客户收运费，车由老板自己叫**。
// 这条不是配置项，是产品红线 —— 所以这里检查的不是源码里"看起来"怎么写，
// 而是【真正会被部署的那串字节】里到底有没有下单能力。
//
// 需要先跑 `npm run dry-run`（package.json 的 test 脚本已经把顺序排好了）。
// 谁哪天把叫车接回来，这个文件立刻变红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLalamoveQuoteRequest } from '../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, '.wrangler-dryrun', 'index.js');

test('运输层只放行报价请求，其它一律拒', () => {
  assert.equal(isLalamoveQuoteRequest('POST', '/v3/quotations'), true);
  // 下单 / 取消 / 查单 —— 一个都不许过
  assert.equal(isLalamoveQuoteRequest('POST', '/v3/orders'), false);
  assert.equal(isLalamoveQuoteRequest('DELETE', '/v3/orders/abc'), false);
  assert.equal(isLalamoveQuoteRequest('GET', '/v3/orders/abc'), false);
  assert.equal(isLalamoveQuoteRequest('GET', '/v3/quotations'), false, '报价只认 POST');
  assert.equal(isLalamoveQuoteRequest('POST', '/v3/quotations/abc'), false, '不许带子路径');
  assert.equal(isLalamoveQuoteRequest('POST', '/v3/quotations?x=1'), false);
  for (const junk of [null, undefined, '', 'post']) {
    assert.equal(isLalamoveQuoteRequest(junk, '/v3/quotations'), junk === 'post', `method=${junk}`);
  }
});

test('★ 部署产物里不存在任何 Lalamove 下单能力', (t) => {
  if (!existsSync(BUNDLE)) {
    // 明确失败而不是静默跳过 —— 「闸门没跑」和「闸门通过了」绝不能长得一样
    assert.fail(`找不到打包产物 ${BUNDLE}；请先跑 npm run dry-run（npm test 已包含）`);
  }
  const code = readFileSync(BUNDLE, 'utf8');
  // 产物是 esbuild 打出来的：不可达的 lalamoveCreateOrder / lalamoveCancelOrder 会被
  // tree-shake 掉，所以这几个字符串一旦出现，就意味着有人把它们接回了可达路径。
  for (const needle of ['/v3/orders', 'lalamoveCreateOrder', 'lalamoveCancelOrder']) {
    assert.ok(!code.includes(needle),
      `部署产物里出现了「${needle}」—— 说明系统叫车被重新接上了。老板的要求是只报价、不叫车。`);
  }
  // 报价能力必须还在（否则运费收不出来，这条闸门就变成了误伤）
  assert.ok(code.includes('/v3/quotations'), '报价端点不见了：运费会算不出来');
});

test('★ 部署产物里报价是唯一会用到 Lalamove 凭据的地方', () => {
  const code = readFileSync(BUNDLE, 'utf8');
  // ⚠️ 不能只匹配 /v3/xxx —— Google 的 JWKS 是 googleapis.com/oauth2/v3/certs，
  // 也长这样，会造成误伤（第一版就误报了）。这里把已知的非 Lalamove 来源先剔掉。
  const NOT_LALAMOVE = [/oauth2\/v3\/certs/g];
  let scrubbed = code;
  for (const re of NOT_LALAMOVE) scrubbed = scrubbed.replace(re, '');
  const uniq = [...new Set([...scrubbed.matchAll(/\/v3\/[a-z]+/g)].map(m => m[0]))].sort();
  assert.deepEqual(uniq, ['/v3/quotations'],
    `产物里出现了非报价的 Lalamove 端点：${uniq.join(', ')}`);
});
