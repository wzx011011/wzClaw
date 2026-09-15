// ============================================================
// app-server-translate — app-server 事件 → 旧 WsEvents 翻译表
//
// 纯函数：把 app-server 的会话事件（session/event 推送）翻译为手机端
// 旧协议事件帧（stream:agent:*）。
//
// 实测形状（APP-SERVER.md「事件与通知」，2026-09-15 审查整改对齐）：
// session/event 单事件 type/payload 在 params 顶层：
//   {method:"session/event", params:{sessionId, seq, turnId, eventId,
//     type:"model.streaming", payload:{kind:"text_delta", delta, done}}}
// params.events 数组形状仅出现在 session/subscribe 应答快照里。
// 词典与 relay/zcode/brain-adapter.js 的 _applyEngineEvent、
// 手机端 lib/services/zcode_protocol_translate.dart 三处保持一致，
// 修改需同步。
// ============================================================

export interface WsEventFrame {
  event: string
  data: Record<string, unknown>
}

interface EnginePayload {
  kind?: string
  delta?: string
  text?: string
  callID?: string
  callId?: string
  toolCallId?: string
  toolName?: string
  tool?: string
  input?: unknown
  result?: unknown
  output?: unknown
  status?: string
  resultType?: string
  requestId?: string
  decision?: string
  error?: string
  message?: string
  usage?: Record<string, unknown>
  [key: string]: unknown
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

const withSession = (sessionId: string, data: Record<string, unknown>): Record<string, unknown> => ({
  sessionId,
  ...data,
})

/** tool.updated result 的内层 result 形状（实测：{success, content, …}） */
function toolResultOutput(p: EnginePayload): { output: string; isError: boolean } {
  const inner = asRecord(p.result)
  const content = inner ? inner.content : undefined
  const output = typeof content === 'string' ? content : content === null || content === undefined ? '' : JSON.stringify(content)
  return {
    output: output.slice(0, 2000),
    isError: inner ? inner.success === false : false,
  }
}

/**
 * 翻译单条实测事件（type + payload）→ 0..N 条旧协议事件帧。
 * 未识别的 type 返回空数组（调用方留观测）。
 * 词典（与 brain-adapter._applyEngineEvent 同源）：
 * - model.streaming: kind=reasoning_delta → thinking；text_delta/带 delta → text
 * - tool.updated: kind=scheduled/started → tool_call；result → tool_result
 *   （output=result.content，isError=result.success===false）；progress/batch → 忽略
 * - turn.started → running；turn.completed/turn.terminal → turn_end + done
 * - permission.resolved → stream:agent:permission_resolved
 * - model.error → stream:agent:error
 */
export function translateEngineEvent(sessionId: string, type: string, payload: unknown): WsEventFrame[] {
  const p = (asRecord(payload) ?? {}) as EnginePayload
  const kind = str(p.kind)
  const frames: WsEventFrame[] = []

  switch (type) {
    case 'model.streaming': {
      if (kind === 'reasoning_delta') {
        const content = str(p.delta ?? p.text)
        if (content) frames.push({ event: 'stream:agent:thinking', data: withSession(sessionId, { content }) })
      } else if (kind === 'text_delta' || p.delta !== undefined || p.text !== undefined) {
        const content = str(p.delta ?? p.text)
        if (content) frames.push({ event: 'stream:agent:text', data: withSession(sessionId, { content }) })
      }
      // 其余 kind（未知 delta 种类）：不硬猜，返回空由调用方留观测
      return frames
    }
    case 'tool.updated': {
      // kind 轨迹（实测）：scheduled → started → progress×N → result（→ batch）
      const toolCallId = str(p.toolCallId ?? p.callID ?? p.callId)
      if (kind === 'scheduled' || kind === 'started') {
        frames.push({
          event: 'stream:agent:tool_call',
          data: withSession(sessionId, {
            toolCallId,
            toolName: str(p.toolName ?? p.tool),
            input: p.input ?? '',
          }),
        })
      } else if (kind === 'result') {
        const { output, isError } = toolResultOutput(p)
        frames.push({
          event: 'stream:agent:tool_result',
          data: withSession(sessionId, { toolCallId, output, isError }),
        })
      }
      // progress / batch / 未知：中间态，旧协议无对应，忽略（调用方观测）
      return frames
    }
    case 'turn.started':
      frames.push({ event: 'stream:agent:running', data: withSession(sessionId, {}) })
      return frames
    case 'turn.completed':
    case 'turn.terminal': {
      const status = str(p.resultType ?? p.status) || 'completed'
      frames.push({ event: 'stream:agent:turn_end', data: withSession(sessionId, { status }) })
      frames.push({ event: 'stream:agent:done', data: withSession(sessionId, { status, usage: p.usage ?? null }) })
      return frames
    }
    case 'permission.resolved':
      frames.push({
        event: 'stream:agent:permission_resolved',
        data: withSession(sessionId, {
          requestId: str(p.requestId),
          toolCallId: str(p.toolCallId),
          decision: str(p.decision),
        }),
      })
      return frames
    case 'model.error':
      frames.push({
        event: 'stream:agent:error',
        data: withSession(sessionId, { error: str(p.error ?? p.message) || 'engine error' }),
      })
      return frames
    default:
      // session.updated / session.titleUpdated 等：旧协议无对应
      return frames
  }
}

/** app-server 消息行工具 part 的 callID（大写 D，实测字段名；callId 只作兼容回退） */
export function toolCallIdOfPart(part: Record<string, unknown>, state: Record<string, unknown>): string {
  return str(part.callID ?? part.callId ?? state.callID ?? state.callId)
}
