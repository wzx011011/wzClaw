import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { WEB_SEARCH_TIMEOUT_MS } from '../../shared/constants'
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
// Helper: 从 HTML 中提取搜索结果
// ============================================================

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** 去除 HTML 标签 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** 从 DuckDuckGo HTML 搜索页解析结果 */
function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // DuckDuckGo HTML lite 使用 <div class="result results_links ..."> 包裹每个结果
  const resultBlocks = html.split(/<div\s+class="result\s+results_links/gi)

  for (const block of resultBlocks.slice(1)) {
    try {
      // 标题: <a class="result__a" href="...">Title</a>
      const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i)
      // 摘要: <a class="result__snippet">...</a> 或 <td class="result__snippet">
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>/i)
      // URL: href 里通过 uddg 参数编码了真实 URL
      const hrefMatch = block.match(/uddg=([^&"']+)/i)

      if (titleMatch) {
        const url = hrefMatch ? decodeURIComponent(hrefMatch[1]) : ''
        const title = stripHtmlTags(titleMatch[1])
        const snippet = snippetMatch ? stripHtmlTags(snippetMatch[1]) : ''

        if (title && url) {
          results.push({ title, url, snippet })
        }
      }
    } catch {
      // 解析失败跳过此结果
    }
  }

  return results
}

// ============================================================
// WebSearchTool Implementation
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

    try {
      // 使用 DuckDuckGo HTML 搜索页（返回真正的搜索结果）
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const response = await fetch(searchUrl, {
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
        }
      })

      if (!response.ok) {
        return {
          output: `Web search failed: ${response.status} ${response.statusText}`,
          isError: true
        }
      }

      const html = await response.text()
      let results = parseDuckDuckGoHtml(html)

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
          return r.snippet ? `${i + 1}. ${link}\n   ${r.snippet}` : `${i + 1}. ${link}`
        })
        .join('\n\n')

      return {
        output: formatted,
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
