// ============================================================
// LocalToolExecutor — 本地工具注册和执行框架
// 管理 Hand 端工具的注册、查找和执行
// 收到 hand:execute 时查找对应工具并执行，返回结果
// ============================================================

import type { HandToolDefinition } from './types.js'

// ---- 工具接口 ----

/**
 * Hand 端工具接口（简化版）
 *
 * 不包含 Brain 端概念（requiresApproval、requiresSnapshot 等），
 * Hand 只负责本地执行。
 */
export interface HandTool {
  /** 工具名称（唯一标识） */
  readonly name: string
  /** 工具描述 */
  readonly description: string
  /** 工具输入 JSON Schema */
  readonly inputSchema: Record<string, unknown>
  /** 是否只读工具（不修改文件系统），默认 false */
  readonly isReadOnly?: boolean
  /** 执行工具 */
  execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }>
}

/** 工具执行结果（与 IToolExecutionResult 一致） */
export interface ToolExecutionResult {
  output: string
  isError: boolean
}

// ---- 内置 EchoTool ----

/** EchoTool — 内置测试工具，回显输入参数 */
const echoTool: HandTool = {
  name: 'Echo',
  description: '回显输入参数（内置测试工具）',
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

/**
 * LocalToolExecutor — 管理本地工具的注册和执行
 *
 * 职责:
 * - 注册工具到内部 registry
 * - 提供 getDefinitions() 供 HandConnection 注册时使用
 * - 提供 getCapabilities() 返回工具名列表
 * - 收到 hand:execute 时查找并执行对应工具
 * - 统一错误处理：工具不存在或执行异常均返回错误结果
 */
export class LocalToolExecutor {
  /** 工具注册表（name → tool） */
  private readonly registry = new Map<string, HandTool>()

  /**
   * 注册一个工具到 registry
   * 重复 name 会覆盖旧定义
   */
  register(tool: HandTool): void {
    this.registry.set(tool.name, tool)
  }

  /**
   * 从 registry 注销一个工具
   */
  unregister(name: string): boolean {
    return this.registry.delete(name)
  }

  /**
   * 返回所有已注册工具的定义列表
   * 用于 hand:register 消息中的 definitions 字段
   */
  getDefinitions(): HandToolDefinition[] {
    return Array.from(this.registry.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      isReadOnly: tool.isReadOnly,
    }))
  }

  /**
   * 返回所有已注册工具名列表
   * 用于 hand:register 消息中的 capabilities 字段
   */
  getCapabilities(): string[] {
    return Array.from(this.registry.keys())
  }

  /**
   * 检查工具是否已注册
   */
  hasTool(name: string): boolean {
    return this.registry.has(name)
  }

  /**
   * 执行指定工具
   *
   * 1. 从 registry 查找工具
   * 2. 不存在时返回 { output: "Tool not found: {name}", isError: true }
   * 3. 调用 tool.execute()，try-catch 包裹
   * 4. 正常返回工具结果
   * 5. 异常捕获：{ output: error.message, isError: true }
   *
   * @param name - 工具名称
   * @param input - 工具输入参数
   * @param context - 执行上下文
   * @returns 工具执行结果
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<ToolExecutionResult> {
    // 查找工具
    const tool = this.registry.get(name)
    if (!tool) {
      return { output: `Tool not found: ${name}`, isError: true }
    }

    // 执行工具（捕获异常防止进程崩溃）
    try {
      return await tool.execute(input, context)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: message, isError: true }
    }
  }

  /**
   * 注册内置示例工具
   * 目前包含 EchoTool（回显输入参数）
   */
  addBuiltinTools(): void {
    this.register(echoTool)
  }
}
