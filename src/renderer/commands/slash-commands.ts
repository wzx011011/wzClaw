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

const COMMIT_PROMPT = `分析当前 git 变更并生成 commit message。

步骤：
1. 先运行 git status 查看有哪些文件变更
2. 运行 git diff 查看具体变更内容
3. 如果有暂存区变更，也运行 git diff --cached

然后生成一个 commit message，规则：
- message 用中文，格式：<type>: <简短描述>
- type 从 feat/fix/refactor/docs/test/chore 中选
- 如果变更较多，添加简短的正文说明关键改动
- 不要执行 git commit，只输出建议的 commit message
- 如果没有变更，告诉用户没有需要提交的内容`

const REVIEW_PROMPT = `审查当前 git 暂存区和工作区的代码变更。

步骤：
1. 运行 git status 查看变更文件
2. 运行 git diff 查看具体变更内容
3. 如果有暂存区变更，也运行 git diff --cached

审查规则：
- 按严重程度分级：Critical / High / Medium / Low
- 每个问题给出：文件路径、行号、问题描述、修复建议
- 关注：安全漏洞、逻辑错误、性能问题、代码风格
- 如果没有变更，告诉用户没有需要审查的内容
- 最后给出整体评价和建议`

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
  },
  {
    name: 'commit',
    description: 'Analyze git changes and generate a commit message',
    handler: {
      type: 'inject-prompt',
      getPrompt: async (_args: string, _workspaceRoot: string): Promise<string> => {
        return COMMIT_PROMPT
      }
    }
  },
  {
    name: 'review',
    description: 'Review current git changes for bugs, security issues, and code quality',
    handler: {
      type: 'inject-prompt',
      getPrompt: async (_args: string, _workspaceRoot: string): Promise<string> => {
        return REVIEW_PROMPT
      }
    }
  }
]
