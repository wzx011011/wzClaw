import type { SlashCommand } from '../../shared/types'
import { useChatStore } from '../stores/chat-store'

// ============================================================
// Slash Command Registry (SLASH-01)
// ============================================================

// Prompt injected by /init — instructs the agent to analyze the codebase
// and produce a concise WZXCLAW.md project instructions file.
const INIT_PROMPT = `Please analyze this codebase and create a WZXCLAW.md file in the project root.

First, explore the project to understand:
- Package manager and key scripts (package.json, Cargo.toml, pyproject.toml, Makefile, etc.)
- README and existing documentation
- Directory structure and main source directories
- Test setup and how to run tests
- Lint/format configuration
- Any existing .cursorrules, CLAUDE.md, or similar instruction files

Then create WZXCLAW.md with ONLY the following (omit sections that don't apply):
1. **Build & Dev Commands** — non-obvious commands only
2. **Architecture Overview** — 3-5 sentences on how the codebase is organized
3. **Key Conventions** — coding style rules that differ from language defaults
4. **Development Notes** — gotchas, non-obvious setup, environment requirements

Rules:
- Only include info that would prevent mistakes if missing
- Do NOT include obvious conventions or describe every file
- Keep it under 100 lines
- Start the file with: "## Project\\n\\n[one-line project description]\\n\\n"
- If WZXCLAW.md already exists, suggest improvements rather than overwriting blindly`

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'init',
    description: 'Analyze the codebase and generate a WZXCLAW.md project instructions file',
    handler: {
      type: 'inject-prompt',
      getPrompt: async (_args: string, _workspaceRoot: string): Promise<string> => {
        return INIT_PROMPT
      }
    }
  },
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
