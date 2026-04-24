// ============================================================
// Shared Rate Limiter — prevents concurrent rate limit bypass
// (per review S2-01)
//
// Uses a promise-chain approach: only one rate-limited operation
// can be in-flight at a time, preventing race conditions where
// two concurrent calls both read the timestamp before either writes.
// ============================================================

import { WEB_SEARCH_RATE_LIMIT_MS } from '../../shared/constants'

let lastRequestTime = 0
let rateLimitPromise: Promise<void> | null = null

/**
 * Enforce a minimum interval between requests.
 * If a request was made within the interval, waits the remaining time.
 * Concurrent calls chain on the same promise, preventing rate limit bypass.
 */
export async function enforceRateLimit(): Promise<void> {
  if (rateLimitPromise) {
    await rateLimitPromise
  }

  rateLimitPromise = (async (): Promise<void> => {
    const now = Date.now()
    const elapsed = now - lastRequestTime
    if (elapsed < WEB_SEARCH_RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, WEB_SEARCH_RATE_LIMIT_MS - elapsed))
    }
    lastRequestTime = Date.now()
  })()

  await rateLimitPromise
}
