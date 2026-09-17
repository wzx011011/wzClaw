'use strict';

// ============================================================
// prepare-runtime — 构建「内嵌 ZCode runtime」预备脚本
//
// 策略（2026-09-17 用户决策）：废止「不打包/不分发」旧规则，允许把
// 本机官方安装的 runtime 内嵌进 Companion 自用安装包（不公开分发）；
// 运行时仍优先本机官方安装，内嵌只作未安装环境的兜底。
//
// 源优先级：ZCODE_BUNDLE_SRC 环境变量 → %LOCALAPPDATA%\Programs\ZCode\resources\glm
// 产物：runtime-bundle/{glm/zcode.cjs, glm/packages/, manifest.json}
// - manifest.bundled=false（CI 无源）时输出空目录，包内不含 runtime，
//   应用回退「未安装引导」路径——两种形态都被 package-contents 测试钉住。
// - 只拷贝 runtime 自身（zcode.cjs + packages/），绝不拷贝用户配置、
//   凭据、日志或任何 ~/.zcode 内容。
// 挂载：package.json 的 predist / predist:dir 钩子自动执行。
// ============================================================

const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_DIR = path.join(__dirname, '..', 'runtime-bundle');
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 防拷错目录（实测 glm/ ≈ 49MB）

function candidateSources(env = process.env) {
  const list = [];
  if (env.ZCODE_BUNDLE_SRC) list.push(env.ZCODE_BUNDLE_SRC);
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    list.push(path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm'));
  }
  return list;
}

function resolveSource(env = process.env) {
  for (const candidate of candidateSources(env)) {
    const cjs = path.join(candidate, 'zcode.cjs');
    const packages = path.join(candidate, 'packages');
    try {
      if (fs.statSync(cjs).isFile()) {
        return { root: candidate, cjs, packages: fs.statSync(packages).isDirectory() ? packages : null };
      }
    } catch { /* 尝试下一个候选 */ }
  }
  return null;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : entry.statSync?.().size ?? fs.statSync(p).size;
  }
  return total;
}

// 从官方安装读 runtime 版本（不执行任何代码；zcode.cjs 是打包 JS，无明文版本号，
// 故以 packages 目录 mtime + 文件大小做指纹，版本真值由运行时 gate 上报）
function copyRuntime(source) {
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BUNDLE_DIR, 'glm'), { recursive: true });
  fs.copyFileSync(source.cjs, path.join(BUNDLE_DIR, 'glm', 'zcode.cjs'));
  if (source.packages) {
    fs.cpSync(source.packages, path.join(BUNDLE_DIR, 'glm', 'packages'), { recursive: true });
  }
  const total = dirSize(BUNDLE_DIR);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`内嵌 runtime 体积异常（${(total / 1024 / 1024).toFixed(1)}MB > 200MB），疑似拷错源目录`);
  }
  const manifest = {
    bundled: true,
    source: source.root,
    bytes: total,
    copiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(BUNDLE_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),);
  console.log(`[prepare-runtime] bundled ${(total / 1024 / 1024).toFixed(1)}MB from ${source.root}`);
}

function writeEmptyBundle(reason) {
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  const manifest = { bundled: false, reason, copiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(BUNDLE_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),);
  console.log(`[prepare-runtime] not bundled: ${reason}`);
}

function main() {
  const source = resolveSource();
  if (!source) {
    writeEmptyBundle('未找到本机官方 ZCode 安装（也未设置 ZCODE_BUNDLE_SRC）');
    return;
  }
  try {
    copyRuntime(source);
  } catch (e) {
    // 拷贝失败必须让构建失败（宁可不打包也不出半份 bundle）
    writeEmptyBundle(`拷贝失败：${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { candidateSources, resolveSource, BUNDLE_DIR };
