// ============================================================
// Agent Tool — Spawns sub-agents with isolated context
// ============================================================

import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { LLMGateway } from '../llm/gateway'
import { ToolRegistry } from './tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import { ContextManager } from '../context/context-manager'
import type { HookRegistry } from '../hooks/hook-registry'
import { AgentLoop } from '../agent/agent-loop'
import type { AgentConfig } from '../agent/types'

const AgentToolSchema = z.object({
  description: z.string().min(1).max(200),
  prompt: z.string().min(1),
  maxTurns: z.number().int().positive().max(20).optional()
})

const DEFAULT_MAX_SUB_AGENT_TURNS = 10

export class AgentTool implements Tool {
  readonly name = 'Agent'
  readonly description =
    'Spawn a sub-agent to handle a complex, self-contained task. ' +
    'The sub-agent gets its own context and returns a summary when done. ' +
    'Use for tasks that need multiple tool calls but are independent of the main conversation.'
  readonly requiresApproval = false
  readonly isReadOnly = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short (3-7 word) description of the delegated task'
      },
      prompt: {
        type: 'string',
        description: 'Detailed instructions for the sub-agent'
      },
      maxTurns: {
        type: 'number',
        description: `Maximum turns for the sub-agent (default: ${DEFAULT_MAX_SUB_AGENT_TURNS})`
      }
    },
    required: ['description', 'prompt']
  }

  private depth: number

  constructor(
    private gateway: LLMGateway,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private contextManager: ContextManager,
    private hookRegistry: HookRegistry | undefined,
    private baseConfig: Omit<AgentConfig, 'conversationId' | 'maxTurns'>,
    depth = 0
  ) {
    this.depth = depth
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = AgentToolSchema.safeParse(input)
    if (!parsed.success) {
      return { output: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    // Prevent deep recursion
    if (this.depth >= 2) {
      return { output: 'Sub-agent depth limit reached (max 2 levels)', isError: true }
    }

    const { description, prompt, maxTurns } = parsed.data

    // Create a child tool registry without the Agent tool itself
    const childRegistry = new ToolRegistry()
    for (const tool of this.toolRegistry.getAll()) {
      if (tool.name !== 'Agent') {
        childRegistry.register(tool)
      }
    }

    // Create a fresh context manager for the sub-agent
    const childContextManager = new ContextManager()

    // Create the sub-agent loop
    const subAgent = new AgentLoop(
      this.gateway,
      childRegistry,
      this.permissionManager,
      childContextManager,
      this.hookRegistry
    )

    const subConfig: AgentConfig = {
      ...this.baseConfig,
      conversationId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      maxTurns: maxTurns ?? DEFAULT_MAX_SUB_AGENT_TURNS,
      workingDirectory: context.workingDirectory
    }

    // Collect the sub-agent's text output
    const textParts: string[] = []
    let lastError = ''

    try {
      for await (const event of subAgent.run(prompt, subConfig)) {
        switch (event.type) {
          case 'agent:text':
            textParts.push(event.content)
            break
          case 'agent:error':
            lastError = event.error
            break
          case 'agent:done':
            // Sub-agent completed
            break
        }
      }
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      }
    }

    const text = textParts.join('')
    if (!text && lastError) {
      return { output: `Sub-agent failed: ${lastError}`, isError: true }
    }

    return {
      output: `[Sub-agent: ${description}]\n\n${text || 'Sub-agent completed without text output.'}`,
      isError: false
    }
  }
}
