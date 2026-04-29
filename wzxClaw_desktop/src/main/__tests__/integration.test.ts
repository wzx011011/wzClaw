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
    on: vi.fn(),
  },
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(() => Buffer.from('encrypted')),
    decryptString: vi.fn(() => 'decrypted'),
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
  it('should register all 11 base tools', () => {
    const registry = createDefaultTools(process.cwd())
    const tools = registry.getAll()

    expect(tools).toHaveLength(11)

    const toolNames = tools.map((t) => t.name).sort()
    expect(toolNames).toEqual([
      'Bash', 'FileEdit', 'FileRead', 'FileWrite', 'Glob', 'Grep',
      'LS', 'MultiEdit', 'SemanticSearch', 'WebFetch', 'WebSearch'
    ])
  })

  it('should have exactly 4 approval-required tools', () => {
    const registry = createDefaultTools(process.cwd())
    const approvalRequired = registry.getApprovalRequired()

    expect(approvalRequired).toHaveLength(4)
    expect(approvalRequired.sort()).toEqual(['Bash', 'FileEdit', 'FileWrite', 'MultiEdit'])
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

    expect(definitions).toHaveLength(11)

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

  it('should register handlers without throwing when given all required components', async () => {
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

    const mockWorkspaceManager = {
      getWorkspaceRoot: vi.fn(() => '/test/workspace'),
      openFolderDialog: vi.fn(),
      getDirectoryTree: vi.fn(),
      startWatching: vi.fn(),
      isWatching: vi.fn(),
      readFile: vi.fn(),
      saveFile: vi.fn(),
    } as unknown

    const mockSessionStore = {
      appendMessage: vi.fn(),
      appendMessages: vi.fn(),
      loadSession: vi.fn(() => []),
      listSessions: vi.fn(() => []),
      deleteSession: vi.fn(() => true),
    } as unknown

    const mockContextManager = {
      compact: vi.fn(),
      getTokenCount: vi.fn(),
    } as unknown

    const mockTerminalManager = {
      createTerminal: vi.fn(),
      killTerminal: vi.fn(),
      writeToTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      getOutputBuffer: vi.fn(),
      dispose: vi.fn(),
    } as unknown

    const mockStepManager = {
      getAllSteps: vi.fn(() => []),
      createStep: vi.fn(),
      updateStep: vi.fn(),
    } as unknown

    const mockSettingsManager = {
      getCurrentConfig: vi.fn(() => ({})),
      updateConfig: vi.fn(),
      setLastWorkspacePath: vi.fn(),
      getRecentWorkspaces: vi.fn(() => []),
    } as unknown

    const mockMcpManager = {
      listServers: vi.fn(() => []),
      getServerStatus: vi.fn(),
      addServer: vi.fn(),
      removeServer: vi.fn(),
      restartServer: vi.fn(),
      loadAndConnect: vi.fn(),
    } as unknown

    const mockTaskStore = {
      listWorkspaces: vi.fn(() => []),
      getWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      updateWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      addProject: vi.fn(),
      removeProject: vi.fn(),
    } as unknown

    // Dynamic import to get fresh module with our mocks
    const { registerIpcHandlers } = await import('../ipc-handlers')

    // Should not throw
    expect(() => {
      registerIpcHandlers(
        mockGateway as import('../llm/gateway').LLMGateway,
        mockAgentLoop as import('../agent/agent-loop').AgentLoop,
        mockPermissionManager as import('../permission/permission-manager').PermissionManager,
        mockWorkspaceManager as import('../workspace/workspace-manager').WorkspaceManager,
        (() => mockSessionStore) as () => import('../persistence/session-store').SessionStore,
        mockContextManager as import('../context/context-manager').ContextManager,
        mockTerminalManager as import('../terminal/terminal-manager').TerminalManager,
        mockStepManager as import('../steps/step-manager').StepManager,
        null, // indexingEngine (optional)
        mockSettingsManager as any,
        mockMcpManager as any,
        mockTaskStore as import('../tasks/workspace-store').WorkspaceStore,
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
    expect(handleCalls).toContain('index:status')
    expect(handleCalls).toContain('index:reindex')
    expect(handleCalls).toContain('index:search')

    // Workspace IPC handlers
    expect(handleCalls).toContain('workspace:list')
    expect(handleCalls).toContain('workspace:get')
    expect(handleCalls).toContain('workspace:create')
    expect(handleCalls).toContain('workspace:update')
    expect(handleCalls).toContain('workspace:delete')
    expect(handleCalls).toContain('workspace:add-project')
    expect(handleCalls).toContain('workspace:remove-project')
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

  it('should accept agent:send_message with optional activeWorkspaceId', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'test-123',
      content: 'Hello!',
      activeWorkspaceId: 'task-abc',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.activeWorkspaceId).toBe('task-abc')
    }
  })

  it('should accept agent:send_message without activeWorkspaceId', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'test-123',
      content: 'Hello!',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.activeWorkspaceId).toBeUndefined()
    }
  })
})
