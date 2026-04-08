import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { WEB_CONTENT_MAX_CHARS, WEB_FETCH_TIMEOUT_MS, WEB_SEARCH_RATE_LIMIT_MS } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const WebFetchInputSchema = z.object({
  url: z.string().min(1),
  maxLength: z.number().int().min(1000).optional()
})

// ============================================================
// Rate Limiting (shared static state)
// ============================================================

let lastRequestTime = 0

async function enforceRateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < WEB_SEARCH_RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, WEB_SEARCH_RATE_LIMIT_MS - elapsed))
  }
  lastRequestTime = Date.now()
}

// ============================================================
// HTML-to-text conversion (MVP, no external library)
// ============================================================

function htmlToText(html: string): string {
  let text = html

  // Remove <script> and <style> tags and their contents
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode basic HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // Collapse multiple whitespace/newlines
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

// ============================================================
// WebFetchTool Implementation
// ============================================================

export class WebFetchTool implements Tool {
  readonly name = 'WebFetch'
  readonly description =
    'Fetch a web page and convert its content to readable text. Returns markdown-formatted content up to 15000 characters.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch'
      },
      maxLength: {
        type: 'number',
        description: 'Max content length in chars (default: 15000)'
      }
    },
    required: ['url']
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = WebFetchInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { url, maxLength: rawMax } = parsed.data
    const maxLength = rawMax ?? WEB_CONTENT_MAX_CHARS

    // Validate URL format
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        output: 'Invalid URL: must start with http:// or https://',
        isError: true
      }
    }

    await enforceRateLimit()

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; wzxClaw/1.0)'
        }
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        return {
          output: `Web fetch failed: ${response.status} ${response.statusText}. Response: ${body.slice(0, 500)}`,
          isError: true
        }
      }

      const html = await response.text()
      const content = htmlToText(html)
      const originalLength = content.length

      // Truncate if needed
      const truncated =
        content.length > maxLength
          ? content.substring(0, maxLength) +
            `\n... [content truncated, ${originalLength} chars total]`
          : content

      // Prepend source URL
      const formatted = `Source: ${url}\n\n${truncated}`

      return {
        output: formatted,
        isError: false
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        output: `Web fetch failed: ${message}`,
        isError: true
      }
    }
  }
}
