'use strict';

const os = require('node:os');
const path = require('node:path');

function resolveCompanionStatePaths({ stateDir, midFile, snapshotPath } = {}) {
  const resolvedStateDir = path.resolve(stateDir
    || (midFile ? path.dirname(midFile) : path.join(os.homedir(), '.wzxclaw', 'zcode-companion')));
  return Object.freeze({
    stateDir: resolvedStateDir,
    midFile: path.resolve(midFile || path.join(resolvedStateDir, 'mid')),
    snapshotPath: path.resolve(snapshotPath || path.join(resolvedStateDir, 'import-snapshot.json')),
    passHashFile: path.join(resolvedStateDir, 'passhash'),
    lockFile: path.join(resolvedStateDir, 'companion.lock'),
    modelDefaultFile: path.join(resolvedStateDir, 'model-default.json'),
    relaySecretFile: path.join(resolvedStateDir, 'relay-secret'),
  });
}

module.exports = { resolveCompanionStatePaths };
