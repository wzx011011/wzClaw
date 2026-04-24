'use strict';

function _format(level, msg) {
  const ts = new Date().toISOString();
  return `[RELAY ${ts}] [${level}] ${msg}\n`;
}

function log(msg) {
  process.stdout.write(_format('INFO', msg));
}

function warn(msg) {
  process.stderr.write(_format('WARN', msg));
}

function error(msg) {
  process.stderr.write(_format('ERROR', msg));
}

module.exports = { log, warn, error };
