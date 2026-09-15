'use strict';

// 大脑适配器端到端测试：真实旧 relay（token 房间）+ 真实 BrainAdapter +
// fake app-server（实测帧形状，见 fixtures/fake-brain-app-server.js），
// 手机以旧 WsEvents 协议遥控，断言翻译层各映射。
// 依据 v3 计划 P2（PLAN-brain-network-v3.md §3 P2）+ 2026-09-15 审查整改
//（反向请求应答回路 / runtimePrefs 代答 / 实测事件词典 / callID 字段）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocket } = require('ws');

process.env.AUTH_TOKEN = 'test-token'; // 必须在 require 之前：auth.init 在模块加载时执行
// 旧 relay 房间持久化默认写到自身目录旁的 data/——夹具搬迁后那就是静态夹具目录，
// 重定向到临时目录，避免测试运行时状态污染 fixtures（也优于旧往 relay/data/ 写的做法）
process.env.RELAY_DATA_DIR = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'wzxclaw-old-relay-test-'),
);

const oldRelay = require('./fixtures/old-relay/server');
const { BrainAdapter, AppServerEngine } = require('../brain-adapter');

const FAKE_APP_SERVER = path.join(__dirname, 'fixtures', 'fake-brain-app-server.js');

function phone(url) {
  const ws = new WebSocket(`${url}&role=mobile`, { handshakeTimeout: 10000 });
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  });
  return {
    ws, messages,
    send: (event, data) => ws.send(JSON.stringify({ event, data })),
    next(match, timeoutMs = 8000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) { waiters.splice(index, 1); reject(new Error('phone next() timeout')); }
        }, timeoutMs).unref();
      });
    },
    close: () => ws.close(),
  };
}

/** 轮询等待 logger 里出现匹配条目（engine 侧通知只能经 logger 观测） */
async function waitForLog(logs, pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logs.some(pred)) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(logs.some(pred), 'logger 等待超时');
}

test('大脑适配器：发现/列表/加载/流式/权限闭环/降级 全链路（旧 relay）', async (t) => {
  if (!oldRelay.server.listening) {
    await new Promise((resolve, reject) => {
      oldRelay.server.once('listening', resolve);
      oldRelay.server.once('error', reject);
    });
  }
  const port = oldRelay.server.address().port;
  const relayUrl = `ws://127.0.0.1:${port}/?token=test-token`;
  t.after(() => {
    clearInterval(oldRelay.statusInterval);
    oldRelay.server.closeAllConnections();
    oldRelay.server.close();
  });

  const logs = [];
  const adapter = new BrainAdapter({
    relayUrl,
    token: 'test-token',
    workspace: process.cwd(),
    brainName: 'brain-test',
    engineCommand: process.execPath,
    engineArgs: [FAKE_APP_SERVER],
    engineEnv: { ...process.env, ANTHROPIC_API_KEY: 'dummy' },
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
  });
  t.after(() => adapter.stop());
  adapter.connect();

  // 手机接入：应收到 desktop_list，内含我们的节点（identity:announce 后有名字）
  const phoneClient = phone(relayUrl);
  t.after(() => phoneClient.close());
  // 等带名字的那一份（identity:announce 之后 relay 会重发全量列表）
  const listMsg = await phoneClient.next(
    (m) => m.event === 'system:desktop_list' && JSON.stringify(m.data).includes('brain-test'),
    10000);
  assert.match(JSON.stringify(listMsg.data), /brain-test/);

  // 启动期反向请求：runtimePrefs 被代答（fixture 只在答对时发探针回执）
  await waitForLog(logs, (l) => l === 'engine-notify-unhandled fake/runtime-prefs');
  // 启动期未知反向请求被安全拒绝（error 帧 → fixture 回执 denied 探针）
  await waitForLog(logs, (l) => l === 'reverse-request-deny interaction/test');
  await waitForLog(logs, (l) => l === 'engine-notify-unhandled fake/interaction-denied');

  // 会话列表
  phoneClient.send('session:list:request', { requestId: 'r1' });
  const listResp = await phoneClient.next(
    (m) => m.event === 'session:list:response' && m.data.requestId === 'r1');
  assert.equal(listResp.data.sessions.length, 1);
  assert.equal(listResp.data.sessions[0].id, 'sess_mock');
  assert.equal(listResp.data.workspaceName, 'brain-test');

  // 会话加载：resume+subscribe+messages → 旧 ChatMessage JSON 形状
  phoneClient.send('session:load:request', { requestId: 'r2', sessionId: 'sess_mock' });
  const loadResp = await phoneClient.next(
    (m) => m.event === 'session:load:response' && m.data.requestId === 'r2');
  assert.equal(loadResp.data.sessionId, 'sess_mock');
  assert.equal(loadResp.data.messages[0].role, 'assistant');
  assert.equal(loadResp.data.messages[0].content, 'mock answer');
  // 权威 part 的 callID（大写 D）必须映射进旧协议 toolCallId（回归锚点）
  assert.equal(loadResp.data.messages[0].tool_calls[0].toolCallId, 'tc-1');
  assert.equal(loadResp.data.messages[0].tool_calls[0].status, 'done');

  // 发送：ack + 实测形状事件翻译
  phoneClient.send('command:send', { content: 'hi', messageId: 'm-1', sessionId: 'sess_mock' });
  await phoneClient.next((m) => m.event === 'command:ack' && m.data.messageId === 'm-1');
  await phoneClient.next((m) => m.event === 'stream:agent:running');
  await phoneClient.next((m) => m.event === 'stream:agent:thinking' && m.data.content === 'thinking');
  await phoneClient.next((m) => m.event === 'stream:agent:text' && m.data.content === 'mock answer');
  // tool.updated 轨迹：scheduled → tool_call；progress 忽略；result → tool_result
  const toolCall = await phoneClient.next((m) => m.event === 'stream:agent:tool_call');
  assert.equal(toolCall.data.toolCallId, 'tc-1');
  assert.equal(toolCall.data.toolName, 'Bash');
  const toolResult = await phoneClient.next((m) => m.event === 'stream:agent:tool_result');
  assert.equal(toolResult.data.toolCallId, 'tc-1');
  assert.equal(toolResult.data.output, 'hi');
  assert.equal(toolResult.data.isError, false);
  const turnEnd = await phoneClient.next((m) => m.event === 'stream:agent:turn_end');
  assert.equal(turnEnd.data.status, 'completed');
  await phoneClient.next((m) => m.event === 'stream:agent:done');

  // 权限闭环：反向请求转推手机 → 手机批准 → option.response 原文回放给引擎
  const permReq = await phoneClient.next((m) => m.event === 'stream:agent:permission_request');
  assert.equal(permReq.data.requestId, 'perm_1');
  assert.equal(permReq.data.toolCallId, 'call_p');
  assert.equal(permReq.data.toolName, 'Bash');
  assert.equal(permReq.data.riskLevel, 'high');
  assert.equal(permReq.data.options.length, 3);
  // 旧 chat_store 应答形状 {toolCallId, approved}（无 remember → allow_once）
  phoneClient.send('permission:response', { toolCallId: 'call_p', approved: true });
  const resolved = await phoneClient.next((m) => m.event === 'stream:agent:permission_resolved');
  assert.equal(resolved.data.decision, 'allow');
  // 引擎收到的是 allow_once 档的 response 原文（非 allow_project/兜底构造）
  await waitForLog(logs, (l) => l === 'engine-notify-unhandled fake/perm-option-allow_once');

  // 迟到应答：已 resolved 再答 → 丢弃且留观测（不 crash、不串台）
  phoneClient.send('permission:response', { toolCallId: 'call_p', approved: false });
  await waitForLog(logs, (l) => l.startsWith('permission-response-late call_p'));

  // 降级：rename 无对应接口 → 显式失败响应
  phoneClient.send('session:rename:request', { requestId: 'r9', sessionId: 'sess_mock', title: 'x' });
  const renameResp = await phoneClient.next(
    (m) => m.event === 'session:rename:response' && m.data.requestId === 'r9');
  assert.equal(renameResp.data.success, false);
});

test('引擎 spawn 失败（只发 error 不发 exit）→ child 置空 + 重启排程（防僵尸）', async () => {
  // 回归：spawn ENOENT 在 Windows 上只触发 'error' 不触发 'exit'；若不置空
  // this.child，重启定时器的 `!this.child` 守卫恒假 → 进程已死仍不重启
  const logs = [];
  const engine = new AppServerEngine({
    command: 'wzxclaw-no-such-binary-xyz',
    args: [],
    cwd: process.cwd(),
    env: { ...process.env },
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
  });
  engine.maxRestarts = 2;
  let deadResolved = false;
  const dead = new Promise((resolve) => engine.once('dead', () => { deadResolved = true; resolve(); }));
  engine.start();
  await Promise.race([dead, new Promise((r) => setTimeout(r, 10000).unref())]);
  assert.equal(engine.child, null, 'error 路径必须置空 child');
  assert.ok(deadResolved, '重启预算耗尽后必须发 dead');
  assert.ok(logs.some((l) => l.startsWith('engine-dead spawn-error')));
  await engine.stop();
});
