// ============================================================
// DesktopToolAdapter — 桌面端 Tool 接口适配为 Hand 的 HandTool 接口
// 将桌面端 25+ 工具适配为 Hand 协议可识别的工具格式
// ============================================================

import type { HandTool } from '@wzxclaw/hand'
import type { Tool, ToolExecutionContext } from './tools/tool-interface'
import { flattenToolOutput } from './tools/tool-interface'
import type { ToolRegistry } from './tools/tool-registry'

/**
 * DesktopToolAdapter — 将桌面端 Tool 适配为 Hand 协议的 HandTool
 *
 * 职责:
 * - 透传 name, description, inputSchema, isReadOnly 属性
 * - 映射执行上下文: HandTool 的 {workingDirectory, projectRoots} → ToolExecutionContext
 * - 输出规范化: Tool 返回的 string | ToolResultContent[] 统一展平为 string
 * - 异常捕获: 工具执行异常时返回 { output: errorMessage, isError: true }
 */
export class DesktopToolAdapter implements HandTool {
  private readonly tool: Tool
  private readonly defaultWorkingDirectory: string

  constructor(tool: Tool, defaultWorkingDirectory?: string) {
    this.tool = tool
    this.defaultWorkingDirectory = defaultWorkingDirectory ?? ''
  }

  /** 工具名称（透传底层 Tool） */
  get name(): string {
    return this.tool.name
  }

  /** 工具描述（透传底层 Tool） */
  get description(): string {
    return this.tool.description
  }

  /** 工具输入 JSON Schema（透传底层 Tool） */
  get inputSchema(): Record<string, unknown> {
    return this.tool.inputSchema
  }

  /** 是否只读工具（透传底层 Tool） */
  get isReadOnly(): boolean | undefined {
    return this.tool.isReadOnly
  }

  /**
   * 执行工具
   *
   * 1. 映射 Hand 执行上下文到桌面端 ToolExecutionContext
   * 2. 调用底层 Tool.execute()
   * 3. 将结果展平为纯文本字符串
   * 4. 异常捕获并返回错误结果
   */
  async execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    try {
      // 映射执行上下文
      const toolContext: ToolExecutionContext = {
        workingDirectory: context.workingDirectory || this.defaultWorkingDirectory,
        projectRoots: context.projectRoots,
      }

      const result = await this.tool.execute(input, toolContext)

      // 展平输出: string | ToolResultContent[] → string
      return {
        output: flattenToolOutput(result.output),
        isError: result.isError,
      }
    } catch (err) {
      // 异常捕获，防止未处理的 Promise rejection
      const message = err instanceof Error ? err.message : String(err)
      return { output: message, isError: true }
    }
  }
}

/**
 * adaptAllTools — 批量适配 ToolRegistry 中所有工具
 *
 * 遍历 registry.getAll() 为每个 Tool 创建 DesktopToolAdapter。
 * 未来可扩展跳过逻辑:
 * - 跳过 AgentTool（sub-agent 工具，不支持 Hand 模式）
 * - 跳过 MCP 资源工具（MCP 工具需要 MCP 服务器在线）
 *
 * @param registry - 桌面端 ToolRegistry 实例
 * @param workingDirectory - 默认工作目录
 * @returns DesktopToolAdapter 数组
 */
export function adaptAllTools(
  registry: ToolRegistry,
  workingDirectory: string,
): DesktopToolAdapter[] {
  return registry
    .getAll()
    .map(tool => new DesktopToolAdapter(tool, workingDirectory))
}
