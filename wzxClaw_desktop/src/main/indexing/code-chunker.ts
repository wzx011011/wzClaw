// ============================================================
// CodeChunker - Splits source files at code boundaries
// ============================================================

/**
 * A chunk of source code extracted from a file.
 */
export interface CodeChunk {
  filePath: string        // relative to workspace root
  startLine: number       // 1-based
  endLine: number         // 1-based
  content: string         // raw text of the chunk
  language: string        // Monaco language ID
  tokenEstimate: number   // rough token count (chars / 4)
}

// Regex patterns for code boundaries (order matters -- more specific first)
const BOUNDARY_PATTERNS = [
  // function declarations (including async, export, default)
  /^(export\s+)?(default\s+)?(async\s+)?function\s+/m,
  // class declarations (including export, default)
  /^(export\s+)?(default\s+)?class\s+/m,
  // interface declarations
  /^(export\s+)?interface\s+/m,
  // type alias declarations
  /^(export\s+)?type\s+\w+\s*=/m,
  // export const/function/class
  /^(export\s+)(const|let|var)\s+/m,
  // Python def
  /^(async\s+)?def\s+/m,
  // Python class
  /^class\s+/m,
]

/** Minimum chunk size in characters -- skip tiny fragments */
const MIN_CHUNK_SIZE = 20
/** Maximum estimated tokens per chunk */
const MAX_TOKENS = 512

export class CodeChunker {
  /**
   * Split a source file into chunks at code boundaries.
   * Falls back to blank-line splitting if no boundaries are found.
   */
  chunkFile(filePath: string, content: string, language: string): CodeChunk[] {
    const lines = content.split('\n')
    const rawChunks = this.splitAtBoundaries(lines)

    // If no boundary-based chunks found (or all too small), fall back to blank-line splitting
    if (rawChunks.length === 0 || (rawChunks.length === 1 && rawChunks[0].startLine === 1 && rawChunks[0].endLine === lines.length)) {
      const fallbackChunks = this.splitAtBlankLines(lines, filePath, language)
      if (fallbackChunks.length > 0) {
        return this.enforceMaxTokens(fallbackChunks)
      }
    }

    // Filter out tiny chunks and build final results
    const filtered = rawChunks
      .filter(c => c.content.trim().length >= MIN_CHUNK_SIZE)
      .map(c => ({
        ...c,
        filePath,
        language,
        tokenEstimate: Math.ceil(c.content.length / 4),
      }))

    return this.enforceMaxTokens(filtered)
  }

  /**
   * Split lines at code boundary patterns.
   */
  private splitAtBoundaries(lines: string[]): Array<{ startLine: number; endLine: number; content: string }> {
    const chunks: Array<{ startLine: number; endLine: number; content: string }> = []
    let currentStart = 0
    let boundaryFound = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let isBoundary = false

      for (const pattern of BOUNDARY_PATTERNS) {
        if (pattern.test(line)) {
          isBoundary = true
          break
        }
      }

      if (isBoundary && i > currentStart) {
        const content = lines.slice(currentStart, i).join('\n')
        chunks.push({ startLine: currentStart + 1, endLine: i, content })
        currentStart = i
        boundaryFound = true
      }
    }

    // Add remaining content
    if (currentStart < lines.length) {
      const content = lines.slice(currentStart).join('\n')
      chunks.push({ startLine: currentStart + 1, endLine: lines.length, content })
    }

    // If only one chunk and no boundaries were found, return empty to trigger fallback
    if (!boundaryFound) {
      return []
    }

    return chunks
  }

  /**
   * Split at groups of 2+ consecutive blank lines.
   */
  private splitAtBlankLines(lines: string[], filePath: string, language: string): CodeChunk[] {
    const chunks: CodeChunk[] = []
    let currentStart = 0
    let blankCount = 0

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        blankCount++
      } else {
        if (blankCount >= 2 && i - blankCount > currentStart) {
          const content = lines.slice(currentStart, i - blankCount).join('\n')
          chunks.push({
            filePath,
            startLine: currentStart + 1,
            endLine: i - blankCount,
            content,
            language,
            tokenEstimate: Math.ceil(content.length / 4),
          })
          currentStart = i - blankCount + 1
        }
        blankCount = 0
      }
    }

    // Add remaining content
    if (currentStart < lines.length) {
      const content = lines.slice(currentStart).join('\n')
      chunks.push({
        filePath,
        startLine: currentStart + 1,
        endLine: lines.length,
        content,
        language,
        tokenEstimate: Math.ceil(content.length / 4),
      })
    }

    return chunks
  }

  /**
   * Enforce maximum token limit by splitting chunks further at blank lines.
   */
  private enforceMaxTokens(chunks: CodeChunk[]): CodeChunk[] {
    const result: CodeChunk[] = []

    for (const chunk of chunks) {
      if (chunk.tokenEstimate <= MAX_TOKENS) {
        result.push(chunk)
        continue
      }

      // Split at blank lines within the chunk
      const lines = chunk.content.split('\n')
      const subChunks: CodeChunk[] = []
      let subStart = 0
      let subBlankCount = 0

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') {
          subBlankCount++
        } else {
          if (subBlankCount >= 1 && i - subBlankCount > subStart) {
            const subContent = lines.slice(subStart, i - subBlankCount).join('\n')
            subChunks.push({
              filePath: chunk.filePath,
              startLine: chunk.startLine + subStart,
              endLine: chunk.startLine + (i - subBlankCount) - 1,
              content: subContent,
              language: chunk.language,
              tokenEstimate: Math.ceil(subContent.length / 4),
            })
            subStart = i - subBlankCount + 1
          }
          subBlankCount = 0
        }
      }

      // Add remaining
      if (subStart < lines.length) {
        const subContent = lines.slice(subStart).join('\n')
        subChunks.push({
          filePath: chunk.filePath,
          startLine: chunk.startLine + subStart,
          endLine: chunk.startLine + lines.length - 1,
          content: subContent,
          language: chunk.language,
          tokenEstimate: Math.ceil(subContent.length / 4),
        })
      }

      // If still over limit, hard-split at line boundaries
      for (const sub of subChunks) {
        if (sub.tokenEstimate <= MAX_TOKENS || sub.content.trim().length < MIN_CHUNK_SIZE) {
          if (sub.content.trim().length >= MIN_CHUNK_SIZE) {
            result.push(sub)
          }
          continue
        }

        // Hard split: divide by lines until we fit under MAX_TOKENS
        const subLines = sub.content.split('\n')
        const targetChars = MAX_TOKENS * 4 // max chars target per piece
        let pos = 0
        let accLen = 0
        let pieceStart = 0

        while (pos < subLines.length) {
          accLen += subLines[pos].length + 1 // +1 for newline
          if (accLen >= targetChars && pos > pieceStart) {
            const piece = subLines.slice(pieceStart, pos).join('\n')
            if (piece.trim().length >= MIN_CHUNK_SIZE) {
              result.push({
                filePath: chunk.filePath,
                startLine: sub.startLine + pieceStart,
                endLine: sub.startLine + pos - 1,
                content: piece,
                language: chunk.language,
                tokenEstimate: Math.ceil(piece.length / 4),
              })
            }
            pieceStart = pos
            accLen = subLines[pos].length + 1
          }
          pos++
        }

        // Add remaining
        if (pieceStart < subLines.length) {
          const piece = subLines.slice(pieceStart).join('\n')
          if (piece.trim().length >= MIN_CHUNK_SIZE) {
            result.push({
              filePath: chunk.filePath,
              startLine: sub.startLine + pieceStart,
              endLine: sub.startLine + subLines.length - 1,
              content: piece,
              language: chunk.language,
              tokenEstimate: Math.ceil(piece.length / 4),
            })
          }
        }
      }
    }

    return result
  }
}
