import type { SlashCommand, ContextBreakdownResponse } from '../../shared/types'
import type { SkillInfo } from '../../shared/types-skill'
import { DEFAULT_MODELS } from '../../shared/constants'
import { useChatStore } from '../stores/chat-store'
import { useI18nStore } from '../i18n/i18n-store'
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
        const t = useI18nStore.getState().t
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
              content: `${t('slashCmd.helpTitle')}

${cmdLines}

${t('slashCmd.helpUsage')}

${t('slashCmd.helpSkills')}

${t('slashCmd.helpShortcuts')}`,
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
  },
  {
    name: 'diff',
    description: 'Show git diff of current changes',
    handler: {
      type: 'inject-prompt',
      getPrompt: async (_args: string, _workspaceRoot: string) => {
        return `Show me the current git diff. Run \`git diff\` and \`git diff --cached\` to show all changes. Summarize the key modifications.`
      }
    }
  },
  {
    name: 'cost',
    description: 'Show token usage and estimated cost for this session',
    handler: {
      type: 'action',
      execute: async (_args: string) => {
        try {
          const bd = await window.wzxclaw.getContextBreakdown()
          const su = bd.sessionUsage
          const costStr = su.totalCostUSD > 0 ? `${su.totalCostUSD.toFixed(4)}` : '$0'
          const content = `## Session Cost & Usage\n\n| Metric | Value |\n|--------|-------|\n| Input Tokens | ${su.inputTokens.toLocaleString()} |\n| Output Tokens | ${su.outputTokens.toLocaleString()} |\n| Cache Read | ${su.cacheReadTokens.toLocaleString()} |\n| Cache Write | ${su.cacheWriteTokens.toLocaleString()} |\n| Total Cost | ${costStr} |\n| Context Usage | ${bd.usagePercent.toFixed(1)}% |\n| Messages | ${bd.conversationMessageCount} |`
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
                content: `Failed to get cost info: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now()
              }
            ]
          })
        }
      }
    }
  },
  {
    name: 'status',
    description: 'Show workspace status (git branch, changed files, index status)',
    handler: {
      type: 'inject-prompt',
      getPrompt: async (_args: string, _workspaceRoot: string) => {
        return `Show the workspace status. Run \`git status\` and \`git branch --show-current\` to display the current branch and changed files. Keep it concise.`
      }
    }
  },
  {
    name: 'version',
    description: 'Show wzxClaw version information',
    handler: {
      type: 'action',
      execute: (_args: string) => {
        const content = `## wzxClaw Version\n\n${window.wzxclaw.getVersion?.() ?? 'Unknown'}\n\nElectron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nNode: ${process.versions.node}`
        useChatStore.setState({
          messages: [
            ...useChatStore.getState().messages,
            { id: uuidv4(), role: 'assistant' as const, content, timestamp: Date.now() }
          ]
        })
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
  const t = useI18nStore.getState().t
  return [
    { label: t('context.systemPrompt'), tokens: bd.systemPromptTokens, color: '🟪' },
    { label: t('context.instructions'), tokens: bd.instructionsTokens, color: '🟦' },
    { label: t('context.commandsSkills'), tokens: bd.commandsTokens + bd.skillsTokens, color: '🟧' },
    { label: 'Memory', tokens: bd.memoryTokens, color: '🟨' },
    { label: t('context.builtinTools'), tokens: bd.builtinToolTokens, color: '🟩' },
    { label: t('context.mcpTools'), tokens: bd.mcpToolTokens, color: '🩵' },
    { label: t('context.conversation'), tokens: bd.conversationTokens, color: '🔵' },
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
  const t = useI18nStore.getState().t
  const buckets = buildCategoryBuckets(bd)
  const contextWindow = bd.contextWindowSize
  const totalUsed = bd.totalEstimatedTokens
  const pctUsed = bd.usagePercent

  const preset = DEFAULT_MODELS.find((m) => m.id === bd.model)
  const modelName = preset?.name ?? bd.model
  const header = `## ${t('context.title')}\n\n**${t('context.model')}**: \`${bd.model}\` (${modelName})\n**${t('context.contextWindow')}**: ${(contextWindow / 1000).toFixed(0)}K tokens | **${t('context.maxOutput')}**: ${(bd.maxOutputTokens / 1000).toFixed(0)}K tokens\n**${t('context.usagePercent')}**: ${pctUsed.toFixed(1)}%`

  const grid = buildContextGrid(buckets, totalUsed, contextWindow)

  const tableHeader = `| ${t('context.color')} | ${t('context.category')} | ${t('context.tokenCount')} | ${t('context.percentage')} |\n|------|------|---------|------|`
  const tableRows = buckets.map((b) => {
    const pct = contextWindow > 0 ? ((b.tokens / contextWindow) * 100).toFixed(1) : '0.0'
    return `| ${b.color} | ${b.label} | ${b.tokens.toLocaleString()} | ${pct}% |`
  })
  const freePct = contextWindow > 0 ? ((bd.freeSpaceTokens / contextWindow) * 100).toFixed(1) : '0.0'
  const tableTotal = `| ⬜ | ${t('context.freeSpace')} | ${bd.freeSpaceTokens.toLocaleString()} | ${freePct}% |\n| | **${t('context.total')}** | **${totalUsed.toLocaleString()}** | **${pctUsed.toFixed(1)}%** |`
  const table = [tableHeader, ...tableRows, tableTotal].join('\n')

  const su = bd.sessionUsage
  const roleCounts = bd.messagesByRole
  const costStr = su.totalCostUSD > 0 ? `$${su.totalCostUSD.toFixed(4)}` : '$0'
  const sessionStats = `### ${t('context.sessionStats')}\n\n| ${t('context.metric')} | ${t('context.value')} |\n|------|----|\n| ${t('context.messageCount')} | ${bd.conversationMessageCount} (${t('context.user')}: ${roleCounts.user}, ${t('context.assistant')}: ${roleCounts.assistant}, ${t('context.tool')}: ${roleCounts.tool_result}) |\n| ${t('context.cumulativeInput')} | ${su.inputTokens.toLocaleString()} tokens |\n| ${t('context.cumulativeOutput')} | ${su.outputTokens.toLocaleString()} tokens |\n| ${t('context.cacheRead')} | ${su.cacheReadTokens.toLocaleString()} tokens |\n| ${t('context.cacheWrite')} | ${su.cacheWriteTokens.toLocaleString()} tokens |\n| ${t('context.cumulativeCost')} | ${costStr} |`

  const ch = bd.compactionHistory
  let compactionSection = ''
  if (ch.compactCount > 0) {
    const lastInfo = ch.lastBefore !== null && ch.lastAfter !== null
      ? ` (${t('context.lastCompact')}: ${formatTokenCount(ch.lastBefore)} → ${formatTokenCount(ch.lastAfter)})`
      : ''
    compactionSection = `\n\n### ${t('context.compactionHistory')}\n\n${t('context.compactCount', { count: ch.compactCount })}${lastInfo}\n\n${t('context.autoCompactThreshold')}`
  }

  const suggestions = buildContextSuggestions(bd)
  let suggestionsSection = ''
  if (suggestions.length > 0) {
    suggestionsSection = `\n\n### ${t('context.suggestions')}\n\n` + suggestions.join('\n')
  }

  return [header, '', grid, '', table, '', sessionStats, compactionSection, suggestionsSection].join('\n')
}

function buildContextSuggestions(bd: ContextBreakdownResponse): string[] {
  const t = useI18nStore.getState().t
  const suggestions: string[] = []
  const pct = bd.usagePercent
  const cw = bd.contextWindowSize
  const toolPct = cw > 0 ? (bd.toolDefinitionsTokens / cw) * 100 : 0
  const mcpPct = cw > 0 ? (bd.mcpToolTokens / cw) * 100 : 0
  const instrPct = cw > 0 ? (bd.instructionsTokens / cw) * 100 : 0
  const convPct = cw > 0 ? (bd.conversationTokens / cw) * 100 : 0

  if (pct >= 85) {
    suggestions.push(t('context.suggestion.critical'))
  } else if (pct >= 70) {
    suggestions.push(t('context.suggestion.high'))
  }
  if (toolPct > 20 && mcpPct > toolPct * 0.6) {
    suggestions.push(t('context.suggestion.mcpHigh', { pct: mcpPct.toFixed(1) }))
  }
  if (instrPct > 15) {
    suggestions.push(t('context.suggestion.instrHigh', { pct: instrPct.toFixed(1) }))
  }
  if (convPct > 60) {
    suggestions.push(t('context.suggestion.convHigh'))
  }
  if (bd.memoryTokens > 2000) {
    suggestions.push(t('context.suggestion.memoryHigh', { tokens: formatTokenCount(bd.memoryTokens) }))
  }
  if (bd.conversationMessageCount > 50) {
    suggestions.push(t('context.suggestion.messageHigh'))
  }
  if (suggestions.length === 0) {
    suggestions.push(t('context.suggestion.ok'))
  }
  return suggestions
}
