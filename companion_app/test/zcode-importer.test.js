'use strict';

// 导入执行器契约：勾选裁剪、凭据零泄漏、原子写入、幂等重扫、空选拒绝。

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyImport, readSnapshot, snapshotSummary, normalizeSelection, SNAPSHOT_SCHEMA_VERSION } = require('../zcode-importer');

function memoryFs() {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    writeFileSync(file, data, options) {
      assert.equal(options.mode, 0o600, '快照必须 0600');
      assert.ok(file.endsWith('.tmp'), '必须先写临时文件再原子改名');
      files.set(file, data);
    },
    renameSync(from, to) {
      assert.ok(files.has(from), 'rename 前临时文件必须存在');
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileSync(file) {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
  };
}

const MANIFEST = {
  models: { selectedModel: 'p/m', providers: [{ id: 'a', name: 'A', hasCredential: false, modelIds: ['m1'] }] },
  workspaces: ['C:\\ws\\a', 'C:\\ws\\b'],
  preferences: { locale: 'zh-CN' },
  extensions: { skills: ['s'], plugins: [], commands: [], mcpCount: 2 },
};

test('normalizeSelection 只接受已知类别且必须显式 true', () => {
  assert.deepEqual(normalizeSelection({ models: true, workspaces: 'yes', preferences: 1, hacked: true }), {
    models: true,
  });
  assert.deepEqual(normalizeSelection(null), {});
});

test('applyImport 按勾选裁剪类别并写 0600 原子快照', () => {
  const fsApi = memoryFs();
  const receipt = applyImport({
    manifest: MANIFEST,
    selection: { models: true, workspaces: true },
    snapshotPath: '/data/import-snapshot.json',
    fsApi,
    now: new Date('2026-09-16T08:00:00Z'),
  });
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.counts, { models: 1, workspaces: 2 });
  const snapshot = JSON.parse(fsApi.files.get('/data/import-snapshot.json'));
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.importedAt, '2026-09-16T08:00:00.000Z');
  assert.deepEqual(Object.keys(snapshot.categories).sort(), ['models', 'workspaces']);
  assert.equal('preferences' in snapshot.categories, false);
});

test('applyImport 空勾选明确拒绝，不写任何文件', () => {
  const fsApi = memoryFs();
  for (const selection of [{}, null, { workspaces: false }]) {
    const receipt = applyImport({
      manifest: MANIFEST, selection,
      snapshotPath: '/data/import-snapshot.json', fsApi,
    });
    assert.equal(receipt.ok, false);
    assert.match(receipt.error, /未选择/);
  }
  assert.equal(fsApi.files.size, 0);
});

test('applyImport manifest 不可用时拒绝且不写半份快照', () => {
  const fsApi = memoryFs();
  const receipt = applyImport({
    manifest: null, selection: { models: true },
    snapshotPath: '/data/import-snapshot.json', fsApi,
  });
  assert.equal(receipt.ok, false);
  assert.equal(fsApi.files.size, 0);
});

test('重扫导入覆盖旧快照（幂等），readSnapshot/summary 只认当前 schema', () => {
  const fsApi = memoryFs();
  const path = '/data/import-snapshot.json';
  const first = applyImport({
    manifest: MANIFEST, selection: { models: true },
    snapshotPath: path, fsApi, now: new Date('2026-09-16T08:00:00Z'),
  });
  assert.equal(first.ok, true);
  applyImport({
    manifest: MANIFEST, selection: { preferences: true, extensions: true },
    snapshotPath: path, fsApi, now: new Date('2026-09-16T09:00:00Z'),
  });
  const snapshot = readSnapshot(path, fsApi);
  assert.deepEqual(Object.keys(snapshot.categories).sort(), ['extensions', 'preferences']);
  assert.equal(snapshot.categories.preferences.locale, 'zh-CN');

  const summary = snapshotSummary(path, fsApi);
  assert.equal(summary.importedAt, '2026-09-16T09:00:00.000Z');
  assert.deepEqual(summary.counts, { preferences: 1, extensions: 3 });

  fsApi.files.set(path, '{"schemaVersion": 999}');
  assert.equal(readSnapshot(path, fsApi), null);
  assert.equal(snapshotSummary(path, fsApi), null);
  fsApi.files.set(path, 'not json');
  assert.equal(snapshotSummary(path, fsApi), null);
});
