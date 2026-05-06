import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { SEARXNG_BASE_URL, WEB_SEARCH_TIMEOUT_MS } from '../../shared/constants'
import { enforceRateLimit } from './rate-limiter'

// ============================================================
// Input Schema
// ============================================================

const WebSearchInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(10).optional(),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional()
})

// ============================================================
// SearXNG JSON 响应类型
// ============================================================

interface SearXNGResult {
  title: string
  url: string
  /** 搜索结果摘要 */
  content: string
}

interface SearXNGResponse {
  results: SearXNGResult[]
}

// ============================================================
// WebSearchTool Implementation — 通过 SearXNG JSON API 搜索
// ============================================================

export class WebSearchTool implements Tool {
  readonly name = 'WebSearch'
  readonly description = [
    'Search the web for information. Returns search results with titles, URLs, and snippets.',
    'Use `allowed_domains` to restrict results to specific sites.',
    'Use `blocked_domains` to exclude specific sites from results.',
    'Results include clickable markdown links for easy reference.'
  ].join(' ')
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly maxResultSizeChars = 50_000
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
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains (e.g. ["github.com", "stackoverflow.com"])'
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains (e.g. ["pinterest.com"])'
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

    const { query, maxResults: rawMax, allowed_domains, blocked_domains } = parsed.data
    const maxResults = Math.min(rawMax ?? 5, 10)

    await enforceRateLimit()

    // 最多重试 1 次（共 2 次尝试），间隔 2 秒
    const MAX_ATTEMPTS = 2
    const RETRY_DELAY_MS = 2000

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // 调用 SearXNG JSON API（自建 NAS 服务）
        const params = new URLSearchParams({
          q: query,
          format: 'json',
          categories: 'general',
          language: 'zh-CN'
        })

        const response = await fetch(`${SEARXNG_BASE_URL}/search?${params}`, {
          signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
        })

        if (!response.ok) {
          // 5xx 服务端错误可重试
          if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
            continue
          }
          return {
            output: `Web search failed: ${response.status} ${response.statusText}`,
            isError: true
          }
        }

        const data = (await response.json()) as SearXNGResponse
        let results = data.results ?? []

        // 域名过滤
        if (allowed_domains && allowed_domains.length > 0) {
          results = results.filter((r) =>
            allowed_domains.some((d) => r.url.includes(d))
          )
        }
        if (blocked_domains && blocked_domains.length > 0) {
          results = results.filter((r) =>
            !blocked_domains.some((d) => r.url.includes(d))
          )
        }

        // 截断到最大结果数
        results = results.slice(0, maxResults)

        if (results.length === 0) {
          return {
            output: `No results found for "${query}".`,
            isError: false
          }
        }

        // 格式化为 Markdown 链接
        const formatted = results
          .map((r, i) => {
            const link = `[${r.title}](${r.url})`
            return r.content ? `${i + 1}. ${link}\n   ${r.content}` : `${i + 1}. ${link}`
          })
          .join('\n\n')

        return {
          output: formatted,
          isError: false
        }
      } catch (err: unknown) {
        // 网络错误（fetch failed / timeout）可重试
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
          continue
        }
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: `Web search failed: ${message}`,
          isError: true
        }
      }
    }

    // 不应到达此处
    return { output: 'Web search failed: unexpected state', isError: true }
  }
}
