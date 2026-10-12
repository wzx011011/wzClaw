'use strict';

// 假 app-server：companion 测试的可控替身（NDJSON stdio，同真实协议帧格式）。
let buf = '';
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

// runtime 预检也复用本替身：模拟独立 CLI 的 version/doctor 两个无副作用命令。
if (process.argv.includes('--version')) {
  // 官方 Windows CLI 实测将版本写到 stderr；预检必须能解析又不得泄漏日志。
  process.stderr.write('zcode 0.16.5\n');
  process.exit(0);
}
if (process.argv.includes('doctor')) {
  process.stdout.write('zcode doctor\nversion: 0.16.5\n');
  process.exit(0);
}

// E2E 模式（手机端 web 端到端测试专用，test/e2e/run-e2e.mjs 经环境变量启用）：
// 模拟一个能吐真实流式事件的引擎——text_delta 分片、tool_input_start/delta/end、
// tool.updated 生命周期、turn.started/completed、state.updated 状态补丁、
// session/subscribe 与 session/events 的 afterSeq 回放、session/messages 权威
// 历史。事件形状逐字段对齐 APP-SERVER.md 实测记录。默认路径（上面的分支）
// 保持原样，companion.test.js 现有断言不受影响。
if (process.env.FAKE_APP_SERVER_E2E === '1') {
  e2eMain();
} else {
  legacyMain();
}

function legacyMain() {
  // 启动即报告 env 注入情况（只报有无，绝不输出 token 值）。
  send({ method: 'fake/env', params: { tokenPresent: typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0 } });
  // 反向请求 1：runtime preferences —— 期待 companion 代答。
  send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
  // 反向请求 2：未知反向请求 —— 期待转发给手机端应答。
  send({ id: 'server-2', method: 'interaction/test', params: {} });
  e2eDrainStdin();
}

function e2eMain() {
  // companion 起桥握手需要 runtimePrefs 反向请求（companion 自动代答），
  // 不发 interaction/test——e2e 会话里手机端不该有陌生的交互弹层。
  send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
  e2eDrainStdin();
}

function e2eDrainStdin() {
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString();
    let index;
    while ((index = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, index).trim();
      buf = buf.slice(index + 1);
      if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (process.env.FAKE_APP_SERVER_E2E === '1' && e2eHandle(frame)) continue;
      handleLegacyFrame(frame);
    }
  });
}

// 启动即报告 env 注入情况（只报有无，绝不输出 token 值）。
send({ method: 'fake/env', params: { tokenPresent: typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0 } });
// 反向请求 1：runtime preferences —— 期待 companion 代答。
send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
// 反向请求 2：未知反向请求 —— 期待转发给手机端应答。
send({ id: 'server-2', method: 'interaction/test', params: {} });

function handleLegacyFrame(frame) {
  if (frame.id === 'server-1') {
    send({ method: 'fake/runtime-prefs', params: { answered: frame.result != null && frame.result.nativeSearchEnhancementsEnabled === false } });
  } else if (frame.id === 'server-2') {
    send({ method: 'fake/interaction-relay', params: { ok: frame.result !== undefined || frame.error !== undefined } });
  } else if (String(frame.id).startsWith('x-')) {
    // companion 本地扩展（x/model/*）经桥发起的请求：直接回 result，
    // 不落 x/ 泄漏哨兵（方法名不带 x/ 前缀，但 id 带 x- 前缀）
    if (frame.method === 'session/resume') {
      send({ id: frame.id, result: { messages: [], session: {},
        settings: { model: { available: [
          { ref: { providerId: 'builtin:p1', modelId: 'glm-x' },
            label: 'GLM-X', providerLabel: 'P1 Name',
            contextWindow: 200000, maxOutputTokens: 32000,
            properties: { inputFormat: { supportsText: true, supportsImage: true } },
            reasoning: { levels: [{ value: 'high', label: 'high' }], defaultLevel: 'high' } },
          { ref: { providerId: 'builtin:p1', modelId: 'glm-mini' } },
        ] } } } });
    } else if (frame.method === 'session/list') {
      send({ id: frame.id, result: { sessions: [{ sessionId: 'sess_mock', title: 'mock' }] } });
    } else if (frame.method === 'session/setModel') {
      // 观测（P2-9 语义拆分断言用）：追加记录被 setModel 的会话到文件；
      // FULL 探针记完整 params（reasoningLevel options 断言用）
      try {
        const fs = require('fs');
        const f = process.env.SETMODEL_PROBE;
        if (f) fs.appendFileSync(f, `${frame.params && frame.params.sessionId}
`);
        const full = process.env.SETMODEL_PROBE_FULL;
        if (full) fs.appendFileSync(full, `${JSON.stringify(frame.params)}
`);
      } catch { /* 观测失败不影响应答 */ }
      send({ id: frame.id, result: { ok: true } });
    } else {
      send({ id: frame.id, result: { ok: true } });
    }
  } else if (frame.method === 'session/resume') {
    // 截断测试：返回超 1MiB 的消息历史（40 条 × ~40KB）
    const big = Array.from({ length: 40 }, (_, i) => ({
      info: { role: 'assistant', id: `m${i}` },
      parts: [{ type: 'text', text: 'x'.repeat(40000) }],
    }));
    send({ id: frame.id, result: { messages: big, session: {} } });
  } else if (String(frame.method || '').startsWith('x/')) {
    // 泄漏哨兵：x/* 是 companion 本地扩展，绝不允许到达 app-server；
    // 一旦到达即回特定标记帧供测试断言
    send({ method: 'fake/x-leak', params: { id: frame.id } });
  } else if (frame.method === 'session/list') {
    send({ id: frame.id, result: { sessions: [{ sessionId: 'sess_mock', title: 'mock' }] } });
  } else if (frame.method === 'session/subscribe') {
    send({ id: frame.id, result: { ok: true } });
  } else if (frame.method === 'session/messages') {
    send({
      id: frame.id,
      result: { messages: [{ info: { role: 'assistant', id: 'm1', time: { created: 123 } }, parts: [{ type: 'text', text: 'mock answer' }] }] },
    });
  } else if (frame.method === 'session/send') {
    send({ id: frame.id, result: { accepted: true, sessionId: 'sess_mock', stateRevision: 1 } });
    send({ method: 'v4/telemetry/event', params: { kind: 'stream.chunk', channel: 'text', chunkLength: 2 } });
    send({ method: 'session/event', params: { sessionId: 'sess_mock', events: [
      { payload: { kind: 'text_delta', delta: 'mock answer' } },
      { payload: { kind: 'turn.terminal', status: 'completed' } },
    ] } });
  } else if (frame.method === 'fake/emit-notifications') {
    // 观测命令：host 控制面通知（companion 必须吞掉不转发）与普通通知
    // （必须照常转发）各发一条，供过滤行为断言。
    send({ method: 'startup/storageState', params: { phase: 'ready' } });
    send({ method: 'fake/normal-note', params: { n: 1 } });
    send({ id: frame.id, result: { emitted: 2 } });
  } else if (frame.method === 'session/fork') {
    // 透传锚（评审 P3-1）：companion 对该族方法纯透传不改写——返回带
    // 实测字段的响应，断言手机端收到的 result 与此处逐字一致。
    send({ id: frame.id, result: { sessionId: 'fork-child-1', session: { sessionId: 'fork-child-1' } } });
  }
}

// ============================================================
// E2E 引擎主体：web 端到端测试的可控流式引擎（FAKE_APP_SERVER_E2E=1）。
// 只在此环境变量下启用；companion.test.js 的默认路径完全不受影响。
// 事件形状逐字段对齐 APP-SERVER.md 实测记录：
// - 流式正文：session/event type=model.streaming + payload.kind=text_delta
// - 工具参数流：tool_input_start/delta/end（payload.toolCallId）
// - 工具生命周期：session/event type=tool.updated kind=scheduled/started/result
// - 回合边界：turn.started / model.response（权威全文）/ turn.completed
// - 状态补丁：state.updated patch.status=running|idle
// - 断线恢复：session/subscribe 与 session/events 按 afterSeq 回放事件日志；
//   回合进行中 session/messages 返回空（引擎实测契约），结束后落库全量
// ============================================================
const e2e = {
  seq: 0,
  nextId: 0,
  eventLog: [], // 完整 session/event 参数帧（含 seq），afterSeq 回放数据源
  messages: [], // 权威消息（仅回合结束后落库，回合中为空——引擎实测契约）
  sessions: new Map(), // sessionId -> {status, workspace, model, thoughtLevel}
  turn: null, // {sessionId, turnId, active}
  stateRevision: 0,
};

function e2eNewSessionId() {
  e2e.nextId += 1;
  return `sess_e2e_${Date.now().toString(36)}_${e2e.nextId}`;
}

const e2eWorkspace = () => ({
  workspaceKey: 'e2e-ws',
  workspacePath: process.cwd(),
});

// 首个种子会话：session/list 必须带 workspace，手机端「新建会话」复用它。
e2e.sessions.set('sess_e2e_seed', {
  status: 'idle',
  workspace: e2eWorkspace(),
  model: { modelId: 'glm-e2e', providerId: 'builtin:e2e' },
  thoughtLevel: 'high',
});

function e2eSessionEvent(sessionId, turnId, type, payload) {
  e2e.seq += 1;
  const params = {
    deliveryKind: 'web-remote-replayable',
    eventId: `evt_${e2e.seq}_${Date.now().toString(36)}`,
    seq: e2e.seq,
    sessionId,
    timestamp: Date.now(),
    turnId,
    type,
    payload,
  };
  e2e.eventLog.push(params);
  send({ method: 'session/event', params });
}

function e2eStateUpdate(sessionId, status) {
  send({ method: 'state.updated', params: { sessionId, patch: { status } } });
}

// 后台任务投影补丁（workflow 回合用；形状 = probe-workflow 实测的
// projection.backgroundJobs 元素）
function e2eBgJobsUpdate(sessionId, jobs) {
  send({ method: 'state.updated', params: { sessionId, patch: { backgroundJobs: jobs } } });
}

// workflow 生命周期遥测（kind=workflow.lifecycle，probe-workflow 实测两枚相位）
function e2eWorkflowTelemetry(sessionId, turnId, toolCallId, workflow, phase, extra) {
  send({
    method: 'v4/telemetry/event',
    params: {
      sessionId, eventSeq: ++e2e.seq, turnId,
      kind: 'workflow.lifecycle', phase, runId: workflow.runId, toolCallId,
      ...extra,
    },
  });
}

// 场景剧本：两段文本夹一次工具调用。分片以 300ms 间隔吐出——给 UI 留出
// 「增量之间」的断言窗口；文案全为平实中文（无 markdown 语法字符），
// 渲染为单段落，浏览器端 find.textContaining 可稳定命中。
const e2eScripts = [
  {
    tag: 'A',
    prefix: 'A',
    headParts: ['山间的', '清晨总带着', '一层薄雾，', '露水停在', '松针尖端，', '迟迟不肯落下。'],
    tool: { name: 'Read', input: { file_path: 'notes/recipe.md' }, output: '两步即可完成：先备好清水，再等雾散。' },
    tailParts: ['炉火', '刚好可以', '烘干袖口的', '潮湿。'],
    inputTokens: 12,
    outputTokens: 34,
  },
  {
    tag: 'B',
    prefix: 'B',
    headParts: ['潮汐', '把昨夜的', '星光叠进', '沙粒深处，', '贝壳记得回声。'],
    tool: { name: 'Read', input: { file_path: 'notes/tide.md' }, output: '潮汐表已归档：黄昏后涨，深夜达到顶点。' },
    tailParts: ['风从', '海面带回', '咸味的故事。'],
    inputTokens: 21,
    outputTokens: 45,
  },
  {
    // 场景 C：dynamic workflow 回合（APP-SERVER.md「workflow 数据面实测」
    // 形状：CreateWorkflow 工具 + result.display 因果图 + workflow.lifecycle
    // 遥测 + backgroundJobs taskKind=workflow 投影）
    tag: 'C',
    prefix: 'C',
    headParts: ['收到，', '我用工作流来编排整理任务。'],
    tool: {
      name: 'CreateWorkflow',
      input: {
        name: '冒烟整理工作流',
        script: 'phase("smoke");\nawait agent("smoke-worker").ask("只回复ok");\nreturn "done";',
      },
      output: '工作流已在后台启动：dwfrun_e2e_smoke。完成后会收到通知。',
    },
    workflow: {
      runId: 'dwfrun_e2e_smoke',
      childSessionId: 'sess_dwf_e2e_smoke_actor_1',
      display: {
        kind: 'create_workflow',
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: {
          steps: [{ id: 'ask#1', kind: 'ask', label: 'smoke-worker', line: 2, column: 8, lane: 'actor#1', phase: 'phase#1' }],
          lanes: [{ id: 'actor#1', name: 'smoke-worker', line: 1, column: 8 }],
          participants: [{ id: 'phase#1:actor#1', phase: 'phase#1', lane: 'actor#1', steps: ['ask#1'] }],
          handoffs: [],
          phases: [{ id: 'phase#1', name: 'smoke', line: 1, column: 1 }],
          phaseEdges: [],
          exits: ['phase#1'],
          sink: ['ask#1'],
        },
      },
    },
    tailParts: ['冒烟子代理已经回来，', '答案收好了，整理完成。'],
    inputTokens: 9,
    outputTokens: 27,
  },
];
let e2eScriptCursor = 0;
const e2eDeltaGapMs = 300;
const e2eToolRunMs = 700;

function e2eFullText(script) {
  return script.headParts.join('') + script.tailParts.join('');
}

// 一个完整回合：立即回 accepted，之后按节奏推事件流。所有 timer 用完即弃。
function e2eRunTurn(sessionId, content) {
  const st = e2e.sessions.get(sessionId);
  if (!st) return;
  const script = e2eScripts[e2eScriptCursor % e2eScripts.length];
  e2eScriptCursor += 1;
  const turnId = `turn_e2e_${Date.now().toString(36)}_${e2e.nextId}`;
  const assistantId = `msg_a_${++e2e.nextId}`;
  const userId = `msg_u_${++e2e.nextId}`;
  const toolCallId = `tool_${e2e.nextId}`;
  st.status = 'running';
  e2e.turn = { sessionId, turnId, active: true, script, userId, assistantId, toolCallId, content };
  const startedAt = Date.now();

  // 时间线调度：clock 只前进不回退，每个事件排在确定的时间点上——
  // 浏览器端的渐进渲染断言依赖真实节奏，瞬时全发等于没测流式。
  let clock = 0;
  const step = (advanceMs, fn) => {
    clock += advanceMs;
    setTimeout(fn, clock);
  };
  // ① running + 回合开始
  step(60, () => e2eStateUpdate(sessionId, 'running'));
  step(40, () => e2eSessionEvent(sessionId, turnId, 'turn.started',
    { messageId: userId, input: content }));
  // ② 前半文本逐片
  for (let i = 0; i < script.headParts.length; i++) {
    step(e2eDeltaGapMs, () => {
      e2eSessionEvent(sessionId, turnId, 'model.streaming', {
        assistantMessageId: assistantId,
        delta: script.headParts[i],
        done: i === script.headParts.length - 1,
        kind: 'text_delta',
      });
    });
  }
  // ③ 工具参数流 → 执行 → 结果
  step(80, () => e2eSessionEvent(sessionId, turnId, 'model.streaming', {
    assistantMessageId: assistantId, toolCallId,
    kind: 'tool_input_start', name: script.tool.name,
  }));
  const inputChunks = JSON.stringify(script.tool.input).match(/.{1,12}/g) || ['{}'];
  for (let i = 0; i < inputChunks.length; i++) {
    step(120, () => e2eSessionEvent(sessionId, turnId, 'model.streaming', {
      assistantMessageId: assistantId, toolCallId,
      delta: inputChunks[i], kind: 'tool_input_delta',
    }));
  }
  step(80, () => e2eSessionEvent(sessionId, turnId, 'model.streaming', {
    assistantMessageId: assistantId, toolCallId, kind: 'tool_input_end',
  }));
  step(80, () => e2eSessionEvent(sessionId, turnId, 'tool.updated', {
    assistantMessageId: assistantId, toolCallId,
    kind: 'scheduled', name: script.tool.name, inputOmitted: true,
  }));
  step(80, () => e2eSessionEvent(sessionId, turnId, 'tool.updated', {
    assistantMessageId: assistantId, toolCallId,
    kind: 'started', name: script.tool.name, startedAt: Date.now(),
  }));
  step(e2eToolRunMs, () => e2eSessionEvent(sessionId, turnId, 'tool.updated', {
    assistantMessageId: assistantId, toolCallId,
    kind: 'result', name: script.tool.name,
    duration: e2eToolRunMs,
    result: {
      success: true, content: script.tool.output,
      // workflow 回合：display 因果图挂 result（probe-workflow 实测 live 形状）
      ...(script.workflow ? { display: script.workflow.display } : {}),
    },
  }));
  if (script.workflow) {
    // workflow 回合追加观测面：actor-spawned 遥测 + 后台任务 running 投影
    step(100, () => {
      e2eWorkflowTelemetry(sessionId, turnId, toolCallId, script.workflow,
        'actor-spawned', { agentId: 'actor#1@1', childSessionId: script.workflow.childSessionId });
      e2eBgJobsUpdate(sessionId, [{
        taskId: script.workflow.runId, toolCallId, toolName: 'CreateWorkflow',
        taskKind: 'workflow', cancellable: false,
        description: script.tool.input.name, status: 'running',
        startedAt: new Date().toISOString(),
      }]);
    });
  }
  // ④ 后半文本逐片 + 权威全文 + 回合收尾
  for (let i = 0; i < script.tailParts.length; i++) {
    step(e2eDeltaGapMs, () => {
      e2eSessionEvent(sessionId, turnId, 'model.streaming', {
        assistantMessageId: assistantId,
        delta: script.tailParts[i],
        done: false,
        kind: 'text_delta',
      });
    });
  }
  step(120, () => e2eSessionEvent(sessionId, turnId, 'model.response', {
    content: e2eFullText(script),
    usage: { inputTokens: script.inputTokens, outputTokens: script.outputTokens },
  }));
  step(120, () => {
    e2eSessionEvent(sessionId, turnId, 'turn.completed', {
      resultType: 'success',
      response: e2eFullText(script),
      tokenCount: script.inputTokens + script.outputTokens,
      toolCallCount: 1,
      duration: Date.now() - startedAt,
    });
    e2eStateUpdate(sessionId, 'idle');
    send({
      method: 'v4/telemetry/event',
      params: {
        sessionId, eventSeq: ++e2e.seq, turnId, assistantMessageId: assistantId,
        kind: 'turn.terminal', status: 'success',
        durationMs: Date.now() - startedAt,
        tokenCount: script.inputTokens + script.outputTokens,
      },
    });
    // 回合结束才落库（引擎实测契约：回合中 session/messages 为空）
    e2e.messages.push(
      {
        info: { role: 'user', id: userId, turnId, time: { created: startedAt } },
        parts: [{ type: 'text', text: content }],
      },
      {
        info: {
          role: 'assistant', id: assistantId, turnId,
          finish: 'stop',
          time: { created: startedAt, completed: Date.now() },
          tokens: { input: script.inputTokens, output: script.outputTokens },
        },
        parts: [
          { type: 'text', text: script.headParts.join('') },
          {
            type: 'tool', callId: toolCallId, tool: script.tool.name,
            state: {
              status: 'completed',
              input: script.tool.input,
              output: script.tool.output,
              // workflow 回合：display 挂 state.metadata（probe-workflow 实测权威形状）
              ...(script.workflow ? {
                metadata: { schemaVersion: 1, display: script.workflow.display },
              } : {}),
              time: { start: startedAt, end: Date.now() },
            },
          },
          { type: 'text', text: script.tailParts.join('') },
        ],
      },
    );
    if (script.workflow) {
      // run 收尾晚于回合（引擎实测：工具即回、后台续跑）：run-settled 遥测
      // + 后台任务 completed 投影
      e2eWorkflowTelemetry(sessionId, turnId, toolCallId, script.workflow,
        'run-settled', { status: 'completed' });
      e2eBgJobsUpdate(sessionId, [{
        taskId: script.workflow.runId, toolCallId, toolName: 'CreateWorkflow',
        taskKind: 'workflow', cancellable: false,
        description: script.tool.input.name, status: 'completed',
        startedAt: new Date().toISOString(),
        terminalId: script.workflow.runId,
        completedAt: new Date().toISOString(),
      }]);
    }
    st.status = 'idle';
    e2e.turn = null;
  });
}

// e2e 帧处理：返回 true 表示已处理（不落 legacy 分支）。
function e2eHandle(frame) {
  const method = frame.method;
  const params = frame.params || {};
  const modelAvailable = () => ({
    ref: { providerId: 'builtin:e2e', modelId: 'glm-e2e' },
    label: 'GLM-E2E', providerLabel: 'E2E',
    contextWindow: 128000, maxOutputTokens: 8192,
    properties: { inputFormat: { supportsText: true, supportsImage: false } },
    reasoning: { levels: [{ value: 'high', label: 'high' }], defaultLevel: 'high' },
  });

  if (String(frame.id || '').startsWith('x-')) {
    // companion 内部（x- 前缀 id）请求：目录快照从 resume 拉。
    if (method === 'session/resume') {
      send({ id: frame.id, result: { messages: [], session: {},
        settings: { model: { available: [modelAvailable()] } } } });
    } else {
      send({ id: frame.id, result: { ok: true } });
    }
    return true;
  }

  switch (method) {
    case 'session/list':
      send({ id: frame.id, result: { sessions: [...e2e.sessions.entries()]
        .map(([sessionId, st]) => ({
          sessionId, title: sessionId === 'sess_e2e_seed' ? 'E2E 种子会话' : 'E2E 会话',
          status: st.status, mode: 'build', sessionKind: 'local',
          workspace: st.workspace,
        })) } });
      return true;
    case 'session/create': {
      const sessionId = e2eNewSessionId();
      e2e.sessions.set(sessionId, {
        status: 'idle', workspace: e2eWorkspace(),
        model: { modelId: 'glm-e2e', providerId: 'builtin:e2e' },
        thoughtLevel: 'high',
      });
      send({ id: frame.id, result: {
        session: { sessionId, mode: 'build',
          model: { modelId: 'glm-e2e', providerId: 'builtin:e2e' } },
        projection: { status: 'idle', contextWindow: 128000 },
        runtime: { eventSeq: e2e.seq },
        protocol: { name: 'ZCode Protocol', version: 1 },
      } });
      return true;
    }
    case 'session/resume': {
      const st = e2e.sessions.get(params.sessionId);
      if (!st) {
        send({ id: frame.id, error: { code: -32004, message: 'Session not found' } });
        return true;
      }
      send({ id: frame.id, result: {
        messages: [], // resume 响应的 messages 数组手机端忽略（自行分页拉取）
        session: { sessionId: params.sessionId, workspace: st.workspace },
        projection: { status: st.status },
        runtime: { eventSeq: e2e.seq },
        settings: { model: { available: [modelAvailable()],
          current: { ref: st.model, modelAvailability: 'current' } } },
      } });
      return true;
    }
    case 'session/read': {
      const st = e2e.sessions.get(params.sessionId);
      if (!st) {
        send({ id: frame.id, error: { code: -32004, message: 'Session not found' } });
        return true;
      }
      send({ id: frame.id, result: {
        session: { sessionId: params.sessionId },
        projection: { status: st.status, mode: 'build', thoughtLevel: st.thoughtLevel },
        runtime: { eventSeq: e2e.seq },
        settings: { model: { current: { ref: st.model, modelAvailability: 'current' } } },
      } });
      return true;
    }
    case 'session/subscribe':
      send({ id: frame.id, result: { sessionId: params.sessionId,
        eventSeq: e2e.seq,
        events: e2e.eventLog.filter((ev) => ev.seq > (params.afterSeq ?? 0)) } });
      return true;
    case 'session/events': {
      let events = e2e.eventLog.filter((ev) => ev.seq > (params.afterSeq ?? 0));
      if (typeof params.limit === 'number') events = events.slice(-params.limit);
      send({ id: frame.id, result: { sessionId: params.sessionId,
        eventSeq: e2e.seq, events } });
      return true;
    }
    case 'session/messages': {
      // 引擎实测契约：回合进行中返回空（消息未落库）；结束后权威全量。
      const running = e2e.turn !== null && e2e.turn.sessionId === params.sessionId;
      let list = running ? [] : e2e.messages;
      const after = params.afterMessageId;
      if (after != null) {
        const idx = list.findIndex((m) => m.info.id === after);
        if (idx >= 0) list = list.slice(idx + 1);
      }
      if (typeof params.limit === 'number') list = list.slice(-params.limit);
      send({ id: frame.id, result: { sessionId: params.sessionId,
        messages: list, hasMore: false } });
      return true;
    }
    case 'session/send':
      send({ id: frame.id, result: { accepted: true,
        sessionId: params.sessionId, stateRevision: ++e2e.stateRevision } });
      e2eRunTurn(params.sessionId, String(params.content ?? ''));
      return true;
    case 'session/setModel':
    case 'session/setMode':
    case 'session/setThoughtLevel':
    case 'session/stop':
    case 'session/close':
    case 'session/usage':
      send({ id: frame.id, result: { ok: true } });
      return true;
    default:
      return false; // 未知方法落 legacy 分支（x/ 泄漏哨兵等保持有效）
  }
}
    // companion 内部（x- 前缀 id）请求：目录快照从
