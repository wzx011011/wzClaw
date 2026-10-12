// probe-storagestate.js — 对照实验：0.16.9 新增反向请求 startup/storageState 对
// session/create 应答完整性的影响。三组：完全不代答 / 只代答 runtimePreferences
// （= 当前 companion 行为）/ 两者都代答。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const resolved = resolveZcodeRuntime();
const token = readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json'));

async function trial(name, answerMode) {
  return new Promise((done) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-tr-'));
    const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
      cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: runtimeProcessEnv(resolved, { ...process.env, ANTHROPIC_API_KEY: token }),
    });
    let buf = '';
    const pending = new Map();
    let nextId = 0;
    let storageStateCount = 0;
    let storageStateParamSample = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.id != null && pending.has(f.id)) { const s = pending.get(f.id); pending.delete(f.id); s(f); }
        else if (f.method === 'session/requestRuntimePreferences') {
          if (answerMode !== 'none') child.stdin.write(JSON.stringify({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } }) + '\n');
        } else if (f.method === 'startup/storageState') {
          storageStateCount++;
          if (!storageStateParamSample) storageStateParamSample = f.params;
          if (answerMode === 'both') child.stdin.write(JSON.stringify({ id: f.id, result: {} }) + '\n');
        }
      }
    });
    const rpc = (method, params, tmo = 25000) => new Promise((res) => {
      const id = 'p' + (++nextId);
      pending.set(id, res);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __timeout: true }); } }, tmo).unref();
      child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
    });
    (async () => {
      const t0 = Date.now();
      const r = await rpc('session/create', {
        workspace: { workspaceKey: 't', workspacePath: tmp },
        persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
      });
      const res = r.result || {};
      console.log(`=== ${name}（耗时 ${Date.now() - t0}ms）===`);
      console.log(`storageState 反向请求数: ${storageStateCount}`);
      console.log(`result keys: ${Object.keys(res).join(',') || '(空)'}`);
      console.log(`session.sessionId: ${JSON.stringify(res.session?.sessionId ?? null)}  settings.model.available: ${res.settings?.model?.available?.length ?? 'ABSENT'}`);
      console.log(`projection.sessionId: ${JSON.stringify(res.projection?.sessionId ?? null)}  protocol: ${JSON.stringify(res.protocol ?? null)}`);
      if (r.error) console.log(`error: ${JSON.stringify(r.error).slice(0, 300)}`);
      if (r.__timeout) console.log('超时未应答');
      if (storageStateParamSample) console.log(`storageState.params keys: ${Object.keys(storageStateParamSample).join(',')}`);
      child.kill();
      setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); done(); }, 1500).unref();
    })();
  });
}

// 用法：node probe-storagestate.js [none|runtime-pref-only|both]（缺省跑全部三组）
const mode = process.argv[2];
(async () => {
  if (mode === 'none') await trial('A. 完全不代答', 'none');
  else if (mode === 'runtime-pref-only') await trial('B. 只代答 runtimePreferences（=当前 companion 行为）', 'runtime-pref-only');
  else if (mode === 'both') await trial('C. 两者都代答（答 {}）', 'both');
  else { await trial('A. 完全不代答', 'none'); await trial('B. 只代答 runtimePreferences（=当前 companion 行为）', 'runtime-pref-only'); await trial('C. 两者都代答（答 {}）', 'both'); }
  process.exit(0);
})().catch((e) => { console.log('FATAL: ' + (e && e.stack || e)); process.exit(1); });
