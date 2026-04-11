import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'
import type { ToolRegistry } from '../tools/tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import type { Message, ToolCall, StreamEvent, LLMProvider } from '../../shared/types'
import { MAX_AGENT_TURNS } from '../../shared/constants'
import { LoopDetector } from './loop-detector'
import { MessageBuilder } from './message-builder'
import { ContextManager } from '../context/context-manager'
import { getGitContext } from '../git/git-context'
import { loadInstructions } from '../context/instruction-loader'
import type { HookRegistry } from '../hooks/hook-registry'
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
    private permissionManager: PermissionManager,
    private contextManager: ContextManager,
    private hookRegistry?: HookRegistry
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
    // Emit session-start for this conversation turn
    await this.hookRegistry?.emit('session-start', { conversationId: config.conversationId })

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

    // Inject git context into system prompt
    let gitContext = ''
    try {
      gitContext = await getGitContext(config.workingDirectory)
    } catch {
      // Git not available — skip
    }

    // Load WZXCLAW.md project instructions (all sources merged, silent if absent)
    let instructionSection = ''
    try {
      instructionSection = await loadInstructions(config.workingDirectory)
    } catch {
      // Instructions unavailable — skip
    }

    let basePrompt = config.systemPrompt
    if (gitContext) basePrompt += `\n\n${gitContext}`
    if (instructionSection) basePrompt += `\n\n${instructionSection}`

    const systemPrompt = this.messageBuilder.buildSystemPrompt(
      basePrompt,
      toolDefinitions
    )

    // Use provider from config (set by settings manager, not guessed from model name)
    const provider: LLMProvider = config.provider

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
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
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

      // Context management: check if compaction needed before LLM call
      if (this.contextManager.shouldCompact(this.messages, config.model)) {
        await this.hookRegistry?.emit('pre-compact', { conversationId: config.conversationId })
        const result = await this.contextManager.compact(
          this.messages,
          this.gateway,
          config.model,
          config.provider,
          config.systemPrompt
        )
        await this.hookRegistry?.emit('post-compact', { conversationId: config.conversationId })
        if (result.summary) {
          // Replace messages with compacted version
          const summaryMsg: Message = {
            role: 'user',
            content: `[Context Summary]\n${result.summary}`,
            timestamp: Date.now()
          }
          const recentMessages = this.messages.slice(-result.keptRecentCount)
          this.messages = [summaryMsg, ...recentMessages]

          yield {
            type: 'agent:compacted',
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
            auto: true
          }
        }
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

      if (hadError) {
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      totalUsage.inputTokens += streamUsage.inputTokens
      totalUsage.outputTokens += streamUsage.outputTokens

      // Track usage in ContextManager for token indicator
      this.contextManager.trackTokenUsage(streamUsage.inputTokens, streamUsage.outputTokens)

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
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // Process tool calls with concurrency:
      // Read-only tools execute in parallel, write tools sequentially
      let loopDetected = false

      // Helper to execute a single tool call
      const executeSingleTool = async (toolCall: ToolCall): Promise<AgentEvent[]> => {
        const events: AgentEvent[] = []

        this.loopDetector.record(toolCall.name, toolCall.input)
        if (this.loopDetector.isLooping()) {
          events.push({
            type: 'agent:error',
            error: 'Loop detected: same tool call repeated 3+ times',
            recoverable: true
          })
          loopDetected = true
          return events
        }

        const tool = this.toolRegistry.get(toolCall.name)
        if (!tool) {
          const output = ContextManager.truncateToolResult(`Tool not found: ${toolCall.name}`)
          this.messages.push({ role: 'tool_result', toolCallId: toolCall.id, content: output, isError: true, timestamp: Date.now() })
          events.push({ type: 'agent:tool_result', toolCallId: toolCall.id, toolName: toolCall.name, output, isError: true })
          return events
        }

        if (this.permissionManager.needsApproval(toolCall.name, toolCall.input)) {
          events.push({ type: 'agent:permission_request', toolCallId: toolCall.id, toolName: toolCall.name, input: toolCall.input })
          let approved = false
          if (sender) {
            approved = await this.permissionManager.requestApproval(config.conversationId, toolCall.name, toolCall.input, sender)
          }
          if (!approved) {
            await this.hookRegistry?.emit('permission-denied', { toolName: toolCall.name, toolInput: toolCall.input, conversationId: config.conversationId })
            const output = `Permission denied for tool: ${toolCall.name}`
            this.messages.push({ role: 'tool_result', toolCallId: toolCall.id, content: output, isError: true, timestamp: Date.now() })
            events.push({ type: 'agent:tool_result', toolCallId: toolCall.id, toolName: toolCall.name, output, isError: true })
            return events
          }
        }

        try {
          await this.hookRegistry?.emit('pre-tool', { toolName: toolCall.name, toolInput: toolCall.input, conversationId: config.conversationId })
          const result = await tool.execute(toolCall.input, { workingDirectory: config.workingDirectory, abortSignal: this.abortController!.signal })
          const truncatedOutput = ContextManager.truncateToolResult(result.output)
          this.messages.push({ role: 'tool_result', toolCallId: toolCall.id, content: truncatedOutput, isError: result.isError, timestamp: Date.now() })
          events.push({ type: 'agent:tool_result', toolCallId: toolCall.id, toolName: toolCall.name, output: result.output, isError: result.isError })
          await this.hookRegistry?.emit('post-tool', { toolName: toolCall.name, toolInput: toolCall.input, toolOutput: truncatedOutput, isError: result.isError, conversationId: config.conversationId })
        } catch (err) {
          const errorMsg = ContextManager.truncateToolResult(err instanceof Error ? err.message : String(err))
          this.messages.push({ role: 'tool_result', toolCallId: toolCall.id, content: errorMsg, isError: true, timestamp: Date.now() })
          events.push({ type: 'agent:tool_result', toolCallId: toolCall.id, toolName: toolCall.name, output: errorMsg, isError: true })
        }
        return events
      }

      // Partition into read-only and write groups
      const readOnlyCalls = toolCalls.filter((tc) => this.toolRegistry.isReadOnly(tc.name))
      const writeCalls = toolCalls.filter((tc) => !this.toolRegistry.isReadOnly(tc.name))

      // Yield tool_call events for all
      for (const toolCall of toolCalls) {
        yield { type: 'agent:tool_call', toolCallId: toolCall.id, toolName: toolCall.name, input: toolCall.input }
      }

      // Execute read-only tools in parallel
      if (readOnlyCalls.length > 0) {
        const results = await Promise.all(readOnlyCalls.map(executeSingleTool))
        for (const events of results) {
          for (const ev of events) yield ev
          if (loopDetected) break
        }
      }

      // Execute write tools sequentially
      if (!loopDetected) {
        for (const tc of writeCalls) {
          const events = await executeSingleTool(tc)
          for (const ev of events) yield ev
          if (loopDetected) break
        }
      }

      if (loopDetected) {
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

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
    await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
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

  /**
   * Replace internal messages (used after manual compaction via /compact).
   */
  replaceMessages(messages: Message[]): void {
    this.messages = messages
  }
}
