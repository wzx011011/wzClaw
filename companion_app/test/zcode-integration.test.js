'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectZcodeConfiguration, normalizeImportSelection, resolveZcodeInstallation,
  buildImportManifest, PREFERENCE_ALLOWLIST } = require('../zcode-integration');

function fakeFs(files) {
  const keyFor = (file) => file.replaceAll('\\', '/');
  return {
    statSync(file) {
      const key = keyFor(file);
      if (!Object.hasOwn(files, key)) throw new Error('ENOENT');
      return { isFile: () => true, size: Buffer.byteLength(files[key]) };
    },
    readFileSync(file) { return files[keyFor(file)]; },
  };
}

test('detects only an existing explicit ZCode executable', () => {
  const fsApi = fakeFs({ 'C:/zcode.cjs': 'module.exports = {}' });
  assert.deepEqual(resolveZcodeInstallation({ fsApi, env: { ZCODE_BIN: 'C:\\zcode.cjs' } }), {
    status: 'found', source: 'environment', command: 'C:\\zcode.cjs',
  });
  assert.equal(resolveZcodeInstallation({ fsApi, env: { ZCODE_BIN: 'missing' } }).status, 'not-found');
});

test('configuration summary never returns credential values', () => {
  const homeDir = '/home/test';
  const fsApi = fakeFs({
    '/home/test/.zcode/v2/config.json': JSON.stringify({
      provider: { 'builtin:test': { name: 'Test', options: { apiKey: 'do-not-leak' } } },
    }),
    '/home/test/.zcode/cli/config.json': JSON.stringify({ model: 'builtin:test/model', skills: ['safe-skill'] }),
  });
  const result = inspectZcodeConfiguration({ fsApi, homeDir });
  assert.equal(result.metadata.providers[0].hasCredential, true);
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
  assert.equal(result.credentials.status, 'available');
});

test('invalid configuration remains a safe status without raw content', () => {
  const homeDir = '/home/test';
  const fsApi = fakeFs({ '/home/test/.zcode/cli/config.json': '{secret: broken' });
  const result = inspectZcodeConfiguration({ fsApi, homeDir });
  assert.equal(result.metadata.status, 'invalid');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('selection defaults to safe metadata and keeps executable extensions opt-in', () => {
  assert.deepEqual(normalizeImportSelection({}), {
    modelMetadata: true, preferences: true, workspaces: false, extensions: false,
  });
});

// ---- buildImportManifest（导入清单，实测形状见本仓库 2026-09-16 本机扫描） ----

function manifestFixture() {
  return {
    '/home/test/.zcode/cli/config.json': JSON.stringify({
      model: 'builtin:bigmodel-coding-plan/glm-5.3',
      skills: ['skill-a', 'skill-b'],
      plugins: { 'official/browser-use': {} },
      commands: ['review'],
      mcp: { serverA: {}, serverB: {} },
      provider: { 'builtin:bigmodel-coding-plan': {} },
    }),
    '/home/test/.zcode/v2/model-providers.json': JSON.stringify([
      { id: 'builtin:bigmodel', name: 'Bigmodel', apiKey: '', models: ['glm-5.3', 'glm-4.7', 42] },
      { id: 'default-deepseek', name: 'DeepSeek', apiKey: 'super-secret-key', models: ['deepseek-chat'] },
      { id: '', broken: true },
      'not-an-object',
    ]),
    '/home/test/.zcode/v2/setting.json': JSON.stringify({
      recentProjects: ['C:\\ws\\a', 'C:\\ws\\a', '', 7, 'C:\\ws\\b'],
      locale: 'zh-CN',
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 30,
      // 白名单之外的键一律不导出
      webRemoteControlExternalRelayDevice: { sid: 'do-not-leak' },
    }),
  };
}

test('import manifest extracts models/workspaces/preferences/extensions with counts', () => {
  const manifest = buildImportManifest({ fsApi: fakeFs(manifestFixture()), homeDir: '/home/test' });
  assert.equal(manifest.models.selectedModel, 'builtin:bigmodel-coding-plan/glm-5.3');
  assert.deepEqual(manifest.models.providers.map((p) => p.id).sort(), ['builtin:bigmodel', 'default-deepseek']);
  const bigmodel = manifest.models.providers.find((p) => p.id === 'builtin:bigmodel');
  assert.deepEqual(bigmodel.modelIds, ['glm-5.3', 'glm-4.7']);
  assert.equal(bigmodel.hasCredential, false);
  const deepseek = manifest.models.providers.find((p) => p.id === 'default-deepseek');
  assert.equal(deepseek.hasCredential, true);
  assert.deepEqual(manifest.workspaces, ['C:\\ws\\a', 'C:\\ws\\b']);
  assert.equal(manifest.preferences.locale, 'zh-CN');
  assert.equal(manifest.preferences.taskAutoArchiveEnabled, true);
  assert.deepEqual(manifest.extensions.skills, ['skill-a', 'skill-b']);
  assert.equal(manifest.extensions.mcpCount, 2);
});

test('import manifest never leaks provider API keys or non-allowlisted settings', () => {
  const manifest = buildImportManifest({ fsApi: fakeFs(manifestFixture()), homeDir: '/home/test' });
  const text = JSON.stringify(manifest);
  assert.equal(text.includes('super-secret-key'), false);
  assert.equal(text.includes('do-not-leak'), false);
  assert.equal('webRemoteControlExternalRelayDevice' in manifest.preferences, false);
  for (const key of Object.keys(manifest.preferences)) {
    assert.ok(PREFERENCE_ALLOWLIST.includes(key), `非白名单偏好键 ${key}`);
  }
});

test('import manifest degrades safely when sources are missing or malformed', () => {
  const manifest = buildImportManifest({ fsApi: fakeFs({}), homeDir: '/home/test' });
  assert.deepEqual(manifest.models.providers, []);
  assert.equal(manifest.models.selectedModel, null);
  assert.deepEqual(manifest.workspaces, []);
  assert.deepEqual(manifest.preferences, {});
  assert.deepEqual(manifest.extensions.skills, []);
  assert.ok(manifest.warnings.length >= 2);
  const broken = fakeFs({ '/home/test/.zcode/v2/model-providers.json': '{broken' });
  const m2 = buildImportManifest({ fsApi: broken, homeDir: '/home/test' });
  assert.deepEqual(m2.models.providers, []);
  assert.ok(m2.warnings.some((w) => w.includes('模型目录')));
});
