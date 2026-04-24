'use strict';

/**
 * Protocol Integration Tests
 *
 * Tests the full application-layer protocol between desktop and mobile
 * through the relay server. Simulates real client behavior for session
 * CRUD, agent streaming, permission flow, file browsing, task management,
 * and workspace switching.
 *
 * These complement relay.test.js (basic forwarding) and e2e.test.js
 * (network optimizations) by validating protocol-level contracts.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const TEST_PORT = 18767;
const TEST_TOKEN = 'protocol-test-token';

// ── Helpers ──────────────────────────────────────────────────────────

function connectClient(urlPath, options = {}) {
  const { timeout = 3000, protocols } = options;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
    const ws = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}${urlPath}`,
      protocols || []
    );
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMessage(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); }
      catch (e) { reject(e); }
    });
  });
}

/** Wait for a specific event type, skipping other events. */
function waitForEvent(ws, eventName, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === eventName) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (_) {}
    };
    ws.on('message', handler);
  });
}

/** Wait for a non-system application message. */
function waitForAppMessage(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App message timeout')), timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event && msg.event.startsWith('system:')) return;
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      } catch (e) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        reject(e);
      }
    };
    ws.on('message', handler);
  });
}

/** Collect all messages within a time window. */
function collectMessages(ws, durationMs = 500) {
  return new Promise((resolve) => {
    const messages = [];
    const handler = (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch (_) {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

/** Connect both desktop and mobile, drain system events, return both. */
async function connectPair() {
  const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

  // Set up listener BEFORE mobile connects to capture system:desktop_list
  const mobileMsgs = [];
  const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
  mobile.on('message', (d) => {
    try { mobileMsgs.push(JSON.parse(d.toString())); } catch (_) {}
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
    mobile.on('open', () => { clearTimeout(timer); resolve(); });
    mobile.on('error', reject);
  });

  await delay(300); // Let system events drain

  return { desktop, mobile, mobileMsgs };
}

function closeAll(...sockets) {
  sockets.forEach(s => { if (s && s.readyState === WebSocket.OPEN) s.close(); });
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('Protocol Integration Tests', () => {
  let serverModule;

  beforeEach(() => {
    process.env.AUTH_TOKEN = TEST_TOKEN;
    process.env.PORT = String(TEST_PORT);
    delete require.cache[require.resolve('../server')];
    delete require.cache[require.resolve('../lib/auth')];
    delete require.cache[require.resolve('../lib/room')];
    serverModule = require('../server');
  });

  afterEach(async () => {
    if (serverModule) {
      clearInterval(serverModule.statusInterval);
      serverModule.roomManager.closeAll();
      await new Promise((resolve) => {
        serverModule.wss.close(() => {
          serverModule.server.close(resolve);
        });
      });
    }
    delete process.env.AUTH_TOKEN;
    delete process.env.PORT;
  });

  // ── 1. Session CRUD Protocol ──────────────────────────────────────

  describe('Session CRUD', () => {
    it('session:list request/response roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      // Mobile sends session:list:request
      const requestId = 'req-list-001';
      sendJson(mobile, {
        event: 'session:list:request',
        data: { requestId },
      });

      // Desktop receives the request
      const req = await waitForAppMessage(desktop);
      assert.equal(req.event, 'session:list:request');
      assert.equal(req.data.requestId, requestId);

      // Desktop responds with sessions
      const sessions = [
        { id: 's1', title: 'Bug Fix', createdAt: Date.now(), updatedAt: Date.now() },
        { id: 's2', title: 'Feature', createdAt: Date.now(), updatedAt: Date.now() },
      ];
      sendJson(desktop, {
        event: 'session:list:response',
        data: { requestId, sessions, workspaceName: 'my-project', workspacePath: '/home/user/project' },
      });

      // Mobile receives the response
      const res = await waitForAppMessage(mobile);
      assert.equal(res.event, 'session:list:response');
      assert.equal(res.data.requestId, requestId);
      assert.equal(res.data.sessions.length, 2);
      assert.equal(res.data.sessions[0].id, 's1');
      assert.equal(res.data.workspaceName, 'my-project');

      closeAll(desktop, mobile);
    });

    it('session:load request/response with messages', async () => {
      const { desktop, mobile } = await connectPair();

      const requestId = 'req-load-001';
      const sessionId = 's1';
      sendJson(mobile, {
        event: 'session:load:request',
        data: { requestId, sessionId, limit: 50 },
      });

      const req = await waitForAppMessage(desktop);
      assert.equal(req.event, 'session:load:request');
      assert.equal(req.data.sessionId, sessionId);

      // Desktop responds with messages (paginated)
      const messages = [
        { id: 'm1', role: 'user', content: 'Fix the login bug' },
        { id: 'm2', role: 'assistant', content: 'I found the issue...' },
      ];
      sendJson(desktop, {
        event: 'session:load:response',
        data: { requestId, sessionId, messages, total: 100, offset: 0, hasMore: true },
      });

      const res = await waitForAppMessage(mobile);
      assert.equal(res.event, 'session:load:response');
      assert.equal(res.data.messages.length, 2);
      assert.equal(res.data.hasMore, true);
      assert.equal(res.data.total, 100);

      closeAll(desktop, mobile);
    });

    it('session:create and session:delete roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      // Create session
      const createReqId = 'req-create-001';
      sendJson(mobile, {
        event: 'session:create:request',
        data: { requestId: createReqId },
      });

      const createReq = await waitForAppMessage(desktop);
      assert.equal(createReq.event, 'session:create:request');

      sendJson(desktop, {
        event: 'session:create:response',
        data: {
          requestId: createReqId,
          session: { id: 'new-s1', title: 'New Session', createdAt: Date.now() },
        },
      });

      const createRes = await waitForAppMessage(mobile);
      assert.equal(createRes.event, 'session:create:response');
      assert.equal(createRes.data.session.id, 'new-s1');

      // Delete session
      const deleteReqId = 'req-delete-001';
      sendJson(mobile, {
        event: 'session:delete:request',
        data: { requestId: deleteReqId, sessionId: 'new-s1' },
      });

      const deleteReq = await waitForAppMessage(desktop);
      assert.equal(deleteReq.event, 'session:delete:request');
      assert.equal(deleteReq.data.sessionId, 'new-s1');

      sendJson(desktop, {
        event: 'session:delete:response',
        data: { requestId: deleteReqId, success: true },
      });

      const deleteRes = await waitForAppMessage(mobile);
      assert.equal(deleteRes.event, 'session:delete:response');
      assert.equal(deleteRes.data.success, true);

      closeAll(desktop, mobile);
    });

    it('session:rename roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      const requestId = 'req-rename-001';
      sendJson(mobile, {
        event: 'session:rename:request',
        data: { requestId, sessionId: 's1', newTitle: 'Renamed Session' },
      });

      const req = await waitForAppMessage(desktop);
      assert.equal(req.event, 'session:rename:request');
      assert.equal(req.data.newTitle, 'Renamed Session');

      sendJson(desktop, {
        event: 'session:rename:response',
        data: { requestId, success: true },
      });

      const res = await waitForAppMessage(mobile);
      assert.equal(res.event, 'session:rename:response');
      assert.equal(res.data.success, true);

      closeAll(desktop, mobile);
    });
  });

  // ── 2. Agent Streaming Protocol ───────────────────────────────────

  describe('Agent Streaming', () => {
    it('full agent stream cycle: text + thinking + tool_call + tool_result + done', async () => {
      const { desktop, mobile } = await connectPair();

      // Mobile sends command
      const messageId = 'msg-stream-001';
      sendJson(mobile, {
        event: 'command:send',
        data: { content: 'Fix the auth bug', messageId },
      });

      // Desktop receives command
      const cmd = await waitForAppMessage(desktop);
      assert.equal(cmd.event, 'command:send');
      assert.equal(cmd.data.messageId, messageId);

      // Desktop sends command:ack
      sendJson(desktop, { event: 'command:ack', data: { messageId } });

      // Mobile receives ack
      const ack = await waitForAppMessage(mobile);
      assert.equal(ack.event, 'command:ack');
      assert.equal(ack.data.messageId, messageId);

      // Desktop streams thinking
      sendJson(desktop, { event: 'stream:agent:thinking', data: { content: 'Analyzing auth flow...' } });

      // Desktop streams text
      sendJson(desktop, { event: 'stream:agent:text', data: { text: 'I found the issue. ' } });
      sendJson(desktop, { event: 'stream:agent:text', data: { text: 'The token check is missing.' } });

      // Desktop sends tool_call
      const toolCallId = 'tc-001';
      sendJson(desktop, {
        event: 'stream:agent:tool_call',
        data: { toolCallId, toolName: 'file_read', input: { path: '/src/auth.ts' } },
      });

      // Desktop sends tool_result
      sendJson(desktop, {
        event: 'stream:agent:tool_result',
        data: { toolCallId, status: 'done', output: 'file contents...' },
      });

      // Desktop sends done
      sendJson(desktop, {
        event: 'stream:agent:done',
        data: { usage: { inputTokens: 1000, outputTokens: 500 }, cost: 0.02 },
      });

      // Mobile receives all stream events in order
      const events = [];
      for (let i = 0; i < 6; i++) {
        const msg = await waitForAppMessage(mobile, 2000);
        events.push(msg.event);
      }

      assert.deepEqual(events, [
        'stream:agent:thinking',
        'stream:agent:text',
        'stream:agent:text',
        'stream:agent:tool_call',
        'stream:agent:tool_result',
        'stream:agent:done',
      ]);

      closeAll(desktop, mobile);
    });

    it('stream:agent:error delivers error to mobile', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'stream:agent:error',
        data: { error: 'API rate limit exceeded', code: 'RATE_LIMIT' },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'stream:agent:error');
      assert.equal(msg.data.code, 'RATE_LIMIT');

      closeAll(desktop, mobile);
    });

    it('stream:agent:compacted delivers compaction notice', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'stream:agent:compacted',
        data: { originalTokens: 80000, compactedTokens: 40000 },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'stream:agent:compacted');
      assert.equal(msg.data.originalTokens, 80000);

      closeAll(desktop, mobile);
    });

    it('stream:retrying delivers retry notification', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'stream:retrying',
        data: { attempt: 2, maxAttempts: 3, delayMs: 2000 },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'stream:retrying');
      assert.equal(msg.data.attempt, 2);

      closeAll(desktop, mobile);
    });
  });

  // ── 3. Permission Flow ────────────────────────────────────────────

  describe('Permission Flow', () => {
    it('permission request → approve → continue', async () => {
      const { desktop, mobile } = await connectPair();

      const toolCallId = 'tc-perm-001';

      // Desktop sends permission request
      sendJson(desktop, {
        event: 'stream:agent:permission_request',
        data: {
          toolCallId,
          toolName: 'bash',
          command: 'rm -rf /tmp/test',
          autoApprove: false,
        },
      });

      // Mobile receives permission request
      const req = await waitForAppMessage(mobile);
      assert.equal(req.event, 'stream:agent:permission_request');
      assert.equal(req.data.toolCallId, toolCallId);
      assert.equal(req.data.toolName, 'bash');

      // Mobile approves
      sendJson(mobile, {
        event: 'permission:response',
        data: { toolCallId, approved: true },
      });

      // Desktop receives approval
      const approval = await waitForAppMessage(desktop);
      assert.equal(approval.event, 'permission:response');
      assert.equal(approval.data.approved, true);

      closeAll(desktop, mobile);
    });

    it('permission:deny → desktop receives denial', async () => {
      const { desktop, mobile } = await connectPair();

      const toolCallId = 'tc-perm-002';

      sendJson(desktop, {
        event: 'stream:agent:permission_request',
        data: { toolCallId, toolName: 'file_write', path: '/etc/config' },
      });

      await waitForAppMessage(mobile); // consume request

      sendJson(mobile, {
        event: 'permission:response',
        data: { toolCallId, approved: false },
      });

      const denial = await waitForAppMessage(desktop);
      assert.equal(denial.event, 'permission:response');
      assert.equal(denial.data.approved, false);

      closeAll(desktop, mobile);
    });

    it('permission mode get/set roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      // Mobile requests current mode
      const getReqId = 'req-mode-get-001';
      sendJson(mobile, {
        event: 'permission:get_mode:request',
        data: { requestId: getReqId },
      });

      const getReq = await waitForAppMessage(desktop);
      assert.equal(getReq.event, 'permission:get_mode:request');

      sendJson(desktop, {
        event: 'permission:mode:response',
        data: { requestId: getReqId, mode: 'accept-edits' },
      });

      const getRes = await waitForAppMessage(mobile);
      assert.equal(getRes.event, 'permission:mode:response');
      assert.equal(getRes.data.mode, 'accept-edits');

      // Mobile sets new mode
      const setReqId = 'req-mode-set-001';
      sendJson(mobile, {
        event: 'permission:set_mode:request',
        data: { requestId: setReqId, mode: 'bypass' },
      });

      const setReq = await waitForAppMessage(desktop);
      assert.equal(setReq.event, 'permission:set_mode:request');
      assert.equal(setReq.data.mode, 'bypass');

      sendJson(desktop, {
        event: 'permission:mode:response',
        data: { requestId: setReqId, mode: 'bypass' },
      });

      const setRes = await waitForAppMessage(mobile);
      assert.equal(setRes.event, 'permission:mode:response');
      assert.equal(setRes.data.mode, 'bypass');

      closeAll(desktop, mobile);
    });
  });

  // ── 4. Plan Mode Flow ─────────────────────────────────────────────

  describe('Plan Mode', () => {
    it('plan mode enter → approve → exit cycle', async () => {
      const { desktop, mobile } = await connectPair();

      // Desktop enters plan mode
      sendJson(desktop, {
        event: 'stream:agent:plan_mode_entered',
        data: { plan: '1. Refactor auth module\n2. Add unit tests\n3. Update docs' },
      });

      const entered = await waitForAppMessage(mobile);
      assert.equal(entered.event, 'stream:agent:plan_mode_entered');
      assert.ok(entered.data.plan.includes('Refactor'));

      // Mobile approves the plan
      sendJson(mobile, {
        event: 'plan:decision',
        data: { approved: true },
      });

      const decision = await waitForAppMessage(desktop);
      assert.equal(decision.event, 'plan:decision');
      assert.equal(decision.data.approved, true);

      // Desktop exits plan mode
      sendJson(desktop, {
        event: 'stream:agent:plan_mode_exited',
        data: { planExecuted: true },
      });

      const exited = await waitForAppMessage(mobile);
      assert.equal(exited.event, 'stream:agent:plan_mode_exited');

      closeAll(desktop, mobile);
    });

    it('plan mode enter → reject → desktop continues', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'stream:agent:plan_mode_entered',
        data: { plan: 'Delete everything' },
      });

      await waitForAppMessage(mobile); // consume entered

      sendJson(mobile, {
        event: 'plan:decision',
        data: { approved: false },
      });

      const decision = await waitForAppMessage(desktop);
      assert.equal(decision.event, 'plan:decision');
      assert.equal(decision.data.approved, false);

      closeAll(desktop, mobile);
    });
  });

  // ── 5. AskUserQuestion Flow ───────────────────────────────────────

  describe('AskUserQuestion', () => {
    it('ask question → answer roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      const questionId = 'q-001';

      // Desktop asks question
      sendJson(desktop, {
        event: 'stream:agent:ask_user_question',
        data: {
          questionId,
          question: 'Which auth library should we use?',
          options: [
            { label: 'Passport.js', description: 'Popular middleware' },
            { label: 'NextAuth', description: 'Next.js native' },
          ],
          multiSelect: false,
        },
      });

      const question = await waitForAppMessage(mobile);
      assert.equal(question.event, 'stream:agent:ask_user_question');
      assert.equal(question.data.questionId, questionId);
      assert.equal(question.data.options.length, 2);

      // Mobile answers
      sendJson(mobile, {
        event: 'ask-user:answer',
        data: {
          questionId,
          selectedLabels: ['Passport.js'],
          customText: null,
        },
      });

      const answer = await waitForAppMessage(desktop);
      assert.equal(answer.event, 'ask-user:answer');
      assert.deepEqual(answer.data.selectedLabels, ['Passport.js']);

      closeAll(desktop, mobile);
    });

    it('ask question with custom text answer', async () => {
      const { desktop, mobile } = await connectPair();

      const questionId = 'q-002';

      sendJson(desktop, {
        event: 'stream:agent:ask_user_question',
        data: {
          questionId,
          question: 'What naming convention?',
          options: [],
          multiSelect: false,
        },
      });

      await waitForAppMessage(mobile); // consume question

      sendJson(mobile, {
        event: 'ask-user:answer',
        data: {
          questionId,
          selectedLabels: [],
          customText: 'I prefer camelCase for everything',
        },
      });

      const answer = await waitForAppMessage(desktop);
      assert.equal(answer.data.customText, 'I prefer camelCase for everything');

      closeAll(desktop, mobile);
    });
  });

  // ── 6. File Browsing Protocol ─────────────────────────────────────

  describe('File Browsing', () => {
    it('file:tree request/response roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      const requestId = 'req-tree-001';
      sendJson(mobile, {
        event: 'file:tree:request',
        data: { requestId, path: '/src', depth: 2 },
      });

      const req = await waitForAppMessage(desktop);
      assert.equal(req.event, 'file:tree:request');
      assert.equal(req.data.path, '/src');

      sendJson(desktop, {
        event: 'file:tree:response',
        data: {
          requestId,
          nodes: [
            { name: 'auth.ts', type: 'file', size: 2048 },
            { name: 'utils', type: 'directory', children: [
              { name: 'helpers.ts', type: 'file', size: 1024 },
            ]},
          ],
        },
      });

      const res = await waitForAppMessage(mobile);
      assert.equal(res.event, 'file:tree:response');
      assert.equal(res.data.nodes.length, 2);
      assert.equal(res.data.nodes[1].children[0].name, 'helpers.ts');

      closeAll(desktop, mobile);
    });

    it('file:read request/response roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      const requestId = 'req-read-001';
      sendJson(mobile, {
        event: 'file:read:request',
        data: { requestId, filePath: '/src/auth.ts' },
      });

      const req = await waitForAppMessage(desktop);
      assert.equal(req.event, 'file:read:request');
      assert.equal(req.data.filePath, '/src/auth.ts');

      sendJson(desktop, {
        event: 'file:read:response',
        data: {
          requestId,
          content: 'export function authenticate() { ... }',
          language: 'typescript',
          size: 2048,
          filePath: '/src/auth.ts',
        },
      });

      const res = await waitForAppMessage(mobile);
      assert.equal(res.event, 'file:read:response');
      assert.equal(res.data.language, 'typescript');
      assert.ok(res.data.content.includes('authenticate'));

      closeAll(desktop, mobile);
    });
  });

  // ── 7. Task Management Protocol ───────────────────────────────────

  describe('Task Management', () => {
    it('task create/list/update/delete roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      // Create task
      const createReqId = 'req-task-create-001';
      sendJson(mobile, {
        event: 'task:create:request',
        data: { requestId: createReqId, subject: 'Fix auth bug', description: 'Token not refreshed' },
      });

      const createReq = await waitForAppMessage(desktop);
      assert.equal(createReq.event, 'task:create:request');

      sendJson(desktop, {
        event: 'task:create:response',
        data: { requestId: createReqId, task: { id: 't1', subject: 'Fix auth bug', status: 'pending' } },
      });

      const createRes = await waitForAppMessage(mobile);
      assert.equal(createRes.event, 'task:create:response');
      assert.equal(createRes.data.task.id, 't1');

      // List tasks
      const listReqId = 'req-task-list-001';
      sendJson(mobile, {
        event: 'task:list:request',
        data: { requestId: listReqId },
      });

      await waitForAppMessage(desktop); // consume request

      sendJson(desktop, {
        event: 'task:list:response',
        data: { requestId: listReqId, tasks: [
          { id: 't1', subject: 'Fix auth bug', status: 'pending' },
        ] },
      });

      const listRes = await waitForAppMessage(mobile);
      assert.equal(listRes.event, 'task:list:response');
      assert.equal(listRes.data.tasks.length, 1);

      // Update task
      const updateReqId = 'req-task-update-001';
      sendJson(mobile, {
        event: 'task:update:request',
        data: { requestId: updateReqId, taskId: 't1', status: 'completed' },
      });

      await waitForAppMessage(desktop); // consume request

      sendJson(desktop, {
        event: 'task:update:response',
        data: { requestId: updateReqId, success: true },
      });

      const updateRes = await waitForAppMessage(mobile);
      assert.equal(updateRes.event, 'task:update:response');
      assert.equal(updateRes.data.success, true);

      // Delete task
      const deleteReqId = 'req-task-delete-001';
      sendJson(mobile, {
        event: 'task:delete:request',
        data: { requestId: deleteReqId, taskId: 't1' },
      });

      await waitForAppMessage(desktop); // consume request

      sendJson(desktop, {
        event: 'task:delete:response',
        data: { requestId: deleteReqId, success: true },
      });

      const deleteRes = await waitForAppMessage(mobile);
      assert.equal(deleteRes.event, 'task:delete:response');
      assert.equal(deleteRes.data.success, true);

      closeAll(desktop, mobile);
    });

    it('todo:updated push notification from desktop', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'todo:updated',
        data: {
          todos: [
            { id: 't1', subject: 'Fix bug', status: 'completed' },
            { id: 't2', subject: 'Add tests', status: 'in_progress' },
          ],
        },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'todo:updated');
      assert.equal(msg.data.todos.length, 2);
      assert.equal(msg.data.todos[1].status, 'in_progress');

      closeAll(desktop, mobile);
    });
  });

  // ── 8. Workspace Protocol ─────────────────────────────────────────

  describe('Workspace', () => {
    it('workspace:list and workspace:switch roundtrip', async () => {
      const { desktop, mobile } = await connectPair();

      // List workspaces
      const listReqId = 'req-ws-list-001';
      sendJson(mobile, {
        event: 'workspace:list:request',
        data: { requestId: listReqId },
      });

      const listReq = await waitForAppMessage(desktop);
      assert.equal(listReq.event, 'workspace:list:request');

      sendJson(desktop, {
        event: 'workspace:list:response',
        data: {
          requestId: listReqId,
          workspaces: [
            { path: '/home/user/project-a', name: 'Project A', isCurrent: true },
            { path: '/home/user/project-b', name: 'Project B', isCurrent: false },
          ],
        },
      });

      const listRes = await waitForAppMessage(mobile);
      assert.equal(listRes.event, 'workspace:list:response');
      assert.equal(listRes.data.workspaces.length, 2);

      // Switch workspace
      const switchReqId = 'req-ws-switch-001';
      sendJson(mobile, {
        event: 'workspace:switch:request',
        data: { requestId: switchReqId, path: '/home/user/project-b' },
      });

      const switchReq = await waitForAppMessage(desktop);
      assert.equal(switchReq.event, 'workspace:switch:request');
      assert.equal(switchReq.data.path, '/home/user/project-b');

      sendJson(desktop, {
        event: 'workspace:switch:response',
        data: { requestId: switchReqId, success: true, workspaceName: 'Project B' },
      });

      const switchRes = await waitForAppMessage(mobile);
      assert.equal(switchRes.event, 'workspace:switch:response');
      assert.equal(switchRes.data.workspaceName, 'Project B');

      closeAll(desktop, mobile);
    });

    it('session:workspace:info push from desktop', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'session:workspace:info',
        data: {
          workspaceName: 'my-project',
          workspacePath: '/home/user/my-project',
          activeSessionId: 's1',
        },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'session:workspace:info');
      assert.equal(msg.data.workspaceName, 'my-project');
      assert.equal(msg.data.activeSessionId, 's1');

      closeAll(desktop, mobile);
    });
  });

  // ── 9. Push Notifications ─────────────────────────────────────────

  describe('Push Notifications', () => {
    it('session:changed push notification', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'session:changed',
        data: { sessionId: 's1', changeType: 'title_updated', newTitle: 'Fixed Bug' },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'session:changed');
      assert.equal(msg.data.changeType, 'title_updated');

      closeAll(desktop, mobile);
    });

    it('session:active push notification', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'session:active',
        data: { sessionId: 's1', title: 'Current Session' },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'session:active');
      assert.equal(msg.data.sessionId, 's1');

      closeAll(desktop, mobile);
    });

    it('task:changed push notification', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'task:changed',
        data: { taskId: 't1', status: 'in_progress' },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'task:changed');
      assert.equal(msg.data.status, 'in_progress');

      closeAll(desktop, mobile);
    });

    it('session:error push notification', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'session:error',
        data: { error: 'Failed to load session', code: 'SESSION_LOAD_ERROR' },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'session:error');
      assert.equal(msg.data.code, 'SESSION_LOAD_ERROR');

      closeAll(desktop, mobile);
    });
  });

  // ── 10. Command:stop Flow ─────────────────────────────────────────

  describe('Command Control', () => {
    it('command:stop is forwarded from mobile to desktop', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(mobile, {
        event: 'command:stop',
        data: { sessionId: 's1' },
      });

      const msg = await waitForAppMessage(desktop);
      assert.equal(msg.event, 'command:stop');
      assert.equal(msg.data.sessionId, 's1');

      closeAll(desktop, mobile);
    });
  });

  // ── 11. Turn End ──────────────────────────────────────────────────

  describe('Turn End', () => {
    it('stream:agent:turn_end clears thinking state', async () => {
      const { desktop, mobile } = await connectPair();

      sendJson(desktop, {
        event: 'stream:agent:turn_end',
        data: { turnNumber: 3, toolCallsCount: 2 },
      });

      const msg = await waitForAppMessage(mobile);
      assert.equal(msg.event, 'stream:agent:turn_end');
      assert.equal(msg.data.turnNumber, 3);

      closeAll(desktop, mobile);
    });
  });
});
