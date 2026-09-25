'use strict';
// ============================================================
// wzxClaw 手机端 hermetic web 端到端测试 · 单入口
//
//   node test/e2e/run-e2e.mjs
//
// 拉起完整本地栈 → ready 探测 → flutter drive -d web-server 驱动
// integration_test/e2e_test.dart → teardown → 退出码 0=全过。
//
// 栈组成（全部 localhost，零外部依赖）：
//   1. relay        node 层 createRelay（relay/zcode/server.js，随机端口）
//   2. origin 剥离代理  relay 生产源码拒绝带 Origin 的 WS 升级（server.js:172），
//      而浏览器 WebSocket 必带 Origin——本地 TCP 前置代理剥掉 Origin 头再转发，
//      relay 源码零改动；app 的所有连接都经它，掐它即可模拟断线
//   3. companion    createCompanion（relay/zcode/companion.js，同
//      relay/zcode/test/companion.test.js 配方），引擎注入 test/fixtures/
//      fake-app-server.js 的 e2e 模式（FAKE_APP_SERVER_E2E=1，流式分片剧本）
//   4. 控制通道     node ws 服务：测试中途发 'drop' 指令 → 代理掐断 app 侧
//      连接（场景 B 断线恢复）
//
// Windows 纪律：teardown 先杀进程树（flutter/chrome/companion cwd 锁），
// 再删临时目录；relay/zcode 生产源码一行不动。
// ============================================================
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..', '..');
const relayDir = path.join(repoRoot, 'relay', 'zcode');
const { createRelay } = require(path.join(relayDir, 'server.js'));
const { createCompanion } = require(path.join(relayDir, 'companion.js'));
const { WebSocket, WebSocketServer } = require(path.join(relayDir, 'node_modules', 'ws'));

const fakeAppServer = path.join(relayDir, 'test', 'fixtures', 'fake-app-server.js');
const androidDir = path.join(repoRoot, 'wzxClaw_android');

const log = (msg) => console.log(`[e2e] ${msg}`);
const logErr = (msg) => console.error(`[e2e] ${msg}`);

// ── origin 剥离代理 ──────────────────────────────────────────────
// 浏览器 →(带 Origin) 代理 →(剥 Origin) relay。维护 app 侧 socket 集，
// dropApp() 全部销毁 = 从 app 视角 relay 断线（WebSocket close 1006）。
function createOriginStripProxy(targetPort) {
  const sockets = new Set();
  let closed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(404, { Connection: 'close' });
    res.end('e2e proxy: websocket only');
  });
  server.on('upgrade', (req, clientSocket, head) => {
    if (closed) { clientSocket.destroy(); return; }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      // 逐头重建：只剥 Origin（relay 对非空 Origin 直接 403，server.js:172）
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'origin') continue;
        headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream).pipe(clientSocket);
    });
    sockets.add(clientSocket);
    sockets.add(upstream);
    // 任一侧关闭/出错都双向销毁，否则 close() 因残留连接永不回调
    const kill = () => { clientSocket.destroy(); upstream.destroy(); };
    clientSocket.on('error', kill);
    upstream.on('error', kill);
    const drop = (which) => () => {
      sockets.delete(which);
      // 单向 close 不立即销毁对端集合（pipe 语义下 close 双向传播，
      // 各自的 close 回调会清自己的条目）
    };
    clientSocket.on('close', drop(clientSocket));
    upstream.on('close', drop(upstream));
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
    }),
    port: () => server.address().port,
    dropApp: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () => new Promise((resolve) => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

// ── 控制通道：测试 → 宿主（'drop' 指令掐代理）────────────────────
function createCtrlServer(onDrop) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const cmd = raw.toString().trim();
      if (cmd === 'drop') {
        log('控制通道收到 drop 指令：掐断 app ↔ relay 连接');
        onDrop();
        ws.send('dropped');
      }
    });
  });
  const listening = new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  return {
    listening,
    port: () => wss.address().port,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

function waitFor(getValue, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (getValue()) { clearInterval(timer); resolve(getValue()); }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`ready 探测超时(${timeoutMs}ms): ${what}`));
    }, timeoutMs).unref();
  });
}

// ── 栈自检：模拟手机完成一次配对 + session/list，确认全链路可用 ────
// 自检连接断开即释放 probe 槽；companion 的引擎桥已起，app 随后配对直接可用。
async function stackSelfCheck(relayUrl, pairingUrl) {
  const parsed = new URL(pairingUrl);
  const sid = parsed.searchParams.get('sid');
  const hash = parsed.searchParams.get('hash');
  const ws = new WebSocket(relayUrl);
  const waiters = [];
  const messages = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    messages.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const next = (match, what, timeoutMs = 15000) => {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`自检超时: ${what}`)), timeoutMs).unref();
    });
  };
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid }));
    const challenge = await next((m) => m.type === 'auth_challenge', 'auth_challenge');
    ws.send(JSON.stringify({
      type: 'auth_response', device_sid: sid,
      proof: createHmac('sha256', hash).update(`${challenge.nonce}|probe|${sid}`).digest('base64url'),
    }));
    const ack = await next((m) => m.type === 'auth_ack', 'auth_ack');
    if (ack.pair_status !== 'matched') {
      // 接管窗口可能先 waiting，随后 device 完成认证广播 matched
      await next((m) => m.type === 'pair_status_ack' && m.pair_status === 'matched', 'pair matched');
    }
    // 配对后 companion 才起桥（spawn 引擎 1–2s）：桥未就绪的 -32000 宽限重试
    const deadline = Date.now() + 15000;
    for (;;) {
      ws.send(JSON.stringify({ type: 'data', payload: { id: 1, method: 'session/list' } }));
      const reply = await next((m) => m.type === 'data' && m.payload?.id === 1, 'session/list');
      if (!reply.payload.error) {
        const seed = (reply.payload.result.sessions || [])
          .find((s) => s.sessionId === 'sess_e2e_seed');
        if (!seed || !seed.workspace?.workspaceKey) {
          throw new Error('自检失败：引擎会话列表缺 e2e 种子会话（fake 引擎 e2e 模式未生效？）');
        }
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`自检失败：session/list 持续报错 ${JSON.stringify(reply.payload.error)}`);
      }
      await delay(400);
    }
    log('栈自检通过：配对 matched，引擎桥 session/list 正常');
  } finally {
    ws.close();
  }
}

// ── flutter drive -d web-server（驱动真实 Chrome 里的真实 Flutter web 应用）
// web integration test 的官方唯一路径是 flutter drive，它要求 WebDriver
// 服务（chromedriver，主版本必须与本机 Chrome 一致）——ensureChromedriver
// 按 Chrome 主版本自动准备（缓存复用，缺则从 Chrome for Testing 官方源
// 下载），经 PATH 注入给 flutter tool。
// Windows 上 flutter 是 .bat：spawn 必须 shell:true，而 cmd 会对 URL 中的
// & ? 等元字符断句——注入值统一走 base64（字符集对 cmd 安全），Dart 侧解码。
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function execFile(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}: ${out.slice(0, 400)}`)));
  });
}

// 本机 Chrome 主版本（App Paths 注册表，Windows 上最通用的安装痕迹）
async function detectChromeMajorVersion() {
  const out = await execFile('powershell', ['-NoProfile', '-c',
    "(Get-Item (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe').'(default)').VersionInfo.ProductVersion",
  ]);
  const version = out.trim().split(/\r?\n/).pop().trim();
  if (!/^\d+\./.test(version)) throw new Error(`无法识别 Chrome 版本: ${version}`);
  return version.split('.')[0];
}

// chromedriver 准备：主版本匹配 + 本地缓存复用 + 缺失时官方源下载
async function ensureChromedriver() {
  const toolsDir = path.join(os.tmpdir(), 'wzxclaw-e2e-tools');
  const major = await detectChromeMajorVersion();
  log(`本机 Chrome 主版本: ${major}`);
  // 缓存命中：%TEMP%/wzxclaw-e2e-tools/chromedriver-<ver>/chromedriver-win32/
  if (fs.existsSync(toolsDir)) {
    const cached = fs.readdirSync(toolsDir)
      .filter((name) => name.startsWith(`chromedriver-${major}.`))
      .sort()
      .pop();
    if (cached) {
      const exe = path.join(toolsDir, cached, 'chromedriver-win32', 'chromedriver.exe');
      if (fs.existsSync(exe)) {
        log(`chromedriver 缓存命中: ${exe}`);
        return exe;
      }
    }
  }
  // 从 Chrome for Testing known-good 清单找同主版本最新
  const metaUrl = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
  const meta = JSON.parse(await execFile('curl', ['-sL', '--max-time', '120', metaUrl]));
  const hits = meta.versions.filter((v) => v.version.startsWith(`${major}.`)
    && (v.downloads.chromedriver || []).some((d) => d.platform === 'win32'));
  if (hits.length === 0) throw new Error(`Chrome for Testing 无 Chrome ${major} 的 win32 chromedriver`);
  const target = hits[hits.length - 1];
  const url = target.downloads.chromedriver.find((d) => d.platform === 'win32').url;
  const dst = path.join(toolsDir, `chromedriver-${target.version}`);
  fs.mkdirSync(dst, { recursive: true });
  const zipPath = path.join(dst, 'chromedriver.zip');
  log(`下载 chromedriver ${target.version} …`);
  await execFile('curl', ['-sL', '--max-time', '600', '-o', zipPath, url]);
  // 解压走 PowerShell Expand-Archive（系统自带；PATH 里可能先命中 Git Bash
  // 的 GNU tar，它把 C:\ 路径当远程主机名）
  await execFile('powershell', ['-NoProfile', '-c',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${dst}' -Force`,
  ]);
  const exe = path.join(dst, 'chromedriver-win32', 'chromedriver.exe');
  if (!fs.existsSync(exe)) throw new Error(`chromedriver 解压后缺可执行: ${exe}`);
  log(`chromedriver 就绪: ${exe}`);
  return exe;
}

let flutterChild = null;
let chromedriverChild = null;

// 自己拉起 chromedriver：flutter drive 不启动 WebDriver，只在 --driver-port
// 端口「连接已运行的 chromedriver」——必须先把它跑起来。
async function startChromedriver(chromedriverExe) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(chromedriverExe, [`--port=${port}`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  chromedriverChild = child;
  // 探测端口就绪（chromedriver 起服务通常 <1s）
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const probe = net.connect(port, '127.0.0.1');
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (open) {
      log(`chromedriver 就绪: 127.0.0.1:${port}`);
      return port;
    }
    await delay(200);
  }
  throw new Error('chromedriver 端口探测超时');
}

function stopChromedriver() {
  if (chromedriverChild) {
    chromedriverChild.kill();
    chromedriverChild = null;
  }
}

function runFlutterDrive({ appPairingUrlB64, ctrlUrl, timeoutMs, driverPort }) {
  return new Promise((resolve) => {
    const webPort = 20000 + Math.floor(Math.random() * 20000);
    const args = [
      'drive',
      '--driver=test_driver/integration_test.dart',
      '--target=integration_test/e2e_test.dart',
      '-d', 'web-server',
      '--browser-name=chrome',
      '--headless',
      `--web-port=${webPort}`,
      `--driver-port=${driverPort}`,
      `--dart-define=WZXCLAW_E2E_PAIRING_URL_B64=${appPairingUrlB64}`,
      `--dart-define=WZXCLAW_E2E_CTRL_URL=${ctrlUrl}`,
    ];
    log(`flutter.bat ${args.join(' ')}`);
    const child = spawn('flutter.bat', args, {
      cwd: androidDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // hermetic 浏览器：独立 user-data-dir，无历史配对/无扩展噪声。
        // 注意 flutter tool 按空格切分 CHROME_FLAGS，路径不得含空格。
        CHROME_FLAGS: `--user-data-dir=${path.join(os.tmpdir(), 'wzxclaw-e2e-chrome-profile')} --no-first-run --no-default-browser-check`,
      },
      shell: true,
      windowsHide: true,
    });
    flutterChild = child;
    const forward = (stream, sink) => {
      let buffered = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffered += chunk;
        let index;
        while ((index = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, index).replace(/\r$/, '');
          buffered = buffered.slice(index + 1);
          sink(`[flutter] ${line}`);
        }
      });
      stream.on('end', () => {
        if (buffered.trim()) sink(`[flutter] ${buffered.replace(/\r$/, '')}`);
      });
    };
    forward(child.stdout, log);
    forward(child.stderr, logErr);
    const timer = setTimeout(() => {
      logErr(`flutter drive 超时(${Math.round(timeoutMs / 1000)}s)，强杀进程树`);
      killTree(child.pid);
    }, timeoutMs).unref();
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      flutterChild = null;
      resolve({ code: code === null ? (signal ? 1 : 0) : code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      flutterChild = null;
      logErr(`flutter drive 启动失败: ${err.message}`);
      resolve({ code: 1 });
    });
  });
}

function killTree(pid) {
  if (!pid || process.platform !== 'win32') return;
  // Windows：flutter.bat(shell) → dart → chrome 进程树，必须整树强杀
  spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: true });
}

// ── 主流程 ───────────────────────────────────────────────────────
async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-e2e-'));
  const stateDir = path.join(tmpRoot, 'companion-state'); // mid/口令/配对产物隔离目录
  fs.mkdirSync(stateDir, { recursive: true });
  const engineCwd = path.join(tmpRoot, 'workspace'); // companion 与引擎的工作目录
  fs.mkdirSync(engineCwd, { recursive: true });

  let relay;
  let proxy;
  let ctrl;
  let companion;
  let flutterCode = null;
  try {
    // 1. relay（随机端口）
    relay = createRelay({});
    const relayAddr = await relay.listen({ port: 0 });
    const relayUrl = `ws://127.0.0.1:${relayAddr.port}/ws`;
    log(`relay 就绪: ${relayUrl}`);

    // 2. origin 剥离代理（app 侧入口）
    proxy = createOriginStripProxy(relayAddr.port);
    const proxyPort = await proxy.listen();
    log(`origin 剥离代理就绪: ws://127.0.0.1:${proxyPort}/ws（app 侧）`);

    // 3. 控制通道
    ctrl = createCtrlServer(() => proxy.dropApp());
    await ctrl.listening;
    const ctrlPort = ctrl.port();
    log(`控制通道就绪: ws://127.0.0.1:${ctrlPort}`);

    // 4. companion + fake 流式引擎（同 companion.test.js 配方；凭据/状态
    // 全部落 tmpRoot，绝不碰本机 ~/.zcode 或 ~/.wzxclaw）
    const v2ConfigPath = path.join(stateDir, 'v2-config.json');
    fs.writeFileSync(v2ConfigPath, JSON.stringify({
      provider: {
        'builtin:bigmodel-coding-plan': { options: { apiKey: 'dummy-token-0123456789abcdef' } },
      },
    }));
    companion = createCompanion({
      relayUrl,
      cwd: engineCwd,
      zcodeCommand: { command: process.execPath, args: [fakeAppServer] },
      v2ConfigPath,
      midFile: path.join(stateDir, 'mid'),
      logger: (event, detail) => logErr(`[companion] ${event}${detail ? ` ${detail}` : ''}`),
      onPairing: () => {},
      onStateChange: () => {},
    });
    // e2e 引擎模式经环境变量注入（子进程继承）；token 由 companion 从
    // v2ConfigPath 读出注入引擎环境，不进命令行参数与日志。
    process.env.FAKE_APP_SERVER_E2E = '1';
    companion.start();

    await waitFor(() => companion.pairingUrl, 20000, 'companion 配对链接');
    const pairingUrl = companion.pairingUrl;
    log(`配对链接已生成（sid=${new URL(pairingUrl).searchParams.get('sid')}，凭据不入日志）`);

    // 5. 栈自检：模拟手机配对 + 引擎握手，把「桥未起」类竞态挡在 drive 之前
    await stackSelfCheck(relayUrl, pairingUrl);
    await delay(300); // 让自检连接完全释放

    // app 实际连的是代理：配对链接 host:port 重写为代理入口
    const pairForApp = new URL(pairingUrl);
    pairForApp.protocol = 'http:';
    pairForApp.host = `127.0.0.1:${proxyPort}`;
    const appPairingUrl = pairForApp.toString();
    log(`app 配对入口（经代理）: ${appPairingUrl}`);

    // 6. flutter drive（真实 Flutter web 应用 + 真实 headless Chrome）
    const chromedriverExe = await ensureChromedriver();
    const driverPort = await startChromedriver(chromedriverExe);
    let result;
    try {
      result = await runFlutterDrive({
        appPairingUrlB64: b64(appPairingUrl),
        ctrlUrl: `ws://127.0.0.1:${ctrlPort}`,
        timeoutMs: 8 * 60 * 1000,
        driverPort,
      });
    } finally {
      stopChromedriver();
    }
    flutterCode = result.code;

    if (flutterCode === 0) {
      log('✅ e2e 全部通过');
    } else {
      logErr(`❌ e2e 失败（flutter drive 退出码 ${flutterCode}）`);
    }
  } catch (err) {
    logErr(`栈异常: ${err && err.stack || err}`);
    flutterCode = flutterCode ?? 1;
  } finally {
    // 7. teardown：先杀进程树再删临时目录（companion 有 cwd 锁）
    log('teardown 开始…');
    if (flutterChild) killTree(flutterChild.pid); // 异常路径下残留的 drive 兜底
    stopChromedriver();
    if (companion) await companion.stop().catch((e) => logErr(`companion.stop 异常: ${e}`));
    if (ctrl) await ctrl.close();
    if (proxy) await proxy.close();
    if (relay) await relay.close();
    await delay(500); // Windows：句柄/子进程退出与目录锁的释放竞态
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      logErr(`临时目录清理失败（保留 ${tmpRoot} 供排查）: ${e.message}`);
    }
    log('teardown 完成');
  }
  process.exit(flutterCode === 0 ? 0 : 1);
}

main();
