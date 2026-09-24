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

// 从某源文件出发递归收集全部相对 require（含 lib/* 的传递依赖）：只查
// companion.js 一层会漏掉「lib 文件新增相对 require」的漂移（复评 P3）。
function readRelativeRequiresTransitive(entryFile) {
  const seen = new Set(); // 规范化相对 coreRoot 的路径
  const queue = [path.normalize(entryFile)];
  while (queue.length) {
    const file = queue.shift();
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
      // Node 的相对 require 省略扩展名：入队前补 .js 再读
      const base = path.resolve(path.dirname(file), match[1]);
      const resolved = /\.(js|cjs)$/.test(base) ? base : `${base}.js`;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (resolved.startsWith(path.join(coreRoot, 'lib'))) queue.push(resolved);
    }
  }
  assert.ok(seen.size > 1, '至少应解析出 companion.js + 一个 lib 依赖');
  return [...seen]
    .map((abs) => path.relative(coreRoot, abs).replaceAll('\\', '/'))
    .map((rel) => (rel.endsWith('.js') || rel.endsWith('.cjs') ? rel : `${rel}.js`))
    .sort();
}

function readSyncFileList() {
  const source = fs.readFileSync(syncScript, 'utf8');
  const block = source.match(/const files = \[([^\]]+)\]/);
  assert.ok(block, 'sync 脚本应含 files 数组');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('sync 清单覆盖 companion.js 全部相对 require（含 lib 传递依赖）', () => {
  const requires = readRelativeRequiresTransitive(companionSource);
  const listed = new Set(readSyncFileList());
  const missing = requires.filter((rel) => !listed.has(rel));
  assert.deepStrictEqual(missing, [], `sync 清单缺列: ${missing.join(', ')}`);
});

test('desktop 检出存在时，被 require 的文件必须真实存在', { skip: !fs.existsSync(path.join(desktopCore, 'companion.js')) }, () => {
  const requires = readRelativeRequiresTransitive(companionSource);
  const missing = requires
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
