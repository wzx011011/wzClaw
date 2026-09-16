'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectZcodeConfiguration, normalizeImportSelection, resolveZcodeInstallation } = require('../zcode-integration');

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
