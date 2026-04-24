'use strict';

const crypto = require('crypto');
const { warn } = require('./logger');

let _devModeWarned = false;
let _devMode = false;

/**
 * Check whether AUTH_TOKEN env var is set and configure dev mode.
 * Should be called once at server startup.
 */
function init() {
  if (!process.env.AUTH_TOKEN) {
    _devMode = true;
    if (!_devModeWarned) {
      warn('AUTH_TOKEN not set - accepting any token (dev mode)');
      _devModeWarned = true;
    }
  } else {
    _devMode = false;
  }
}

/**
 * Authenticate a connection token.
 * @param {string} token - Token from the WebSocket query string.
 * @returns {{ ok: boolean, reason: string }}
 */
function authenticate(token) {
  // Token must be a non-empty string.
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'missing token' };
  }

  // Dev mode: accept any non-empty token when AUTH_TOKEN is not configured.
  if (_devMode) {
    return { ok: true, reason: '' };
  }

  // Production: token must match AUTH_TOKEN env var (timing-safe comparison).
  const expected = Buffer.from(process.env.AUTH_TOKEN, 'utf8');
  const provided = Buffer.from(token, 'utf8');
  if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
    return { ok: true, reason: '' };
  }

  return { ok: false, reason: 'invalid token' };
}

module.exports = { init, authenticate };
