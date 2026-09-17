'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { files, syncCore } = require('../scripts/sync-core');
const { resolveCompanionStatePaths } = require('../cclient/lib/state-path');

const sourceRoot = path.resolve(__dirname, '..', '..', 'relay', 'zcode');
const targetRoot = path.resolve(__dirname, '..', 'cclient');

test('sync-core deterministically mirrors the declared core source set', () => {
  assert.equal(syncCore(), files.length);
  for (const relative of files) {
    const digest = (root) => createHash('sha256')
      .update(fs.readFileSync(path.join(root, relative))).digest('hex');
    assert.equal(digest(targetRoot), digest(sourceRoot), relative);
  }
});

test('state path resolver binds explicit GUI snapshot path without moving shared identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-state-path-'));
  const snapshotPath = path.join(root, 'imports', 'snapshot.json');
  const paths = resolveCompanionStatePaths({ stateDir: root, snapshotPath });
  assert.equal(paths.stateDir, path.resolve(root));
  assert.equal(paths.midFile, path.join(path.resolve(root), 'mid'));
  assert.equal(paths.snapshotPath, path.resolve(snapshotPath));
  assert.equal(paths.modelDefaultFile, path.join(path.resolve(root), 'model-default.json'));
  fs.rmSync(root, { recursive: true, force: true });
});
