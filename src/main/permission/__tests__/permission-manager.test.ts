import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PermissionManager } from '../permission-manager'

// Mock Electron
const mockSend = vi.fn()
const mockWebContents = {
  send: mockSend
} as unknown as Electron.WebContents

// Mock ipcMain for handleOnce pattern
vi.mock('electron', () => ({
  ipcMain: {
    handleOnce: vi.fn()
  }
}))

describe('PermissionManager', () => {
  let manager: PermissionManager

  beforeEach(() => {
    manager = new PermissionManager()
    vi.clearAllMocks()
  })

  it('new conversation has no cached approvals', () => {
    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(false)
    expect(manager.isApproved('conv-1', 'Bash')).toBe(false)
  })

  it('approve for session caches subsequent same-tool approvals', async () => {
    // Simulate: first request -> renderer approves with sessionCache=true
    // We need to make requestApproval resolve to true
    // The method sends IPC to renderer and waits for response
    // We simulate this by triggering the response handler

    const { ipcMain } = await import('electron')

    // Mock ipcMain.handleOnce to immediately invoke the response handler
    let responseHandler: any = null
    vi.mocked(ipcMain.handleOnce).mockImplementation((channel: string, handler: any) => {
      responseHandler = handler
    })

    // Start the request
    const approvalPromise = manager.requestApproval(
      'conv-1',
      'FileWrite',
      { path: '/test.ts', content: 'hi' },
      mockWebContents
    )

    // Verify IPC was sent to renderer
    expect(mockSend).toHaveBeenCalledWith('agent:permission_request', {
      toolName: 'FileWrite',
      toolInput: { path: '/test.ts', content: 'hi' },
      reason: expect.any(String)
    })

    // Simulate renderer responding with approval + session cache
    // The handleOnce handler receives (event, data) and returns the data
    // We call the handler to simulate the response
    expect(ipcMain.handleOnce).toHaveBeenCalledWith('agent:permission_response', expect.any(Function))

    // Simulate the response by calling the registered handler
    const mockEvent = {} as any
    await responseHandler(mockEvent, { approved: true, sessionCache: true })

    const approved = await approvalPromise
    expect(approved).toBe(true)

    // Subsequent calls should be auto-approved from cache
    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(true)
  })

  it('deny does not cache approval', async () => {
    const { ipcMain } = await import('electron')

    let responseHandler: any = null
    vi.mocked(ipcMain.handleOnce).mockImplementation((channel: string, handler: any) => {
      responseHandler = handler
    })

    const approvalPromise = manager.requestApproval(
      'conv-1',
      'Bash',
      { command: 'rm -rf /' },
      mockWebContents
    )

    const mockEvent = {} as any
    await responseHandler(mockEvent, { approved: false, sessionCache: false })

    const approved = await approvalPromise
    expect(approved).toBe(false)
    expect(manager.isApproved('conv-1', 'Bash')).toBe(false)
  })

  it('clearSession removes all cached approvals for conversation', async () => {
    const { ipcMain } = await import('electron')

    let responseHandler: any = null
    vi.mocked(ipcMain.handleOnce).mockImplementation((channel: string, handler: any) => {
      responseHandler = handler
    })

    const approvalPromise = manager.requestApproval(
      'conv-1',
      'FileWrite',
      { path: '/test.ts', content: 'hi' },
      mockWebContents
    )

    const mockEvent = {} as any
    await responseHandler(mockEvent, { approved: true, sessionCache: true })
    await approvalPromise

    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(true)

    manager.clearSession('conv-1')

    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(false)
  })

  it('different conversations have independent caches', async () => {
    const { ipcMain } = await import('electron')

    let responseHandler: any = null
    vi.mocked(ipcMain.handleOnce).mockImplementation((channel: string, handler: any) => {
      responseHandler = handler
    })

    const approvalPromise = manager.requestApproval(
      'conv-1',
      'FileWrite',
      { path: '/test.ts', content: 'hi' },
      mockWebContents
    )

    const mockEvent = {} as any
    await responseHandler(mockEvent, { approved: true, sessionCache: true })
    await approvalPromise

    // conv-1 has cached approval
    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(true)
    // conv-2 does not
    expect(manager.isApproved('conv-2', 'FileWrite')).toBe(false)
  })

  it('isRendererConnected returns true (placeholder)', () => {
    expect(manager.isRendererConnected()).toBe(true)
  })
})
