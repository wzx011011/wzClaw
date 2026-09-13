'use strict';

// CLI 冒烟：真实 spawn companion.js 命令行入口（连本地 relay + 假 app-server），
// 验证启动路径不崩溃且渲染配对二维码。
// 教训：qrcode-terminal 曾因函数拆离对象调用只在 CLI 路径崩溃——
// 库的单元测试覆盖不到，必须冒烟真实入口。
// 安全：stdout/stderr 只做结构与计数断言，sid/hash/URL 内容绝不输出。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createRelay } = require('../server');

test('companion CLI 启动渲染二维码且不崩溃（本地 relay，假 app-server）', async (t) => {
  const relay = createRelay();
  const address = await relay.listen({ port: 0 });
  const relayUrl = `ws://127.0.0.1:${address.port}/ws`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-cli-'));
  const v2 = path.join(dir, 'v2.json');
  fs.writeFileSync(v2, JSON.stringify({ provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'dummy-token-0123456789abcdef' } } } }));

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'companion.js'),
    '--relay', relayUrl,
    '--cwd', dir,
  ], {
    cwd: dir,
    env: {
      ...process.env,
      // 指向假 app-server，避免冒烟时拉起真 zcode（未配对不会启动，双保险）
      ZCODE_BIN: path.join(__dirname, 'fixtures', 'fake-app-server.js'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await delay(200); }
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // 真实 CLI 路径：配对标题 + 二维码渲染 + 进程存活。
  // stdout 收进变量仅做结构断言，内容（含真实 sid/hash）绝不打印。
  await delay(2500);
  assert.equal(child.exitCode, null, 'companion CLI 不应退出');
  assert.equal(stdout.includes('配对 URL'), true);
  assert.equal(/█/.test(stdout), true, '应渲染出二维码字形');
  assert.equal(stderr.includes('Error'), false, `stderr 不应有堆栈: ${stderr.slice(0, 200)}`);
  assert.equal(stderr.includes('waiting-pairing') || stderr.includes('paired'), true);
});

test('companion CLI 二维码渲染路径（qrcode-terminal 方法调用）', async () => {
  // 直接触发 onPairing 中同一调用形式：模块方法调用 + 真实长度 URL。
  // 不运行 CLI 是为了不打印真实凭据；这里用等长假 URL 验证渲染不抛错。
  const qrTerminal = require('qrcode-terminal');
  const fakeUrl = `https://zcode.5945.top/pair?sid=${'a'.repeat(36)}&hash=${encodeURIComponent(Buffer.alloc(32, 7).toString('base64'))}`;
  let rendered = '';
  // cb 捕获输出而不打印（内容不进入测试日志）
  qrTerminal.generate(fakeUrl, { small: true }, (output) => { rendered = output; });
  assert.equal(rendered.length > 100, true, '二维码应渲染出内容');
  assert.equal(rendered.includes('█'), true, '应包含二维码字形');
});
