import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/index.js';

// Auth-only release on the deployed b076eeb source: the optional Worker secret
// ADMIN_TOKEN_SECONDARY is a second, independent boss login on the existing /api/admin gate.
// isAdmin is not exported here, so every assertion goes through the real Worker route.
const OWNER = 'owner-original-admin-token';
const ADDITIONAL = 'Lq7vW2xN9pR4tY6uZ8aB1cD3eF5gH0jK2mS4nV6wX8y';
const ROTATED = 'rotated-additional-admin-token-value-000000000';
const AUTH_SECRET = 'additional-credential-test-auth-secret';
const STATUS_URL = 'https://shop.example/api/admin/publication/status';
const EXPECTED = {
  active_release_id: 'release-active', draft_revision: 'rev-1', updated_at: '2026-09-11T00:00:00Z',
  releases: [{ id: 'release-active', status: 'published' }],
};

let dbCalls = 0;
const statusDb = {
  prepare(sql) { dbCalls += 1; return { sql, bind() { return this; } }; },
  async batch(statements) {
    assert.equal(statements.length, 2);
    return [{ results: [{ active_release_id: 'release-active', draft_revision: 'rev-1', updated_at: '2026-09-11T00:00:00Z' }] },
      { results: [{ id: 'release-active', status: 'published' }] }];
  },
};
const env = (extra = {}) => ({ ADMIN_TOKEN: OWNER, ADMIN_TOKEN_SECONDARY: ADDITIONAL, AUTH_SECRET, DB: statusDb, ...extra });
const status = async (authorization, overrides) => {
  const init = authorization === undefined ? {} : { headers: { authorization } };
  const response = await worker.fetch(new Request(STATUS_URL, init), env(overrides), {});
  if (response.status === 200) assert.deepEqual(await response.json(), EXPECTED);
  return response.status;
};

async function staffToken(secret, claims) {
  const payload = btoa(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

test('ADMIN_TOKEN_SECONDARY reads publication status as a second, independent boss credential', async () => {
  assert.equal(await status(`Bearer ${ADDITIONAL}`), 200, 'the additional credential must authenticate');
  assert.equal(await status(`Bearer ${OWNER}`), 200, 'adding the binding keeps the original credential valid');
  assert.equal(await status(`Bearer ${ADDITIONAL}`, { ADMIN_TOKEN: undefined }), 200,
    'the additional credential does not depend on ADMIN_TOKEN');
  assert.equal(await status(`Bearer ${OWNER}`, { ADMIN_TOKEN: undefined, ADMIN_TOKEN_SECONDARY: OWNER }), 401,
    'a binding shorter than 32 characters never authenticates, even if it equals the owner token');
  assert.equal(await status(`Bearer ${ADDITIONAL}`, { ADMIN_TOKEN_SECONDARY: undefined }), 401,
    'without the binding the additional value is just a wrong token');
  assert.equal(await status(`Bearer ${ADDITIONAL}`, { ADMIN_TOKEN_SECONDARY: ROTATED }), 401,
    'rotating the additional binding revokes the previous value');
  assert.equal(await status(`Bearer ${OWNER}`, { ADMIN_TOKEN_SECONDARY: ROTATED }), 200,
    'rotating the additional binding does not affect the original credential');
});

test('near-miss or malformed additional presentations and weak bindings are rejected before D1', async () => {
  dbCalls = 0;
  for (const authorization of [
    undefined, '', 'Bearer', ADDITIONAL, `Basic ${ADDITIONAL}`, `Bearer  ${ADDITIONAL}`,
    `Bearer ${ADDITIONAL} extra`, `Bearer ${ADDITIONAL}x`, `Bearer x${ADDITIONAL}`, `Bearer ${ADDITIONAL.slice(0, -1)}`,
    `Bearer ${ADDITIONAL.toUpperCase()}`, `Bearer ${ADDITIONAL},${OWNER}`,
  ]) assert.equal(await status(authorization), 401, `${JSON.stringify(authorization)} must be rejected`);
  for (const [binding, presented, why] of [
    ['short-admin-token', 'short-admin-token', 'weak binding'],
    ['k'.repeat(31), 'k'.repeat(31), '31 characters is below the floor'],
    [`${ADDITIONAL}\n`, ADDITIONAL, 'binding with trailing whitespace'],
    [{ length: ADDITIONAL.length, charCodeAt: i => ADDITIONAL.charCodeAt(i) }, ADDITIONAL, 'non-string binding'],
  ]) assert.equal(await status(`Bearer ${presented}`, { ADMIN_TOKEN_SECONDARY: binding }), 401, why);
  assert.equal(dbCalls, 0, 'rejected requests must stop before D1');
  assert.equal(await status(`Bearer ${'k'.repeat(32)}`, { ADMIN_TOKEN: undefined, ADMIN_TOKEN_SECONDARY: 'k'.repeat(32) }), 200,
    'a 32-character binding is the minimum accepted length');
});

test('the original ADMIN_TOKEN behaviour is unchanged with or without the additional binding', async () => {
  const b076eeb = (authorization, bindings) => {   // frozen copy of the deployed isAdmin
    const t = String(authorization || '').replace(/^Bearer\s+/i, '');
    return !!(bindings.ADMIN_TOKEN && t && t === bindings.ADMIN_TOKEN);
  };
  const headers = [undefined, '', 'Bearer', `Bearer ${OWNER}`, `bearer ${OWNER}`, `BEARER ${OWNER}`,
    `Bearer  ${OWNER}`, `Bearer ${OWNER} x`, `Bearer ${OWNER}x`, OWNER, `Basic ${OWNER}`, 'Bearer short',
    `Bearer ${OWNER.slice(0, -1)}`, 'Bearer wrong'];
  for (const bindings of [{ ADMIN_TOKEN: OWNER }, { ADMIN_TOKEN: 'short' }, { ADMIN_TOKEN: '' }, {}]) {
    for (const authorization of headers) {
      const expected = b076eeb(authorization, bindings) ? 200 : 401;
      for (const additional of [undefined, '', ADDITIONAL]) {
        assert.equal(await status(authorization, { ADMIN_TOKEN: undefined, ...bindings, ADMIN_TOKEN_SECONDARY: additional }),
          expected, `${JSON.stringify(authorization)} with ${JSON.stringify(bindings)} and additional=${JSON.stringify(additional)}`);
      }
    }
  }
});

test('POS staff and kitchen tokens never become boss authority', async () => {
  const now = Date.now();
  for (const claims of [{ c: 'pos', r: 'staff', exp: now + 3_600_000 }, { r: 'kitchen', exp: now + 3_600_000 }]) {
    assert.equal(await status(`Bearer ${await staffToken(AUTH_SECRET, claims)}`), 401, `${claims.r} token must be rejected`);
  }
  assert.equal(await status(`Bearer ${AUTH_SECRET}`), 401, 'AUTH_SECRET is not an admin credential');
});
