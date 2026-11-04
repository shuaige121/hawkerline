import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  homepagePosterPublicProjection,
  validateHomepagePosterInputs,
  validatePickupSettingsPatch,
} from '../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8');
// 店面行为已拆成 index.html（外壳）+ storefront.js（行为）；断言要看浏览器实际拿到的整体。
const home = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8')
  + '\n' + fs.readFileSync(path.join(ROOT, 'web/storefront.css'), 'utf8')
  + '\n' + fs.readFileSync(path.join(ROOT, 'web/storefront.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'web/admin.html'), 'utf8');

function poster(overrides = {}) {
  return {
    id:'new80', title_cn:'首单立减 20%', title_en:'20% off', body_cn:'登录会员使用', body_en:'Members only',
    badge:'NEW80', action_type:'promo', action_value:'NEW80', cta_cn:'领取', cta_en:'Save',
    active:true, show_on_open:true, show_on_home:true, starts:'', ends:'', ...overrides,
  };
}

test('homepage campaign validation and public projection keep uploaded artwork lazy', () => {
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(400);
  const checked = validateHomepagePosterInputs([{ ...poster(), image_data:image }]);
  assert.equal(checked.ok, true);
  const publicPoster = homepagePosterPublicProjection({
    ...checked.posters[0], image_data:image, image_version:'v-test', updated_at:'2026-08-09T00:00:00Z',
  });
  assert.equal(publicPoster.image_url, '/api/poster-image/new80?v=v-test');
  assert.doesNotMatch(JSON.stringify(publicPoster), /data:image/);
});

test('pickup settings reject invalid photos and the public/order paths use a selected point', () => {
  assert.equal(validatePickupSettingsPatch({ pickup_points:[{ id:'riverside', name:'Riverside Mall', photo:'/img/riverside.jpg' }] }).ok, true);
  const bad = validatePickupSettingsPatch({ pickup_points:[{ id:'riverside', photo:'javascript:alert(1)' }] });
  assert.equal(bad.ok, false);
  assert.match(worker, /pickup_points/);
  assert.match(worker, /pickup_point_id/);
  assert.match(worker, /pickupSnapshot\(pickupPoint\)/);
  assert.match(home, /id="pickupPoint"/);
  assert.match(home, /pickup_point_id:\s*pickupPoint \? pickupPoint\.id : null/);
  assert.match(admin, /其他自取点/);
  assert.match(admin, /base_revision:\s*STORE_DRAFT_REVISION/);
  assert.match(admin, /settings_revision:\s*STORE_SETTINGS_REVISION/);
});

test('campaign and stored-value entrances are restored on the homepage and admin', () => {
  assert.match(home, /id="posterRail"/);
  assert.match(home, /id="topupPromo"/);
  assert.match(home, /id="pickupHome"/);
  assert.match(home, /renderHomepagePickupPoints\(\)/);
  assert.match(home, /loadTopupTiers\(\)/);
  assert.match(home, /\.sv-title \{ font-size:22px/);
  assert.match(home, /font-size:40px/);
  assert.match(admin, /onclick="postersView\(\)"/);
  assert.match(admin, /这里才是全部充值记录/);
  assert.match(admin, /这不是全部充值记录，也不是全部会员余额/);
});

test('stored-value balance stays visible and is applied automatically after sign-in', () => {
  assert.doesNotMatch(home, /id="moreToggle"/);
  assert.match(home, /id="moreOpts"/);
  assert.match(home, /id="useBal"/);
  assert.match(home, /if \(useBal\) useBal\.checked = BAL > 0/);
  assert.match(home, /登录后自动显示余额并优先抵扣商品金额/);
  assert.match(home, /MEMBER_SUMMARY[\s\S]*?S\$ \$\{\(\+MEMBER_SUMMARY\.balance \|\| 0\)\.toFixed\(2\)\}/);
  assert.match(home, /取消自动抵扣只改变本单的付款选择，已登录会员的真实余额仍应一直显示/);
});

test('legacy ownership-transfer audit rows never double-count wallet balance', () => {
  // 分工：单个会员的流水【要含】转移（那是他的真实变动，藏了结存列就整列消失）；
  // 全店负债汇总【要排除】转移（会员之间挪账，总额净零，计入即重复）。
  assert.doesNotMatch(worker, /we\.type NOT IN \('legacy_merge','legacy_unmerge'\)/,
    '单个会员的流水不得再隐藏转移行');
  assert.match(worker, /WHEN w\.type IN \('legacy_merge','legacy_unmerge'\) THEN 'transfer'/,
    '全店汇总必须把会员间转移单列出来');
  assert.match(worker, /THEN 'transfer'/, '转移必须有自己的桶');
  // 分类必须是白名单：未知 type / NULL 金额一律 fail closed，不能默认计入
  // 分类必须是【一个】总覆盖的 CASE：三个 NOT(...) 的合取在 SQL 三值逻辑下
  // 会让某些行两边都不落，判定与展示因此分叉。
  assert.match(worker, /const BUCKET_CASE = `CASE/, '分类必须只定义一次');
  assert.match(worker, /ELSE 'unresolved' END`/, '必须有全覆盖的 ELSE（fail closed）');
  assert.doesNotMatch(worker, /UNRESOLVED_SQL/, '不得再用 NOT(...) 合取来求补集');
  assert.match(worker, /typeof\(w\.amount\) IN \('integer','real'\)/,
    '非数值金额不得计入（SQLite 动态类型，TEXT 也能塞进 REAL 列）');
  // 判定量必须来自同一条 SQL，否则并发下会拼出一个假的「账平」
  assert.match(worker, /const snap = await env\.DB\.prepare/, '对账判定必须来自单条快照查询');
  assert.match(worker, /reconciled = snapUsable && unresolved_rows === 0/,
    '有挂起项或快照不可用时都不许宣称账平');
  // 对账表改成【显式归类】而不是 SQL 过滤：legacy 进「已排除项」并写明理由，
  // 且不得进入账面推算。断言行为，不再数字面量出现几次。
  // 对账表按【这笔钱是否已在别处记过】分类，不再猜 ref 前缀：
  // 整单退款与只退运费的 ref 都是 'refund:'，前者置 balance_refunded_at 而后者不置。
  assert.match(worker, /WHEN w\.type = 'refund' AND o\.id IS NOT NULL AND o\.balance_refunded_at IS NOT NULL/,
    '必须按订单是否已退出消费口径来分类');
  // 「排除」的前提是这笔事件确实等于消费口径里剔掉的那一笔。前提要被检查，不能当公理。
  assert.match(worker, /AND w\.amount = o\.paid_by_balance THEN 'order_refunded'/,
    '排除整单退款前必须【精确】验证金额与订单一致（四舍五入会抹掉亚分差）');
  assert.match(worker, /总额不变，计入即重复/, '必须写明为什么不再加一次');
  assert.doesNotMatch(worker, /LIKE 'bal_refund:%'/, '不得再用 ref 前缀做对账判据');
  assert.match(worker, /account_email/);
  assert.match(worker, /current_balance/);
});

// 一分钟发布 Cron 必须存在，且【所有】旧排程一条都不能少。
test('wrangler crons keep every existing schedule and add the one-minute publication tick', () => {
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const line = toml.split('\n').find(row => row.trim().startsWith('crons'));
  assert.ok(line, 'wrangler.toml 必须有 crons');
  for (const cron of ['* * * * *', '0 0 * * *', '0 13 * * *', '*/5 * * * *', '*/30 * * * *']) {
    assert.ok(line.includes(`"${cron}"`), `缺少 cron ${cron}`);
  }
  const worker = fs.readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8');
  assert.match(worker, /event\.cron === '\* \* \* \* \*'/, 'scheduled() 必须单独处理一分钟 cron');
  assert.match(worker, /allowBootstrap: true/, '只有 cron 允许 bootstrap');
});
