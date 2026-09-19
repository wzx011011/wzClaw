'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');

const requiredFiles = [
  '/main.js',
  '/preload.js',
  '/runtime-gate.js',
  '/zcode-integration.js',
  '/zcode-importer.js',
  '/renderer/index.html',
  '/renderer/renderer.js',
  '/cclient/companion.js',
  '/cclient/lib/constants.js',
  '/cclient/lib/runtime-resolver.js',
  '/cclient/lib/state-path.js',
];

const forbiddenCoreFiles = ['/cclient/server.js'];

// 内嵌 runtime 双模式（2026-09-17 策略）：以构建预备脚本产出的 manifest 为准。
// bundled:true  → resources/zcode-runtime 必须存在且含 zcode.cjs，且绝不携带
//                 用户配置/凭据形态文件；asar 内仍不得出现 runtime（asar 外分发）。
// bundled:false → CI/无源构建：包内外都必须不含 runtime（旧契约保持）。
function runtimeBundleManifest() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'runtime-bundle', 'manifest.json'), 'utf8'),
    );
  } catch {
    return { bundled: false, reason: 'manifest 缺失' };
  }
}

const FORBIDDEN_RUNTIME_HINTS = ['zcode.cjs', 'zcode-runtime'];
const FORBIDDEN_CREDENTIAL_NAMES = [
  'config.json', 'credentials.json', 'credential', 'token', 'secret',
  'setting.json', 'coding-plan-cache', 'auth',
];

// manifest 随包分发：必须只含确定性字段（来源枚举/体积/内容哈希或固定枚举
// reason），绝不携带构建机绝对路径与时间戳；哈希须与包内 runtime 一致。
function assertManifestShape(manifest, runtimeDir) {
  const keys = Object.keys(manifest).sort();
  if (manifest.bundled === true) {
    assert.deepEqual(keys, ['bundled', 'bytes', 'runtimeSha256', 'sourceType'],
      `bundled manifest must only carry deterministic fields, got ${keys}`);
    assert.equal(['environment', 'installed'].includes(manifest.sourceType), true,
      `manifest.sourceType must be an enum, got ${manifest.sourceType}`);
    const cjs = path.join(runtimeDir, 'glm', 'zcode.cjs');
    assert.equal(
      createHash('sha256').update(fs.readFileSync(cjs)).digest('hex'),
      manifest.runtimeSha256,
      'bundled runtime hash must match manifest.runtimeSha256',
    );
  } else {
    assert.deepEqual(keys, ['bundled', 'reason'],
      `empty manifest must only carry bundled+reason, got ${keys}`);
    assert.equal(['source-not-found', 'copy-failed'].includes(manifest.reason), true,
      `manifest.reason must be a fixed enum, got ${manifest.reason}`);
  }
}

function assertPackageContents(archivePath) {
  const manifest = runtimeBundleManifest();
  const entries = new Set(asar.listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')));
  for (const required of requiredFiles) assert.equal(entries.has(required), true, `package missing ${required}`);
  for (const forbidden of forbiddenCoreFiles) {
    assert.equal(entries.has(forbidden), false, `package must not include relay runtime ${forbidden}`);
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    for (const hint of FORBIDDEN_RUNTIME_HINTS) {
      assert.equal(lower.includes(hint), false, `asar must not carry runtime (use extraResources): ${entry}`);
    }
  }
  const resourcesRoot = path.dirname(path.resolve(archivePath));
  const runtimeDir = path.join(resourcesRoot, 'zcode-runtime');
  if (manifest.bundled === true) {
    assertManifestShape(manifest, runtimeDir);
    const cjs = path.join(runtimeDir, 'glm', 'zcode.cjs');
    assert.equal(fs.existsSync(cjs), true, `bundled build must ship runtime at ${cjs}`);
    // 凭据零容忍：内嵌目录只允许 glm/{zcode.cjs,packages/**}
    const violations = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        const lower = entry.name.toLowerCase();
        if (FORBIDDEN_CREDENTIAL_NAMES.some((n) => lower.includes(n))) violations.push(p);
      }
    };
    walk(runtimeDir);
    assert.deepEqual(violations, [], `bundled runtime must not carry credential-like files: ${violations}`);
  } else {
    assertManifestShape(manifest, runtimeDir);
    // 非 bundled 构建：extraResources 仍会拷出含 manifest 的 zcode-runtime
    // 目录（prepare-runtime 的空形态），但绝不能携带 runtime 本体
    assert.equal(
      fs.existsSync(path.join(runtimeDir, 'glm', 'zcode.cjs')),
      false,
      'non-bundled build must not ship zcode-runtime/glm/zcode.cjs',
    );
  }
}

test('built package includes host modules and consistent runtime mode', (t) => {
  const archivePath = process.env.COMPANION_ASAR;
  if (!archivePath) return t.skip('set COMPANION_ASAR after dist:dir');
  assert.equal(fs.existsSync(archivePath), true, `missing ${archivePath}`);
  assertPackageContents(path.resolve(archivePath));
});

module.exports = { assertPackageContents };
