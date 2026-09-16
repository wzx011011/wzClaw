// ============================================================
// brain-adapter — 大脑适配器（v3 唯一新组件）
//
// 角色：把"旧 WsEvents 协议"（wzxClaw 手机端/relay 房间）翻译成
// ZCode app-server 帧协议（stdio NDJSON）。大脑节点 = 本适配器 +
// app-server 子进程，可部署在任意环境（PC / NAS Docker / VPS）。
//
// 协议依据（全部实测，见 APP-SERVER.md 与 probe-methods*.js）：
// - relay 侧：wss://…/?token=<TOKEN>&role=desktop，信封 {event, data}
// - 手机侧事件：command:send/stop、session:list:load:create:request、
//   permission:response、identity:announce 等（ws_message.dart WsEvents）
// - app-server 侧：{id, method, params} / {id, result} / 通知 {method, params}
//
// 降级（计划 D5）：session:rename/delete/clear、task:*、file:*、workspace:*
// 在 app-server 上无对应接口，返回显式失败响应（不假成功）。
// ============================================================

'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { classifyFrame } = require('./lib/protocol');

const DEFAULT_RELAY_URL = process.env.RELAY_URL || 'wss://5945.top/relay/';
const RECONNECT_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const PERMISSION_TIMEOUT_MS = 120000;
const MAX_NDJSON_BUFFER = 1024 * 1024;

// ── app-server 子进程桥（stdio NDJSON + 崩溃重启） ───────────────────

class AppServerEngine extends EventEmitter {
  constructor({ command, args, cwd, env, logger }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.logger = logger || (() => {});
    this.child = null;
    this.buffer = '';
    this.restarts = 0;
    this.maxRestarts = 10;
    this.stopped = false;
    this._restarting = false; // 重启排程中（防 error/exit 双触发排两个定时器）
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, timer}
  }

  start() {
    this.stopped = false;
    this._restarting = false;
    this._spawn();
  }

  _spawn() {
    const child = spawn(this.command, [...this.args, 'app-server', '--cwd', this.cwd], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.child = child;
    this.buffer = '';
    this._restarting = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._feed(chunk));
    child.stderr.on('data', (chunk) => this.logger('engine-stderr', chunk.slice(0, 500)));
    child.on('error', (error) => {
      // spawn 失败（ENOENT 等）只发 'error' 不发 'exit'：不置空 child 会让
      // 下面的重启定时器 `!this.child` 永远为假 → 进程已成尸仍不重启
      if (this.child === child) this.child = null;
      this._onDead(`spawn-error:${error.code || error.message}`);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this._onDead(`exit=${code}`);
    });
    this.logger('engine-started', '');
  }

  _onDead(why) {
    if (this.stopped || this._restarting) return;
    this._restarting = true;
    this.logger('engine-dead', why);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { code: -32000, message: 'engine restart' } });
    }
    this.pending.clear();
    if (this.restarts >= this.maxRestarts) {
      this.logger('engine-giveup', '');
      this.emit('dead');
      return;
    }
    this.restarts += 1;
    setTimeout(() => {
      if (!this.stopped && !this.child) this._spawn();
    }, 1000 * this.restarts).unref();
  }

  _feed(text) {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > MAX_NDJSON_BUFFER) {
      this.logger('engine-ndjson-overflow', String(Buffer.byteLength(this.buffer)));
      this.buffer = '';
      if (this.child) this.child.kill();
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { this.logger('engine-bad-frame', line.slice(0, 120)); continue; }
      const kind = classifyFrame(frame);
      if (kind === 'response') {
        const id = frame.id;
        if (id != null && this.pending.has(id)) {
          const entry = this.pending.get(id);
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve(frame);
        } else {
          // 无法配对的应答：留观测（丢弃 = 缺陷）
          this.logger('engine-unmatched-response', `id=${typeof id === 'string' ? id.slice(0, 24) : String(id)}`);
        }
        continue;
      }
      if (kind === 'reverse-request') {
        // 服务端反向请求（字符串 id + method）：转给订阅者应答
        this.emit('reverseRequest', frame);
        continue;
      }
      if (kind === 'notification') {
        this.emit('notification', frame);
        continue;
      }
      // request 形状（数字 id + method）不该由服务端发出：留观测
      this.logger('engine-bad-frame', JSON.stringify(frame).slice(0, 120));
    }
  }

  /** 反向请求应答：result 原文回传（带原字符串 id） */
  respond(id, result) {
    this._writeRaw({ id, result });
  }

  /** 反向请求拒绝（code 沿用 protocol.js ERR_UNHANDLED = -32000） */
  respondError(id, code, message) {
    this._writeRaw({ id, error: { code, message } });
  }

  _writeRaw(frame) {
    if (!this.child || !this.child.stdin.writable) {
      this.logger('engine-write-dropped', `child 已退出，丢弃 ${JSON.stringify(frame).slice(0, 80)}`);
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (error) {
      this.logger('engine-write-error', String(error).slice(0, 120));
      return false;
    }
  }

  /** 发送请求并等待响应（超时返回错误帧，不抛出） */
  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.resolve({ error: { code: -32000, message: 'engine not running' } });
    }
    const id = this.nextId++;
    const frame = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ id, error: { code: -32022, message: `timeout: ${method}` } });
        }
      }, timeoutMs).unref();
      this.pending.set(id, { resolve, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ id, error: { code: -32000, message: String(error) } });
      }
    });
  }

  resetRestartBudget() { this.restarts = 0; }

  async stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners('exit');
    child.removeAllListeners('error'); // 主动停止不触发 _onDead
    try { child.stdin.destroy(); } catch { /* 忽略 */ }
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(); }, 2000).unref();
      try { child.kill(); } catch { resolve(); }
    });
  }
}

// ── 旧协议（WsEvents）↔ app-server 翻译器 ────────────────────────────

const DEGRADED = '该能力在当前大脑节点上不受支持（app-server 协议无对应接口）';

class BrainAdapter {
  constructor({ relayUrl, token, workspace, brainName, platform, engineCommand, engineArgs, engineEnv, logger }) {
    this.relayUrl = relayUrl;
    this.token = token;
    this.workspace = workspace;
    this.brainName = brainName || 'brain';
    this.platform = platform || process.platform;
    // 引擎进程 cwd 与 --cwd（代理工作区）分离：CLI 需从其包目录解析内部模块
    this.engineCwd = (process.env.ENGINE_CWD || '').trim() || this.workspace;
    this.engineEnv = engineEnv || { ...process.env };
    this.logger = logger || (() => {});
    const command = engineCommand || process.env.ZCODE_BIN;
    if (!command) throw new Error('engineCommand/ZCODE_BIN 未配置');
    this.engine = new AppServerEngine({
      command,
      args: (engineArgs || []).slice(),
      cwd: this.engineCwd,
      env: this.engineEnv,
      logger: this.logger,
    });
    this.ws = null;
    this.stopped = false;
    this.activeSessionId = null;
    this.mode = null;
    // 等待手机应答的反向请求：frame.id（server-N）-> 原帧。
    // app-server 的 server-N id 会从头复用，必须按原 id 精确应答并及时清理。
    this._pendingPermission = new Map();
    this._permissionTimers = new Map();
    this.engine.on('notification', (frame) => this._onEngineNotification(frame));
    this.engine.on('reverseRequest', (frame) => this._onEngineReverseRequest(frame));
    this.engine.on('dead', () => this._clearPendingPermissions('engine-dead'));
  }

  // ---- relay 连接 ----

  connect() {
    if (this.stopped) return;
    const url = `${this.relayUrl}${this.relayUrl.includes('?') ? '&' : '?'}role=desktop`;
    // 与旧桌面客户端一致：token 走子协议（relay 据此鉴权并回显协议头）
    this.ws = new WebSocket(url, [`wzxclaw-${this.token}`], {
      handshakeTimeout: 15000,
      maxPayload: 1024 * 1024,
    });
    this.ws.on('open', () => {
      this.logger('relay-open', '');
      this._send('identity:announce', { name: this.brainName, platform: this.platform });
      this.engine.start();
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.logger('phone-frame', `${msg && msg.event}`);
      if (msg && typeof msg.event === 'string') this._onPhoneEvent(msg.event, msg.data);
    });
    this.ws.on('error', (e) => { this.logger('ws-error', `${e.message}`); });
    this.ws.on('unexpected-response', (_req, res) => this.logger('ws-unexpected-resp', String(res && res.statusCode)));
    this.ws.on('close', (code, reason) => {
      this.logger('relay-close', `code=${code} reason=${reason && reason.toString().slice(0, 80)}`);
      this.ws = null;
      this._clearPendingPermissions('relay-close');
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* 已关闭 */ } }
    this._clearPendingPermissions('stop');
    await this.engine.stop();
  }

  _clearPendingPermissions(reason) {
    for (const timer of this._permissionTimers.values()) clearTimeout(timer);
    const count = this._pendingPermission.size;
    this._permissionTimers.clear();
    this._pendingPermission.clear();
    if (count) this.logger('permission-pending-cleared', `${reason} count=${count}`);
  }

  _send(event, data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ event, data })); } catch { /* 忽略 */ }
  }

  // ---- 手机事件入口 ----

  _onPhoneEvent(event, data) {
    const d = data && typeof data === 'object' ? data : {};
    switch (event) {
      case 'ping': this._send('pong', {}); return;
      case 'session:list:request': this._onSessionList(d); return;
      case 'session:load:request': this._onSessionLoad(d); return;
      case 'session:create:request': this._onSessionCreate(d); return;
      case 'session:delete:request': this._degrade(event, d); return;
      case 'session:rename:request': this._degrade(event, d); return;
      case 'session:clear:request': this._degrade(event, d); return;
      case 'command:send': this._onCommandSend(d); return;
      case 'command:stop': this._onCommandStop(d); return;
      case 'permission:response': this._onPermissionResponse(d); return;
      case 'permission:get_mode:request': this._send('permission:mode:response', { mode: this.mode || 'build' }); return;
      case 'permission:set_mode:request': this._onSetMode(d); return;
      case 'workspace:list:request':
        this._send('workspace:list:response', { requestId: d.requestId ?? null, workspaces: [{ id: 'default', name: this.brainName, path: this.workspace, active: true }] });
        return;
      case 'workspace:switch:request':
        this._send('workspace:switch:response', { requestId: d.requestId ?? null, error: DEGRADED });
        return;
      case 'file:tree:request':
      case 'file:read:request':
        this._send(event.replace(':request', ':response'), { requestId: d.requestId ?? null, error: DEGRADED });
        return;
      default:
        // task:* 等无对应接口的事件：显式降级响应（若有 requestId）
        if (d && d.requestId != null) this._degrade(event, d);
    }
  }

  _degrade(event, data) {
    const base = event.replace(':request', ':response');
    this._send(base, {
      requestId: data.requestId ?? null,
      success: false,
      error: DEGRADED,
    });
  }

  // ---- 会话列表 ----

  async _onSessionList(d) {
    const requestId = d.requestId ?? null;
    const resp = await this.engine.request('session/list');
    if (resp.error) {
      this._send('session:error', { requestId, error: resp.error.message || 'session/list failed' });
      return;
    }
    const sessions = (resp.result && resp.result.sessions) || [];
    const mapped = sessions.map((s) => ({
      id: s.sessionId,
      title: s.title || s.sessionId,
      createdAt: Number(s.createdAt) || 0,
      updatedAt: Number(s.updatedAt) || 0,
      messageCount: Number(s.messageCount) || 0,
      preview: s.preview || '',
      isRunning: s.status === 'running' || s.isRunning === true,
      workspacePath: (s.workspace && s.workspace.workspacePath) || this.workspace,
    }));
    this._send('session:list:response', {
      requestId,
      workspaceName: this.brainName,
      workspacePath: this.workspace,
      sessions: mapped,
      runningSessionIds: mapped.filter((s) => s.isRunning).map((s) => s.id),
      taskStatuses: {},
      activeSessionId: this.activeSessionId,
    });
  }

  // ---- 会话加载（resume + messages → 旧 ChatMessage JSON 形状） ----

  async _onSessionLoad(d) {
    const requestId = d.requestId ?? null;
    const sessionId = d.sessionId;
    if (!sessionId) {
      this._send('session:error', { requestId, error: 'missing sessionId' });
      return;
    }
    const resume = await this.engine.request('session/resume', { sessionId });
    if (resume.error) {
      const code = resume.error.code;
      if (code === -32004) {
        this._send('session:error', {
          requestId,
          error: '该会话正在桌面端运行中，手机端无法查看其流式过程',
          code,
        });
      } else {
        this._send('session:error', { requestId, error: resume.error.message || 'resume failed' });
      }
      return;
    }
    this.activeSessionId = sessionId;
    await this.engine.request('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' });
    const messages = await this.engine.request('session/messages', { sessionId, limit: 200 });
    const rows = (messages.result && messages.result.messages) || [];
    const mapped = rows.map((row) => this._mapEngineMessage(row, sessionId)).filter(Boolean);
    this._send('session:load:response', {
      requestId,
      sessionId,
      messages: mapped,
      activeSessionId: sessionId,
    });
    this._send('session:active', { sessionId });
  }

  /** app-server 消息行（info+parts）→ 旧 ChatMessage JSON（snake_case 键） */
  _mapEngineMessage(row, sessionId) {
    const info = row.info || {};
    const role = info.role === 'user' ? 'user' : 'assistant';
    let content = '';
    const toolCalls = [];
    let usage = null;
    let createdAt = Number(info.time && (info.time.created || info.time.updated)) || 0;
    for (const part of row.parts || []) {
      if (part.type === 'text' && part.text) content += part.text;
      else if (part.type === 'reasoning' && part.text) { /* 思考内容不进正文 */ }
      else if (part.type === 'tool') {
        const state = part.state || {};
        toolCalls.push({
          // 实测字段为 callID（大写 D，APP-SERVER.md「工具回合实测」）；
          // callId 只作旧版本兼容回退
          toolCallId: part.callID || part.callId || state.callID || state.callId || '',
          toolName: part.tool || state.tool || '',
          inputSummary: typeof state.input === 'string' ? state.input.slice(0, 200) : undefined,
          outputSummary: typeof state.output === 'string' ? state.output.slice(0, 200) : undefined,
          status: state.status === 'completed' ? 'done' : state.status === 'error' ? 'error' : 'running',
          isError: state.status === 'error',
        });
      } else if (part.type === 'step-finish' && part.tokens) {
        usage = {
          input_tokens: part.tokens.total || 0,
          output_tokens: part.tokens.output || 0,
        };
      }
      // info 缺时间戳时用首个部件时间兜底；都没有则 0（不伪造当前时刻）
      if (!createdAt && part.time && part.time.created) createdAt = Number(part.time.created) || 0;
    }
    if (role === 'tool' || (!content && toolCalls.length === 0)) return null;
    return {
      role,
      content,
      created_at: createdAt,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage } : {}),
      session_id: sessionId,
    };
  }

  // ---- 新建会话 ----

  async _onSessionCreate(d) {
    const requestId = d.requestId ?? null;
    const resp = await this.engine.request('session/create', {
      workspace: { workspaceKey: this.workspace, workspacePath: this.workspace },
    });
    if (resp.error) {
      this._send('session:create:response', { requestId, error: resp.error.message || 'create failed' });
      return;
    }
    const session = (resp.result && resp.result.session) || {};
    const sessionId = session.sessionId || '';
    this._send('session:create:response', { requestId, sessionId });
    if (sessionId) {
      this.activeSessionId = sessionId;
      this._send('session:active', { sessionId });
    }
  }

  // ---- 发送 / 停止 / 流式回程 ----

  async _onCommandSend(d) {
    const content = d.content || d.text || '';
    const sessionId = d.sessionId || this.activeSessionId;
    if (!sessionId) {
      this._send('stream:agent:error', { error: '未选择会话' });
      return;
    }
    if (d.messageId) this._send('command:ack', { messageId: d.messageId });
    // 先订阅后发送：send 落地到引擎产生首帧事件的窗口极短，后订阅会丢开头事件
    const sub = await this.engine.request('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' });
    if (sub.error) this.logger('subscribe-failed', `code=${sub.error.code} ${sessionId}`);
    const resp = await this.engine.request('session/send', { sessionId, content });
    if (resp.error) {
      this._send('stream:agent:error', { sessionId, error: resp.error.message || String(resp.error.code) });
      return;
    }
    if (typeof resp.result === 'string') {
      this._send('stream:agent:error', { sessionId, error: resp.result });
      return;
    }
    this.activeSessionId = sessionId;
  }

  _onCommandStop(d) {
    const sessionId = d.sessionId || this.activeSessionId;
    if (sessionId) this.engine.request('session/stop', { sessionId });
  }

  // ---- app-server 通知 → stream:agent:* ----
  //
  // 实测通知形状（APP-SERVER.md「事件与通知」）：session/event 单事件，
  // type/payload 在 params 顶层：
  //   {method:"session/event", params:{sessionId, seq, turnId, eventId,
  //     type:"model.streaming", payload:{kind:"text_delta", delta, done}}}
  // params.events 数组形状仅出现在 session/subscribe 应答快照里，这里一并
  // 兼容（sessionId 在每个 event 内部）。词典逐条对应 zcode_protocol_translate.dart
  // （手机端旧协议栈参考实现），两处需同步修改。

  _onEngineNotification(frame) {
    const params = frame.params || {};
    if (frame.method !== 'session/event') {
      if (frame.method === 'state.updated') {
        const mode = params.settings && params.settings.mode && params.settings.mode.current;
        if (mode) { this.mode = mode; this._send('permission:mode:response', { mode }); }
        return;
      }
      // v4/telemetry 等：无旧协议对应，留观测
      this.logger('engine-notify-unhandled', frame.method || '(no method)');
      return;
    }
    const sessionId = params.sessionId || this.activeSessionId || '';
    const events = params.events;
    if (Array.isArray(events)) {
      // subscribe 应答快照：事件数组，sessionId 在事件内
      for (const ev of events) {
        if (ev && typeof ev === 'object') {
          this._applyEngineEvent(ev.sessionId || sessionId, ev.type, ev.payload !== undefined ? ev.payload : ev);
        }
      }
      return;
    }
    this._applyEngineEvent(sessionId, params.type, params.payload);
  }

  _applyEngineEvent(sessionId, type, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const kind = typeof p.kind === 'string' ? p.kind : '';
    switch (type) {
      case 'model.streaming': {
        if (kind === 'reasoning_delta') {
          this._send('stream:agent:thinking', { sessionId, content: p.delta || p.text || '' });
        } else if (kind === 'text_delta' || p.delta != null || p.text != null) {
          const content = p.delta || p.text || '';
          if (content) this._send('stream:agent:text', { sessionId, content });
        } else {
          // 未知 delta 种类：留观测不硬猜
          this.logger('engine-event-unhandled', `model.streaming kind=${kind}`);
        }
        return;
      }
      case 'tool.updated': {
        // kind 轨迹（实测）：scheduled → started → progress* → result；
        // batch 只出现在批量工具。旧协议只有 tool_call/tool_result 两站。
        const callId = p.toolCallId || p.callID || p.callId || '';
        if (kind === 'scheduled' || kind === 'started') {
          this._send('stream:agent:tool_call', {
            sessionId,
            toolCallId: callId,
            toolName: p.toolName || p.tool || '',
            input: p.input !== undefined ? p.input : '',
          });
        } else if (kind === 'result') {
          const inner = p.result && typeof p.result === 'object' ? p.result : {};
          const output = typeof inner.content === 'string'
            ? inner.content
            : (inner.content == null ? '' : JSON.stringify(inner.content));
          this._send('stream:agent:tool_result', {
            sessionId,
            toolCallId: callId,
            output: output.slice(0, 2000),
            isError: inner.success === false,
          });
        } else {
          // progress / batch / 未知：中间态，旧协议无对应，留观测
          this.logger('engine-event-ignored', `tool.updated kind=${kind || '(none)'}`);
        }
        return;
      }
      case 'turn.started':
        this._send('stream:agent:running', { sessionId });
        return;
      case 'turn.completed':
      case 'turn.terminal': {
        const status = p.resultType || p.status || 'completed';
        this._send('stream:agent:turn_end', { sessionId, status });
        this._send('stream:agent:done', { sessionId, status, usage: p.usage || null });
        return;
      }
      case 'permission.resolved': {
        // 服务端裁决落定：清掉暂存的待答反向请求（防 server-N 复用串台）
        const key = p.requestId || p.toolCallId || '';
        for (const [frameId, frame] of this._pendingPermission) {
          const rp = frame.params || {};
          if (rp.requestId === key || rp.toolCallId === key) {
            this._pendingPermission.delete(frameId);
            const timer = this._permissionTimers.get(frameId);
            if (timer) clearTimeout(timer);
            this._permissionTimers.delete(frameId);
          }
        }
        this._send('stream:agent:permission_resolved', {
          sessionId,
          requestId: p.requestId || '',
          toolCallId: p.toolCallId || '',
          decision: p.decision || '',
        });
        return;
      }
      case 'model.error':
        this._send('stream:agent:error', { sessionId, error: p.error || p.message || 'engine error' });
        return;
      default:
        // session.updated / session.titleUpdated / permission.requested（反向
        // 请求通道已覆盖）等：旧协议无对应，留观测
        this.logger('engine-event-ignored', `${type || '(no type)'} kind=${kind}`);
    }
  }

  // ---- app-server 反向请求 → 手机应答 ----

  _onEngineReverseRequest(frame) {
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
    if (frame.method === 'session/requestRuntimePreferences') {
      // 实测契约（APP-SERVER.md）：必须应答 {nativeSearchEnhancementsEnabled: false}，
      // 不应答引擎会等待超时
      this.engine.respond(frame.id, { nativeSearchEnhancementsEnabled: false });
      return;
    }
    if (frame.method === 'interaction/requestPermission') {
      // 暂存原帧（按 server-N id），转推手机旧协议事件；
      // 实测 params：{requestId: perm_<uuid>, toolCallId, toolName, input,
      //   reason, riskLevel, sessionId, options:[allow_once/allow_project/deny]}
      const toolCallId = params.toolCallId || params.requestId || frame.id;
      const oldTimer = this._permissionTimers.get(frame.id);
      if (oldTimer) clearTimeout(oldTimer);
      this._pendingPermission.set(frame.id, frame);
      this._permissionTimers.set(frame.id, setTimeout(() => {
        if (!this._pendingPermission.has(frame.id)) return;
        this._pendingPermission.delete(frame.id);
        this._permissionTimers.delete(frame.id);
        this.logger('permission-timeout', String(frame.id));
        this.engine.respondError(frame.id, -32022, 'Client request timed out');
      }, PERMISSION_TIMEOUT_MS).unref());
      this._send('stream:agent:permission_request', {
        requestId: params.requestId || toolCallId,
        toolCallId,
        toolName: params.toolName || '',
        input: params.input !== undefined ? params.input : {},
        reason: params.reason || '',
        riskLevel: params.riskLevel || '',
        options: Array.isArray(params.options) ? params.options : [],
        sessionId: params.sessionId || this.activeSessionId || '',
      });
      return;
    }
    // 未知反向请求：安全拒绝（error 帧），不假成功；留观测
    this.logger('reverse-request-deny', frame.method || '(no method)');
    this.engine.respondError(frame.id, -32000, `手机端未处理该反向请求: ${frame.method}`);
  }

  // ---- 权限 / 模式 ----

  _onPermissionResponse(d) {
    // 旧 UI 应答 {requestId?, toolCallId?, approved, remember?}：
    // 找到暂存的反向请求原帧，回放所选 option 的 response 原文
    //（实测契约：result 必须是 option.response 原文，畸形 result 被服务端
    // 静默判为 deny——见 APP-SERVER.md「工具回合实测」）。
    const key = d.toolCallId || d.requestId || '';
    let frameId = null;
    for (const [id, frame] of this._pendingPermission) {
      const rp = frame.params || {};
      if (rp.toolCallId === key || rp.requestId === key) { frameId = id; break; }
    }
    if (frameId == null) {
      // 迟到/未知应答（已 resolved / 断线重连后重放）：丢弃但留观测
      this.logger('permission-response-late', String(key).slice(0, 40));
      return;
    }
    const frame = this._pendingPermission.get(frameId);
    this._pendingPermission.delete(frameId);
    const timer = this._permissionTimers.get(frameId);
    if (timer) clearTimeout(timer);
    this._permissionTimers.delete(frameId);
    const approved = d.approved === true;
    // 语义映射（手机旧 UI 档位 → app-server optionId）：
    // 批准且 remember → allow_project（服务端 kind 为 allow_always，语义近似）；
    // 批准 → allow_once；拒绝 → deny。旧 UI 无 remember 时只有一次性批准。
    const wanted = approved ? (d.remember ? 'allow_project' : 'allow_once') : 'deny';
    const options = Array.isArray(frame.params && frame.params.options) ? frame.params.options : [];
    let result = null;
    for (const option of options) {
      if (option && (option.optionId === wanted || option.kind === wanted)
        && option.response && typeof option.response === 'object') {
        result = option.response;
        break;
      }
    }
    if (!result) {
      // 请求未带 options（异常）时按实测 schema 兜底构造（无 permissionUpdates，
      // 只能退化为一次性决定）
      result = { decision: approved ? 'allow' : 'deny', reason: approved ? 'Approved once' : 'Denied' };
    }
    this.engine.respond(frameId, result);
  }

  _onSetMode(d) {
    const mode = d.mode || 'build';
    this.mode = mode;
    const sessionId = d.sessionId || this.activeSessionId;
    if (sessionId) this.engine.request('session/setMode', { sessionId, mode });
    this._send('permission:mode:response', { mode });
  }
}

module.exports = { BrainAdapter, AppServerEngine, DEGRADED };

if (require.main === module) {
  const token = process.env.RELAY_TOKEN;
  if (!token || !process.env.ZCODE_BIN) {
    console.error('用法: RELAY_URL=wss://… RELAY_TOKEN=<token> ZCODE_BIN=<zcode CLI> WORKSPACE=<目录> BRAIN_NAME=<名称> node brain-adapter.js');
    process.exit(1);
  }
  const adapter = new BrainAdapter({
    relayUrl: process.env.RELAY_URL || DEFAULT_RELAY_URL,
    token,
    workspace: process.env.WORKSPACE || process.cwd(),
    brainName: process.env.BRAIN_NAME || undefined,
    engineCommand: process.env.ZCODE_BIN,
    engineEnv: { ...process.env },
    logger: (event, detail) => console.error(`[brain] ${event}${detail ? ` ${detail}` : ''}`),
  });
  adapter.connect();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void adapter.stop(); process.exit(0); });
  }
}
