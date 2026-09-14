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

const DEFAULT_RELAY_URL = process.env.RELAY_URL || 'wss://5945.top/relay/';
const RECONNECT_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;

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
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, timer}
  }

  start() {
    this.stopped = false;
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._feed(chunk));
    child.stderr.on('data', (chunk) => this.logger('engine-stderr', chunk.slice(0, 500)));
    child.on('error', (error) => this._onDead(`spawn-error:${error.code || error.message}`));
    child.on('exit', (code) => {
      this.child = null;
      this._onDead(`exit=${code}`);
    });
    this.logger('engine-started', '');
  }

  _onDead(why) {
    if (this.stopped) return;
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
    setTimeout(() => { if (!this.stopped && !this.child) this._spawn(); }, 1000 * this.restarts);
  }

  _feed(text) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const id = frame.id;
      if (id != null && this.pending.has(id)) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(frame);
        continue;
      }
      // 通知帧（无 id）：转给订阅者
      if (frame.method) this.emit('notification', frame);
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
    this.engine.on('notification', (frame) => this._onEngineNotification(frame));
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
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* 已关闭 */ } }
    await this.engine.stop();
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
    let createdAt = Number(info.time && (info.time.created || info.time.updated)) || Date.now();
    for (const part of row.parts || []) {
      if (part.type === 'text' && part.text) content += part.text;
      else if (part.type === 'reasoning' && part.text) { /* 思考内容不进正文 */ }
      else if (part.type === 'tool') {
        const state = part.state || {};
        toolCalls.push({
          toolCallId: part.callId || state.callId || '',
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
      if (part.time && part.time.created) createdAt = Math.min(createdAt, part.time.created) === Number(part.time.created) ? part.time.created : createdAt;
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
    const resp = await this.engine.request('session/send', { sessionId, content });
    if (resp.error) {
      this._send('stream:agent:error', { sessionId, error: resp.error.message || String(resp.error.code) });
      return;
    }
    if (typeof resp.result === 'string') {
      this._send('stream:agent:error', { sessionId, error: resp.result });
      return;
    }
    await this.engine.request('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' });
    this.activeSessionId = sessionId;
  }

  _onCommandStop(d) {
    const sessionId = d.sessionId || this.activeSessionId;
    if (sessionId) this.engine.request('session/stop', { sessionId });
  }

  // ---- app-server 通知 → stream:agent:* ----

  _onEngineNotification(frame) {
    const params = frame.params || {};
    const sessionId = params.sessionId || this.activeSessionId || '';
    const events = params.events;
    if (Array.isArray(events)) {
      for (const ev of events) this._applyEngineEvent(sessionId, ev.payload || ev);
      return;
    }
    if (params.kind) this._applyEngineEvent(sessionId, params);
    if (frame.method === 'state.updated' && params.settings) {
      const mode = params.settings.mode && params.settings.mode.current;
      if (mode) { this.mode = mode; this._send('permission:mode:response', { mode }); }
    }
  }

  _applyEngineEvent(sessionId, payload) {
    const kind = payload && payload.kind;
    const sendText = (content) => {
      if (content) this._send('stream:agent:text', { sessionId, content });
    };
    if (payload.type === 'text_delta' || kind === 'text_delta' || kind == null) {
      if (payload.delta || payload.text) sendText(payload.delta || payload.text);
    }
    if (kind === 'reasoning_delta' || payload.type === 'reasoning_delta') {
      this._send('stream:agent:thinking', { sessionId, content: payload.delta || payload.text || '' });
    }
    if (kind && kind.startsWith('tool.')) {
      const callId = payload.callId || payload.toolCallId || payload.id || '';
      const toolName = payload.tool || payload.name || '';
      if (kind === 'tool.call' || kind === 'tool.use' || kind === 'tool_start') {
        this._send('stream:agent:tool_call', { sessionId, toolCallId: callId, toolName: toolName, input: payload.input || payload.params || '' });
      } else {
        this._send('stream:agent:tool_result', {
          sessionId,
          toolCallId: callId,
          output: typeof payload.output === 'string' ? payload.output.slice(0, 2000) : JSON.stringify(payload.output || ''),
          isError: kind.includes('error'),
        });
      }
    }
    if (kind === 'turn.started' || payload.type === 'turn.started') {
      this._send('stream:agent:running', { sessionId });
    }
    if (kind === 'turn.terminal' || payload.type === 'turn.terminal' || kind === 'turn.completed') {
      const status = payload.status || kind;
      this._send('stream:agent:turn_end', { sessionId, status });
      this._send('stream:agent:done', {
        sessionId,
        status,
        usage: payload.usage || null,
      });
    }
    if (kind === 'model.error' || payload.isError === true) {
      this._send('stream:agent:error', { sessionId, error: payload.error || payload.message || 'engine error' });
    }
  }

  // ---- 权限 / 模式 ----

  _onPermissionResponse(d) {
    // 旧 UI 的权限应答 {requestId, approved, remember} → 转给等待中的反向请求
    // （app-server 反向请求在适配器内以 pending 形式等待，此处简化为透传日志）
    this.logger('permission-response', JSON.stringify(d && d.requestId || '').slice(0, 40));
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
