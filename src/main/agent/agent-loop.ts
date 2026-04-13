import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'
import type { ToolRegistry } from '../tools/tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import type { Message, ToolCall, LLMProvider, ContentBlock } from '../../shared/types'
import { MAX_AGENT_TURNS, SYSTEM_PROMPT_CACHE_BOUNDARY } from '../../shared/constants'
import { LoopDetector } from './loop-detector'
import { MessageBuilder } from './message-builder'
import { ContextManager } from '../context/context-manager'
import { getGitContext } from '../git/git-context'
import { loadInstructions } from '../context/instruction-loader'
import { buildEnvInfo } from '../context/env-info'
import type { HookRegistry } from '../hooks/hook-registry'
import type { AgentEvent, AgentConfig } from './types'
import { PromptTooLongError } from '../llm/retry'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { MemoryManager } from '../memory/memory-manager'
import { truncateToolResult, enforceContextBudget, ToolResultEntry } from '../context/tool-result-budget'
import { StreamingToolExecutor } from './streaming-tool-executor'
import type { ToolExecResult } from './streaming-tool-executor'
import type { FileHistoryManager } from '../file-history/file-history-manager'
import { FileChangeTracker, buildTurnAttachments, wrapSystemReminder } from '../context/turn-attachments'
import path from 'path'

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
  private fileTracker = new FileChangeTracker()

  constructor(
    private gateway: LLMGateway,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private contextManager: ContextManager,
    private hookRegistry?: HookRegistry,
    private historyManager?: FileHistoryManager
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

    // Reactive compaction circuit breaker: max 2 reactive compacts per session
    const MAX_REACTIVE_COMPACTS = 2
    let reactiveCompactCount = 0

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

    // Load MEMORY.md cross-session memory (silent if absent)
    let memorySection = ''
    try {
      const memoryManager = new MemoryManager(config.workingDirectory)
      memorySection = await memoryManager.buildSystemPromptSection()
    } catch {
      // Memory unavailable — skip
    }

    // Build environment info (model identity, platform, CWD, date)
    const envInfo = buildEnvInfo({
      model: config.model,
      provider: config.provider,
      workingDirectory: config.workingDirectory
    })

    // Assemble system prompt with cache boundary:
    // STATIC part (before boundary): base prompt — cacheable across turns
    // DYNAMIC part (after boundary): env info, git, instructions, memory — per-session
    // System prompt: no longer embed tool descriptions in the text —
    // tools are passed via the structured `tools` parameter to avoid duplication.
    const staticPrompt = config.systemPrompt

    const dynamicParts: string[] = [envInfo]
    if (gitContext) dynamicParts.push(gitContext)
    if (instructionSection) dynamicParts.push(instructionSection)
    if (memorySection) dynamicParts.push(memorySection)

    const systemPrompt = staticPrompt + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicParts.join('\n\n')

    // Use provider from config (set by settings manager, not guessed from model name)
    const provider: LLMProvider = config.provider

    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    let turnCount = 0

    // Main agent loop
    for (let turn = 0; turn < maxTurns; turn++) {
      // Advance file change tracker
      this.fileTracker.advanceTurn()
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

      // Inject per-turn attachments (changed files, active tasks) for non-first turns
      if (turn > 0) {
        const attachmentText = buildTurnAttachments({
          ...this.fileTracker.getContext(),
          activeTasks: undefined // TODO: wire in task manager when available
        })
        if (attachmentText) {
          this.messages.push({
            role: 'user',
            content: attachmentText,
            timestamp: Date.now()
          })
        }
      }

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
        abortSignal: this.abortController.signal,
        // Emit stream:retrying to the renderer before each retry attempt
        onRetry: sender
          ? (info) => {
              if (!sender.isDestroyed()) {
                sender.send(IPC_CHANNELS['stream:retrying'], info)
              }
            }
          : undefined,
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

      // Stream from LLM — start tool executions eagerly via StreamingToolExecutor
      let textContent = ''
      const toolCalls: ToolCall[] = []
      const contentBlocks: ContentBlock[] = []  // Preserves interleaved text/tool order
      let streamUsage = { inputTokens: 0, outputTokens: 0 }
      let hadError = false

      // Track tool names from tool_use_start events (tool_use_end doesn't include name)
      const toolNameMap = new Map<string, string>()

      // Streaming executor: starts each tool execution as soon as its block finishes,
      // overlapping with the remaining LLM stream for read-only tools.
      const executor = new StreamingToolExecutor(this.toolRegistry.isReadOnly.bind(this.toolRegistry))

      // Core tool execution helper.
      // Handles loop detection, plan mode, permission checks, and tool.execute().
      // Does NOT modify this.messages — caller processes results after waitAll().
      const executeToolCore = async (toolCall: ToolCall): Promise<ToolExecResult> => {
        this.loopDetector.record(toolCall.name, toolCall.input)
        if (this.loopDetector.isLooping()) {
          const msg = 'Loop detected: same tool call repeated 3+ times'
          return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: true }
        }

        const tool = this.toolRegistry.get(toolCall.name)
        if (!tool) {
          const msg = ContextManager.truncateToolResult(`Tool not found: ${toolCall.name}`)
          return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
        }

        // Block write tools when plan mode is active
        const planModeRejection = this.permissionManager.getPlanModeRejection(toolCall.name)
        if (planModeRejection) {
          const truncated = ContextManager.truncateToolResult(planModeRejection)
          return { toolCallId: toolCall.id, toolName: toolCall.name, output: planModeRejection, truncatedOutput: truncated, isError: true, loopDetected: false }
        }

        if (this.permissionManager.needsApproval(toolCall.name, toolCall.input)) {
          let approved = false
          if (sender) {
            approved = await this.permissionManager.requestApproval(config.conversationId, toolCall.name, toolCall.input, sender)
          }
          if (!approved) {
            await this.hookRegistry?.emit('permission-denied', { toolName: toolCall.name, toolInput: toolCall.input, conversationId: config.conversationId })
            const msg = `Permission denied for tool: ${toolCall.name}`
            return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
          }
        }

        try {
          await this.hookRegistry?.emit('pre-tool', { toolName: toolCall.name, toolInput: toolCall.input, conversationId: config.conversationId })
          // Snapshot file content before write/edit so the renderer can offer Revert
          if (this.historyManager && (toolCall.name === 'FileWrite' || toolCall.name === 'FileEdit')) {
            const rawPath = String(toolCall.input.path ?? '')
            if (rawPath) {
              const absolutePath = path.isAbsolute(rawPath)
                ? rawPath
                : path.resolve(config.workingDirectory, rawPath)
              await this.historyManager.snapshot(absolutePath, toolCall.id)
            }
          }
          const result = await tool.execute(toolCall.input, {
            workingDirectory: config.workingDirectory,
            abortSignal: this.abortController!.signal
          })
          const truncatedOutput = truncateToolResult(toolCall.name, result.output)
          await this.hookRegistry?.emit('post-tool', { toolName: toolCall.name, toolInput: toolCall.input, toolOutput: truncatedOutput, isError: result.isError, conversationId: config.conversationId })
          return { toolCallId: toolCall.id, toolName: toolCall.name, output: result.output, truncatedOutput, isError: result.isError, loopDetected: false }
        } catch (err) {
          const msg = ContextManager.truncateToolResult(err instanceof Error ? err.message : String(err))
          return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
        }
      }

      try {
        for await (const event of this.gateway.stream(streamOptions)) {
          switch (event.type) {
            case 'text_delta':
              textContent += event.content
              // Append to current text block or create a new one
              if (contentBlocks.length > 0 && contentBlocks[contentBlocks.length - 1].type === 'text') {
                (contentBlocks[contentBlocks.length - 1] as { type: 'text'; text: string }).text += event.content
              } else {
                contentBlocks.push({ type: 'text', text: event.content })
              }
              yield { type: 'agent:text', content: event.content }
              break

            case 'tool_use_start':
              // Track tool name by id for later use in tool_use_end
              toolNameMap.set(event.id, event.name)
              break

            case 'tool_use_end': {
              const toolName = toolNameMap.get(event.id) || ''
              const toolCall: ToolCall = { id: event.id, name: toolName, input: event.parsedInput }
              toolCalls.push(toolCall)
              contentBlocks.push({ type: 'tool_use', id: event.id, name: toolName, input: event.parsedInput })
              // Emit tool_call event immediately so the UI shows the tool starting
              yield { type: 'agent:tool_call', toolCallId: event.id, toolName, input: event.parsedInput }
              // Start execution now — read-only tools run in parallel with the remaining
              // LLM stream; write tools are chained sequentially
              executor.onToolUseEnd(event.id, toolName, () => executeToolCore(toolCall))
              break
            }

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
      } catch (streamErr) {
        if (streamErr instanceof PromptTooLongError && reactiveCompactCount < MAX_REACTIVE_COMPACTS) {
          // Reactive compaction: aggressively trim context to recover from prompt_too_long
          reactiveCompactCount++
          const beforeTokens = this.contextManager.estimateTokens(this.messages)
          this.messages = this.contextManager.reactiveCompact(this.messages)
          const afterTokens = this.contextManager.estimateTokens(this.messages)

          if (sender && !sender.isDestroyed()) {
            sender.send(IPC_CHANNELS['session:compacted'], {
              beforeTokens,
              afterTokens,
              auto: true
            })
          }

          // Retry this turn without consuming a turn slot
          turn--
          turnCount--
          continue
        } else {
          yield {
            type: 'agent:error',
            error: 'Context too long — use /compact to reduce context size',
            recoverable: true
          }
          hadError = true
        }
      }

      if (hadError) {
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      totalUsage.inputTokens += streamUsage.inputTokens
      totalUsage.outputTokens += streamUsage.outputTokens

      // Track usage in ContextManager for token indicator
      this.contextManager.trackTokenUsage(streamUsage.inputTokens, streamUsage.outputTokens)

      // Record assistant message with interleaved content blocks
      this.messages.push({
        role: 'assistant',
        content: textContent,
        toolCalls,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
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

      // Wait for all tool executions started during streaming to complete,
      // then process results in original LLM-emission order.
      let loopDetected = false
      if (executor.size > 0) {
        const execResults = await executor.waitAll()
        for (const result of execResults) {
          if (result.loopDetected) {
            yield { type: 'agent:error', error: 'Loop detected: same tool call repeated 3+ times', recoverable: true }
            loopDetected = true
            break
          }

          // Track file reads/writes for per-turn attachment system
          if (result.toolName === 'FileRead' && !result.isError) {
            const tc = toolCalls.find(t => t.id === result.toolCallId)
            if (tc?.input?.path) {
              const rawPath = String(tc.input.path)
              const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(config.workingDirectory, rawPath)
              this.fileTracker.recordRead(absPath)
            }
          } else if ((result.toolName === 'FileWrite' || result.toolName === 'FileEdit') && !result.isError) {
            const tc = toolCalls.find(t => t.id === result.toolCallId)
            if (tc?.input?.path) {
              const rawPath = String(tc.input.path)
              const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(config.workingDirectory, rawPath)
              this.fileTracker.recordWrite(absPath)
            }
          }

          this.messages.push({
            role: 'tool_result',
            toolCallId: result.toolCallId,
            content: result.truncatedOutput,
            isError: result.isError,
            timestamp: Date.now()
          })
          yield { type: 'agent:tool_result', toolCallId: result.toolCallId, toolName: result.toolName, output: result.output, isError: result.isError }
        }
      }

      if (loopDetected) {
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // Enforce global tool result budget: compact oldest, largest results
      // when total tool result chars exceed the budget (200K default).
      const toolResultEntries: ToolResultEntry[] = this.messages
        .map((m, i) => ({ msg: m, idx: i }))
        .filter(({ msg }) => msg.role === 'tool_result')
        .map(({ msg, idx }) => ({
          toolName: 'tool_result',
          result: msg.content,
          turnIndex: idx
        }))
      const budgeted = enforceContextBudget(toolResultEntries)
      // Apply any compacted results back to messages
      for (const entry of budgeted) {
        const msg = this.messages[entry.turnIndex]
        if (msg && msg.role === 'tool_result' && msg.content !== entry.result) {
          msg.content = entry.result
        }
      }

      // Signal end of this turn so the renderer can finalize the current
      // assistant message bubble before the next LLM call starts a new one.
      yield { type: 'agent:turn_end' as const }

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
    this.fileTracker.reset()
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

  /**
   * Restore agent context from persisted messages loaded off disk.
   * Filters meta lines, casts raw records to Message[], and compacts the
   * context if it already exceeds the configured threshold.  Called by
   * the session:load IPC handler so the agent can continue the conversation.
   *
   * @returns info about the restored context for the renderer notification
   */
  async restoreContext(
    rawMessages: unknown[],
    config: Pick<AgentConfig, 'model' | 'provider' | 'systemPrompt' | 'workingDirectory'>
  ): Promise<{ messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }> {
    // Filter out JSONL meta lines (type:'meta') and cast to internal Message format.
    // Messages were stored via agentLoop.getMessages() so they match the Message shape.
    const messages = (rawMessages as Array<Record<string, unknown>>)
      .filter((m) => m.type !== 'meta' && m.role != null)
      .map((m) => m as unknown as Message)

    const beforeTokens = this.contextManager.estimateTokens(messages)

    if (this.contextManager.shouldCompact(messages, config.model)) {
      const result = await this.contextManager.compact(
        messages,
        this.gateway,
        config.model,
        config.provider as 'openai' | 'anthropic',
        config.systemPrompt ?? ''
      )
      if (result.summary) {
        const summaryMsg: Message = {
          role: 'user',
          content: `[Context Summary]\n${result.summary}`,
          timestamp: Date.now()
        }
        const recentMessages = messages.slice(-result.keptRecentCount)
        this.messages = [summaryMsg, ...recentMessages]
        const afterTokens = this.contextManager.estimateTokens(this.messages)
        return { messageCount: this.messages.length, compacted: true, beforeTokens, afterTokens }
      }
    }

    this.messages = messages
    return { messageCount: messages.length, compacted: false, beforeTokens, afterTokens: beforeTokens }
  }
}
