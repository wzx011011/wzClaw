// ============================================================
// E2E 测试 — NAS agent-server 端到端验证
//
// 测试完整链路：Client → AgentServer(Brain) → Hand → 工具执行
// 运行前需要 NAS agent-server 已启动且 docker-hand 已连接
//
// 运行方式：
//   NAS_E2E=1 npx vitest run test/e2e/nas-e2e.test.ts
//
// 环境变量：
//   NAS_URL — agent-server WebSocket 地址（默认 wss://agent.5945.top）
//   NAS_TOKEN — 认证 token（默认 b612b4d5732446b6）
//   NAS_HTTP — agent-server HTTP 地址（默认 https://agent.5945.top）
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'

const NAS_URL = process.env.NAS_URL || 'wss://agent.5945.top'
const NAS_TOKEN = process.env.NAS_TOKEN || 'b612b4d5732446b6'
const NAS_HTTP = process.env.NAS_HTTP || 'https://agent.5945.top'

/** 建立客户端 WebSocket 连接 */
function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${NAS_URL}/?token=${NAS_TOKEN}&type=client`)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Connection timeout'))
    }, 10000)
    ws.on('open', () => {
      clearTimeout(timeout)
      resolve(ws)
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** 发送消息并等待指定 event 的回复 */
function sendAndWait(ws: WebSocket, event: string, data: unknown, waitFor: string, timeoutMs = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${waitFor}`)), timeoutMs)
    const handler = (raw: unknown) => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (msg.event === waitFor) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(msg.data)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ event, data }))
  })
}

/** 收集所有 stream 事件直到 stream:done 或 stream:error */
function chatAndCollect(ws: WebSocket, sessionId: string, message: string, timeoutMs = 60000): Promise<{ events: string[]; text: string; done: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const events: string[] = []
    let text = ''
    let error: string | undefined
    const timer = setTimeout(() => {
      resolve({ events, text, done: false, error: 'timeout' })
    }, timeoutMs)

    const handler = (raw: unknown) => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      events.push(msg.event)
      if (msg.event === 'stream:text') {
        text += msg.data.delta || ''
      } else if (msg.event === 'stream:done') {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve({ events, text, done: true })
      } else if (msg.event === 'stream:error') {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve({ events, text, done: false, error: msg.data.error })
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ event: 'chat:send', data: { sessionId, message } }))
  })
}

// ---- 测试 ----

describe.skipIf(!process.env.NAS_E2E)('E2E: NAS Agent-Server', () => {
  let ws: WebSocket

  beforeAll(async () => {
    ws = await connectClient()
  })

  afterAll(() => {
    if (ws && ws.readyState === 1) ws.close()
  })

  // ---- S1: Health Check ----
  it('S1: health endpoint returns ok with hand count', async () => {
    const res = await fetch(`${NAS_HTTP}/health`)
    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(data.hands).toBeGreaterThanOrEqual(1)
  })

  // ---- S2: Hand Tool Registration ----
  it('S2: hand tools are registered (FileRead, FileWrite, FileList, Echo)', async () => {
    const data = await sendAndWait(ws, 'tool:list', {}, 'tool:list') as { definitions: Array<{ name: string }> }
    expect(data.definitions).toBeDefined()
    const names = data.definitions.map((d: { name: string }) => d.name)
    expect(names).toContain('FileRead')
    expect(names).toContain('FileWrite')
    expect(names).toContain('FileList')
    expect(names).toContain('Echo')
  })

  // ---- S3: Direct Tool Execution (FileList) ----
  it('S3: FileList tool executes and returns directory contents', async () => {
    const data = await sendAndWait(ws, 'tool:execute', {
      name: 'FileList',
      input: { path: '/data' },
    }, 'tool:result', 15000) as { output: string; isError: boolean }
    expect(data.isError).toBe(false)
    const items = JSON.parse(data.output)
    expect(Array.isArray(items)).toBe(true)
    expect(items.some((i: { name: string }) => i.name === 'sessions.db')).toBe(true)
  })

  // ---- S4: Direct Tool Execution (Echo) ----
  it('S4: Echo tool returns echoed message', async () => {
    const data = await sendAndWait(ws, 'tool:execute', {
      name: 'Echo',
      input: { message: 'hello-e2e' },
    }, 'tool:result', 15000) as { output: string; isError: boolean }
    expect(data.isError).toBe(false)
    expect(data.output).toContain('hello-e2e')
  })

  // ---- S5: Session CRUD ----
  it('S5: session create, list, and delete work', async () => {
    // Create
    const created = await sendAndWait(ws, 'session:create', {}, 'session:created') as { sessionId: string }
    expect(created.sessionId).toBeDefined()
    const sid = created.sessionId

    // List — session might not appear until first message (SQLite only persists on chat)
    const listed = await sendAndWait(ws, 'session:list', {}, 'session:list') as Array<{ id: string }>
    expect(Array.isArray(listed)).toBe(true)

    // Delete
    const deleted = await sendAndWait(ws, 'session:delete', { sessionId: sid }, 'session:deleted') as { sessionId: string }
    expect(deleted.sessionId).toBe(sid)
  })

  // ---- S6: Chat with LLM (GLM-5.1) ----
  it('S6: chat:send triggers LLM response via GLM-5.1', async () => {
    const created = await sendAndWait(ws, 'session:create', {}, 'session:created') as { sessionId: string }
    const result = await chatAndCollect(ws, created.sessionId, '请用一句话回答：1+1等于几？')
    expect(result.done).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.events).toContain('stream:text')
    expect(result.events).toContain('stream:done')
  })

  // ---- S7: Admin Config API ----
  it('S7: admin config GET/PUT works with auth', async () => {
    // GET
    const getRes = await fetch(`${NAS_HTTP}/admin/config/api-keys.json`, {
      headers: { Authorization: `Bearer ${NAS_TOKEN}` },
    })
    expect(getRes.status).toBe(200)
    const getData = await getRes.json()
    expect(getData.content).toBeDefined()

    // PUT (re-write same content to test round-trip)
    const originalContent = getData.content
    const putRes = await fetch(`${NAS_HTTP}/admin/config/api-keys.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${NAS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: originalContent }),
    })
    expect(putRes.status).toBe(200)
    const putData = await putRes.json()
    expect(putData.ok).toBe(true)

    // Unauthorized
    const noAuthRes = await fetch(`${NAS_HTTP}/admin/config/api-keys.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '{}' }),
    })
    expect(noAuthRes.status).toBe(401)
  })

  // ---- S8: WebSocket Auth Reject ----
  it('S8: WebSocket rejects invalid token', async () => {
    const closeCode = await new Promise<number>((resolve) => {
      const badWs = new WebSocket(`${NAS_URL}/?token=invalid-token&type=client`)
      badWs.on('open', () => {
        // Connection opens at TCP level, but server sends close frame after auth check
      })
      badWs.on('close', (code) => {
        resolve(code)
      })
      badWs.on('error', () => {
        resolve(-1)
      })
      setTimeout(() => resolve(0), 5000)
    })
    // Server should close with 4001 (auth failure) or similar non-1000 code
    expect(closeCode).not.toBe(1000)
    expect(closeCode).not.toBe(0)
  })

  // ---- S9: Stop Generation ----
  it('S9: chat:stop cancels active generation', async () => {
    const created = await sendAndWait(ws, 'session:create', {}, 'session:created') as { sessionId: string }

    // Send a message that will take time
    ws.send(JSON.stringify({ event: 'chat:send', data: { sessionId: created.sessionId, message: '写一个100字的故事' } }))

    // Wait a bit then send stop
    await new Promise(r => setTimeout(r, 500))
    const stopped = await sendAndWait(ws, 'chat:stop', {}, 'stream:stopped', 5000) as Record<string, unknown>
    expect(stopped).toBeDefined()
  })

  // ---- S10: Admin Hands List ----
  it('S10: admin hands list shows connected hands', async () => {
    const res = await fetch(`${NAS_HTTP}/admin/hands`, {
      headers: { Authorization: `Bearer ${NAS_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    // Response is the array directly (not wrapped in { hands: [...] })
    const hands = Array.isArray(data) ? data : data.hands
    expect(Array.isArray(hands)).toBe(true)
    expect(hands.length).toBeGreaterThanOrEqual(1)
    const hand = hands[0]
    expect(hand.id).toBeDefined()
    expect(hand.capabilities).toBeDefined()
    expect(hand.capabilities.length).toBeGreaterThanOrEqual(4)
  })
})

function connectClientWithToken(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${NAS_URL}/?token=${token}&type=client`)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Connection timeout'))
    }, 5000)
    ws.on('open', () => {
      clearTimeout(timeout)
      resolve(ws)
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    ws.on('close', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Closed with code ${code}`))
    })
  })
}
