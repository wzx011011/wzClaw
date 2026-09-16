'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const asar = require('@electron/asar');

const requiredFiles = [
  '/main.js',
  '/preload.js',
  '/runtime-gate.js',
  '/zcode-integration.js',
  '/renderer/index.html',
  '/renderer/renderer.js',
  '/cclient/companion.js',
];

function assertPackageContents(archivePath) {
  const entries = new Set(asar.listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')));
  for (const required of requiredFiles) assert.equal(entries.has(required), true, `package missing ${required}`);
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    assert.equal(lower.includes('zcode.cjs'), false, `package must not bundle ZCode runtime: ${entry}`);
    assert.equal(lower.includes('zcode-runtime'), false, `package must not bundle ZCode runtime: ${entry}`);
  }
}

test('built package includes host modules and does not bundle ZCode runtime', (t) => {
  const archivePath = process.env.COMPANION_ASAR;
  if (!archivePath) return t.skip('set COMPANION_ASAR after dist:dir');
  assert.equal(fs.existsSync(archivePath), true, `missing ${archivePath}`);
  assertPackageContents(path.resolve(archivePath));
});

module.exports = { assertPackageContents };
