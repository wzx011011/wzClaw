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

// ============================================================
// Sub-agent type definitions
// ============================================================

type SubagentType = 'explore' | 'plan' | 'general'

interface AgentTypeConfig {
  description: string
  systemPrompt: string | null
  /** Tool names to restrict to; null means all tools (except Agent itself) */
  allowedTools: string[] | null
}

const AGENT_TYPES: Record<SubagentType, AgentTypeConfig> = {
  explore: {
    description: 'Fast read-only agent for exploring and understanding code',
    systemPrompt:
      'You are a code exploration expert. Your job is to quickly search, read, and understand codebases. ' +
      'Be concise and direct. Return only the information that was asked for. ' +
      'Never modify files — you have access only to read-only tools.',
    allowedTools: ['FileRead', 'Grep', 'Glob'],
  },
  plan: {
    description: 'Planning agent that designs solutions without modifying code',
    systemPrompt:
      'You are a software architect. Analyze the codebase and design clear implementation plans. ' +
      'Read files to understand the code thoroughly, then produce a structured plan. ' +
      'Never modify anything — you have access only to read-only tools.',
    allowedTools: ['FileRead', 'Grep', 'Glob'],
  },
  general: {
    description: 'General purpose agent with access to all tools',
    systemPrompt: null,    // inherit from parent agent config
    allowedTools: null,    // all tools except Agent (recursion guard)
  },
}

// ============================================================
// Zod schema
// ============================================================

const AgentToolSchema = z.object({
  description: z.string().min(1).max(200),
  prompt: z.string().min(1),
  maxTurns: z.number().int().positive().max(20).optional(),
  subagent_type: z.enum(['explore', 'plan', 'general']).optional(),
})

const DEFAULT_MAX_SUB_AGENT_TURNS = 10

export class AgentTool implements Tool {
  readonly name = 'Agent'
  readonly description =
    'Spawn a sub-agent to handle a complex, self-contained task. ' +
    'The sub-agent gets its own context and returns a summary when done. ' +
    'Use for tasks that need multiple tool calls but are independent of the main conversation.\n\n' +
    'subagent_type options:\n' +
    '  "explore" — read-only agent (FileRead, Grep, Glob only) for fast codebase exploration\n' +
    '  "plan"    — read-only agent that produces implementation plans without touching files\n' +
    '  "general" — full-access agent with all tools except Agent (default)'
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
      },
      subagent_type: {
        type: 'string',
        enum: ['explore', 'plan', 'general'],
        description: 'Type of sub-agent to spawn (default: "general")'
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
    depth = 0,
    private getLatestConfig?: () => Omit<AgentConfig, 'conversationId' | 'maxTurns'>
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

    const { description, prompt, maxTurns, subagent_type = 'general' } = parsed.data
    const typeConfig = AGENT_TYPES[subagent_type]

    // Use latest config (model/provider may change after construction)
    const currentBase = this.getLatestConfig ? this.getLatestConfig() : this.baseConfig

    // Build child tool registry: apply allowedTools filter if specified,
    // always exclude Agent itself to prevent unbounded recursion.
    const childRegistry = new ToolRegistry()
    for (const tool of this.toolRegistry.getAll()) {
      if (tool.name === 'Agent') continue
      if (typeConfig.allowedTools !== null && !typeConfig.allowedTools.includes(tool.name)) continue
      childRegistry.register(tool)
    }

    // Create a fresh context manager for the sub-agent
    const childContextManager = new ContextManager()

    // Resolve system prompt: type-specific override takes priority over parent config
    const resolvedSystemPrompt = typeConfig.systemPrompt ?? this.baseConfig.systemPrompt

    // Create the sub-agent loop
    const subAgent = new AgentLoop(
      this.gateway,
      childRegistry,
      this.permissionManager,
      childContextManager,
      this.hookRegistry
    )

    const subConfig: AgentConfig = {
      ...currentBase,
      systemPrompt: resolvedSystemPrompt,
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
      output: `[Sub-agent (${subagent_type}): ${description}]\n\n${text || 'Sub-agent completed without text output.'}`,
      isError: false
    }
  }
}
