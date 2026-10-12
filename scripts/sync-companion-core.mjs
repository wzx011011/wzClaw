#!/usr/bin/env node
// 从 relay/zcode（唯一事实源）同步 companion 核心到开源 ZCode 桌面端的
// packages/desktop/companion-core/（逐字拷贝，勿改逻辑，见该目录 README.md）。
//
// 用法：
//   node scripts/sync-companion-core.mjs [desktop 检出路径]
// desktop 路径缺省取本仓库的 desktop submodule（<repoRoot>/desktop，2026-09-21
// 起的唯一桌面形态）；可用环境变量 WZXCLAW_DESKTOP 覆盖。目标不存在/缺
// companion.js 时报错退出。
//
// 同步后必须在 desktop 仓库提交，并与本仓库的 relay 核心变更同一变更集，
// 保证「哪版 wzxClaw 配哪版桌面端」可追溯（协议契约耦合）。

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'relay', 'zcode');

const argTarget = process.argv[2];
const defaultTarget = process.env.WZXCLAW_DESKTOP || path.join(repoRoot, 'desktop');
const desktopRoot = path.resolve(repoRoot, argTarget || defaultTarget);
const targetRoot = path.join(desktopRoot, 'packages', 'desktop', 'companion-core');

const files = [
  'companion.js',
  'lib/constants.js',
  'lib/engine-history.js',
  'lib/plan-overlay.js',
  'lib/proof.js',
  'lib/protocol.js',
  'lib/runtime-resolver.js',
  'lib/state-path.js',
  'vendor/zcode-protocol.cjs',
];

for (const relative of files) {
  const source = path.join(sourceRoot, relative);
  if (!existsSync(source) || !statSync(source).isFile()) {
    console.error(`[sync] 源文件缺失: ${source}`);
    process.exit(1);
  }
}
if (!existsSync(path.join(targetRoot, 'companion.js'))) {
  console.error(
    `[sync] 目标不是 companion-core 检出（缺 companion.js）: ${targetRoot}\n` +
      '       用法: node scripts/sync-companion-core.mjs <desktop 检出路径>',
  );
  process.exit(1);
}

for (const relative of files) {
  const target = path.join(targetRoot, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(sourceRoot, relative), target);
  console.log(`[sync] ${relative}`);
}
console.log(
  `[sync] 完成：${files.length} 个文件 → ${targetRoot}\n` +
    '[sync] 记得在 desktop 仓库提交，并与 relay 核心变更同一变更集。',
);
