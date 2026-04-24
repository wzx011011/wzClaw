// ============================================================
// SemanticSearchTool - Semantic/embedding-based code search
// ============================================================

import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { IndexingEngine } from '../indexing/indexing-engine'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const SemanticSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural language query describing the code you are looking for'),
  topK: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .default(10)
    .describe('Maximum number of results to return')
})

// ============================================================
// SemanticSearchTool Implementation
// ============================================================

export class SemanticSearchTool implements Tool {
  readonly name = 'SemanticSearch'
  readonly description =
    'Search the codebase using semantic/embedding-based search. Finds relevant code chunks even when the query uses different terminology than the code. Best for finding functions, classes, or patterns by purpose/behavior rather than exact name. Falls back to keyword matching when no embedding index is available.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural language query describing the code you are looking for (e.g., "function that handles user authentication", "error retry logic")'
      },
      topK: {
        type: 'number',
        description: 'Maximum number of results to return (1-20, default 10)'
      }
    },
    required: ['query']
  }

  private indexingEngine: IndexingEngine | null = null

  /**
   * Set the IndexingEngine reference. Called after workspace is opened
   * and IndexingEngine is created.
   */
  setIndexingEngine(engine: IndexingEngine): void {
    this.indexingEngine = engine
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    // Validate input
    const parsed = SemanticSearchInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || 'input'} ${i.message}`)
          .join(', ')}`,
        isError: true
      }
    }

    // Check if IndexingEngine is available
    if (!this.indexingEngine) {
      return {
        output:
          'Semantic search is not available. Please open a workspace folder first to enable codebase indexing.',
        isError: true
      }
    }

    const { query, topK } = parsed.data

    try {
      const results = await this.indexingEngine.search(query, topK)

      if (results.length === 0) {
        return {
          output: `No results found for: "${query}"\n\nTip: Try a more specific query or use the Grep tool for exact text search.`,
          isError: false
        }
      }

      // Format results
      const lines: string[] = []
      lines.push(`Found ${results.length} result${results.length !== 1 ? 's' : ''} for: "${query}"`)
      lines.push('')

      for (const result of results) {
        lines.push(
          `${result.filePath}:${result.startLine}-${result.endLine} (score: ${result.score.toFixed(3)})`
        )
        lines.push(result.content)
        lines.push('')
      }

      let output = lines.join('\n')

      // Truncate at MAX_TOOL_RESULT_CHARS
      if (output.length > MAX_TOOL_RESULT_CHARS) {
        output =
          output.substring(0, MAX_TOOL_RESULT_CHARS) +
          '\n\n[Output truncated. Use a more specific query to narrow results.]'
      }

      return { output, isError: false }
    } catch (err: any) {
      return {
        output: `Semantic search failed: ${err.message || String(err)}`,
        isError: true
      }
    }
  }
}
