import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PermissionManager } from '../permission-manager'

// Mock Electron — handle captures the registered handler for test use
let capturedHandler: ((event: unknown, data: unknown) => Promise<unknown>) | null = null

const mockSend = vi.fn()
const mockWebContents = { send: mockSend } as unknown as Electron.WebContents

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((_ch: string, h: any) => { capturedHandler = h }),
    removeHandler: vi.fn()
  }
}))

describe('PermissionManager', () => {
  let manager: PermissionManager

  beforeEach(() => {
    capturedHandler = null
    mockSend.mockClear()
    // New manager instance resets handlerRegistered to false,
    // so the next requestApproval() call will re-register via ipcMain.handle
    manager = new PermissionManager()
  })

  it('new conversation has no cached approvals', () => {
    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(false)
    expect(manager.isApproved('conv-1', 'Bash')).toBe(false)
  })

  it('approve for session caches subsequent same-tool approvals', async () => {
    const approvalPromise = manager.requestApproval(
      'conv-1', 'FileWrite', { path: '/test.ts', content: 'hi' }, mockWebContents
    )

    expect(mockSend).toHaveBeenCalledWith('agent:permission_request', {
      toolName: 'FileWrite',
      toolInput: { path: '/test.ts', content: 'hi' },
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      reason: expect.any(String)
    })
    expect(capturedHandler).not.toBeNull()

    // Capture requestId from the mock call to pass it in the response
    const sentPayload = mockSend.mock.calls[0][1] as { requestId: string }
    await capturedHandler!({}, { approved: true, sessionCache: true, requestId: sentPayload.requestId })
    const approved = await approvalPromise
    expect(approved).toBe(true)
    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(true)
  })

  it('deny does not cache approval', async () => {
    const approvalPromise = manager.requestApproval(
      'conv-1', 'Bash', { command: 'rm -rf /' }, mockWebContents
    )

    await capturedHandler!({}, { approved: false, sessionCache: false })
    const approved = await approvalPromise
    expect(approved).toBe(false)
    expect(manager.isApproved('conv-1', 'Bash')).toBe(false)
  })

  it('clearSession removes all cached approvals for conversation', async () => {
    const approvalPromise = manager.requestApproval(
      'conv-1', 'FileWrite', { path: '/test.ts', content: 'hi' }, mockWebContents
    )
    await capturedHandler!({}, { approved: true, sessionCache: true })
    await approvalPromise

    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(true)
    manager.clearSession('conv-1')
    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(false)
  })

  it('different conversations have independent caches', async () => {
    const approvalPromise = manager.requestApproval(
      'conv-1', 'FileWrite', { path: '/test.ts', content: 'hi' }, mockWebContents
    )
    await capturedHandler!({}, { approved: true, sessionCache: true })
    await approvalPromise

    expect(manager.isApproved('conv-1', 'FileWrite')).toBe(true)
    expect(manager.isApproved('conv-2', 'FileWrite')).toBe(false)
  })

  it('isRendererConnected returns true (placeholder)', () => {
    expect(manager.isRendererConnected()).toBe(true)
  })
})
