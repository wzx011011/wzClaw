// ============================================================
// facet-extractor.ts — LLM-based per-session facet extraction + cache
// 对齐 Claude Code 的 FACET_EXTRACTION_PROMPT 和分类体系
// ============================================================

import fsp from 'fs/promises'
import path from 'path'
import type { ChatMessageLike } from '../persistence/session-store'
import type { SessionInsightMeta, SessionFacets } from './insight-types'

/**
 * Extract facets for a single session using LLM analysis.
 */
export async function extractFacets(
  meta: SessionInsightMeta,
  messages: ChatMessageLike[],
  apiKey: string,
  baseUrl: string,
  model: string,
  cacheDir: string,
): Promise<SessionFacets | null> {
  if (meta.userMessageCount < 2 || meta.durationMs < 60_000) return null

  // Check cache
  const cachePath = path.join(cacheDir, `${meta.sessionId}.json`)
  const cached = await loadCachedFacets(cachePath, meta.updatedAt)
  if (cached) return cached

  // Build condensed transcript
  const transcript = buildCondensedTranscript(meta, messages)
  if (!transcript) return null

  // LLM call
  const result = await callLlmForFacets(transcript, meta, apiKey, baseUrl, model)
  if (!result) return null

  const facets: SessionFacets = {
    sessionId: meta.sessionId,
    extractedAt: Date.now(),
    ...result,
  }

  // Save cache
  try {
    await fsp.mkdir(cacheDir, { recursive: true })
    await fsp.writeFile(cachePath, JSON.stringify(facets, null, 2), 'utf-8')
  } catch {
    // non-blocking
  }

  return facets
}

/**
 * Batch-extract facets with concurrency limit.
 */
export async function batchExtractFacets(
  sessions: Array<{ meta: SessionInsightMeta; messages: ChatMessageLike[] }>,
  apiKey: string,
  baseUrl: string,
  model: string,
  cacheDir: string,
  onProgress?: (current: number, total: number) => void,
): Promise<(SessionFacets | null)[]> {
  // Serial execution with delay to avoid rate limits on GLM/DeepSeek APIs
  const DELAY_MS = 2000
  const results: (SessionFacets | null)[] = new Array(sessions.length).fill(null)

  for (let i = 0; i < sessions.length; i++) {
    const { meta, messages } = sessions[i]
    try {
      results[i] = await extractFacets(meta, messages, apiKey, baseUrl, model, cacheDir)
    } catch {
      results[i] = null
    }
    onProgress?.(i + 1, sessions.length)
    if (i < sessions.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS))
    }
  }

  return results
}

// ---- Cache helpers ----

async function loadCachedFacets(cachePath: string, sessionMtime: number): Promise<SessionFacets | null> {
  try {
    const raw = await fsp.readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as SessionFacets
    if (cached.extractedAt >= sessionMtime) return cached
  } catch { /* cache miss */ }
  return null
}

// ---- Transcript condensation ----

function buildCondensedTranscript(meta: SessionInsightMeta, messages: ChatMessageLike[]): string | null {
  const actualMessages = messages.filter(m => m.type !== 'meta')
  const lines: string[] = []

  lines.push(`Session: ${meta.sessionId.slice(0, 8)}`)
  lines.push(`Title: ${meta.title}`)
  lines.push(`Duration: ${Math.round(meta.durationMs / 60_000)} min`)
  lines.push(`Errors: ${meta.toolErrorCount}`)
  lines.push(`Tools: ${Object.entries(meta.toolCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`)
  lines.push('')

  // First 5 user messages
  let userCount = 0
  for (const m of actualMessages) {
    if (m.role === 'user' && !m.toolCallId && m.content) {
      lines.push(`[User]: ${m.content.slice(0, 300)}`)
      userCount++
      if (userCount >= 5) break
    }
  }

  // Tool call summary
  lines.push('')
  for (const m of actualMessages) {
    if (m.role === 'assistant' && m.toolCalls) {
      const tcs = m.toolCalls as Array<{ name?: string }>
      for (const tc of tcs) {
        if (tc.name) lines.push(`[Tool: ${tc.name}]`)
      }
    }
  }

  // Last 3 exchanges
  lines.push('')
  lines.push('--- Last exchanges ---')
  const recent = actualMessages.slice(-6)
  for (const m of recent) {
    if (m.role === 'user' && m.content) {
      lines.push(`[User]: ${m.content.slice(0, 200)}`)
    } else if (m.role === 'assistant' && m.content) {
      lines.push(`[Assistant]: ${m.content.slice(0, 200)}`)
    }
  }

  const result = lines.join('\n')
  return result.length > 4000 ? result.slice(0, 4000) + '\n[truncated]' : result
}

// ---- LLM call ----

interface RawFacets {
  underlying_goal?: string
  underlyingGoal?: string
  goal_categories?: Record<string, number>
  goalCategories?: Record<string, number>
  outcome: string
  user_satisfaction?: Record<string, number>
  userSatisfaction?: Record<string, number>
  claude_helpfulness?: string
  claudeHelpfulness?: string
  session_type?: string
  sessionType?: string
  friction_counts?: Record<string, number>
  frictionCounts?: Record<string, number>
  friction_detail?: string
  frictionDetail?: string
  primary_success?: string
  primarySuccess?: string
  brief_summary?: string
  briefSummary?: string
  user_instructions_to_claude?: string[]
  userInstructionsToClaude?: string[]
}

const FACET_SYSTEM_PROMPT = 'You are a code session analyst. Respond only with valid JSON.'

const FACET_PROMPT = `Analyze this AI coding session and extract structured facets.

CRITICAL GUIDELINES:

1. **goal_categories**: Count ONLY what the USER explicitly asked for.
   - DO NOT count Claude's autonomous exploration
   - ONLY count when user says "can you...", "please...", "I need...", "let's..."

2. **user_satisfaction**: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. **friction_counts**: Be specific about what went wrong.
   - misunderstood_request: AI interpreted incorrectly
   - wrong_approach: Right goal, wrong solution method
   - buggy_code: Code didn't work correctly
   - user_rejected_action: User said no/stop to a tool call
   - excessive_changes: Over-engineered or changed too much
   - claude_got_blocked: AI hit a permission or tool limit
   - user_stopped_early: User interrupted or gave up
   - wrong_file_or_location: Right idea, wrong target
   - slow_or_verbose: Too slow or too much output
   - tool_failed: Tool execution error
   - user_unclear: User's request was ambiguous
   - external_issue: External dependency or environment problem

4. If very short or just warmup, use warmup_minimal for goal_category with count 1

SESSION:
{transcript}

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "underlying_goal": "What the user fundamentally wanted to achieve",
  "goal_categories": {"category_name": count, ...},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear",
  "user_satisfaction": {"level": count, ...},
  "claude_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"friction_type": count, ...},
  "friction_detail": "One sentence describing friction or empty string",
  "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|handled_complexity|good_debugging",
  "brief_summary": "One sentence: what user wanted and whether they got it",
  "user_instructions_to_claude": ["instruction repeated by user", ...]
}`

async function callLlmForFacets(
  transcript: string,
  meta: SessionInsightMeta,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<RawFacets | null> {
  const prompt = FACET_PROMPT.replace('{transcript}', transcript)
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  const MAX_RETRIES = 3
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000)
      console.log(`[insights] callLlmForFacets retry ${attempt}/${MAX_RETRIES} after ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
    console.log(`[insights] callLlmForFacets → ${url} model=${model} attempt=${attempt}`)
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: FACET_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1024,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      if (resp.status === 429 && attempt < MAX_RETRIES) {
        console.warn(`[insights] callLlmForFacets HTTP 429 (rate limited), will retry...`)
        continue
      }
      console.error(`[insights] callLlmForFacets HTTP ${resp.status}: ${body.slice(0, 500)}`)
      return null
    }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    const text = data.choices?.[0]?.message?.content
    if (!text) {
      console.error(`[insights] callLlmForFacets: empty response content, data=`, JSON.stringify(data).slice(0, 300))
      return null
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error(`[insights] callLlmForFacets: no JSON in response: ${text.slice(0, 200)}`)
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as RawFacets

    // Normalize snake_case → camelCase (GLM returns snake_case keys)
    const goal = parsed.underlying_goal || parsed.underlyingGoal
    if (!goal) {
      console.error(`[insights] callLlmForFacets: missing underlying goal in parsed JSON:`, JSON.stringify(parsed).slice(0, 300))
      return null
    }
    parsed.underlyingGoal = goal
    parsed.goalCategories = parsed.goalCategories || parsed.goal_categories || {}
    parsed.userSatisfaction = parsed.userSatisfaction || parsed.user_satisfaction || {}
    parsed.claudeHelpfulness = parsed.claudeHelpfulness || parsed.claude_helpfulness || 'moderately_helpful'
    parsed.sessionType = parsed.sessionType || parsed.session_type || 'single_task'
    parsed.frictionCounts = parsed.frictionCounts || parsed.friction_counts || {}
    parsed.frictionDetail = parsed.frictionDetail || parsed.friction_detail || ''
    parsed.primarySuccess = parsed.primarySuccess || parsed.primary_success || 'none'
    parsed.briefSummary = parsed.briefSummary || parsed.brief_summary || ''
    parsed.userInstructionsToClaude = parsed.userInstructionsToClaude || parsed.user_instructions_to_claude || []

    // Clamp enum values
    const validOutcomes = ['fully_achieved', 'mostly_achieved', 'partially_achieved', 'not_achieved', 'unclear']
    const validHelpfulness = ['unhelpful', 'slightly_helpful', 'moderately_helpful', 'very_helpful', 'essential']
    const validTypes = ['single_task', 'multi_task', 'iterative_refinement', 'exploration', 'quick_question']

    if (!validOutcomes.includes(parsed.outcome)) parsed.outcome = 'mostly_achieved'
    if (!validHelpfulness.includes(parsed.claudeHelpfulness)) parsed.claudeHelpfulness = 'moderately_helpful'
    if (!validTypes.includes(parsed.sessionType)) parsed.sessionType = 'single_task'

    return parsed
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      console.warn(`[insights] callLlmForFacets error (will retry):`, err)
      continue
    }
    console.error(`[insights] callLlmForFacets error (final):`, err)
    return null
  }
  } // end retry loop
  return null
}
