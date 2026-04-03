import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC_CHANNELS, IpcSchemas } from '../../shared/ipc-channels'
import { createDefaultTools } from '../tools/tool-registry'

// ============================================================
// Integration Test: IPC -> AgentLoop -> Tool execution wiring
// ============================================================
// These tests verify the wiring between components WITHOUT
// spawning Electron. Agent loop logic is covered by Plan 03 tests.

// Mock electron module
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    handleOnce: vi.fn(),
  },
}))

// ============================================================
// Test 1: IPC channel definitions
// ============================================================
describe('IPC Channels', () => {
  it('should define all required agent channels', () => {
    expect(IPC_CHANNELS['agent:send_message']).toBe('agent:send_message')
    expect(IPC_CHANNELS['agent:stop']).toBe('agent:stop')
  })

  it('should define all required stream channels', () => {
    expect(IPC_CHANNELS['stream:text_delta']).toBe('stream:text_delta')
    expect(IPC_CHANNELS['stream:tool_use_start']).toBe('stream:tool_use_start')
    expect(IPC_CHANNELS['stream:tool_use_delta']).toBe('stream:tool_use_delta')
    expect(IPC_CHANNELS['stream:tool_use_end']).toBe('stream:tool_use_end')
    expect(IPC_CHANNELS['stream:error']).toBe('stream:error')
    expect(IPC_CHANNELS['stream:done']).toBe('stream:done')
  })

  it('should define permission channels', () => {
    expect(IPC_CHANNELS['agent:permission_request']).toBe('agent:permission_request')
    expect(IPC_CHANNELS['agent:permission_response']).toBe('agent:permission_response')
  })

  it('should define settings channels', () => {
    expect(IPC_CHANNELS['settings:get']).toBe('settings:get')
    expect(IPC_CHANNELS['settings:update']).toBe('settings:update')
  })
})

// ============================================================
// Test 2: Tool registry wiring
// ============================================================
describe('Default Tool Registry', () => {
  it('should register all 6 tools', () => {
    const registry = createDefaultTools(process.cwd())
    const tools = registry.getAll()

    expect(tools).toHaveLength(6)

    const toolNames = tools.map((t) => t.name).sort()
    expect(toolNames).toEqual(['Bash', 'FileEdit', 'FileRead', 'FileWrite', 'Glob', 'Grep'])
  })

  it('should have exactly 3 approval-required tools', () => {
    const registry = createDefaultTools(process.cwd())
    const approvalRequired = registry.getApprovalRequired()

    expect(approvalRequired).toHaveLength(3)
    expect(approvalRequired.sort()).toEqual(['Bash', 'FileEdit', 'FileWrite'])
  })

  it('should have valid JSON Schema for each tool', () => {
    const registry = createDefaultTools(process.cwd())
    const tools = registry.getAll()

    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties).toBeDefined()
      expect(typeof tool.inputSchema.properties).toBe('object')
    }
  })

  it('should produce valid tool definitions for LLM', () => {
    const registry = createDefaultTools(process.cwd())
    const definitions = registry.getDefinitions()

    expect(definitions).toHaveLength(6)

    for (const def of definitions) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
      expect(def.inputSchema).toBeDefined()
      expect(def.inputSchema.type).toBe('object')
    }
  })
})

// ============================================================
// Test 3: IPC handler registration wiring
// ============================================================
describe('IPC Handler Registration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('should register handlers without throwing when given gateway + agentLoop + permissionManager', async () => {
    // Import the mocked electron
    const { ipcMain } = await import('electron')

    // Create mock components
    const mockGateway = {
      stream: vi.fn(),
      addProvider: vi.fn(),
      getAdapter: vi.fn(),
      hasProvider: vi.fn(),
    } as unknown

    const mockAgentLoop = {
      run: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
      getMessages: vi.fn(),
    } as unknown

    const mockPermissionManager = {
      requestApproval: vi.fn(),
      clearSession: vi.fn(),
      isApproved: vi.fn(),
      isRendererConnected: vi.fn(),
    } as unknown

    // Dynamic import to get fresh module with our mocks
    const { registerIpcHandlers } = await import('../ipc-handlers')

    // Should not throw
    expect(() => {
      registerIpcHandlers(
        mockGateway as import('../llm/gateway').LLMGateway,
        mockAgentLoop as import('../agent/agent-loop').AgentLoop,
        mockPermissionManager as import('../permission/permission-manager').PermissionManager
      )
    }).not.toThrow()

    // Verify ipcMain.handle was called for all expected channels
    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: [string, ...unknown[]]) => call[0]
    )

    expect(handleCalls).toContain('agent:send_message')
    expect(handleCalls).toContain('agent:stop')
    expect(handleCalls).toContain('settings:get')
    expect(handleCalls).toContain('settings:update')
  })
})

// ============================================================
// Test 4: Zod validation schemas
// ============================================================
describe('IPC Zod Schemas', () => {
  it('should validate correct agent:send_message request', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'test-123',
      content: 'Hello, world!',
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty content in agent:send_message', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'test-123',
      content: '',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing conversationId in agent:send_message', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      content: 'Hello!',
    })
    expect(result.success).toBe(false)
  })
})
