const test = require('node:test');
const assert = require('node:assert');
const { extractToken } = require('../lib/authToken');

function mkReq({ headers = {}, query = {}, cookies = {}, method = 'GET' } = {}) {
  return {
    method,
    query,
    cookies,
    get(name) { return headers[name.toLowerCase()]; },
  };
}

test('reads Bearer token from Authorization header', () => {
  const req = mkReq({ headers: { authorization: 'Bearer abc123' } });
  assert.strictEqual(extractToken(req), 'abc123');
});

test('ignores non-Bearer Authorization schemes', () => {
  const req = mkReq({ headers: { authorization: 'Basic zzz' } });
  assert.strictEqual(extractToken(req), null);
});

test('reads access_token query only on GET', () => {
  assert.strictEqual(extractToken(mkReq({ query: { access_token: 'q1' }, method: 'GET' })), 'q1');
  assert.strictEqual(extractToken(mkReq({ query: { access_token: 'q1' }, method: 'POST' })), null);
});

test('falls back to sid cookie', () => {
  const req = mkReq({ cookies: { sid: 'cookie999' } });
  assert.strictEqual(extractToken(req), 'cookie999');
});

test('header wins over query wins over cookie', () => {
  const req = mkReq({
    headers: { authorization: 'Bearer H' },
    query: { access_token: 'Q' },
    cookies: { sid: 'C' },
    method: 'GET',
  });
  assert.strictEqual(extractToken(req), 'H');
});

test('returns null when nothing present or blank', () => {
  assert.strictEqual(extractToken(mkReq()), null);
  assert.strictEqual(extractToken(mkReq({ headers: { authorization: 'Bearer    ' } })), null);
});
