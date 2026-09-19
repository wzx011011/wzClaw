// 复刻 gate probeAppServer 的完整交互时序（一次性诊断脚本）
'use strict';
const { spawn } = require('child_process');
const EXE = 'C:/Users/67376/AppData/Local/Programs/wzxclaw-companion-app/wzxClaw Companion.exe';
const RT = 'C:/Users/67376/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs';
const NL = String.fromCharCode(10);
const child = spawn(EXE, [RT, 'app-server', '--cwd', 'C:/Users/67376'], {
  cwd: 'C:/Users/67376', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
let buf = ''; let err = '';
const t0 = Date.now();
const log = (m) => console.log('[' + (Date.now() - t0) + 'ms] ' + m);
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf(NL)) !== -1) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { log('BAD_LINE ' + line.slice(0, 80)); continue; }
    if (f.method && f.id != null) {
      log('REVERSE ' + f.method + ' id=' + f.id);
      const resp = f.method === 'session/requestRuntimePreferences'
        ? { id: f.id, result: { nativeSearchEnhancementsEnabled: false } }
        : { id: f.id, error: { code: -32000, message: 'probe does not handle' } };
      child.stdin.write(JSON.stringify(resp) + NL);
    } else if (f.id === 1) {
      log('SESSION_LIST_RESPONSE ' + JSON.stringify(f).slice(0, 150));
    } else {
      log('OTHER ' + JSON.stringify(f).slice(0, 120));
    }
  }
});
child.stderr.on('data', (d) => { err += d; });
child.on('exit', (code) => {
  log('ENGINE_EXIT code=' + code + ' stderr=' + err.slice(0, 200));
  process.exit(0);
});
child.stdin.write('{"id":1,"method":"session/list","params":{}}' + NL);
setTimeout(() => { log('still alive at 20s — kill'); child.kill(); process.exit(0); }, 20000);
