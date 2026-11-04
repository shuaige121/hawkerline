import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import worker from '../worker/index.js';

function captureDb(results = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, binds: [] };
      calls.push(call);
      return {
        bind(...binds) { call.binds = binds; return this; },
        async all() { return { results }; },
      };
    },
  };
}

function topupDb({ account = null, legacy = null, finalBalance = 110 } = {}) {
  const calls = [];
  const batches = [];
  const DB = {
    calls,
    batches,
    prepare(sql) {
      const call = { sql, binds: [] };
      calls.push(call);
      const statement = {
        call,
        bind(...binds) { call.binds = binds; return this; },
        async first() {
          if (/SELECT a\.id user_id/.test(sql)) return account;
          if (/SELECT ua\.id AS user_id/.test(sql)) return account;
          if (/SELECT phone FROM user_accounts/.test(sql)) return account ? { phone: account.phone } : null;
          if (/SELECT phone,name,email,archived_at FROM members/.test(sql)) return legacy;
          if (/SELECT merged_to_user_id FROM members/.test(sql)) return null;
          if (/FROM topups WHERE client_token/.test(sql)) return null;
          if (/SELECT v FROM app_settings/.test(sql)) return null;
          if (/SELECT balance FROM members/.test(sql)) return { balance: finalBalance };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements) {
      batches.push(statements.map(s => s.call));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return DB;
}

test('admin member search matches canonical Singapore phone and identity fields', async () => {
  const DB = captureDb([{ user_id: 'user-1', phone: '80000002', name: 'Test' }]);
  const response = await worker.fetch(new Request(
    'http://localhost/api/admin/members?q=' + encodeURIComponent('+65 8000 0002'),
    { headers: { authorization: 'Bearer unit-admin' } },
  ), { ADMIN_TOKEN: 'unit-admin', DB }, {});

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.members, [{ user_id: 'user-1', phone: '80000002', name: 'Test' }]);
  // 「删除会员」做成了归档：列表默认不含已归档的，加 ?include_archived=1 才显示。
  // 这个标志要如实回给前端，否则老板不知道自己看到的是不是全部。
  assert.equal(body.include_archived, false);
  assert.match(DB.calls[0].sql, /archived_at IS NULL/, '默认必须把已归档的排除掉');
  assert.equal(DB.calls.length, 1);
  assert.match(DB.calls[0].sql, /COALESCE\(phone,''\) LIKE \?/);
  assert.match(DB.calls[0].sql, /COALESCE\(email,''\) LIKE \?/);
  assert.match(DB.calls[0].sql, /COALESCE\(user_id,''\) LIKE \?/);
  assert.match(DB.calls[0].sql, /COALESCE\(admin_note,''\) LIKE \?/);
  assert.match(DB.calls[0].sql, /m\.admin_note/);
  assert.ok(DB.calls[0].binds.includes('%80000002%'));
  assert.ok(DB.calls[0].binds.includes('%+65 8000 0002%'));
});

test('admin member page exposes searchable controls and valid inline scripts', () => {
  const html = fs.readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
  assert.match(html, /id="member-q"/);
  assert.match(html, /手机号 \/ 姓名 \/ Email \/ User ID \/ 会员备注/);
  assert.match(html, /window\.searchMembers/);
  assert.match(html, /window\.memberSearchChanged/);
  assert.match(html, /oninput="memberSearchChanged\(this\)"/);
  assert.match(html, /id="mnote-\$\{i\}"/);
  assert.match(html, /window\.memberTopupAudit/);
  assert.match(html, /充值流水审计/);
  assert.match(html, /encodeURIComponent\(query\)/);
  assert.match(html, /id="tu-member-q"/);
  assert.match(html, /手机号 \/ Email \/ 姓名/);
  assert.match(html, /window\.searchTopupMembers/);
  assert.match(html, /window\.selectTopupMember/);
  assert.match(html, /姓名（新建会员必填）/);
  assert.match(html, /Email（可选）/);
  assert.match(html, /user_id:selected&&selected\.user_id/);
  assert.match(html, /旧的电话档案如果缺姓名或 Email/);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new Function(script);
});

test('admin top-up creates a named legacy profile in the same money batch', async () => {
  const DB = topupDb();
  const response = await worker.fetch(new Request('http://localhost/api/admin/topup', {
    method: 'POST',
    headers: { authorization: 'Bearer unit-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+65 9123 4567', name: 'Eva Yuan', email: 'EVA@example.com', amount: 100,
      pay_method: 'paynow', client_token: 'new-eva-topup' }),
  }), { ADMIN_TOKEN: 'unit-admin', DB }, {});

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.created_member, true);
  assert.deepEqual(body.member, { user_id: null, phone: '91234567', name: 'Eva Yuan', email: 'eva@example.com' });
  assert.equal(DB.batches.length, 1, '会员档案、余额和充值流水必须在一个 batch');
  const memberWrite = DB.batches[0].find(call => /INSERT INTO members \(phone,name,email,balance/.test(call.sql));
  assert.ok(memberWrite, '必须写入带姓名和 Email 的会员档案');
  assert.deepEqual(memberWrite.binds.slice(0, 4), ['91234567', 'Eva Yuan', 'eva@example.com', 110]);
  assert.ok(DB.batches[0].some(call => /INSERT INTO topups/.test(call.sql)), '同一 batch 必须包含充值流水');
});

test('admin top-up accepts a searched online member without a phone', async () => {
  const DB = topupDb({ account: { user_id: 'user-email-only', phone: null, name: 'Email User', archived_at: null } });
  const response = await worker.fetch(new Request('http://localhost/api/admin/topup', {
    method: 'POST',
    headers: { authorization: 'Bearer unit-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'user-email-only', phone: '', amount: 100, pay_method: 'cash', client_token: 'email-user-topup' }),
  }), { ADMIN_TOKEN: 'unit-admin', DB }, {});

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.user_id, 'user-email-only');
  assert.equal(body.created_member, false);
  assert.equal(DB.batches.length, 1);
  const topupWrite = DB.batches[0].find(call => /INSERT INTO topups/.test(call.sql));
  assert.ok(topupWrite);
  assert.equal(topupWrite.binds[0] != null, true, '充值流水必须有 id');
  assert.equal(topupWrite.binds[1], '');
  assert.equal(topupWrite.binds[2], 'user-email-only');
});

test('admin top-up can fill blank profile fields on an existing phone member', async () => {
  const DB = topupDb({ legacy: { phone: '93334444', name: null, email: null, archived_at: null }, finalBalance: 53 });
  const response = await worker.fetch(new Request('http://localhost/api/admin/topup', {
    method: 'POST',
    headers: { authorization: 'Bearer unit-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '93334444', name: 'Old Customer', email: 'old@example.com', amount: 50,
      pay_method: 'paynow', client_token: 'existing-phone-topup' }),
  }), { ADMIN_TOKEN: 'unit-admin', DB }, {});

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.created_member, false);
  assert.equal(body.member.name, 'Old Customer');
  assert.equal(body.member.email, 'old@example.com');
  const memberWrite = DB.batches[0].find(call => /INSERT INTO members \(phone,name,email,balance/.test(call.sql));
  assert.deepEqual(memberWrite.binds.slice(0, 3), ['93334444', 'Old Customer', 'old@example.com']);
});
