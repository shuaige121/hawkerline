import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appleClientSecret,
  courierRecipientPhone,
  e164Phone,
  normPhone,
  signSession,
  verifyOidcIdToken,
  verifySession,
} from '../worker/index.js';

const enc = new TextEncoder();
const b64url = value => Buffer.from(value).toString('base64url');
const jsonPart = value => b64url(enc.encode(JSON.stringify(value)));

test('member sessions carry stable user_id and reject tampering', async () => {
  const env = { AUTH_SECRET: 'unit-test-secret' };
  const token = await signSession(env, 'user-123');
  assert.equal(await verifySession(env, token), 'user-123');

  const [payload, signature] = token.split('.');
  const tampered = payload + '.' + (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  assert.equal(await verifySession(env, tampered), null);
  assert.equal(await verifySession({ AUTH_SECRET: 'another-secret' }, token), null);
});

test('Singapore contact phones have one unique canonical form', () => {
  assert.equal(normPhone('80000002'), '80000002');
  assert.equal(normPhone('+65 8000 0002'), '80000002');
  assert.equal(e164Phone('80000002'), '6580000002');
  assert.equal(e164Phone('+65 8000 0002'), '6580000002');
  assert.equal(normPhone('+1 415 555 0123'), '14155550123');
  assert.equal(courierRecipientPhone('', '80000001'), '+6580000001');
  assert.equal(courierRecipientPhone('80000002', '80000001'), '+6580000002');
});

test('OIDC verifier checks RSA signature, issuer, audience, nonce and expiry', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  const now = Math.floor(Date.now() / 1000);
  const basePayload = { iss: 'https://issuer.example', aud: 'client-id', sub: 'provider-user', nonce: 'nonce-1', iat: now, exp: now + 300 };
  const makeJwt = async overrides => {
    const head = jsonPart({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
    const body = jsonPart({ ...basePayload, ...overrides });
    const input = head + '.' + body;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(input));
    return input + '.' + b64url(signature);
  };

  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const options = { jwksUrl: 'https://issuer.example/jwks', audience: 'client-id', issuers: ['https://issuer.example'], nonce: 'nonce-1' };
  try {
    const valid = await makeJwt({});
    assert.equal((await verifyOidcIdToken(valid, options)).sub, 'provider-user');
    await assert.rejects(() => verifyOidcIdToken(valid, { ...options, nonce: 'wrong' }), /nonce mismatch/);
    await assert.rejects(() => verifyOidcIdToken(valid, { ...options, audience: 'wrong' }), /aud mismatch/);
    await assert.rejects(() => verifyOidcIdToken(valid, { ...options, issuers: ['https://wrong.example'] }), /iss mismatch/);
    const wrongAzp = await makeJwt({ aud: ['client-id', 'other'], azp: 'other' });
    await assert.rejects(() => verifyOidcIdToken(wrongAzp, options), /azp mismatch/);
    const expired = await makeJwt({ exp: now - 1 });
    await assert.rejects(() => verifyOidcIdToken(expired, options), /expired/);
    const parts = valid.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await assert.rejects(() => verifyOidcIdToken(parts.join('.'), options), /bad signature/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('Apple client secret is a valid ES256 JWT with configured claims', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const pemBody = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n');
  const env = {
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_CLIENT_ID: 'com.example.web',
    APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`,
  };

  const token = await appleClientSecret(env);
  const [headPart, bodyPart, signaturePart] = token.split('.');
  const head = JSON.parse(Buffer.from(headPart, 'base64url').toString());
  const body = JSON.parse(Buffer.from(bodyPart, 'base64url').toString());
  assert.deepEqual(head, { alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' });
  assert.equal(body.iss, env.APPLE_TEAM_ID);
  assert.equal(body.sub, env.APPLE_CLIENT_ID);
  assert.equal(body.aud, 'https://appleid.apple.com');
  assert.ok(body.exp > body.iat && body.exp - body.iat <= 30 * 86400);
  assert.equal(Buffer.from(signaturePart, 'base64url').byteLength, 64);
  assert.equal(await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    Buffer.from(signaturePart, 'base64url'),
    enc.encode(headPart + '.' + bodyPart),
  ), true);
});
