import { z } from 'zod'
import TurndownService from 'turndown'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { WEB_CONTENT_MAX_CHARS, WEB_FETCH_TIMEOUT_MS, WEB_FETCH_CACHE_TTL_MS, WEB_FETCH_CACHE_MAX_ENTRIES } from '../../shared/constants'
import { enforceRateLimit } from './rate-limiter'

// ============================================================
// turndown 实例（HTML → Markdown）
// ============================================================

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
})

// ============================================================
// 内存缓存
// ============================================================

interface CacheEntry {
  content: string
  timestamp: number
}

const cache = new Map<string, CacheEntry>()

function getCached(url: string): string | null {
  const entry = cache.get(url)
  if (!entry) return null
  if (Date.now() - entry.timestamp > WEB_FETCH_CACHE_TTL_MS) {
    cache.delete(url)
    return null
  }
  return entry.content
}

function setCache(url: string, content: string): void {
  cache.set(url, { content, timestamp: Date.now() })
  // 淘汰最旧的条目
  if (cache.size > WEB_FETCH_CACHE_MAX_ENTRIES) {
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    if (oldest) cache.delete(oldest[0])
  }
}

// ============================================================
// Binary content-type 检测
// ============================================================

const BINARY_CONTENT_TYPES = [
  'image/', 'video/', 'audio/', 'application/octet-stream',
  'application/pdf', 'application/zip', 'application/gzip',
  'application/x-tar', 'application/x-rar'
]

function isBinaryContentType(contentType: string): boolean {
  return BINARY_CONTENT_TYPES.some((t) => contentType.includes(t))
}

// ============================================================
// Input Schema
// ============================================================

const WebFetchInputSchema = z.object({
  url: z.string().min(1),
  maxLength: z.number().int().min(1000).optional(),
  prompt: z.string().optional()
})

// ============================================================
// WebFetchTool Implementation
// ============================================================

export class WebFetchTool implements Tool {
  readonly name = 'WebFetch'
  readonly description = [
    'Fetch a web page and convert its content to Markdown format.',
    'Returns structured content with headings, lists, code blocks, and links preserved.',
    'Use the `prompt` parameter to specify what information to extract from the page.',
    'Results are cached for 15 minutes for faster repeated access.'
  ].join(' ')
  readonly requiresApproval = false
  readonly isReadOnly = true
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
      },
      prompt: {
        type: 'string',
        description: 'What to extract or focus on from the page content'
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

    const { url, maxLength: rawMax, prompt } = parsed.data
    const maxLength = rawMax ?? WEB_CONTENT_MAX_CHARS

    // 验证 URL 格式
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        output: 'Invalid URL: must start with http:// or https://',
        isError: true
      }
    }

    // 检查缓存
    const cached = getCached(url)
    if (cached) {
      const header = `Source: ${url} (cached)\n`
      const focusHeader = prompt ? `Focus: ${prompt}\n\n` : '\n'
      return { output: header + focusHeader + cached, isError: false }
    }

    await enforceRateLimit()

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
        }
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        return {
          output: `Web fetch failed: ${response.status} ${response.statusText}. Response: ${body.slice(0, 500)}`,
          isError: true
        }
      }

      // 检查 content-type
      const contentType = response.headers.get('content-type') ?? ''
      if (isBinaryContentType(contentType)) {
        return {
          output: `Cannot fetch binary content (content-type: ${contentType}). Use a different tool for binary files.`,
          isError: true
        }
      }

      const html = await response.text()

      // HTML → Markdown
      const markdown = turndown.turndown(html)
      const originalLength = markdown.length

      // 截断
      const truncated =
        markdown.length > maxLength
          ? markdown.substring(0, maxLength) + `\n... [content truncated, ${originalLength} chars total]`
          : markdown

      // 存入缓存
      setCache(url, truncated)

      // 格式化输出
      const header = `Source: ${url}\n`
      const focusHeader = prompt ? `Focus: ${prompt}\n\n` : '\n'
      const formatted = header + focusHeader + truncated

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
