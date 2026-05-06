import type { SlashCommand, ContextBreakdownResponse } from '../../shared/types'
import type { SkillInfo } from '../../shared/types-skill'
import { DEFAULT_MODELS } from '../../shared/constants'
import { useChatStore } from '../stores/chat-store'
import { v4 as uuidv4 } from 'uuid'

// PluginManager modal state — set by ChatPanel
let _setShowPluginManager: ((show: boolean) => void) | null = null

/** Register the PluginManager modal toggle (called from ChatPanel) */
export function registerPluginManagerToggle(fn: (show: boolean) => void): void {
  _setShowPluginManager = fn
}

function showPluginManager(): void {
  _setShowPluginManager?.(true)
}

// ============================================================
// Slash Command Registry (SLASH-01) + Dynamic Skills
// ============================================================

// ---- Prompt templates ----
// Note: /init, /commit, /review prompts are now registered as bundled skills
// in src/main/skills/bundled-skills.ts and loaded via IPC.

// ============================================================
// Builtin commands — always available, hardcoded
// ============================================================

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show available commands and usage information',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        const { messages } = useChatStore.getState()
        // Build command list (builtins + dynamic)
        const allCmds = getAllSlashCommands()
        const cmdLines = allCmds
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

**自定义技能**：在 \`~/.wzxclaw/skills/\` 或项目 \`.wzxclaw/skills/\` 目录下放置 .md 文件即可添加自定义技能。

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
  // /init, /commit, /review are now registered as bundled skills in the main process.
  // They appear in autocomplete via fetchSkills() and are dispatched through IPC.
  {
    name: 'plugin',
    description: 'Open the plugin manager to view, enable, disable, or uninstall plugins',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        showPluginManager()
      }
    }
  },
  {
    name: 'plan',
    description: 'Toggle plan mode — read-only analysis before making changes',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        window.wzxclaw.togglePlanMode?.().catch(() => {})
      }
    }
  },
  {
    name: 'insights',
    description: 'Analyze your coding sessions and generate optimization insights',
    handler: {
      type: 'action',
      execute: async (_args: string) => {
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
// Dynamic skill cache — loaded from main process via IPC
// ============================================================

let cachedSkills: SkillInfo[] | null = null
let skillLoadPromise: Promise<SkillInfo[]> | null = null

/**
 * Fetch skills from main process (cached within session).
 */
async function fetchSkills(): Promise<SkillInfo[]> {
  if (cachedSkills) return cachedSkills
  if (skillLoadPromise) return skillLoadPromise

  skillLoadPromise = (async () => {
    try {
      const skills = await window.wzxclaw.listSkills()
      cachedSkills = skills
      return skills
    } catch (err) {
      console.warn('[slash-commands] Failed to load skills:', err)
      return []
    }
  })()

  return skillLoadPromise
}

/**
 * Invalidate skill cache (e.g. after reload).
 */
export function invalidateSkillCache(): void {
  cachedSkills = null
  skillLoadPromise = null
}

/**
 * Convert a dynamic SkillInfo to a SlashCommand.
 */
function skillToSlashCommand(skill: SkillInfo): SlashCommand {
  return {
    name: skill.name,
    description: skill.description || skill.displayName,
    handler: {
      type: 'inject-prompt',
      getPrompt: async (args: string, _workspaceRoot: string): Promise<string> => {
        const prompt = await window.wzxclaw.getSkillPrompt({ name: skill.name, args })
        return prompt ?? `Execute the ${skill.name} skill.`
      }
    }
  }
}

/**
 * Get all slash commands: builtins + dynamic skills.
 * Async because it fetches skills from main process.
 */
export async function getAllSlashCommandsAsync(): Promise<SlashCommand[]> {
  const skills = await fetchSkills()
  const dynamicCommands = skills
    .filter(s => s.userInvocable && !s.isHidden && s.isEnabled)
    // Don't duplicate builtins
    .filter(s => !BUILTIN_COMMANDS.some(b => b.name === s.name))
    .map(skillToSlashCommand)

  return [...BUILTIN_COMMANDS, ...dynamicCommands]
}

/**
 * Get all slash commands (synchronous, builtins only).
 * Use getAllSlashCommandsAsync() for the full list.
 */
export function getAllSlashCommands(): SlashCommand[] {
  return BUILTIN_COMMANDS
}

// Legacy export — returns builtins only for initial render.
// ChatPanel should call getAllSlashCommandsAsync() to get the full list.
export const SLASH_COMMANDS: SlashCommand[] = BUILTIN_COMMANDS

// ============================================================
// /context — Context breakdown report builder
// ============================================================

interface CategoryBucket {
  label: string
  tokens: number
  color: string
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
  const totalCells = 100
  const lines: string[] = []

  const cellsPerCat = buckets.map((b) => {
    const pct = totalTokens > 0 ? b.tokens / contextWindow : 0
    return Math.max(pct > 0 ? 1 : 0, Math.round(pct * totalCells))
  })

  let sum = cellsPerCat.reduce((a, b) => a + b, 0)
  const freeCells = Math.max(0, totalCells - sum)
  if (sum + freeCells > totalCells) {
    const maxIdx = cellsPerCat.indexOf(Math.max(...cellsPerCat))
    cellsPerCat[maxIdx] -= (sum + freeCells - totalCells)
  }

  const gridChars: string[] = []
  for (let i = 0; i < buckets.length; i++) {
    for (let j = 0; j < cellsPerCat[i]; j++) {
      gridChars.push(buckets[i].color)
    }
  }
  while (gridChars.length < totalCells) {
    gridChars.push('⬜')
  }

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

  const preset = DEFAULT_MODELS.find((m) => m.id === bd.model)
  const modelName = preset?.name ?? bd.model
  const header = `## 上下文使用情况\n\n**模型**: \`${bd.model}\` (${modelName})\n**上下文窗口**: ${(contextWindow / 1000).toFixed(0)}K tokens | **最大输出**: ${(bd.maxOutputTokens / 1000).toFixed(0)}K tokens\n**使用率**: ${pctUsed.toFixed(1)}%`

  const grid = buildContextGrid(buckets, totalUsed, contextWindow)

  const tableHeader = '| 颜色 | 类别 | Token 数 | 占比 |\n|------|------|---------|------|'
  const tableRows = buckets.map((b) => {
    const pct = contextWindow > 0 ? ((b.tokens / contextWindow) * 100).toFixed(1) : '0.0'
    return `| ${b.color} | ${b.label} | ${b.tokens.toLocaleString()} | ${pct}% |`
  })
  const freePct = contextWindow > 0 ? ((bd.freeSpaceTokens / contextWindow) * 100).toFixed(1) : '0.0'
  const tableTotal = `| ⬜ | 剩余空间 | ${bd.freeSpaceTokens.toLocaleString()} | ${freePct}% |\n| | **总计** | **${totalUsed.toLocaleString()}** | **${pctUsed.toFixed(1)}%** |`
  const table = [tableHeader, ...tableRows, tableTotal].join('\n')

  const su = bd.sessionUsage
  const roleCounts = bd.messagesByRole
  const costStr = su.totalCostUSD > 0 ? `$${su.totalCostUSD.toFixed(4)}` : '$0'
  const sessionStats = `### 会话统计\n\n| 指标 | 值 |\n|------|----|\n| 消息数 | ${bd.conversationMessageCount} (用户: ${roleCounts.user}, 助手: ${roleCounts.assistant}, 工具: ${roleCounts.tool_result}) |\n| 累计输入 | ${su.inputTokens.toLocaleString()} tokens |\n| 累计输出 | ${su.outputTokens.toLocaleString()} tokens |\n| 缓存读取 | ${su.cacheReadTokens.toLocaleString()} tokens |\n| 缓存写入 | ${su.cacheWriteTokens.toLocaleString()} tokens |\n| 累计费用 | ${costStr} |`

  const ch = bd.compactionHistory
  let compactionSection = ''
  if (ch.compactCount > 0) {
    const lastInfo = ch.lastBefore !== null && ch.lastAfter !== null
      ? ` (最近: ${formatTokenCount(ch.lastBefore)} → ${formatTokenCount(ch.lastAfter)})`
      : ''
    compactionSection = `\n\n### 压缩历史\n\n已压缩 **${ch.compactCount}** 次${lastInfo}\n\n自动压缩阈值: 80% 上下文窗口`
  }

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

  if (pct >= 85) {
    suggestions.push('🔴 **上下文严重不足** — 建议立即使用 `/compact` 压缩对话或 `/clear` 开始新会话')
  } else if (pct >= 70) {
    suggestions.push('🟡 **上下文偏高** — 建议使用 `/compact` 压缩对话以释放空间')
  }
  if (toolPct > 20 && mcpPct > toolPct * 0.6) {
    suggestions.push(`💡 MCP 工具占用 ${mcpPct.toFixed(1)}% — 考虑断开未使用的 MCP 服务器`)
  }
  if (instrPct > 15) {
    suggestions.push(`📄 指令文件占用 ${instrPct.toFixed(1)}% — 考虑精简 WZXCLAW.md 和 rules 文件`)
  }
  if (convPct > 60) {
    suggestions.push('💬 对话历史占比过高 — 使用 `/compact` 可显著释放空间')
  }
  if (bd.memoryTokens > 2000) {
    suggestions.push(`🧠 Memory 文件占用 ${formatTokenCount(bd.memoryTokens)} tokens — 考虑归档旧的 Memory 条目`)
  }
  if (bd.conversationMessageCount > 50) {
    suggestions.push(`📝 消息数已超过 50 条 — 建议压缩或开启新会话以保持效率`)
  }
  if (suggestions.length === 0) {
    suggestions.push('✅ 上下文空间充裕，无需优化')
  }
  return suggestions
}
