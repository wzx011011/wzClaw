// ============================================================
// E2E 测试 — Workspace 协议端到端验证
//
// 测试 Workspace CRUD + Project 管理 + Session 集成
// 运行方式：NAS_E2E=1 npx vitest run test/e2e/workspace-e2e.test.ts
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'

const NAS_URL = process.env.NAS_URL || 'wss://agent.5945.top'
const NAS_TOKEN = process.env.NAS_TOKEN || 'b612b4d5732446b6'

interface Workspace {
  id: string
  title: string
  description?: string
  projects: Array<{ id: string; path: string; name: string; addedAt: number }>
  createdAt: number
  updatedAt: number
  archived: boolean
  lastSessionId?: string
  systemPrompt?: string
}

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${NAS_URL}/?token=${NAS_TOKEN}&type=client`)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Connection timeout')) }, 10000)
    ws.on('open', () => { clearTimeout(timeout); resolve(ws) })
    ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
  })
}

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

describe.skipIf(!process.env.NAS_E2E)('E2E: Workspace Protocol', () => {
  let ws: WebSocket
  let createdId: string

  beforeAll(async () => { ws = await connectClient() })
  afterAll(() => { if (ws?.readyState === 1) ws.close() })

  // W1: List workspaces (empty or with existing)
  it('W1: workspace:list returns an array', async () => {
    const data = await sendAndWait(ws, 'workspace:list', {}, 'workspace:list') as { workspaces: Workspace[] }
    expect(Array.isArray(data.workspaces)).toBe(true)
  })

  // W2: Create workspace
  it('W2: workspace:create creates a new workspace', async () => {
    const data = await sendAndWait(ws, 'workspace:create', {
      title: 'E2E Test Workspace',
      description: 'Created by workspace E2E test',
    }, 'workspace:created') as { workspace: Workspace }
    expect(data.workspace.id).toBeDefined()
    expect(data.workspace.title).toBe('E2E Test Workspace')
    expect(data.workspace.description).toBe('Created by workspace E2E test')
    expect(data.workspace.projects).toEqual([])
    expect(data.workspace.archived).toBe(false)
    createdId = data.workspace.id
  })

  // W3: Get workspace by ID
  it('W3: workspace:get retrieves the created workspace', async () => {
    const data = await sendAndWait(ws, 'workspace:get', { workspaceId: createdId }, 'workspace:loaded') as { workspace: Workspace }
    expect(data.workspace.id).toBe(createdId)
    expect(data.workspace.title).toBe('E2E Test Workspace')
  })

  // W4: Update workspace
  it('W4: workspace:update changes title and systemPrompt', async () => {
    const data = await sendAndWait(ws, 'workspace:update', {
      workspaceId: createdId,
      updates: { title: 'E2E Updated', systemPrompt: 'You are a test agent.' },
    }, 'workspace:updated') as { workspace: Workspace }
    expect(data.workspace.title).toBe('E2E Updated')
    expect(data.workspace.systemPrompt).toBe('You are a test agent.')
  })

  // W5: Add project
  it('W5: workspace:add-project adds a project to workspace', async () => {
    const data = await sendAndWait(ws, 'workspace:add-project', {
      workspaceId: createdId,
      folderPath: '/data/e2e-project',
    }, 'workspace:updated') as { workspace: Workspace }
    expect(data.workspace.projects.length).toBe(1)
    expect(data.workspace.projects[0].path).toBe('/data/e2e-project')
    expect(data.workspace.projects[0].name).toBe('e2e-project')
  })

  // W6: Duplicate add-project is idempotent
  it('W6: adding same project path again is idempotent', async () => {
    const data = await sendAndWait(ws, 'workspace:add-project', {
      workspaceId: createdId,
      folderPath: '/data/e2e-project',
    }, 'workspace:updated') as { workspace: Workspace }
    expect(data.workspace.projects.length).toBe(1)
  })

  // W7: Remove project
  it('W7: workspace:remove-project removes the project', async () => {
    const before = await sendAndWait(ws, 'workspace:get', { workspaceId: createdId }, 'workspace:loaded') as { workspace: Workspace }
    const projectId = before.workspace.projects[0].id
    const data = await sendAndWait(ws, 'workspace:remove-project', {
      workspaceId: createdId,
      projectId,
    }, 'workspace:updated') as { workspace: Workspace }
    expect(data.workspace.projects.length).toBe(0)
  })

  // W8: Archive workspace
  it('W8: workspace:update can archive workspace', async () => {
    const data = await sendAndWait(ws, 'workspace:update', {
      workspaceId: createdId,
      updates: { archived: true },
    }, 'workspace:updated') as { workspace: Workspace }
    expect(data.workspace.archived).toBe(true)
  })

  // W9: List excludes archived by default
  it('W9: workspace:list excludes archived by default', async () => {
    const data = await sendAndWait(ws, 'workspace:list', {}, 'workspace:list') as { workspaces: Workspace[] }
    const found = data.workspaces.find((w) => w.id === createdId)
    expect(found).toBeUndefined()
  })

  // W10: List includes archived when requested
  it('W10: workspace:list includes archived when includeArchived=true', async () => {
    const data = await sendAndWait(ws, 'workspace:list', { includeArchived: true }, 'workspace:list') as { workspaces: Workspace[] }
    const found = data.workspaces.find((w) => w.id === createdId)
    expect(found).toBeDefined()
    expect(found!.archived).toBe(true)
  })

  // W11: Delete workspace
  it('W11: workspace:delete removes workspace permanently', async () => {
    const data = await sendAndWait(ws, 'workspace:delete', { workspaceId: createdId }, 'workspace:deleted') as { workspaceId: string }
    expect(data.workspaceId).toBe(createdId)

    // Verify gone from list
    const all = await sendAndWait(ws, 'workspace:list', { includeArchived: true }, 'workspace:list') as { workspaces: Workspace[] }
    expect(all.workspaces.find((w) => w.id === createdId)).toBeUndefined()
  })

  // W12: Get capabilities includes workspace
  it('W12: capabilities:get returns workspace=true', async () => {
    const data = await sendAndWait(ws, 'capabilities:get', {}, 'capabilities') as { workspace: boolean }
    expect(data.workspace).toBe(true)
  })

  // W13: Session creation with workspaceId applies defaults
  it('W13: session:create with workspaceId succeeds', async () => {
    // Create a workspace with a project first
    const wsData = await sendAndWait(ws, 'workspace:create', {
      title: 'Session-Workspace',
    }, 'workspace:created') as { workspace: Workspace }
    const wsId = wsData.workspace.id

    await sendAndWait(ws, 'workspace:add-project', {
      workspaceId: wsId,
      folderPath: '/data/session-test-project',
    }, 'workspace:updated')

    // Create session with workspaceId
    const session = await sendAndWait(ws, 'session:create', { workspaceId: wsId }, 'session:created') as { sessionId: string }
    expect(session.sessionId).toBeDefined()

    // Cleanup
    await sendAndWait(ws, 'session:delete', { sessionId: session.sessionId }, 'session:deleted')
    await sendAndWait(ws, 'workspace:delete', { workspaceId: wsId }, 'workspace:deleted')
  })
})
