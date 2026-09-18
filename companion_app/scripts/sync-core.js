'use strict';

const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(appRoot, '..', 'relay', 'zcode');
const targetRoot = path.join(appRoot, 'cclient');
const files = Object.freeze([
  'companion.js',
  'lib/constants.js',
  'lib/plan-overlay.js',
  'lib/proof.js',
  'lib/protocol.js',
  'lib/runtime-resolver.js',
  'lib/state-path.js',
]);

function syncCore() {
  const expected = new Set(files.map((file) => path.normalize(file)));
  fs.rmSync(targetRoot, { recursive: true, force: true });
  for (const relative of files) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    if (!fs.statSync(source).isFile()) throw new Error(`核心源码不存在: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return expected.size;
}

if (require.main === module) {
  const count = syncCore();
  process.stdout.write(`已同步 ${count} 个核心源码文件到 cclient\n`);
}

module.exports = { files, syncCore };
