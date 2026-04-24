import type { SlashCommand, ContextBreakdownResponse } from '../../shared/types'
import { DEFAULT_MODELS } from '../../shared/constants'
import { useChatStore } from '../stores/chat-store'
import { v4 as uuidv4 } from 'uuid'

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
    name: 'help',
    description: 'Show available commands and usage information',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        const { messages } = useChatStore.getState()
        // Build command list
        const cmdLines = SLASH_COMMANDS
          .filter((c) => c.name !== 'help')
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => `- \`/${c.name}\` — ${c.description}`)
          .join('\n')

        useChatStore.setState({
          messages: [
            ...messages,
            {
              id: uuidv4(),
              role: 'assistant' as const,
              content: `## 可用命令

${cmdLines}

**使用方式**：在输入框输入 \`/命令名\`，例如 \`/compact\`、\`/commit\`。
部分命令可以带参数，例如 \`/init\` 会自动分析项目。

**快捷操作**：
- \`Enter\` 发送消息
- \`Shift+Enter\` 换行
- \`Escape\` 中止生成
- \`Ctrl+N\` 新建会话`,
              timestamp: Date.now()
            }
          ]
        })
      }
    }
  },
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
    name: 'context',
    description: 'Show detailed context window usage with token breakdown',
    handler: {
      type: 'action',
      execute: async (_args: string) => {
        try {
          const bd = await window.wzxclaw.getContextBreakdown()
          const content = buildContextReport(bd)
          useChatStore.setState({
            messages: [
              ...useChatStore.getState().messages,
              { id: uuidv4(), role: 'assistant' as const, content, timestamp: Date.now() }
            ]
          })
        } catch (err) {
          useChatStore.setState({
            messages: [
              ...useChatStore.getState().messages,
              {
                id: uuidv4(),
                role: 'assistant' as const,
                content: `Failed to get context breakdown: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now()
              }
            ]
          })
        }
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
  },
  {
    name: 'insights',
    description: 'Analyze your coding sessions and generate optimization insights',
    handler: {
      type: 'action',
      execute: async (_args: string) => {
        // Inject progress message
        const { messages } = useChatStore.getState()
        useChatStore.setState({
          messages: [
            ...messages,
            {
              id: uuidv4(),
              role: 'assistant' as const,
              content: 'Analyzing your coding sessions... This may take 30-60 seconds.\n\nScanning session files...',
              timestamp: Date.now()
            }
          ]
        })

        try {
          const result = await window.wzxclaw.generateInsights()
          const { messages: currentMessages } = useChatStore.getState()
          useChatStore.setState({
            messages: [
              ...currentMessages,
              {
                id: uuidv4(),
                role: 'assistant' as const,
                content: `## Insights Report\n\n${result.summary}\n\n---\n*Report saved to: \`${result.htmlPath}\`*`,
                timestamp: Date.now()
              }
            ]
          })
        } catch (err) {
          const { messages: currentMessages } = useChatStore.getState()
          useChatStore.setState({
            messages: [
              ...currentMessages,
              {
                id: uuidv4(),
                role: 'assistant' as const,
                content: `Failed to generate insights: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now()
              }
            ]
          })
        }
      }
    }
  }
]

// ============================================================
// /context — Context breakdown report builder
// ============================================================

interface CategoryBucket {
  label: string
  tokens: number
  color: string   // emoji block
}

function buildCategoryBuckets(bd: ContextBreakdownResponse): CategoryBucket[] {
  return [
    { label: '系统提示词', tokens: bd.systemPromptTokens, color: '🟪' },
    { label: '指令文件', tokens: bd.instructionsTokens, color: '🟦' },
    { label: '命令+技能', tokens: bd.commandsTokens + bd.skillsTokens, color: '🟧' },
    { label: 'Memory', tokens: bd.memoryTokens, color: '🟨' },
    { label: '内置工具', tokens: bd.builtinToolTokens, color: '🟩' },
    { label: 'MCP 工具', tokens: bd.mcpToolTokens, color: '🩵' },
    { label: '对话历史', tokens: bd.conversationTokens, color: '🔵' },
  ]
}

function buildContextGrid(buckets: CategoryBucket[], totalTokens: number, contextWindow: number): string {
  const totalCells = 100 // 10×10
  const lines: string[] = []

  // Calculate cells per category
  const cellsPerCat = buckets.map((b) => {
    const pct = totalTokens > 0 ? b.tokens / contextWindow : 0
    return Math.max(pct > 0 ? 1 : 0, Math.round(pct * totalCells))
  })

  // Adjust to fit exactly 100 cells
  let sum = cellsPerCat.reduce((a, b) => a + b, 0)
  const usedTokens = buckets.reduce((a, b) => a + b.tokens, 0)
  const freeCells = Math.max(0, totalCells - sum)
  if (sum + freeCells > totalCells) {
    // Shrink largest category to fit
    const maxIdx = cellsPerCat.indexOf(Math.max(...cellsPerCat))
    cellsPerCat[maxIdx] -= (sum + freeCells - totalCells)
  }

  // Build flat array of emoji strings
  const gridChars: string[] = []
  for (let i = 0; i < buckets.length; i++) {
    for (let j = 0; j < cellsPerCat[i]; j++) {
      gridChars.push(buckets[i].color)
    }
  }
  // Fill remaining with white
  while (gridChars.length < totalCells) {
    gridChars.push('⬜')
  }

  // Render as 10×10 grid
  for (let row = 0; row < 10; row++) {
    lines.push(gridChars.slice(row * 10, row * 10 + 10).join(''))
  }

  return lines.join('\n')
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function buildContextReport(bd: ContextBreakdownResponse): string {
  const buckets = buildCategoryBuckets(bd)
  const contextWindow = bd.contextWindowSize
  const totalUsed = bd.totalEstimatedTokens
  const pctUsed = bd.usagePercent

  // Header
  const preset = DEFAULT_MODELS.find((m) => m.id === bd.model)
  const modelName = preset?.name ?? bd.model
  const header = `## 上下文使用情况\n\n**模型**: \`${bd.model}\` (${modelName})\n**上下文窗口**: ${(contextWindow / 1000).toFixed(0)}K tokens | **最大输出**: ${(bd.maxOutputTokens / 1000).toFixed(0)}K tokens\n**使用率**: ${pctUsed.toFixed(1)}%`

  // Grid
  const grid = buildContextGrid(buckets, totalUsed, contextWindow)

  // Category table
  const tableHeader = '| 颜色 | 类别 | Token 数 | 占比 |\n|------|------|---------|------|'
  const tableRows = buckets.map((b) => {
    const pct = contextWindow > 0 ? ((b.tokens / contextWindow) * 100).toFixed(1) : '0.0'
    return `| ${b.color} | ${b.label} | ${b.tokens.toLocaleString()} | ${pct}% |`
  })
  const freePct = contextWindow > 0 ? ((bd.freeSpaceTokens / contextWindow) * 100).toFixed(1) : '0.0'
  const tableTotal = `| ⬜ | 剩余空间 | ${bd.freeSpaceTokens.toLocaleString()} | ${freePct}% |\n| | **总计** | **${totalUsed.toLocaleString()}** | **${pctUsed.toFixed(1)}%** |`
  const table = [tableHeader, ...tableRows, tableTotal].join('\n')

  // Session statistics
  const su = bd.sessionUsage
  const roleCounts = bd.messagesByRole
  const costStr = su.totalCostUSD > 0 ? `$${su.totalCostUSD.toFixed(4)}` : '$0'
  const sessionStats = `### 会话统计\n\n| 指标 | 值 |\n|------|----|\n| 消息数 | ${bd.conversationMessageCount} (用户: ${roleCounts.user}, 助手: ${roleCounts.assistant}, 工具: ${roleCounts.tool_result}) |\n| 累计输入 | ${su.inputTokens.toLocaleString()} tokens |\n| 累计输出 | ${su.outputTokens.toLocaleString()} tokens |\n| 缓存读取 | ${su.cacheReadTokens.toLocaleString()} tokens |\n| 缓存写入 | ${su.cacheWriteTokens.toLocaleString()} tokens |\n| 累计费用 | ${costStr} |`

  // Compaction history
  const ch = bd.compactionHistory
  let compactionSection = ''
  if (ch.compactCount > 0) {
    const lastInfo = ch.lastBefore !== null && ch.lastAfter !== null
      ? ` (最近: ${formatTokenCount(ch.lastBefore)} → ${formatTokenCount(ch.lastAfter)})`
      : ''
    compactionSection = `\n\n### 压缩历史\n\n已压缩 **${ch.compactCount}** 次${lastInfo}\n\n自动压缩阈值: 80% 上下文窗口`
  }

  // Suggestions
  const suggestions = buildContextSuggestions(bd)
  let suggestionsSection = ''
  if (suggestions.length > 0) {
    suggestionsSection = '\n\n### 建议\n\n' + suggestions.join('\n')
  }

  return [header, '', grid, '', table, '', sessionStats, compactionSection, suggestionsSection].join('\n')
}

function buildContextSuggestions(bd: ContextBreakdownResponse): string[] {
  const suggestions: string[] = []
  const pct = bd.usagePercent
  const cw = bd.contextWindowSize
  const toolPct = cw > 0 ? (bd.toolDefinitionsTokens / cw) * 100 : 0
  const mcpPct = cw > 0 ? (bd.mcpToolTokens / cw) * 100 : 0
  const instrPct = cw > 0 ? (bd.instructionsTokens / cw) * 100 : 0
  const convPct = cw > 0 ? (bd.conversationTokens / cw) * 100 : 0

  // Critical: near context limit
  if (pct >= 85) {
    suggestions.push('🔴 **上下文严重不足** — 建议立即使用 `/compact` 压缩对话或 `/clear` 开始新会话')
  } else if (pct >= 70) {
    suggestions.push('🟡 **上下文偏高** — 建议使用 `/compact` 压缩对话以释放空间')
  }

  // Tool definitions bloat
  if (toolPct > 20 && mcpPct > toolPct * 0.6) {
    suggestions.push(`💡 MCP 工具占用 ${mcpPct.toFixed(1)}% — 考虑断开未使用的 MCP 服务器`)
  }

  // Instruction files bloat
  if (instrPct > 15) {
    suggestions.push(`📄 指令文件占用 ${instrPct.toFixed(1)}% — 考虑精简 WZXCLAW.md 和 rules 文件`)
  }

  // Conversation history heavy
  if (convPct > 60) {
    suggestions.push('💬 对话历史占比过高 — 使用 `/compact` 可显著释放空间')
  }

  // Memory bloat
  if (bd.memoryTokens > 2000) {
    suggestions.push(`🧠 Memory 文件占用 ${formatTokenCount(bd.memoryTokens)} tokens — 考虑归档旧的 Memory 条目`)
  }

  // High message count
  if (bd.conversationMessageCount > 50) {
    suggestions.push(`📝 消息数已超过 50 条 — 建议压缩或开启新会话以保持效率`)
  }

  // All clear
  if (suggestions.length === 0) {
    suggestions.push('✅ 上下文空间充裕，无需优化')
  }

  return suggestions
}
