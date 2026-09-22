'use strict';
// companion-core 同步漂移测试（P0 复现锚）：
// 曾因 sync 脚本 files 清单漏列 lib/engine-history.js，47eeba1 同步后桌面端
// companion.js 顶层 require 直接 MODULE_NOT_FOUND，且重跑同步也修不好。
// 契约：sync 清单必须覆盖 companion.js 的全部相对 require；desktop 检出存在时，
// 每个被 require 的文件必须真实存在。改 companion 依赖或 sync 清单必须双侧同改。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const coreRoot = path.resolve(__dirname, '..'); // relay/zcode
const repoRoot = path.resolve(coreRoot, '..', '..'); // 仓库根
const companionSource = path.join(coreRoot, 'companion.js');
const syncScript = path.join(repoRoot, 'scripts', 'sync-companion-core.mjs');
const desktopCore = path.join(repoRoot, 'desktop', 'packages', 'desktop', 'companion-core');

function readRelativeRequires(file) {
  const source = fs.readFileSync(file, 'utf8');
  const requires = [];
  for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
    requires.push(match[1]);
  }
  assert.ok(requires.length > 0, `${file} 应解析出相对 require`);
  return requires;
}

function readSyncFileList() {
  const source = fs.readFileSync(syncScript, 'utf8');
  const block = source.match(/const files = \[([^\]]+)\]/);
  assert.ok(block, 'sync 脚本应含 files 数组');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('sync 清单覆盖 companion.js 全部相对 require', () => {
  const requires = readRelativeRequires(companionSource)
    .map((rel) => path.normalize(rel).replaceAll('\\', '/'))
    .map((rel) => (rel.endsWith('.js') || rel.endsWith('.cjs') ? rel : `${rel}.js`));
  const listed = new Set(readSyncFileList());
  const missing = [...new Set(requires)].filter((rel) => !listed.has(rel));
  assert.deepStrictEqual(missing, [], `sync 清单缺列: ${missing.join(', ')}`);
});

test('desktop 检出存在时，被 require 的文件必须真实存在', { skip: !fs.existsSync(path.join(desktopCore, 'companion.js')) }, () => {
  const requires = readRelativeRequires(companionSource)
    .map((rel) => (rel.endsWith('.js') || rel.endsWith('.cjs') ? rel : `${rel}.js`));
  const missing = [...new Set(requires)]
    .map((rel) => path.join(desktopCore, rel))
    .filter((target) => !fs.existsSync(target));
  assert.deepStrictEqual(
    missing.map((p) => path.relative(repoRoot, p)),
    [],
    'desktop companion-core 缺文件：重跑 node scripts/sync-companion-core.mjs 并双侧提交',
  );
});

test('sync 清单中的每个文件在源侧真实存在', () => {
  for (const relative of readSyncFileList()) {
    assert.ok(
      fs.existsSync(path.join(coreRoot, relative)),
      `sync 清单指向不存在的源文件: ${relative}`,
    );
  }
});
