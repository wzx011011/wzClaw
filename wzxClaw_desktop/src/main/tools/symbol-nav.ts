import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

// ============================================================
// IPC Query Helper
// ============================================================

type GetWebContents = () => Electron.WebContents | null

interface SymbolResult {
  filePath: string
  line: number
  symbolName: string
  kind: string
}

// Pending queries map shared across all symbol tools
const pendingQueries = new Map<string, { resolve: (result: unknown) => void; timer: NodeJS.Timeout }>()

let queryCounter = 0

function generateQueryId(): string {
  // Cap counter to prevent floating-point precision issues after MAX_SAFE_INTEGER
  if (queryCounter > Number.MAX_SAFE_INTEGER - 1000) {
    queryCounter = 0
  }
  return `sym-${Date.now()}-${++queryCounter}`
}

/**
 * Clean up all pending symbol queries (e.g., when webContents is destroyed).
 * Rejects all pending queries to prevent memory leaks from dangling references.
 */
export function cleanupPendingQueries(): void {
  for (const [queryId, pending] of pendingQueries) {
    clearTimeout(pending.timer)
    pending.resolve([]) // Resolve with empty results instead of rejecting
  }
  pendingQueries.clear()
}

/**
 * Send an IPC query to the renderer (Monaco) and wait for the response.
 * Returns the result or throws on timeout.
 */
async function queryRenderer(
  getWebContents: GetWebContents,
  operation: string,
  params: Record<string, unknown>,
  timeout = 10000
): Promise<SymbolResult[]> {
  const webContents = getWebContents()
  if (!webContents) {
    throw new Error('No web contents available (Monaco not ready)')
  }

  const queryId = generateQueryId()

  return new Promise<SymbolResult[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQueries.delete(queryId)
      reject(new Error(`Symbol query timed out after ${timeout}ms`))
    }, timeout)

    pendingQueries.set(queryId, {
      resolve: (result: unknown) => {
        clearTimeout(timer)
        pendingQueries.delete(queryId)
        resolve(result as SymbolResult[])
      },
      timer
    })

    webContents.send('symbol:query', { queryId, operation, params })
  })
}

/**
 * Called from ipc-handlers when the renderer sends back a symbol query result.
 */
export function handleSymbolResult(payload: { queryId: string; result: unknown; isError: boolean }): void {
  const pending = pendingQueries.get(payload.queryId)
  if (!pending) return

  if (payload.isError) {
    // Resolve with empty results on error
    pending.resolve([])
  } else {
    pending.resolve(payload.result)
  }
}

// ============================================================
// GoToDefinitionTool
// ============================================================

const GoToDefinitionInputSchema = z.object({
  symbolName: z.string().min(1),
  filePath: z.string().optional()
})

export class GoToDefinitionTool implements Tool {
  readonly name = 'GoToDefinition'
  readonly description =
    'Find the definition of a symbol. Returns file path, line number, and symbol information.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      symbolName: {
        type: 'string',
        description: 'Name of the symbol to find definition for'
      },
      filePath: {
        type: 'string',
        description: 'File path where the symbol is referenced (for context)'
      }
    },
    required: ['symbolName']
  }

  constructor(private readonly getWebContents: GetWebContents) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = GoToDefinitionInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { symbolName, filePath } = parsed.data

    try {
      const results = await queryRenderer(this.getWebContents, 'goto-definition', {
        symbolName,
        filePath: filePath ?? ''
      })

      if (results.length === 0) {
        return {
          output: `No definition found for "${symbolName}"`,
          isError: false
        }
      }

      const lines = results.map(
        (r) => `Definition: ${r.symbolName}\n  File: ${r.filePath}:${r.line}\n  Kind: ${r.kind}`
      )
      return { output: lines.join('\n\n'), isError: false }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `GoToDefinition failed: ${message}`, isError: true }
    }
  }
}

// ============================================================
// FindReferencesTool
// ============================================================

const FindReferencesInputSchema = z.object({
  symbolName: z.string().min(1),
  filePath: z.string().optional()
})

export class FindReferencesTool implements Tool {
  readonly name = 'FindReferences'
  readonly description =
    'Find all references to a symbol across the codebase. Returns a list of file locations.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      symbolName: {
        type: 'string',
        description: 'Name of the symbol'
      },
      filePath: {
        type: 'string',
        description: 'File path where the symbol appears (for context)'
      }
    },
    required: ['symbolName']
  }

  constructor(private readonly getWebContents: GetWebContents) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = FindReferencesInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { symbolName, filePath } = parsed.data

    try {
      const results = await queryRenderer(this.getWebContents, 'find-references', {
        symbolName,
        filePath: filePath ?? ''
      })

      if (results.length === 0) {
        return {
          output: `No references found for "${symbolName}"`,
          isError: false
        }
      }

      const header = `References for ${symbolName} (${results.length} found):`
      const refs = results.map((r) => `  ${r.filePath}:${r.line} (${r.kind})`)
      return { output: `${header}\n${refs.join('\n')}`, isError: false }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `FindReferences failed: ${message}`, isError: true }
    }
  }
}

// ============================================================
// SearchSymbolsTool
// ============================================================

const SearchSymbolsInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).optional()
})

export class SearchSymbolsTool implements Tool {
  readonly name = 'SearchSymbols'
  readonly description =
    'Search for symbols by name pattern. Returns matching symbols with their locations.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (partial match)'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results (default: 10)'
      }
    },
    required: ['query']
  }

  constructor(private readonly getWebContents: GetWebContents) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = SearchSymbolsInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { query, maxResults: rawMax } = parsed.data
    const maxResults = Math.min(rawMax ?? 10, 20)

    try {
      const results = await queryRenderer(this.getWebContents, 'search-symbols', {
        query,
        maxResults
      })

      if (results.length === 0) {
        return {
          output: `No symbols matching "${query}"`,
          isError: false
        }
      }

      const header = `Symbols matching '${query}' (${results.length} found):`
      const syms = results.map((r) => `  ${r.symbolName} (${r.kind}) at ${r.filePath}:${r.line}`)
      return { output: `${header}\n${syms.join('\n')}`, isError: false }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: `SearchSymbols failed: ${message}`, isError: true }
    }
  }
}
