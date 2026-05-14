// ============================================================
// LocalToolExecutor 测试
// 覆盖工具注册、查找、执行和错误处理
// ============================================================

import { describe, it, expect } from 'vitest'
import { LocalToolExecutor } from './tool-executor.js'
import type { HandTool } from './tool-executor.js'

// ---- 测试用工具 ----

/** 简单回显工具 — 将输入参数 JSON 序列化后返回 */
const echoTool: HandTool = {
  name: 'Echo',
  description: '回显输入参数',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '要回显的消息' },
    },
  },
  isReadOnly: true,
  async execute(input) {
    return { output: JSON.stringify(input), isError: false }
  },
}

/** 总是抛出异常的工具 — 用于测试错误捕获 */
const failingTool: HandTool = {
  name: 'Fail',
  description: '总是失败的工具',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: true,
  async execute() {
    throw new Error('工具执行失败')
  },
}

/** 只读文件读取模拟工具 */
const fileReadTool: HandTool = {
  name: 'FileRead',
  description: '读取文件内容',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input) {
    return { output: `文件内容: ${input.path}`, isError: false }
  },
}

/** 非只读工具（写入操作） */
const fileWriteTool: HandTool = {
  name: 'FileWrite',
  description: '写入文件',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  isReadOnly: false,
  async execute(input) {
    return { output: `已写入: ${input.path}`, isError: false }
  },
}

describe('LocalToolExecutor', () => {
  // ---- 注册和获取定义 ----

  it('注册工具后能获取定义列表', () => {
    const executor = new LocalToolExecutor()
    executor.register(echoTool)
    executor.register(fileReadTool)

    const defs = executor.getDefinitions()
    expect(defs).toHaveLength(2)
    expect(defs.map((d) => d.name)).toContain('Echo')
    expect(defs.map((d) => d.name)).toContain('FileRead')
  })

  it('定义包含完整的工具信息', () => {
    const executor = new LocalToolExecutor()
    executor.register(echoTool)

    const defs = executor.getDefinitions()
    const echo = defs.find((d) => d.name === 'Echo')!
    expect(echo.description).toBe('回显输入参数')
    expect(echo.inputSchema).toEqual(echoTool.inputSchema)
    expect(echo.isReadOnly).toBe(true)
  })

  // ---- getCapabilities ----

  it('getCapabilities 返回所有已注册工具名列表', () => {
    const executor = new LocalToolExecutor()
    executor.register(echoTool)
    executor.register(fileReadTool)
    executor.register(failingTool)

    const caps = executor.getCapabilities()
    expect(caps).toEqual(['Echo', 'FileRead', 'Fail'])
  })

  it('无工具时 getCapabilities 返回空数组', () => {
    const executor = new LocalToolExecutor()
    expect(executor.getCapabilities()).toEqual([])
  })

  // ---- hasTool ----

  it('hasTool 对已注册工具返回 true', () => {
    const executor = new LocalToolExecutor()
    executor.register(echoTool)
    expect(executor.hasTool('Echo')).toBe(true)
  })

  it('hasTool 对未注册工具返回 false', () => {
    const executor = new LocalToolExecutor()
    expect(executor.hasTool('Echo')).toBe(false)
  })

  // ---- execute 正常工具 ----

  it('execute 正常执行工具并返回结果', async () => {
    const executor = new LocalToolExecutor()
    executor.register(echoTool)

    const result = await executor.execute('Echo', { message: 'hello' }, {
      workingDirectory: '/tmp',
      projectRoots: ['/tmp'],
    })
    expect(result.isError).toBe(false)
    expect(result.output).toBe(JSON.stringify({ message: 'hello' }))
  })

  it('execute 传递完整的 context 给工具', async () => {
    const executor = new LocalToolExecutor()
    let receivedContext: unknown
    const contextTool: HandTool = {
      name: 'ContextProbe',
      description: '探测上下文',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_input, context) {
        receivedContext = context
        return { output: 'ok', isError: false }
      },
    }
    executor.register(contextTool)

    const ctx = { workingDirectory: '/project', projectRoots: ['/project', '/lib'] }
    await executor.execute('ContextProbe', {}, ctx)
    expect(receivedContext).toEqual(ctx)
  })

  // ---- execute 不存在的工具 ----

  it('execute 不存在的工具返回错误结果', async () => {
    const executor = new LocalToolExecutor()
    const result = await executor.execute('NotExist', {}, {
      workingDirectory: '/tmp',
      projectRoots: [],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Tool not found: NotExist')
  })

  // ---- execute 工具抛异常 ----

  it('execute 工具抛异常时返回错误结果', async () => {
    const executor = new LocalToolExecutor()
    executor.register(failingTool)

    const result = await executor.execute('Fail', {}, {
      workingDirectory: '/tmp',
      projectRoots: [],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toBe('工具执行失败')
  })

  // ---- 重复注册覆盖 ----

  it('重复注册同名工具覆盖旧定义', () => {
    const executor = new LocalToolExecutor()
    executor.register(echoTool)

    const echoV2: HandTool = {
      ...echoTool,
      description: '回显 V2',
    }
    executor.register(echoV2)

    const defs = executor.getDefinitions()
    expect(defs).toHaveLength(1)
    expect(defs[0].description).toBe('回显 V2')
  })

  // ---- addBuiltinTools ----

  it('addBuiltinTools 注册 EchoTool 内置工具', () => {
    const executor = new LocalToolExecutor()
    executor.addBuiltinTools()

    expect(executor.hasTool('Echo')).toBe(true)
    const defs = executor.getDefinitions()
    const echo = defs.find((d) => d.name === 'Echo')!
    expect(echo.description).toContain('回显')
  })

  it('内置 EchoTool 正常执行', async () => {
    const executor = new LocalToolExecutor()
    executor.addBuiltinTools()

    const result = await executor.execute('Echo', { hello: 'world' }, {
      workingDirectory: '/tmp',
      projectRoots: [],
    })
    expect(result.isError).toBe(false)
    expect(result.output).toBe(JSON.stringify({ hello: 'world' }))
  })

  // ---- isReadOnly 通过 getDefinitions 反映 ----

  it('非只读工具的 isReadOnly 为 false', () => {
    const executor = new LocalToolExecutor()
    executor.register(fileWriteTool)

    const defs = executor.getDefinitions()
    expect(defs[0].isReadOnly).toBe(false)
  })
})
