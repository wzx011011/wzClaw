'use strict';

// 假 app-server（brain-adapter e2e 专用）：帧形状完全按 APP-SERVER.md 实测记录
// 构造（区别于 companion 用的 fake-app-server.js——那份的 session/event 是
// events 数组旧猜测形状，companion 测试只验证转发不解析形状，故保留不动）。
//
// 行为脚本：
// 1. 启动即发 server-1 runtimePrefs 反向请求（期待被代答 false）；
// 2. 启动即发 server-2 interaction/test 未知反向请求（期待被安全拒绝 error 帧）；
// 3. session/send → 应答 accepted + 实测形状事件序列（turn.started /
//    model.streaming text_delta+reasoning_delta / tool.updated scheduled+result /
//    turn.completed），随后发 server-3 权限反向请求；
// 4. 收到 server-3 应答 → 回显 fake/permission-result + permission.resolved 事件。
let buf = '';
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

const EVENT_BASE = { deliveryKind: 'web-remote-replayable', sessionId: 'sess_mock' };
let seq = 0;
const event = (type, payload) => {
  seq += 1;
  send({
    method: 'session/event',
    params: { ...EVENT_BASE, eventId: `ev-${seq}`, seq, turnId: 'turn_1', timestamp: 1757900000000 + seq, type, payload },
  });
};

// 1/2：启动即发两个反向请求（与真实 app-server 启动行为一致）
send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
send({ id: 'server-2', method: 'interaction/test', params: {} });

process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { continue; }

    // runtimePrefs 必须被代答 {nativeSearchEnhancementsEnabled: false}；
    // 答对才发探针回执（手机侧只能经 logger 观测该通知）
    if (frame.id === 'server-1') {
      send({
        method: 'fake/runtime-prefs',
        params: { answered: frame.result != null && frame.result.nativeSearchEnhancementsEnabled === false },
      });

    // 未知反向请求：期待 error 帧安全拒绝——按结果回执不同的探针方法名
    //（logger 只记方法名，用名字区分 allow/deny 以便测试断言）
    } else if (frame.id === 'server-2') {
      send({ method: frame.error !== undefined ? 'fake/interaction-denied' : 'fake/interaction-answered', params: {} });

    // 权限应答：校验 result 是 option.response 原文——按回放的 option 回执
    // 不同探针方法名（logger 只记方法名，测试据此断言回放了哪一档），
    // 再发 permission.resolved 事件闭环
    } else if (frame.id === 'server-3') {
      const r = frame.result && typeof frame.result === 'object' ? frame.result : {};
      const which = Array.isArray(r.permissionUpdates) ? 'allow_project'
        : r.reason === 'Approved once' ? 'allow_once'
        : r.decision === 'deny' ? 'deny' : 'fallback';
      send({ method: `fake/perm-option-${which}`, params: {} });
      event('permission.resolved', { requestId: 'perm_1', toolCallId: 'call_p', decision: r.decision, reason: r.reason });

    } else if (frame.method === 'session/resume') {
      send({ id: frame.id, result: { messages: [], session: {} } });
    } else if (frame.method === 'session/list') {
      send({ id: frame.id, result: { sessions: [{ sessionId: 'sess_mock', title: 'mock' }] } });
    } else if (frame.method === 'session/subscribe') {
      send({ id: frame.id, result: { eventSeq: 0, events: [], sessionId: 'sess_mock' } });
    } else if (frame.method === 'session/messages') {
      // 权威消息含工具 part：callID 大写 D（实测字段名，回归锚点）
      send({
        id: frame.id,
        result: { messages: [{
          info: { role: 'assistant', id: 'm1', time: { created: 1757900000000 } },
          parts: [
            { type: 'tool', callID: 'tc-1', tool: 'Bash', state: { status: 'completed', callID: 'tc-1', input: 'echo hi', output: 'hi' } },
            { type: 'text', text: 'mock answer' },
          ],
        }] },
      });
    } else if (frame.method === 'session/send') {
      send({ id: frame.id, result: { accepted: true, sessionId: 'sess_mock', stateRevision: 1 } });
      // 实测形状的最小回合事件序列（单事件 type/payload 在 params 顶层）
      event('turn.started', {});
      event('model.streaming', { assistantMessageId: 'msg_1', kind: 'reasoning_delta', delta: 'thinking' });
      event('model.streaming', { assistantMessageId: 'msg_1', kind: 'text_delta', delta: 'mock answer', done: false });
      // scheduled 实测不带 input（只有长度与引用）
      event('tool.updated', { toolCallId: 'tc-1', assistantMessageId: 'msg_1', toolName: 'Bash', kind: 'scheduled', inputOmitted: true, inputRef: 'model_stream' });
      event('tool.updated', { toolCallId: 'tc-1', kind: 'progress', toolName: 'Bash', elapsedMs: 5 });
      event('tool.updated', { toolCallId: 'tc-1', kind: 'result', result: { success: true, content: 'hi' }, duration: 12 });
      event('turn.completed', { response: 'mock answer', tokenCount: 5, duration: 100, toolCallCount: 1 });
      // 3：权限反向请求（工具回合实测的 options 三档原文）
      send({
        id: 'server-3',
        method: 'interaction/requestPermission',
        params: {
          requestId: 'perm_1',
          toolCallId: 'call_p',
          toolName: 'Bash',
          input: { command: 'printf A > probe-a.txt', description: '写文件' },
          reason: 'High risk tools require explicit approval',
          riskLevel: 'high',
          sessionId: 'sess_mock',
          turnId: 'turn_1',
          options: [
            { kind: 'allow_once', optionId: 'allow_once', name: 'Allow once', response: { decision: 'allow', reason: 'Approved once' } },
            { kind: 'allow_always', optionId: 'allow_project', name: 'Always allow in this project', response: { decision: 'allow', permissionUpdates: [{ behavior: 'allow', rules: [{ ruleContent: "printf 'A' > probe-a.txt", toolName: 'Bash' }], type: 'addRules' }], reason: 'Approved for this project' } },
            { kind: 'deny', optionId: 'deny', name: 'Deny', response: { decision: 'deny', reason: 'Denied' } },
          ],
        },
      });
    }
  }
});
