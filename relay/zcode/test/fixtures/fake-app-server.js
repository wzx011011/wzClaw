'use strict';

// 假 app-server：companion 测试的可控替身（NDJSON stdio，同真实协议帧格式）。
let buf = '';
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

// 启动即报告 env 注入情况（只报有无，绝不输出 token 值）。
send({ method: 'fake/env', params: { tokenPresent: typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0 } });
// 反向请求 1：runtime preferences —— 期待 companion 代答。
send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
// 反向请求 2：未知反向请求 —— 期待转发给手机端应答。
send({ id: 'server-2', method: 'interaction/test', params: {} });

process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.id === 'server-1') {
      send({ method: 'fake/runtime-prefs', params: { answered: frame.result != null && frame.result.nativeSearchEnhancementsEnabled === false } });
    } else if (frame.id === 'server-2') {
      send({ method: 'fake/interaction-relay', params: { ok: frame.result !== undefined || frame.error !== undefined } });
    } else if (frame.method === 'session/resume') {
      // 截断测试：返回超 1MiB 的消息历史（40 条 × ~40KB）
      const big = Array.from({ length: 40 }, (_, i) => ({
        info: { role: 'assistant', id: `m${i}` },
        parts: [{ type: 'text', text: 'x'.repeat(40000) }],
      }));
      send({ id: frame.id, result: { messages: big, session: {} } });
    } else if (frame.method === 'session/list') {
      send({ id: frame.id, result: { sessions: [{ sessionId: 'sess_mock', title: 'mock' }] } });
    } else if (frame.method === 'session/send') {
      send({ id: frame.id, result: { accepted: true, sessionId: 'sess_mock', stateRevision: 1 } });
      send({ method: 'v4/telemetry/event', params: { kind: 'stream.chunk', channel: 'text', chunkLength: 2 } });
    }
  }
});
