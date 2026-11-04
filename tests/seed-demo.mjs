// 本地演示库播种：把四端（顾客 / 老板 / 收银台 / 厨房）都填满可点的数据。
//
//   node tests/seed-demo.mjs --persist <dir>
//
// 只写本地 D1，永不碰生产。凭据全是测试用的假值，写死在这里方便逐按钮点：
//   ADMIN_TOKEN      testadmin      （老板后台 /admin）
//   POS  pos1/pos2   123456         （收银台 /pos）
//   KITCHEN_PASSWORD kitchen123     （厨房 /kitchen）
//   telegram_webhook_secret e2esecret
// Stripe 故意配一个【格式合法但无效】的 sk_test_，这样点到 Stripe 相关按钮时走的是
// 真实的错误分支（可验报错文案），而不会真的向 Stripe 发出成功请求。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--persist');
if (i < 0) { console.error('用法：node tests/seed-demo.mjs --persist <dir>'); process.exit(1); }
const persist = process.argv[i + 1];
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const d1 = (sql) => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const NOW = new Date().toISOString();
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const pin = (p) => {
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  return { salt, hash: pbkdf2Sync(p, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex') };
};

console.log('· 建库');
execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

console.log('· 设置 / 凭据');
const settings = [
  ['store_open', '1'], ['pickup_enabled', '1'], ['delivery_enabled', '1'],
  ['shop_name', 'Example Food Court'], ['shop_address', 'Example Food Court #01-01, S(100003)'],
  ['shop_pickup_detail', '红色招牌入口，从玻璃门进入'], ['shop_contact_phone', '80000001'],
  ['SHOP_POSTAL', '100003'], ['SHOP_DOMAIN', 'shop.example'], ['prep_time_min', '20'],
  ['business_hours', JSON.stringify({ 0: ['09:30', '21:30'], 1: null, 2: ['10:00', '20:30'], 3: ['10:00', '20:30'], 4: ['10:00', '20:30'], 5: ['10:00', '20:30'], 6: ['09:30', '21:30'] })],
  ['TOPUP_TIERS', '[[500,80],[200,25],[100,10],[50,3]]'],
  ['telegram_webhook_secret', 'e2esecret'],
  ['print_when', 'paid'], ['print_token', 'printtoken123'], ['print_profile', 'text80'],
  ['KITCHEN_PASSWORD', 'kitchen123'],
  ['pos_refund_delivery_fee', '1'],
  // 格式合法但无效：Stripe 相关按钮会走真实的失败分支，不会真的成功下单/退款
  ['STRIPE_SECRET_KEY', 'sk_test_' + '0'.repeat(24)],
  ['courier_provider', 'lalamove'], ['delivery_fee_mode', 'flat'], ['selfdeliver_flat', '9.00'],
];
for (const [k, v] of settings) {
  // SQL 单引号字面量里【不处理反斜杠】：用 JSON.stringify 转义会把 \" 原样存进去，
  // 存出来的 business_hours 根本不是合法 JSON（旧解析器静默回落默认值所以一直没人发现）。
  d1(`INSERT INTO app_settings (k,v,updated_at) VALUES ('${k}','${String(v).replace(/'/g, "''")}','${NOW}')
      ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`);
}

console.log('· 收银员 / 厨房');
for (const [c, p] of [['pos1', '123456'], ['pos2', '123456']]) {
  const { salt, hash } = pin(p);
  d1(`INSERT INTO pos_pins (cashier,pin_hash,pin_salt,updated_at) VALUES ('${c}','${hash}','${salt}','${NOW}')
      ON CONFLICT(cashier) DO UPDATE SET pin_hash=excluded.pin_hash,pin_salt=excluded.pin_salt`);
}

console.log('· 会员');
d1(`INSERT INTO user_accounts (id,phone,name,created_at,updated_at) VALUES
    ('u-demo-1','91234567','陈美玲','${NOW}','${NOW}'),
    ('u-demo-2','98765432','林伟强','${NOW}','${NOW}')`);
d1(`INSERT INTO auth_identities (provider,provider_sub,user_id,email,display_name,created_at,updated_at) VALUES
    ('google','g-sub-1','u-demo-1','meiling@example.com','陈美玲','${NOW}','${NOW}')`);
// ⚠️ 余额不是随便填的：储值台账会做「充值 − 已扣未退 + 人工调整 = 余额」的对账，
// 对不上老板一进台账就是满屏红色告警。这里的数字按下面的订单/充值倒推得出：
//   陈美玲 u-demo-1：充值 225，储值支付 34（含运费8）+ 26 = 60 → 余额 165
//   林伟强 u-demo-2：充值 130，储值支付 36（含运费10）+ 26 = 62 → 余额 68
//   王老太 legacy：充值 110，人工调整 −21.50 → 余额 88.50
d1(`INSERT INTO members (phone,user_id,name,balance,points,total_spent,orders_count,created_at,updated_at) VALUES
    ('91234567','u-demo-1','陈美玲',165.00,180,180,4,'${NOW}','${NOW}'),
    ('98765432','u-demo-2','林伟强',68.00,12,12,1,'${NOW}','${NOW}')`);
// legacy 储值会员（没有账号）——给「柜台核验合并」用
d1(`INSERT INTO members (phone,name,balance,points,created_at,updated_at) VALUES
    ('80000002','王老太',88.50,5,'${NOW}','${NOW}')`);
d1(`INSERT INTO topups (id,phone,user_id,amount,bonus,credited,pay_method,pay_status,cashier,created_at,note) VALUES
    ('tp-1','91234567','u-demo-1',200,25,225,'cash','PAID','pos1','${NOW}','柜台充值'),
    ('tp-3','98765432','u-demo-2',120,10,130,'cash','PAID','pos1','${NOW}','柜台充值'),
    ('tp-2','80000002',NULL,100,10,110,'paynow','PAID','pos1','${NOW}','柜台充值')`);
d1(`INSERT INTO wallet_events (id,type,ref,order_id,phone,user_id,amount,created_at,note) VALUES
    ('we-1','adjustment','adj:1',NULL,'80000002',NULL,-21.50,'${NOW}','老板手工扣减')`);

console.log('· 订单（覆盖各种状态，给每个按钮都留活）');
// 明细固定为 鲜肉包 2×5.00 + 豆沙包 4×4.00 = 26.00，所以每单 subtotal 一律 26，
// total = 26 + 运费。之前 subtotal 随手写 50/40/30，发票页上明细加不出小计，看着像算错了。
const SUB = 26;
const ORD = [
  // id, inv, name, phone, uid, subtotal, fee, total, fulfilment, provider, status, paid_by_balance, fulfil, addr
  ['11111111-1111-4111-8111-111111111111', 'HL-DEMO-0001', '陈美玲', '91234567', 'u-demo-1', SUB, 8, SUB + 8, 'anytime', 'balance', 'PAID', SUB + 8, 'new', 'Blk 123 Ang Mo Kio Ave 3 #05-12'],
  ['22222222-2222-4222-8222-222222222222', 'HL-DEMO-0002', '林伟强', '98765432', 'u-demo-2', SUB, 10, SUB + 10, 'anytime', 'balance', 'PAID', SUB + 10, 'preparing', 'Blk 55 Toa Payoh #12-03'],
  ['33333333-3333-4333-8333-333333333333', 'HL-DEMO-0003', '陈美玲', '91234567', 'u-demo-1', SUB, 0, SUB, 'pickup', 'balance', 'PAID', SUB, 'ready', null],
  ['44444444-4444-4444-8444-444444444444', 'HL-DEMO-0004', '游客', '90001111', null, SUB, 0, SUB, 'pickup', 'manual_qr', 'UNPAID', 0, 'new', null],
  ['55555555-5555-4555-8555-555555555555', 'HL-DEMO-0005', '陈美玲', '91234567', 'u-demo-1', SUB, 12, SUB + 12, 'anytime', 'stripe', 'PAID', 0, 'new', 'Blk 8 Bishan St 21 #03-44'],
  ['66666666-6666-4666-8666-666666666666', 'HL-DEMO-0006', '林伟强', '98765432', 'u-demo-2', SUB, 0, SUB, 'pickup', 'balance', 'PAID', SUB, 'done', null],
];
for (const [id, inv, nm, ph, uid, st, fee, tot, ful, prov, pay, pbb, fs, addr] of ORD) {
  d1(`INSERT INTO orders (id,invoice_no,created_at,customer_name,phone,user_id,items_json,subtotal,delivery_fee,
        total,fulfilment,address,pay_provider,pay_ref,pay_status,paid_at,paid_by_balance,fulfil_status,refunded_total,deliver_at)
      VALUES ('${id}','${inv}','${NOW}','${nm}','${ph}',${uid ? `'${uid}'` : 'NULL'},
        '[{"sku":"S01","name":"鲜肉包","qty":2,"unit_price":5},{"sku":"S05","name":"豆沙包","qty":4,"unit_price":4}]',
        ${st},${fee},${tot},'${ful}',${addr ? `'${addr}'` : 'NULL'},'${prov}',
        '${prov === 'stripe' ? 'cs_test_' + 'a'.repeat(58) : 'HL' + inv.slice(-4)}',
        '${pay}',${pay === 'PAID' ? `'${NOW}'` : 'NULL'},${pbb},'${fs}',0,'${today}')`);
}
d1(`INSERT INTO order_events (id,order_id,actor,type,message,created_at) VALUES
    ('oe-1','22222222-2222-4222-8222-222222222222','telegram:999','fulfil:preparing','new → preparing','${NOW}')`);

console.log('· 厨房打印队列');
d1(`INSERT INTO print_jobs (id,order_id,kind,content,status,created_at) VALUES
    ('pj-1','11111111-1111-4111-8111-111111111111','ticket','鲜肉包 x2 / 豆沙包 x4','pending','${NOW}'),
    ('pj-2','22222222-2222-4222-8222-222222222222','ticket','鲜肉包 x2 / 豆沙包 x4','pending','${NOW}')`);

console.log('· 优惠码 / 路线 / Telegram 订阅');
d1(`INSERT INTO promo_codes (code,kind,value,active,min_spend,per_account_limit,created_at) VALUES
    ('DEMO10','percent',10,1,0,1,'${NOW}'),
    ('NEIGHBOUR68','fixed',6.80,1,20,1,'${NOW}')`);
d1(`INSERT INTO routes (id,name,blocks,fee,cutoff,active,created_at) VALUES
    ('r-1','周三 · 碧山顺路送','Blk 1-99 Bishan',3.50,'${today} 16:00',1,'${NOW}')`);
d1(`INSERT INTO telegram_subscribers (chat_id,name,added_at) VALUES ('999','老板测试群','${NOW}')`);

console.log('\n✅ 播种完成');
console.log('   老板后台 /admin      ADMIN_TOKEN = testadmin');
console.log('   收银台   /pos        pos1 / 123456');
console.log('   厨房     /kitchen    kitchen123');
console.log('   顾客端   /           有 legacy 会员 80000002（余额 88.50）可做柜台合并');
