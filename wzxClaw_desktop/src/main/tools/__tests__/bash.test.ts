import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BashTool } from '../bash'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

// Mock child_process
const mockExec = vi.fn()
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args)
}))

describe('BashTool', () => {
  let tool: BashTool

  beforeEach(() => {
    tool = new BashTool()
    vi.clearAllMocks()
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('Bash')
    expect(tool.requiresApproval).toBe(true)
    expect(tool.description).toContain('command')
    expect(tool.inputSchema).toBeDefined()
  })

  it('runs command and returns stdout', async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, 'hello\n', '')
    })

    const result = await tool.execute(
      { command: 'echo hello' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('returns stderr and isError for failing command', async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error('Command failed'), 'some output', 'error message')
    })

    const result = await tool.execute(
      { command: 'bad-command' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('error message')
  })

  it('respects custom timeout', async () => {
    mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
      expect(opts.timeout).toBe(5000)
      cb(null, 'done', '')
    })

    await tool.execute(
      { command: 'test', timeout: 5000 },
      { workingDirectory: '/project' }
    )
  })

  it('uses default 30s timeout', async () => {
    mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
      expect(opts.timeout).toBe(30000)
      cb(null, 'done', '')
    })

    await tool.execute(
      { command: 'test' },
      { workingDirectory: '/project' }
    )
  })

  it('returns error for empty command', async () => {
    const result = await tool.execute(
      { command: '' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('command')
  })

  it('returns error for missing command', async () => {
    const result = await tool.execute(
      {},
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('command')
  })

  it('kills child process on abort signal', async () => {
    const mockChild = new EventEmitter() as ChildProcess
    mockChild.kill = vi.fn()

    let execCallback: Function | null = null
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      execCallback = cb
      return mockChild
    })

    const controller = new AbortController()
    const executePromise = tool.execute(
      { command: 'long-running' },
      { workingDirectory: '/project', abortSignal: controller.signal }
    )

    // Abort the signal
    controller.abort()

    // Simulate Node.js behavior: when child.kill() is called, exec invokes callback with an error
    // The kill() mock was called, so now simulate the callback
    if (execCallback) {
      execCallback(new Error('Command aborted'), '', '')
    }

    const result = await executePromise
    expect(result.isError).toBe(true)
    expect(mockChild.kill).toHaveBeenCalled()
  })

  it('includes stderr in output when present', async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, 'stdout content', 'stderr content')
    })

    const result = await tool.execute(
      { command: 'test' },
      { workingDirectory: '/project' }
    )

    expect(result.output).toContain('stdout content')
    expect(result.output).toContain('STDERR')
    expect(result.output).toContain('stderr content')
  })
})
