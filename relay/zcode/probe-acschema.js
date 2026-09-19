// probe-acschema.js — 探明 provider/updateAccountConfig 的参数 schema。
// 用 zod 的 -32602 报错反推期望形状（发空对象，无副作用）。只读探针纪律。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const resolved = resolveZcodeRuntime();
if (resolved.category !== 'resolved') { console.log('runtime 未解析'); process.exit(1); }
let token;
try { token = readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')); }
catch (error) { console.log(`登录态不可读 ${error.code}`); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-acschema-'));
const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
  cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: runtimeProcessEnv(resolved, { ...process.env, ANTHROPIC_API_KEY: token }),
});
let buf = ''; const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk; let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim(); buf = buf.slice(index + 1);
    if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.id != null && pending.has(frame.id)) { const s = pending.get(frame.id); pending.delete(frame.id); s(frame); }
    else if (frame.method === 'session/requestRuntimePreferences' || frame.method === 'startup/storageState') {
      // storageState 是新发现的反向请求：先记录，不改答（探schema不受影响）
      child.stdin.write(`${JSON.stringify({ id: frame.id, error: { code: -32022, message: 'probe does not handle' } })}\n`);
    }
  }
});
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = `ac-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 15000).unref();
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
(async () => {
  const r1 = await rpc('provider/updateAccountConfig', {});
  console.log('空参数响应:', r1.error
    ? `${r1.error.code}: ${String(r1.error.message).slice(0, 500)}`
    : `意外成功: ${JSON.stringify(r1.result).slice(0, 200)}`);
  child.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }, 1000).unref();
})();
