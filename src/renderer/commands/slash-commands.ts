import type { SlashCommand } from '../../shared/types'
import { useChatStore } from '../stores/chat-store'

// ============================================================
// Slash Command Registry (SLASH-01)
// ============================================================

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'compact',
    description: 'Compact the current conversation context to free up token space',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        window.wzxclaw.compactContext()
      }
    }
  },
  {
    name: 'clear',
    description: 'Clear the current conversation and start a new session',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        useChatStore.getState().createSession()
      }
    }
  }
]
