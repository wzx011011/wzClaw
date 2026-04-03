import { ipcMain } from 'electron'
import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'
import type { LLMGateway } from './llm/gateway'

// In-memory settings for Phase 1 (Phase 4 adds persistence)
let currentSettings = {
  provider: 'openai' as string,
  model: 'gpt-4o',
  hasApiKey: false,
  baseURL: undefined as string | undefined,
  systemPrompt: undefined as string | undefined,
}

// Store API keys in memory (Phase 4 uses safeStorage)
const apiKeys = new Map<string, string>()

export function registerIpcHandlers(gateway: LLMGateway): void {
  // Agent: send message
  ipcMain.handle(IPC_CHANNELS['agent:send_message'], async (event, request) => {
    const result = IpcSchemas['agent:send_message'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const sender = event.sender

    try {
      for await (const streamEvent of gateway.stream({
        model: currentSettings.model,
        messages: [{ role: 'user', content: result.data.content }],
        systemPrompt: currentSettings.systemPrompt,
      })) {
        switch (streamEvent.type) {
          case 'text_delta':
            sender.send(IPC_CHANNELS['stream:text_delta'], { content: streamEvent.content })
            break
          case 'tool_use_start':
            sender.send(IPC_CHANNELS['stream:tool_use_start'], { id: streamEvent.id, name: streamEvent.name })
            break
          case 'tool_use_end':
            sender.send(IPC_CHANNELS['stream:tool_use_end'], { id: streamEvent.id, parsedInput: streamEvent.parsedInput })
            break
          case 'error':
            sender.send(IPC_CHANNELS['stream:error'], { error: streamEvent.error })
            break
          case 'done':
            sender.send(IPC_CHANNELS['stream:done'], { usage: streamEvent.usage })
            break
        }
      }
    } catch (error) {
      sender.send(IPC_CHANNELS['stream:error'], {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  // Agent: stop
  ipcMain.handle(IPC_CHANNELS['agent:stop'], () => {
    // Phase 2 implements AbortController cancellation
  })

  // Settings: get
  ipcMain.handle(IPC_CHANNELS['settings:get'], () => {
    return currentSettings
  })

  // Settings: update
  ipcMain.handle(IPC_CHANNELS['settings:update'], (_event, request) => {
    if (request.provider) currentSettings.provider = request.provider
    if (request.model) currentSettings.model = request.model
    if (request.apiKey) {
      apiKeys.set(currentSettings.provider, request.apiKey)
      currentSettings.hasApiKey = true
    }
    if (request.baseURL !== undefined) currentSettings.baseURL = request.baseURL
    if (request.systemPrompt !== undefined) currentSettings.systemPrompt = request.systemPrompt
  })
}
