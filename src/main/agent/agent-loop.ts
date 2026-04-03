import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'
import type { ToolRegistry } from '../tools/tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import type { Message, ToolCall, StreamEvent, LLMProvider } from '../../shared/types'
import { MAX_AGENT_TURNS } from '../../shared/constants'
import { LoopDetector } from './loop-detector'
import { MessageBuilder } from './message-builder'
import type { AgentEvent, AgentConfig } from './types'

// ============================================================
// AgentLoop (per D-23, D-35)
// ============================================================

/**
 * Core agent loop that orchestrates multi-turn LLM conversations
 * with tool execution, permission checks, loop detection, and cancellation.
 *
 * Flow:
 * 1. User sends message
 * 2. LLM processes and responds (may include tool calls)
 * 3. Tool calls are executed (with permission checks for destructive tools)
 * 4. Results are fed back to LLM
 * 5. Repeat until LLM returns text-only response or safety guard triggers
 */
export class AgentLoop {
  private messages: Message[] = []
  private loopDetector = new LoopDetector()
  private messageBuilder = new MessageBuilder()
  private abortController: AbortController | null = null

  constructor(
    private gateway: LLMGateway,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager
  ) {}

  /**
   * Run the agent loop for a user message.
   * Yields AgentEvent instances as the conversation progresses.
   *
   * @param userMessage - The user's input message
   * @param config - Agent configuration
   * @param sender - Optional Electron WebContents for permission requests
   */
  async *run(
    userMessage: string,
    config: AgentConfig,
    sender?: Electron.WebContents
  ): AsyncGenerator<AgentEvent> {
    const maxTurns = config.maxTurns ?? MAX_AGENT_TURNS

    // Create AbortController for this run
    this.abortController = new AbortController()
    this.loopDetector.reset()

    // Add user message to internal messages
    this.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: Date.now()
    })

    // Build system prompt with tool descriptions
    const toolDefinitions = this.toolRegistry.getDefinitions()
    const systemPrompt = this.messageBuilder.buildSystemPrompt(
      config.systemPrompt,
      toolDefinitions
    )

    // Detect provider from model name
    const provider: LLMProvider = config.model.startsWith('claude') ? 'anthropic' : 'openai'

    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    let turnCount = 0

    // Main agent loop
    for (let turn = 0; turn < maxTurns; turn++) {
      // Check for cancellation
      if (this.abortController.signal.aborted) {
        yield {
          type: 'agent:error',
          error: 'Agent loop cancelled',
          recoverable: true
        }
        return
      }

      turnCount++

      // Build provider-specific messages
      const providerMessages = this.messageBuilder.buildMessages(this.messages, provider)

      // Build stream options
      const streamOptions: StreamOptions = {
        model: config.model,
        messages: providerMessages,
        systemPrompt,
        tools: toolDefinitions.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema
        })),
        abortSignal: this.abortController.signal
      }

      // Stream from LLM
      let textContent = ''
      const toolCalls: ToolCall[] = []
      let streamUsage = { inputTokens: 0, outputTokens: 0 }
      let hadError = false

      // Track tool names from tool_use_start events (tool_use_end doesn't include name)
      const toolNameMap = new Map<string, string>()

      for await (const event of this.gateway.stream(streamOptions)) {
        switch (event.type) {
          case 'text_delta':
            textContent += event.content
            yield { type: 'agent:text', content: event.content }
            break

          case 'tool_use_start':
            // Track tool name by id for later use in tool_use_end
            toolNameMap.set(event.id, event.name)
            break

          case 'tool_use_end':
            toolCalls.push({
              id: event.id,
              name: toolNameMap.get(event.id) || '',
              input: event.parsedInput
            })
            break

          case 'error':
            yield {
              type: 'agent:error',
              error: event.error,
              recoverable: false
            }
            hadError = true
            break

          case 'done':
            streamUsage = event.usage
            break
        }

        if (hadError) break
      }

      if (hadError) return

      totalUsage.inputTokens += streamUsage.inputTokens
      totalUsage.outputTokens += streamUsage.outputTokens

      // Record assistant message
      this.messages.push({
        role: 'assistant',
        content: textContent,
        toolCalls,
        timestamp: Date.now()
      })

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        yield {
          type: 'agent:done',
          usage: totalUsage,
          turnCount
        }
        return
      }

      // Process tool calls
      let loopDetected = false
      for (const toolCall of toolCalls) {
        // Yield tool call event
        yield {
          type: 'agent:tool_call',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input
        }

        // Record for loop detection
        this.loopDetector.record(toolCall.name, toolCall.input)

        // Check for loop
        if (this.loopDetector.isLooping()) {
          yield {
            type: 'agent:error',
            error: 'Loop detected: same tool call repeated 3+ times',
            recoverable: true
          }
          loopDetected = true
          break
        }

        // Look up tool in registry
        const tool = this.toolRegistry.get(toolCall.name)
        if (!tool) {
          // Tool not found — create error result
          const output = `Tool not found: ${toolCall.name}`
          this.messages.push({
            role: 'tool_result',
            toolCallId: toolCall.id,
            content: output,
            isError: true,
            timestamp: Date.now()
          })
          yield {
            type: 'agent:tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            output,
            isError: true
          }
          continue
        }

        // Permission check for destructive tools
        if (tool.requiresApproval) {
          yield {
            type: 'agent:permission_request',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.input
          }

          let approved = false
          if (sender) {
            approved = await this.permissionManager.requestApproval(
              config.conversationId,
              toolCall.name,
              toolCall.input,
              sender
            )
          } else {
            // No sender available — deny by default
            approved = false
          }

          if (!approved) {
            const output = `Permission denied for tool: ${toolCall.name}`
            this.messages.push({
              role: 'tool_result',
              toolCallId: toolCall.id,
              content: output,
              isError: true,
              timestamp: Date.now()
            })
            yield {
              type: 'agent:tool_result',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              output,
              isError: true
            }
            continue
          }
        }

        // Execute tool
        try {
          const result = await tool.execute(toolCall.input, {
            workingDirectory: config.workingDirectory,
            abortSignal: this.abortController.signal ?? undefined
          })

          this.messages.push({
            role: 'tool_result',
            toolCallId: toolCall.id,
            content: result.output,
            isError: result.isError,
            timestamp: Date.now()
          })

          yield {
            type: 'agent:tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            output: result.output,
            isError: result.isError
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.messages.push({
            role: 'tool_result',
            toolCallId: toolCall.id,
            content: errorMsg,
            isError: true,
            timestamp: Date.now()
          })
          yield {
            type: 'agent:tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            output: errorMsg,
            isError: true
          }
        }
      }

      if (loopDetected) return

      // Continue loop — feed tool results back to LLM
    }

    // Max turns exceeded
    yield {
      type: 'agent:error',
      error: `Max agent turns exceeded (${turnCount})`,
      recoverable: true
    }
    yield {
      type: 'agent:done',
      usage: totalUsage,
      turnCount
    }
  }

  /**
   * Cancel the running agent loop.
   */
  cancel(): void {
    this.abortController?.abort()
    this.loopDetector.reset()
  }

  /**
   * Reset the agent loop state (clears conversation history).
   */
  reset(): void {
    this.messages = []
    this.loopDetector.reset()
    this.abortController = null
  }

  /**
   * Get a copy of the current messages array.
   */
  getMessages(): Message[] {
    return [...this.messages]
  }
}
