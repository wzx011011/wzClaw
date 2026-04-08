import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { WEB_SEARCH_RATE_LIMIT_MS } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const WebSearchInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(10).optional()
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
// WebSearchTool Implementation
// ============================================================

export class WebSearchTool implements Tool {
  readonly name = 'WebSearch'
  readonly description =
    'Search the web for information. Returns a list of results with titles, URLs, and snippets.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results (default: 5, max: 10)'
      }
    },
    required: ['query']
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = WebSearchInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { query, maxResults: rawMax } = parsed.data
    const maxResults = Math.min(rawMax ?? 5, 10)

    await enforceRateLimit()

    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000)
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        return {
          output: `Web search failed: ${response.status} ${response.statusText}. First 500 chars: ${body.slice(0, 500)}`,
          isError: true
        }
      }

      const data = (await response.json()) as {
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
        AbstractText?: string
        AbstractURL?: string
      }

      const results: string[] = []

      // Add abstract if present
      if (data.AbstractText && data.AbstractURL) {
        results.push(`Title: ${data.AbstractText}\nURL: ${data.AbstractURL}`)
      }

      // Add related topics
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics) {
          if (topic.Text && topic.FirstURL) {
            results.push(`Title: ${topic.Text}\nURL: ${topic.FirstURL}`)
          }
          if (results.length >= maxResults) break
        }
      }

      if (results.length === 0) {
        return {
          output: `No results found for "${query}". Consider configuring a search API key for better results.`,
          isError: false
        }
      }

      return {
        output: results.join('\n\n'),
        isError: false
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        output: `Web search failed: ${message}`,
        isError: true
      }
    }
  }
}
