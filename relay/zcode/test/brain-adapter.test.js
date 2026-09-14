'use strict';

// 大脑适配器端到端测试：真实旧 relay（token 房间）+ 真实 BrainAdapter +
// fake app-server，手机以旧 WsEvents 协议遥控，断言翻译层各映射。
// 依据 v3 计划 P2（PLAN-brain-network-v3.md §3 P2）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocket } = require('ws');

process.env.AUTH_TOKEN = 'test-token'; // 必须在 require 之前：auth.init 在模块加载时执行

const oldRelay = require('../../server');
const { BrainAdapter } = require('../brain-adapter');

const FAKE_APP_SERVER = path.join(__dirname, 'fixtures', 'fake-app-server.js');

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

test('大脑适配器：发现/列表/加载/流式/降级 全链路（旧 relay）', async (t) => {
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

  const adapter = new BrainAdapter({
    relayUrl,
    token: 'test-token',
    workspace: process.cwd(),
    brainName: 'brain-test',
    engineCommand: process.execPath,
    engineArgs: [FAKE_APP_SERVER],
    engineEnv: { ...process.env, ANTHROPIC_API_KEY: 'dummy' },
    logger: () => {},
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

  // 发送：ack + 流式翻译（text_delta→stream:agent:text，turn.terminal→turn_end/done）
  phoneClient.send('command:send', { content: 'hi', messageId: 'm-1', sessionId: 'sess_mock' });
  await phoneClient.next((m) => m.event === 'command:ack' && m.data.messageId === 'm-1');
  await phoneClient.next((m) => m.event === 'stream:agent:text' && m.data.content === 'mock answer');
  const turnEnd = await phoneClient.next((m) => m.event === 'stream:agent:turn_end');
  assert.equal(turnEnd.data.status, 'completed');
  await phoneClient.next((m) => m.event === 'stream:agent:done');

  // 降级：rename 无对应接口 → 显式失败响应
  phoneClient.send('session:rename:request', { requestId: 'r9', sessionId: 'sess_mock', title: 'x' });
  const renameResp = await phoneClient.next((m) => m.event === 'session:rename:response');
  assert.equal(renameResp.data.success, false);
});
