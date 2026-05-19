import { describe, it, expect } from 'vitest'
import { StreamingToolExecutor } from '../streaming-tool-executor.js'
import type { ToolExecResult } from '../streaming-tool-executor.js'

function makeResult(id: string, name: string, output: string): ToolExecResult {
  return { toolCallId: id, toolName: name, output, truncatedOutput: output, isError: false, loopDetected: false }
}

describe('StreamingToolExecutor', () => {
  it('executes read-only tools in parallel', async () => {
    const order: string[] = []
    const executor = new StreamingToolExecutor(name => name === 'FileRead')

    executor.onToolUseEnd('r1', 'FileRead', async () => {
      await new Promise(r => setTimeout(r, 20))
      order.push('r1')
      return makeResult('r1', 'FileRead', 'content1')
    })
    executor.onToolUseEnd('r2', 'FileRead', async () => {
      order.push('r2')
      return makeResult('r2', 'FileRead', 'content2')
    })

    const results = await executor.waitAll()
    expect(results).toHaveLength(2)
    expect(results.map(r => r.toolCallId)).toEqual(['r1', 'r2'])
    // r2 should have started before r1 finished (parallel)
    expect(order).toContain('r2')
  })

  it('chains write tools sequentially', async () => {
    const order: string[] = []
    const executor = new StreamingToolExecutor(() => false) // all write

    executor.onToolUseEnd('w1', 'FileWrite', async () => {
      await new Promise(r => setTimeout(r, 30))
      order.push('w1')
      return makeResult('w1', 'FileWrite', 'ok1')
    })
    executor.onToolUseEnd('w2', 'FileWrite', async () => {
      order.push('w2')
      return makeResult('w2', 'FileWrite', 'ok2')
    })

    await executor.waitAll()
    // w2 should only run after w1
    expect(order).toEqual(['w1', 'w2'])
  })

  it('mixes read and write tools correctly', async () => {
    const order: string[] = []
    const executor = new StreamingToolExecutor(name => name === 'FileRead')

    executor.onToolUseEnd('r1', 'FileRead', async () => {
      order.push('r1')
      return makeResult('r1', 'FileRead', 'content')
    })
    executor.onToolUseEnd('w1', 'FileWrite', async () => {
      order.push('w1')
      return makeResult('w1', 'FileWrite', 'ok')
    })
    executor.onToolUseEnd('r2', 'FileRead', async () => {
      order.push('r2')
      return makeResult('r2', 'FileRead', 'content2')
    })

    const results = await executor.waitAll()
    expect(results.map(r => r.toolCallId)).toEqual(['r1', 'w1', 'r2'])
    // r1 and r2 are read-only, run immediately; w1 is write, sequential
    expect(order.indexOf('w1')).toBeGreaterThan(order.indexOf('r1') - 1)
  })

  it('wraps thrown errors as error results', async () => {
    const executor = new StreamingToolExecutor(() => true)

    executor.onToolUseEnd('e1', 'FileRead', async () => {
      throw new Error('disk full')
    })

    const results = await executor.waitAll()
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(true)
    expect(results[0].output).toBe('disk full')
  })

  it('write tool failure does not block subsequent write tools', async () => {
    const order: string[] = []
    const executor = new StreamingToolExecutor(() => false)

    executor.onToolUseEnd('w1', 'FileWrite', async () => {
      order.push('w1')
      throw new Error('fail')
    })
    executor.onToolUseEnd('w2', 'FileWrite', async () => {
      order.push('w2')
      return makeResult('w2', 'FileWrite', 'ok')
    })

    const results = await executor.waitAll()
    expect(order).toEqual(['w1', 'w2'])
    expect(results).toHaveLength(2)
    expect(results[0].isError).toBe(true)
    expect(results[1].isError).toBe(false)
  })

  it('size tracks pending count', () => {
    const executor = new StreamingToolExecutor(() => true)
    expect(executor.size).toBe(0)
    executor.onToolUseEnd('r1', 'FileRead', async () => makeResult('r1', 'FileRead', ''))
    expect(executor.size).toBe(1)
  })

  it('getPending returns snapshot', () => {
    const executor = new StreamingToolExecutor(() => true)
    executor.onToolUseEnd('r1', 'FileRead', async () => makeResult('r1', 'FileRead', ''))
    const pending = executor.getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('r1')
  })
})
