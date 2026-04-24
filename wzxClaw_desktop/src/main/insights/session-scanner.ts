// ============================================================
// session-scanner.ts — 扫描所有 JSONL 会话，提取完整 SessionInsightMeta
// 对齐 Claude Code /insights 的数据提取维度
// ============================================================

import fsp from 'fs/promises'
import path from 'path'
import type { ChatMessageLike } from '../persistence/session-store'
import type { SessionInsightMeta } from './insight-types'
import { getPricing } from '../llm/model-cost'

/** Simple line diff counter — avoids external dependency on 'diff' */
function countLineDiff(oldStr: string, newStr: string): { added: number; removed: number } {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  // Use LCS-like heuristic: count lines unique to each side
  const oldSet = new Map<string, number>()
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) || 0) + 1)
  let added = 0
  let removed = 0
  const newSet = new Map<string, number>()
  for (const line of newLines) newSet.set(line, (newSet.get(line) || 0) + 1)
  // Lines in old not in new = removed
  for (const [line, count] of oldSet) {
    const newCount = newSet.get(line) || 0
    removed += Math.max(0, count - newCount)
  }
  // Lines in new not in old = added
  for (const [line, count] of newSet) {
    const oldCount = oldSet.get(line) || 0
    added += Math.max(0, count - oldCount)
  }
  return { added, removed }
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
  '.css': 'CSS', '.html': 'HTML', '.json': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML', '.md': 'Markdown',
  '.sh': 'Shell', '.sql': 'SQL', '.vue': 'Vue',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C',
  '.cpp': 'C++', '.h': 'C/C++ Header',
}

function getLanguageFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] || null
}

interface RawToolCall {
  id?: string
  name?: string
  input?: Record<string, unknown>
}

/**
 * Scan all session JSONL files under the sessions root directory.
 */
export async function scanAllSessions(sessionsRoot: string): Promise<SessionInsightMeta[]> {
  let topDirs: string[]
  try {
    const entries = await fsp.readdir(sessionsRoot, { withFileTypes: true })
    topDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }

  const results: SessionInsightMeta[] = []

  for (const dir of topDirs) {
    const dirPath = path.join(sessionsRoot, dir)
    let files: string[]
    try {
      const entries = await fsp.readdir(dirPath)
      files = entries.filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file)
      try {
        const meta = await extractSessionMeta(filePath, dir)
        if (meta) results.push(meta)
      } catch {
        // skip unreadable/corrupt sessions
      }
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Load raw messages from a session JSONL file.
 */
export async function loadSessionMessages(filePath: string): Promise<ChatMessageLike[]> {
  const content = await fsp.readFile(filePath, 'utf-8')
  const messages: ChatMessageLike[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }
  return messages
}

/**
 * Extract full SessionInsightMeta from a single JSONL file.
 */
async function extractSessionMeta(filePath: string, projectHash: string): Promise<SessionInsightMeta | null> {
  const messages = await loadSessionMessages(filePath)
  const sessionId = path.basename(filePath, '.jsonl')

  // Extract title from meta line or first user message
  let title = 'Untitled'
  const actualMessages = messages.filter(m => m.type !== 'meta')
  if (messages.length > 0 && messages[0].type === 'meta' && messages[0].content) {
    title = messages[0].content
  } else {
    for (const m of actualMessages) {
      if (m.role === 'user' && m.content) {
        title = m.content.length > 50 ? m.content.substring(0, 50) + '...' : m.content
        break
      }
    }
  }

  // Initialize counters
  let userMessageCount = 0
  let assistantMessageCount = 0
  let toolCallCount = 0
  let toolErrorCount = 0
  const toolErrorCategories: Record<string, number> = {}
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let firstTs = Infinity
  let lastTs = -Infinity
  let model = ''
  const toolCounts: Record<string, number> = {}
  const languageSet = new Set<string>()
  const filesModifiedSet = new Set<string>()
  let linesAdded = 0
  let linesRemoved = 0
  let gitCommits = 0
  let gitPushes = 0
  let userInterruptions = 0
  const userResponseTimes: number[] = []
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  let usesTaskAgent = false
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let firstPrompt = ''
  let lastAssistantTimestamp: string | null = null

  for (const msg of actualMessages) {
    const ts = msg.timestamp ?? 0
    const tsISO = ts > 0 ? new Date(ts).toISOString() : ''

    if (ts > 0) {
      if (ts < firstTs) firstTs = ts
      if (ts > lastTs) lastTs = ts
    }

    // --- User messages ---
    if (msg.role === 'user') {
      // Check if this is a human message (has text content) vs tool_result
      let isHumanMessage = false
      if (typeof msg.content === 'string' && msg.content.trim()) {
        isHumanMessage = true
      }

      if (isHumanMessage) {
        userMessageCount++

        // First prompt
        if (!firstPrompt && msg.content) {
          firstPrompt = msg.content.slice(0, 200)
        }

        // Message hour and timestamp for charts / multi-clauding
        if (ts > 0) {
          const hour = new Date(ts).getHours()
          messageHours.push(hour)
          userMessageTimestamps.push(tsISO)
        }

        // Response time (gap between last assistant msg and this user msg)
        if (lastAssistantTimestamp && ts > 0) {
          const assistantTime = new Date(lastAssistantTimestamp).getTime()
          const gapSec = (ts - assistantTime) / 1000
          if (gapSec > 2 && gapSec < 3600) {
            userResponseTimes.push(gapSec)
          }
        }

        // Check for interruptions
        if (msg.content.includes('[Request interrupted by user')) {
          userInterruptions++
        }
      }

      // Check tool_result errors (some sessions store tool_results as role='user')
      if (msg.toolCallId && msg.isError) {
        toolErrorCount++
      }
    }

    // --- Tool result messages ---
    if (msg.role === 'tool_result') {
      if (msg.isError) {
        toolErrorCount++
        // Categorize error
        const errContent = msg.content?.toLowerCase() || ''
        let category = 'Other'
        if (errContent.includes('exit code')) category = 'Command Failed'
        else if (errContent.includes('rejected') || errContent.includes("doesn't want")) category = 'User Rejected'
        else if (errContent.includes('string to replace not found') || errContent.includes('no changes')) category = 'Edit Failed'
        else if (errContent.includes('modified since read')) category = 'File Changed'
        else if (errContent.includes('exceeds maximum') || errContent.includes('too large')) category = 'File Too Large'
        else if (errContent.includes('file not found') || errContent.includes('does not exist')) category = 'File Not Found'
        toolErrorCategories[category] = (toolErrorCategories[category] || 0) + 1
      }
    }

    // --- Assistant messages ---
    if (msg.role === 'assistant') {
      assistantMessageCount++

      if (ts > 0) {
        lastAssistantTimestamp = tsISO
      }

      // Token usage
      if (msg.usage) {
        totalInputTokens += msg.usage.inputTokens || 0
        totalOutputTokens += msg.usage.outputTokens || 0
      }

      // Tool calls
      const toolCalls = (msg.toolCalls as RawToolCall[] | undefined) ?? []
      for (const tc of toolCalls) {
        if (!tc.name) continue
        toolCallCount++
        toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1

        // Detect special tool usage
        if (tc.name === 'Agent') usesTaskAgent = true
        if (tc.name.startsWith('mcp__')) usesMcp = true
        if (tc.name === 'WebSearch') usesWebSearch = true
        if (tc.name === 'WebFetch' || tc.name === 'WebFetchTool') usesWebFetch = true

        const input = tc.input
        if (input) {
          const fp = (input.path as string) || (input.file_path as string) || ''
          if (fp) {
            const lang = getLanguageFromPath(fp)
            if (lang) languageSet.add(lang)

            if (tc.name === 'FileEdit' || tc.name === 'FileWrite') {
              filesModifiedSet.add(fp)
            }
          }

          // Lines diff for Edit tool
          if (tc.name === 'FileEdit') {
            const oldStr = (input.old_string as string) || ''
            const newStr = (input.new_string as string) || ''
            const diff = countLineDiff(oldStr, newStr)
            linesAdded += diff.added
            linesRemoved += diff.removed
          }

          // Lines from Write tool
          if (tc.name === 'FileWrite') {
            const writeContent = (input.content as string) || ''
            if (writeContent) {
              linesAdded += writeContent.split('\n').length
            }
          }

          // Git commands
          const cmd = (input.command as string) || ''
          if (cmd.includes('git commit')) gitCommits++
          if (cmd.includes('git push')) gitPushes++
        }
      }
    }
  }

  if (firstTs === Infinity) firstTs = 0
  if (lastTs === -Infinity) lastTs = 0

  let createdAt = firstTs
  let updatedAt = lastTs
  try {
    const stat = await fsp.stat(filePath)
    createdAt = stat.birthtimeMs || firstTs
    updatedAt = stat.mtimeMs || lastTs
  } catch {
    // use message-derived timestamps
  }

  // Cost
  let estimatedCostUSD = 0
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    const pricing = getPricing(model || 'glm-5')
    if (pricing) {
      estimatedCostUSD =
        (totalInputTokens / 1_000_000) * pricing.inputPerMToken +
        (totalOutputTokens / 1_000_000) * pricing.outputPerMToken
    }
  }

  return {
    sessionId,
    projectHash,
    title,
    createdAt,
    updatedAt,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    toolCounts,
    toolErrorCount,
    toolErrorCategories,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUSD,
    model,
    durationMs: lastTs > 0 && firstTs > 0 ? lastTs - firstTs : 0,
    languages: [...languageSet],
    filesModified: filesModifiedSet.size,
    linesAdded,
    linesRemoved,
    gitCommits,
    gitPushes,
    userInterruptions,
    userResponseTimes,
    usesTaskAgent,
    usesMcp,
    usesWebSearch,
    usesWebFetch,
    firstPrompt,
    messageHours,
    userMessageTimestamps,
  }
}

/**
 * Detect multi-clauding (using multiple sessions concurrently).
 * Sliding window: finds pattern session1 -> session2 -> session1 within 30 min.
 */
export function detectMultiClauding(
  sessions: Array<{ sessionId: string; userMessageTimestamps: string[] }>,
): { overlapEvents: number; sessionsInvolved: number; userMessagesDuring: number } {
  const OVERLAP_WINDOW_MS = 30 * 60_000
  const allMsgs: Array<{ ts: number; sid: string }> = []

  for (const s of sessions) {
    for (const ts of s.userMessageTimestamps) {
      try {
        allMsgs.push({ ts: new Date(ts).getTime(), sid: s.sessionId })
      } catch { /* skip */ }
    }
  }

  allMsgs.sort((a, b) => a.ts - b.ts)

  const overlapPairs = new Set<string>()
  const msgsDuringOverlap = new Set<string>()
  const sessionLastIdx = new Map<string, number>()

  let windowStart = 0
  for (let i = 0; i < allMsgs.length; i++) {
    const msg = allMsgs[i]

    while (windowStart < i && msg.ts - allMsgs[windowStart].ts > OVERLAP_WINDOW_MS) {
      const expiring = allMsgs[windowStart]
      if (sessionLastIdx.get(expiring.sid) === windowStart) sessionLastIdx.delete(expiring.sid)
      windowStart++
    }

    const prevIdx = sessionLastIdx.get(msg.sid)
    if (prevIdx !== undefined) {
      for (let j = prevIdx + 1; j < i; j++) {
        if (allMsgs[j].sid !== msg.sid) {
          const pair = [msg.sid, allMsgs[j].sid].sort().join(':')
          overlapPairs.add(pair)
          msgsDuringOverlap.add(`${allMsgs[prevIdx].ts}:${msg.sid}`)
          msgsDuringOverlap.add(`${allMsgs[j].ts}:${allMsgs[j].sid}`)
          msgsDuringOverlap.add(`${msg.ts}:${msg.sid}`)
          break
        }
      }
    }
    sessionLastIdx.set(msg.sid, i)
  }

  const involved = new Set<string>()
  for (const pair of overlapPairs) {
    const [s1, s2] = pair.split(':')
    if (s1) involved.add(s1)
    if (s2) involved.add(s2)
  }

  return {
    overlapEvents: overlapPairs.size,
    sessionsInvolved: involved.size,
    userMessagesDuring: msgsDuringOverlap.size,
  }
}
