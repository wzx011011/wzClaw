'use strict';

// companion_app/cclient 拷贝漂移钉子：cclient/ 是 relay/zcode 源码的原样
// 拷贝（Electron 壳内嵌运行），任何一侧单独改动都会造成行为漂移——
// 本测试强制两侧逐字节一致；有意的变更必须双侧同步提交。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SRC = path.join(__dirname, '..');
const DST = path.join(__dirname, '..', '..', '..', 'companion_app', 'cclient');

const PAIRS = ['companion.js', 'lib/constants.js', 'lib/proof.js', 'lib/protocol.js',
  'lib/runtime-resolver.js', 'lib/state-path.js'];

test('companion_app/cclient 与 relay/zcode 源码零漂移', () => {
  for (const rel of PAIRS) {
    const a = fs.readFileSync(path.join(SRC, rel));
    const b = fs.readFileSync(path.join(DST, rel));
    const ha = createHash('sha256').update(a).digest('hex');
    const hb = createHash('sha256').update(b).digest('hex');
    assert.equal(hb, ha,
      `cclient/${rel} 与 relay/zcode/${rel} 漂移——修复或有意的变更必须双侧同步提交`);
  }
});
