// ============================================================
// app-server-translate — app-server 事件 → 旧 WsEvents 翻译表
//
// 纯函数：把 app-server 的会话事件 payload（state.updated 补丁 /
// session/event 推送）翻译为手机端旧协议事件帧（stream:agent:*）。
// 语义与 relay/zcode/brain-adapter.js 的 _applyEngineEvent 一致。
// ============================================================

export interface WsEventFrame {
  event: string
  data: Record<string, unknown>
}

interface EnginePayload {
  type?: string
  kind?: string
  delta?: string
  text?: string
  callId?: string
  toolCallId?: string
  id?: string
  tool?: string
  name?: string
  input?: unknown
  output?: unknown
  status?: string
  error?: string
  message?: string
  isError?: boolean
  usage?: Record<string, unknown>
  [key: string]: unknown
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/**
 * 翻译单个引擎事件 payload → 0..N 条旧协议事件帧。
 * 未识别的 kind 返回空数组（调用方可另行处理）。
 */
export function translateEnginePayload(sessionId: string, payload: unknown): WsEventFrame[] {
  const p = asRecord(payload)
  if (!p) return []
  const kind = str(p.kind) || undefined
  const type = str(p.type) || undefined
  const frames: WsEventFrame[] = []
  const withSession = (data: Record<string, unknown>): Record<string, unknown> => ({
    sessionId,
    ...data,
  })

  // 文本增量（kind 缺省视为 text_delta，与实测一致）
  if (type === 'text_delta' || kind === 'text_delta' || kind === undefined) {
    const content = str(p.delta ?? p.text)
    if (content) frames.push({ event: 'stream:agent:text', data: withSession({ content }) })
  }
  if (type === 'reasoning_delta' || kind === 'reasoning_delta') {
    const content = str(p.delta ?? p.text)
    if (content) frames.push({ event: 'stream:agent:thinking', data: withSession({ content }) })
  }
  if (kind?.startsWith('tool.')) {
    const toolCallId = str(p.callId ?? p.toolCallId ?? p.id)
    const toolName = str(p.tool ?? p.name)
    if (kind === 'tool.call' || kind === 'tool.use' || kind === 'tool_start') {
      frames.push({
        event: 'stream:agent:tool_call',
        data: withSession({ toolCallId, toolName, input: p.input ?? p.params ?? '' }),
      })
    } else {
      const output = typeof p.output === 'string' ? p.output.slice(0, 2000) : JSON.stringify(p.output ?? '')
      frames.push({
        event: 'stream:agent:tool_result',
        data: withSession({ toolCallId, output, isError: kind.includes('error') }),
      })
    }
  }
  if (kind === 'turn.started' || type === 'turn.started') {
    frames.push({ event: 'stream:agent:running', data: withSession({}) })
  }
  if (kind === 'turn.terminal' || type === 'turn.terminal' || kind === 'turn.completed') {
    const status = str(p.status) || kind || 'completed'
    frames.push({ event: 'stream:agent:turn_end', data: withSession({ status }) })
    frames.push({ event: 'stream:agent:done', data: withSession({ status, usage: p.usage ?? null }) })
  }
  if (kind === 'model.error' || p.isError === true) {
    frames.push({
      event: 'stream:agent:error',
      data: withSession({ error: str(p.error ?? p.message) || 'engine error' }),
    })
  }
  return frames
}
