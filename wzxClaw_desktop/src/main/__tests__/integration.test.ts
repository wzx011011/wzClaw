import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC_CHANNELS, IpcSchemas } from '../../shared/ipc-channels'
import { createDefaultTools } from '../tools/tool-registry'

// ============================================================
// Integration Test: Tool Registry + IPC Schema validation
// ============================================================

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
  it('should define settings channels', () => {
    expect(IPC_CHANNELS['settings:get']).toBe('settings:get')
    expect(IPC_CHANNELS['settings:update']).toBe('settings:update')
  })

  it('should define terminal channels', () => {
    expect(IPC_CHANNELS['terminal:create']).toBe('terminal:create')
    expect(IPC_CHANNELS['terminal:kill']).toBe('terminal:kill')
  })
})

// ============================================================
// Test 2: Tool registry wiring
// ============================================================
describe('Default Tool Registry', () => {
  it('should register all base tools', () => {
    const registry = createDefaultTools(process.cwd())
    const tools = registry.getAll()

    expect(tools.length).toBeGreaterThanOrEqual(10)

    const toolNames = tools.map((t) => t.name).sort()
    // Core tools must always exist
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('FileRead')
    expect(toolNames).toContain('FileWrite')
    expect(toolNames).toContain('Grep')
    expect(toolNames).toContain('Glob')
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

  it('should register handlers without throwing', async () => {
    const { ipcMain } = await import('electron')

    const mockPermissionManager = {
      getMode: vi.fn(() => 'always-ask'),
      setMode: vi.fn(),
      getAlwaysAllowRules: vi.fn(() => []),
    } as unknown

    const mockWorkspaceManager = {
      getWorkspaceRoot: vi.fn(() => '/test/workspace'),
      openFolderDialog: vi.fn(),
      getDirectoryTree: vi.fn(),
      startWatching: vi.fn(),
      isWatching: vi.fn(),
      onFileChange: vi.fn(),
      offFileChange: vi.fn(),
    } as unknown

    const mockTerminalManager = {
      createTerminal: vi.fn(() => 'term-1'),
      killTerminal: vi.fn(),
      writeToTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      getOutputBuffer: vi.fn(() => ''),
      dispose: vi.fn(),
      onTerminalData: vi.fn(),
    } as unknown

    const mockSettingsManager = {
      getSettings: vi.fn(() => ({})),
      getCurrentConfig: vi.fn(() => ({})),
      updateSettings: vi.fn(),
      setLastWorkspacePath: vi.fn(),
      getLastWorkspacePath: vi.fn(() => null),
    } as unknown

    const mockMcpManager = {
      listServers: vi.fn(() => []),
      listAllTools: vi.fn(() => []),
      addServer: vi.fn(),
      removeServer: vi.fn(),
    } as unknown

    const mockWorkspaceStore = {
      listWorkspaces: vi.fn(() => []),
      getWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      updateWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      addProject: vi.fn(),
      removeProject: vi.fn(),
    } as unknown

    const mockHandBridge = {
      getStatus: vi.fn(() => 'disconnected'),
      getHandId: vi.fn(() => ''),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown

    const mockToolRegistry = {
      getDefinitions: vi.fn(() => []),
      getApprovalRequired: vi.fn(() => []),
      isReadOnly: vi.fn(() => true),
    } as unknown

    const { registerIpcHandlers } = await import('../ipc-handlers')

    expect(() => {
      registerIpcHandlers(
        mockPermissionManager as any,
        mockWorkspaceManager as any,
        mockTerminalManager as any,
        null, // indexingEngine
        mockSettingsManager as any,
        mockMcpManager as any,
        mockWorkspaceStore as any,
        mockHandBridge as any,
        mockToolRegistry as any,
      )
    }).not.toThrow()

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: [string, ...unknown[]]) => call[0]
    )

    expect(handleCalls).toContain('settings:get')
    expect(handleCalls).toContain('settings:update')
    expect(handleCalls).toContain('workspace:list')
    expect(handleCalls).toContain('workspace:get')
    expect(handleCalls).toContain('workspace:create')
  })
})

// ============================================================
// Test 4: Zod validation schemas
// ============================================================
describe('IPC Zod Schemas', () => {
  it('should validate correct file:save request', () => {
    const result = IpcSchemas['file:save'].request.safeParse({
      filePath: '/test/file.ts',
      content: 'hello',
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty filePath in file:save', () => {
    const result = IpcSchemas['file:save'].request.safeParse({
      filePath: '',
      content: 'hello',
    })
    expect(result.success).toBe(false)
  })
})
