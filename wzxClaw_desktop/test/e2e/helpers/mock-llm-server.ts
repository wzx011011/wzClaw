// ============================================================
// Mock Anthropic-Compatible LLM Server for E2E Tests
// ============================================================
// 在随机端口上启动一个 HTTP 服务，模拟 Anthropic /v1/messages 接口。
// 每次 POST 请求从队列中取一个脚本，以 SSE 流的形式返回。
// ============================================================

import http from 'http'
import type { IncomingMessage, ServerResponse } from 'http'

// ── Script types ─────────────────────────────────────────────

export interface TextTurn {
  type: 'text'
  text: string
}

export interface ToolUseTurn {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type Turn = TextTurn | ToolUseTurn

export interface MockScript {
  /** Content blocks to include in the response */
  turns: Turn[]
  /** Message-level stop reason */
  stopReason?: 'end_turn' | 'tool_use'
  /** Optional delay in ms between text chunks (default 0) */
  chunkDelayMs?: number
}

// ── Script factories ─────────────────────────────────────────

/** Create a simple text response script */
export function textScript(text: string, chunkDelayMs = 0): MockScript {
  return { turns: [{ type: 'text', text }], stopReason: 'end_turn', chunkDelayMs }
}

/** Create a tool_use response script */
export function toolScript(
  toolName: string,
  input: Record<string, unknown>,
  toolId?: string
): MockScript {
  return {
    turns: [{ type: 'tool_use', id: toolId ?? `toolu_e2e_${Date.now()}`, name: toolName, input }],
    stopReason: 'tool_use',
  }
}

// ── SSE helpers ──────────────────────────────────────────────

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function serveScript(res: ServerResponse, script: MockScript): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  // message_start
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_e2e_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  })

  writeSse(res, 'ping', { type: 'ping' })

  let outputTokens = 0
  const delay = script.chunkDelayMs ?? 0

  for (let i = 0; i < script.turns.length; i++) {
    const turn = script.turns[i]

    if (turn.type === 'text') {
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      })

      // Stream text in small chunks to simulate real streaming
      const chunks = turn.text.match(/.{1,12}/gs) ?? [turn.text]
      for (const chunk of chunks) {
        if (delay > 0) await sleep(delay)
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: chunk },
        })
        outputTokens += Math.ceil(chunk.length / 4)
      }

      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i })
    } else if (turn.type === 'tool_use') {
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: turn.id, name: turn.name, input: {} },
      })

      // Send entire JSON input as one delta
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.input) },
      })

      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i })
      outputTokens += 20
    }
  }

  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: script.stopReason ?? 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: Math.max(1, outputTokens) },
  })

  writeSse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

// ── MockLLMServer class ──────────────────────────────────────

export class MockLLMServer {
  private server: http.Server
  private queue: MockScript[] = []
  private defaultScript: MockScript = textScript('Mock LLM response')

  /** Resolved after start() */
  public port = 0

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Drain request body before responding
    await new Promise<void>((resolve) => {
      req.resume()
      req.on('end', resolve)
      req.on('error', resolve)
    })

    if (req.method !== 'POST' || !req.url?.includes('/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    const script = this.queue.shift() ?? this.defaultScript
    try {
      await serveScript(res, script)
    } catch {
      // Connection may have been closed by stop-test; ignore
    }
  }

  /** Start listening on a random port. Returns the assigned port number. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'))
          return
        }
        this.port = addr.port
        resolve(this.port)
      })
      this.server.on('error', reject)
    })
  }

  /** Stop the server. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }

  /** Enqueue a script. The next request will consume it. */
  enqueue(script: MockScript): void {
    this.queue.push(script)
  }

  /** Clear the queue. */
  clearQueue(): void {
    this.queue = []
  }

  /** Set the fallback script used when the queue is empty. */
  setDefault(script: MockScript): void {
    this.defaultScript = script
  }

  /** Base URL for env var injection: http://127.0.0.1:{port} */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }
}
