// ============================================================
// L4 E2E Harness — Three-way Consistency Assertion
// ============================================================
// Asserts that the three views of a session are equivalent:
//   1. JSONL on disk (loaded via SessionStore)
//   2. Desktop runtime in-memory messages
//   3. Mobile chatStore projection from stream events
//
// "Equivalent" is content-level: same set of (role, content, toolCallId)
// tuples, ignoring auto-assigned ids and minor timestamp differences.
// ============================================================

import type { ChatMessageLike } from '../../../persistence/session-store'
import type { MobileChatMessage } from './mobile-client'

export interface ConsistencyInputs {
  jsonl: ChatMessageLike[]
  runtime: ChatMessageLike[]
  mobile: MobileChatMessage[]
}

interface NormalizedKey {
  role: string
  // content for text-bearing roles; tool name for tool calls; etc.
  content: string
  toolCallId?: string
  toolName?: string
}

function normRole(r: string): string {
  // Mobile observes tool_call/tool_result/assistant/user. JSONL has the same.
  // The desktop runtime stores assistant messages with toolCalls separately
  // — in the scripted fixture we record an empty-content assistant + tool_result.
  // We collapse "assistant with empty content but has toolCalls" to a synthetic
  // "tool_call" entry per tool to match the mobile projection.
  return r
}

function explodeAssistantWithTools(msg: ChatMessageLike): NormalizedKey[] {
  const tcs = (msg.toolCalls as Array<{ id?: string; name?: string }> | undefined) ?? []
  if ((!msg.content || msg.content === '') && tcs.length > 0) {
    return tcs.map((t) => ({
      role: 'tool_call',
      content: '', // tool input is not faithfully echoed in mobile projection (we stringify)
      toolCallId: t.id,
      toolName: t.name,
    }))
  }
  return [{ role: msg.role, content: msg.content ?? '' }]
}

function normalizeJsonlOrRuntime(msgs: ChatMessageLike[]): NormalizedKey[] {
  const out: NormalizedKey[] = []
  for (const m of msgs) {
    if (m.type === 'meta') continue
    if (m.role === 'assistant' && m.toolCalls && (m.toolCalls as unknown[]).length > 0) {
      out.push(...explodeAssistantWithTools(m))
    } else if (m.role === 'tool_result') {
      out.push({
        role: 'tool_result',
        content: m.content ?? '',
        toolCallId: m.toolCallId,
      })
    } else {
      out.push({ role: normRole(m.role), content: m.content ?? '' })
    }
  }
  return out
}

function normalizeMobile(msgs: MobileChatMessage[]): NormalizedKey[] {
  return msgs.map((m) => {
    if (m.role === 'tool_call') {
      return { role: 'tool_call', content: '', toolCallId: m.toolCallId, toolName: m.toolName }
    }
    if (m.role === 'tool_result') {
      return { role: 'tool_result', content: m.content ?? '', toolCallId: m.toolCallId }
    }
    return { role: m.role, content: m.content ?? '' }
  })
}

function multisetKey(k: NormalizedKey): string {
  return [k.role, k.content, k.toolCallId ?? '', k.toolName ?? ''].join('||')
}

function multisetCount(arr: NormalizedKey[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const k of arr) {
    const key = multisetKey(k)
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return m
}

function diffMultisets(
  a: Map<string, number>,
  b: Map<string, number>,
): { onlyInA: string[]; onlyInB: string[] } {
  const onlyInA: string[] = []
  const onlyInB: string[] = []
  const allKeys = new Set([...a.keys(), ...b.keys()])
  for (const k of allKeys) {
    const av = a.get(k) ?? 0
    const bv = b.get(k) ?? 0
    if (av > bv) for (let i = 0; i < av - bv; i++) onlyInA.push(k)
    else if (bv > av) for (let i = 0; i < bv - av; i++) onlyInB.push(k)
  }
  return { onlyInA, onlyInB }
}

export interface ConsistencyResult {
  ok: boolean
  errors: string[]
  details: {
    jsonl: NormalizedKey[]
    runtime: NormalizedKey[]
    mobile: NormalizedKey[]
  }
}

/**
 * Compare normalized message multisets across the three views.
 * Returns ok=true only if all three are identical multisets.
 */
export function checkConsistency(inputs: ConsistencyInputs): ConsistencyResult {
  const jsonl = normalizeJsonlOrRuntime(inputs.jsonl)
  const runtime = normalizeJsonlOrRuntime(inputs.runtime)
  const mobile = normalizeMobile(inputs.mobile)

  const errors: string[] = []
  const jsonlMs = multisetCount(jsonl)
  const runtimeMs = multisetCount(runtime)
  const mobileMs = multisetCount(mobile)

  const dJR = diffMultisets(jsonlMs, runtimeMs)
  if (dJR.onlyInA.length || dJR.onlyInB.length) {
    errors.push(
      `JSONL vs runtime mismatch: onlyJSONL=${JSON.stringify(dJR.onlyInA)} onlyRuntime=${JSON.stringify(dJR.onlyInB)}`,
    )
  }
  const dJM = diffMultisets(jsonlMs, mobileMs)
  if (dJM.onlyInA.length || dJM.onlyInB.length) {
    errors.push(
      `JSONL vs mobile mismatch: onlyJSONL=${JSON.stringify(dJM.onlyInA)} onlyMobile=${JSON.stringify(dJM.onlyInB)}`,
    )
  }

  return {
    ok: errors.length === 0,
    errors,
    details: { jsonl, runtime, mobile },
  }
}

/** Vitest-friendly: throws with a readable error if not consistent. */
export function assertConsistent(inputs: ConsistencyInputs): void {
  const r = checkConsistency(inputs)
  if (!r.ok) {
    throw new Error(
      `Three-way consistency check failed:\n  ${r.errors.join('\n  ')}\n` +
        `JSONL=${JSON.stringify(r.details.jsonl, null, 2)}\n` +
        `RUNTIME=${JSON.stringify(r.details.runtime, null, 2)}\n` +
        `MOBILE=${JSON.stringify(r.details.mobile, null, 2)}`,
    )
  }
}

/** Strict: also asserts that no JSONL line is duplicated. */
export function assertNoJsonlDuplicates(jsonl: ChatMessageLike[]): void {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const m of jsonl) {
    if (m.type === 'meta') continue
    const key = `${m.role}|${m.content}|${m.timestamp}|${m.toolCallId ?? ''}`
    if (seen.has(key)) dups.push(key)
    else seen.add(key)
  }
  if (dups.length > 0) {
    throw new Error(`JSONL contains duplicate messages: ${dups.slice(0, 5).join('; ')}`)
  }
}
