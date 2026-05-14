// ============================================================
// DesktopToolAdapter 单元测试
// 测试 Tool -> HandTool 的接口适配
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { DesktopToolAdapter, adaptAllTools } from '../tool-hand-adapter'
import type { Tool, ToolExecutionResult, ToolResultContent } from '../tools/tool-interface'
import type { ToolRegistry } from '../tools/tool-registry'
import type { HandTool } from '@wzxclaw/hand'

// ---- Mock 工具工厂 ----

/** 创建简单的 echo 工具 mock */
function createMockTool(overrides?: Partial<Tool>): Tool {
  return {
    name: 'Echo',
    description: '回显输入参数',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    requiresApproval: false,
    isReadOnly: true,
    execute: vi.fn(async (input: Record<string, unknown>) => ({
      output: JSON.stringify(input),
      isError: false,
    })),
    ...overrides,
  }
}

/** 创建返回 ToolResultContent[] 的工具 mock */
function createContentArrayTool(): Tool {
  const blocks: ToolResultContent[] = [
    { type: 'text', text: '第一块内容' },
    { type: 'error', text: '错误信息' },
    { type: 'image', image: { url: 'file:///test.png', mimeType: 'image/png' } },
  ]
  return {
    name: 'ContentTool',
    description: '返回多块内容',
    inputSchema: { type: 'object', properties: {} },
    requiresApproval: false,
    execute: vi.fn(async () => ({
      output: blocks,
      isError: false,
    })),
  }
}

/** 创建抛异常的工具 mock */
function createThrowingTool(): Tool {
  return {
    name: 'BadTool',
    description: '总是抛异常',
    inputSchema: { type: 'object', properties: {} },
    requiresApproval: false,
    execute: vi.fn(async () => {
      throw new Error('工具执行失败: 权限不足')
    }),
  }
}

// ---- 测试用例 ----

describe('DesktopToolAdapter', () => {
  it('Test 1: 正确映射 name, description, inputSchema, isReadOnly', () => {
    const tool = createMockTool()
    const adapter = new DesktopToolAdapter(tool)

    expect(adapter.name).toBe('Echo')
    expect(adapter.description).toBe('回显输入参数')
    expect(adapter.inputSchema).toEqual({ type: 'object', properties: { message: { type: 'string' } } })
    expect(adapter.isReadOnly).toBe(true)
  })

  it('Test 2: execute() 调用底层 Tool.execute() 并返回 { output, isError }', async () => {
    const tool = createMockTool()
    const adapter = new DesktopToolAdapter(tool, '/test/workspace')

    const result = await adapter.execute(
      { message: 'hello' },
      { workingDirectory: '/test/dir', projectRoots: ['/test/dir'] },
    )

    expect(result.output).toBe('{"message":"hello"}')
    expect(result.isError).toBe(false)

    // 验证底层工具被正确调用
    expect(tool.execute).toHaveBeenCalledOnce()
    const [input, ctx] = (tool.execute as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(input).toEqual({ message: 'hello' })
    expect(ctx.workingDirectory).toBe('/test/dir')
    expect(ctx.projectRoots).toEqual(['/test/dir'])
  })

  it('Test 3: Tool 返回 ToolResultContent[] 时自动展平为 string', async () => {
    const tool = createContentArrayTool()
    const adapter = new DesktopToolAdapter(tool)

    const result = await adapter.execute(
      {},
      { workingDirectory: '/test', projectRoots: [] },
    )

    // 展平后应该只有 text 和 error 块的内容，image 块被过滤
    expect(result.output).toBe('第一块内容\n错误信息')
    expect(result.isError).toBe(false)
  })

  it('Test 4: context 映射: HandTool 的 {workingDirectory, projectRoots} 映射到 ToolExecutionContext', async () => {
    const tool = createMockTool()
    const adapter = new DesktopToolAdapter(tool, '/default/ws')

    const handContext = {
      workingDirectory: '/project/src',
      projectRoots: ['/project', '/lib'],
    }

    await adapter.execute({}, handContext)

    const [, ctx] = (tool.execute as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(ctx.workingDirectory).toBe('/project/src')
    expect(ctx.projectRoots).toEqual(['/project', '/lib'])
  })

  it('Test 5: Tool 执行异常时捕获并返回 { output: errorMessage, isError: true }', async () => {
    const tool = createThrowingTool()
    const adapter = new DesktopToolAdapter(tool)

    const result = await adapter.execute(
      {},
      { workingDirectory: '/test', projectRoots: [] },
    )

    expect(result.output).toBe('工具执行失败: 权限不足')
    expect(result.isError).toBe(true)
  })
})

describe('adaptAllTools', () => {
  it('Test 6: adaptAllTools(toolRegistry) 批量适配 ToolRegistry 中所有工具', () => {
    // 创建包含 3 个工具的 mock registry
    const mockRegistry = {
      getAll: vi.fn(() => [
        createMockTool({ name: 'FileRead' }),
        createMockTool({ name: 'FileWrite', isReadOnly: false }),
        createMockTool({ name: 'Bash', isReadOnly: false }),
      ]),
    } as unknown as ToolRegistry

    const adapters = adaptAllTools(mockRegistry, '/test/workspace')

    expect(adapters).toHaveLength(3)
    expect(adapters[0].name).toBe('FileRead')
    expect(adapters[1].name).toBe('FileWrite')
    expect(adapters[2].name).toBe('Bash')
  })
})
