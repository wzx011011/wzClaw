'use strict';

/**
 * 端到端通知测试
 *
 * 模拟完整链路：
 *   模拟 desktop → Relay → 模拟 mobile（订阅 messageStream 的那一端）
 *
 * 验证：
 * 1. mobile 连接后收到 stream:agent:done  →  期望触发通知（事件可达）
 * 2. mobile 离线时 desktop 发送 done      →  事件进入离线队列
 * 3. mobile 重新连接                       →  离线队列中的事件被推送
 *
 * 运行：
 *   cd relay && node test/e2e-notification.test.js
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { RoomManager } = require('../lib/room');

// ─── 测试配置 ────────────────────────────────────────────────
const PORT = 0; // 随机端口，避免冲突
const TOKEN = 'e2e-test-token';

// ─── 颜色输出 ────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(G(`  ✓ ${message}`));
    passed++;
  } else {
    console.log(R(`  ✗ ${message}`));
    failed++;
  }
}

// ─── Relay 服务器 ────────────────────────────────────────────

function startRelay() {
  return new Promise((resolve) => {
    const roomManager = new RoomManager();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, `http://localhost`);
      const token = url.searchParams.get('token') || '';
      const role = url.searchParams.get('role') || 'mobile';
      const device = url.searchParams.get('device') || 'unknown';
      // 简单接受所有连接（不做 auth 校验，测试环境）
      roomManager.join(token, role, ws);
    });

    server.listen(PORT, () => {
      const { port } = server.address();
      resolve({ server, wss, roomManager, port });
    });
  });
}

// ─── 工具函数 ────────────────────────────────────────────────

function connectAs(port, role, device = role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${TOKEN}&role=${role}&device=${device}`
    );
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(t);
      try { resolve(JSON.parse(data.toString())); }
      catch { resolve({ raw: data.toString() }); }
    });
  });
}

function send(ws, event, data) {
  ws.send(JSON.stringify({ event, data }));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 测试用例 ────────────────────────────────────────────────

async function runTests(port) {
  console.log('\n' + Y('═══ 端到端通知测试 ═══'));

  // ── Test 1: mobile 在线时实时收到 done 事件 ─────────────────
  console.log('\n' + Y('Test 1: mobile 在线时实时收到 stream:agent:done'));
  {
    const desktop = await connectAs(port, 'desktop', 'test-desktop');
    const mobile = await connectAs(port, 'mobile', 'test-mobile');
    await delay(200); // 等待 room 建立

    // 消费掉 system:desktop_list 等初始消息
    let pendingMessages = [];
    mobile.on('message', (d) => {
      try { pendingMessages.push(JSON.parse(d.toString())); } catch {}
    });
    await delay(200);
    pendingMessages = [];

    // desktop 广播 done 事件
    send(desktop, 'stream:agent:done', { sessionId: 'sess-1' });
    await delay(300);

    const doneMsg = pendingMessages.find((m) => m.event === 'stream:agent:done');
    assert(!!doneMsg, 'mobile 收到 stream:agent:done 事件');

    desktop.close();
    mobile.close();
    await delay(200);
  }

  // ── Test 2: mobile 离线时 done 事件进入离线队列 ─────────────
  console.log('\n' + Y('Test 2: mobile 离线时事件进入离线队列'));
  {
    const desktop = await connectAs(port, 'desktop', 'test-desktop-2');
    await delay(200);

    // 发送 done（mobile 未连接）
    send(desktop, 'stream:agent:done', { sessionId: 'sess-2' });
    await delay(300);

    // 先创建 WebSocket 对象、挂 listener，再等 open
    // 这样不会错过 flush 消息
    let gotDone = false;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/?token=${TOKEN}&role=mobile&device=test-mobile-2`
      );
      ws.on('message', (d) => {
        try {
          const msg = JSON.parse(d.toString());
          if (msg.event === 'stream:agent:done') gotDone = true;
        } catch {}
      });
      ws.on('open', async () => {
        await delay(800); // 等 flush 到达
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });

    assert(gotDone, '重新连接后收到离线队列中的 stream:agent:done');

    desktop.close();
    await delay(200);
  }

  // ── Test 3: mobile 在线时实时收到 error 事件 ────────────────
  console.log('\n' + Y('Test 3: mobile 在线时实时收到 stream:agent:error'));
  {
    const desktop = await connectAs(port, 'desktop', 'test-desktop-3');
    const mobile = await connectAs(port, 'mobile', 'test-mobile-3');
    await delay(200);

    let gotError = false;
    mobile.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.event === 'stream:agent:error') gotError = true;
      } catch {}
    });
    await delay(200);

    send(desktop, 'stream:agent:error', { error: '测试错误' });
    await delay(300);

    assert(gotError, 'mobile 收到 stream:agent:error 事件');

    desktop.close();
    mobile.close();
    await delay(200);
  }

  // ── Test 4: 非 done/error 事件不应触发通知（事件正确传递）──
  console.log('\n' + Y('Test 4: 普通文本事件正常传递'));
  {
    const desktop = await connectAs(port, 'desktop', 'test-desktop-4');
    const mobile = await connectAs(port, 'mobile', 'test-mobile-4');
    await delay(200);

    let gotText = false;
    mobile.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.event === 'stream:agent:text') gotText = true;
      } catch {}
    });
    await delay(200);

    send(desktop, 'stream:agent:text', { text: 'hello' });
    await delay(300);

    assert(gotText, 'stream:agent:text 正常路由到 mobile');

    desktop.close();
    mobile.close();
    await delay(200);
  }
}

// ─── 主入口 ─────────────────────────────────────────────────

(async () => {
  const { server, wss, port } = await startRelay();
  console.log(Y(`Relay 启动于 ws://127.0.0.1:${port}`));

  try {
    await runTests(port);
  } catch (e) {
    console.log(R(`\n测试异常: ${e.message}`));
    failed++;
  } finally {
    wss.close();
    server.close();
  }

  console.log(`\n${G(`通过: ${passed}`)}  ${failed > 0 ? R(`失败: ${failed}`) : '失败: 0'}`);
  process.exit(failed > 0 ? 1 : 0);
})();
