import type { StreamEvent } from '../../shared/types'

// ============================================================
// LLM Retry with Exponential Backoff and Model Fallback
// ============================================================

/**
 * Thrown when the prompt exceeds the model's context window.
 * Not retryable — caller (agent-loop) should trigger reactive compaction.
 */
export class PromptTooLongError extends Error {
  constructor(message?: string) {
    super(message ?? 'Prompt too long')
    this.name = 'PromptTooLongError'
  }
}

/**
 * Thrown when the API key is invalid or access is forbidden.
 * Not retryable — user needs to update their API key.
 */
export class AuthError extends Error {
  constructor(message?: string) {
    super(message ?? 'Authentication failed')
    this.name = 'AuthError'
  }
}

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  delayMs: number
}

type ErrorClassification = 'retryable' | 'prompt_too_long' | 'auth' | 'non_retryable'

interface ClassifyResult {
  classification: ErrorClassification
  /** Milliseconds to wait if the server provided a Retry-After value. */
  retryAfterMs?: number
}

/**
 * Classify an LLM API error message string to determine retry behavior.
 *
 * Retryable:
 *   - HTTP 429 / "rate_limit" / "too many requests" → exponential backoff,
 *     respects retry-after header value if present in message
 *   - HTTP 500/502/503 / "server_error" / "overloaded" / "service unavailable"
 *   - Network errors: ECONNRESET / ETIMEDOUT / ENOTFOUND / ECONNREFUSED
 *
 * Not retryable (prompt_too_long):
 *   - "prompt_too_long" / "context_length_exceeded" / "maximum context length"
 *
 * Not retryable (auth):
 *   - HTTP 401 / 403 / "invalid_api_key" / "unauthorized" / "forbidden"
 *
 * Not retryable (non_retryable):
 *   - All other 4xx errors
 */
export function classifyError(errorMsg: string): ClassifyResult {
  const msg = errorMsg.toLowerCase()

  // --- Rate limit (429) ---
  if (
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    // Try to extract retry-after seconds from strings like "retry after 5s" or "retry_after: 10"
    const retryMatch = msg.match(/retry[_\s-]after[:\s]+(\d+)/i)
    const retryAfterMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : undefined
    return { classification: 'retryable', retryAfterMs }
  }

  // --- Server errors (500/502/503) ---
  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('server_error') ||
    msg.includes('server error') ||
    msg.includes('overloaded') ||
    msg.includes('service unavailable') ||
    msg.includes('internal server')
  ) {
    return { classification: 'retryable' }
  }

  // --- Network errors ---
  if (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('connect timeout') ||
    msg.includes('network error') ||
    msg.includes('fetch failed')
  ) {
    return { classification: 'retryable' }
  }

  // --- Prompt too long (not retryable — triggers reactive compaction) ---
  if (
    msg.includes('prompt_too_long') ||
    msg.includes('prompt too long') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('context length exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('max_tokens') ||
    msg.includes('token limit') ||
    (msg.includes('400') && (msg.includes('too long') || msg.includes('too many tokens')))
  ) {
    return { classification: 'prompt_too_long' }
  }

  // --- Auth errors (401/403) ---
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication_error') ||
    msg.includes('authentication failed') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key') ||
    msg.includes('permission denied')
  ) {
    return { classification: 'auth' }
  }

  // --- All other errors (4xx etc.) ---
  return { classification: 'non_retryable' }
}

/**
 * Calculate exponential backoff delay in milliseconds.
 * Base: 1 000 ms, doubles each attempt, capped at 30 000 ms.
 * Adds ±20 % random jitter to avoid thundering-herd retries.
 */
function exponentialBackoff(attempt: number): number {
  const base = 1000
  const max = 30000
  const delay = Math.min(base * Math.pow(2, attempt - 1), max)
  const jitter = delay * 0.2 * (Math.random() - 0.5)
  return Math.round(delay + jitter)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WithRetryOptions {
  /** Maximum number of retry attempts on the primary model. Default: 3. */
  maxRetries?: number
  /** If set, tried once (with a 1 s delay) after the primary model exhausts its retries. */
  fallbackModel?: string
  /** Invoked before each retry so callers can emit UI notifications. */
  onRetry?: (info: RetryInfo) => void
}

/**
 * Wraps an async-generator factory (thunk) with retry + model-fallback logic.
 *
 * The thunk receives the current model name and must return an `AsyncGenerator<StreamEvent>`.
 * On retryable errors — and only if no content has been yielded yet — the thunk is
 * re-invoked with exponential backoff up to `maxRetries` times. After exhausting
 * retries on the primary model, the `fallbackModel` is attempted once if configured.
 *
 * Special error handling:
 *  - `prompt_too_long` → throws `PromptTooLongError` (not retried)
 *  - auth errors       → yields the error event and returns
 *  - non-retryable     → yields the error event and returns
 *  - retryable but content already streamed → yields the error event (can't restart)
 */
export async function* withRetry(
  thunk: (model: string) => AsyncGenerator<StreamEvent>,
  primaryModel: string,
  options: WithRetryOptions = {}
): AsyncGenerator<StreamEvent> {
  const maxRetries = options.maxRetries ?? 3
  const fallbackModel = options.fallbackModel
  const onRetry = options.onRetry

  let attempt = 0
  let currentModel = primaryModel
  let usingFallback = false

  while (true) {
    const gen = thunk(currentModel)
    let hasYieldedContent = false
    let errorEvent: (StreamEvent & { type: 'error' }) | null = null

    for await (const event of gen) {
      if (event.type === 'error') {
        errorEvent = event as StreamEvent & { type: 'error' }
        break
      }
      // Once content starts flowing we can no longer safely restart the stream
      if (event.type === 'text_delta' || event.type === 'tool_use_start') {
        hasYieldedContent = true
      }
      yield event
    }

    // Generator completed without an error event — normal success path
    if (!errorEvent) return

    const classified = classifyError(errorEvent.error)

    // Prompt too long → throw for the agent-loop to handle via reactive compaction
    if (classified.classification === 'prompt_too_long') {
      throw new PromptTooLongError(errorEvent.error)
    }

    // Auth error → not retryable, surface the error event and stop
    if (classified.classification === 'auth') {
      yield errorEvent
      return
    }

    // Non-retryable → surface and stop
    if (classified.classification === 'non_retryable') {
      yield errorEvent
      return
    }

    // Retryable — only restart if no content has been committed to the stream
    if (classified.classification === 'retryable' && !hasYieldedContent) {
      if (!usingFallback && attempt < maxRetries) {
        attempt++
        const delayMs = classified.retryAfterMs ?? exponentialBackoff(attempt)
        const info: RetryInfo = { attempt, maxAttempts: maxRetries, delayMs }
        onRetry?.(info)
        await sleep(delayMs)
        continue
      }

      if (fallbackModel && !usingFallback) {
        // Switch to fallback model after primary retries are exhausted
        usingFallback = true
        currentModel = fallbackModel
        attempt = 1
        const delayMs = 1000
        const info: RetryInfo = { attempt: 1, maxAttempts: 1, delayMs }
        onRetry?.(info)
        await sleep(delayMs)
        continue
      }
    }

    // Retries exhausted, or content already streamed — yield error and stop
    yield errorEvent
    return
  }
}
