'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/auth');

describe('authenticate()', () => {
  const originalAuthToken = process.env.AUTH_TOKEN;

  beforeEach(() => {
    // Reset module state between tests.
    delete process.env.AUTH_TOKEN;
  });

  afterEach(() => {
    // Restore original env.
    if (originalAuthToken !== undefined) {
      process.env.AUTH_TOKEN = originalAuthToken;
    } else {
      delete process.env.AUTH_TOKEN;
    }
  });

  it('returns ok:true when token matches AUTH_TOKEN', () => {
    process.env.AUTH_TOKEN = 'valid-token';
    auth.init();
    const result = auth.authenticate('valid-token');
    assert.equal(result.ok, true);
    assert.equal(result.reason, '');
  });

  it('returns ok:false with reason "invalid token" when token does not match', () => {
    process.env.AUTH_TOKEN = 'valid-token';
    auth.init();
    const result = auth.authenticate('wrong-token');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid token');
  });

  it('returns ok:false with reason "missing token" for empty string', () => {
    process.env.AUTH_TOKEN = 'valid-token';
    auth.init();
    const result = auth.authenticate('');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing token');
  });

  it('returns ok:false with reason "missing token" for null', () => {
    process.env.AUTH_TOKEN = 'valid-token';
    auth.init();
    const result = auth.authenticate(null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing token');
  });

  it('returns ok:false with reason "missing token" for whitespace-only string', () => {
    process.env.AUTH_TOKEN = 'valid-token';
    auth.init();
    const result = auth.authenticate('   ');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing token');
  });

  it('returns ok:true for any non-empty token in dev mode (AUTH_TOKEN not set)', () => {
    auth.init();
    const result = auth.authenticate('any-token');
    assert.equal(result.ok, true);
  });
});
