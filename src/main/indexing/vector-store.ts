// ============================================================
// VectorStore - JSON file-based vector storage with cosine similarity
// ============================================================

import * as path from 'path'
import { createHash } from 'crypto'
import * as fsp from 'fs/promises'

/**
 * A single indexed entry in the vector store.
 */
export interface IndexEntry {
  id: string              // hash of filePath + startLine
  filePath: string        // relative to workspace root
  startLine: number
  endLine: number
  content: string         // chunk text
  language: string
  embedding: number[]     // vector or TF-IDF vector
  mtime: number           // file modification time for invalidation
  embeddingType: 'api' | 'tfidf'  // track which method produced the vector
}

/**
 * A search result returned from vector similarity search.
 */
export interface SearchResult {
  filePath: string
  startLine: number
  endLine: number
  content: string
  score: number           // cosine similarity 0-1
}

// ============================================================
// Binary Extensions to Exclude
// ============================================================

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.odt', '.ods', '.odp',
])

/** Maximum file size to index (100KB) */
export const MAX_INDEX_FILE_SIZE = 102400

// ============================================================
// Skip Directories (matches workspace-manager.ts SKIP_DIRS)
// ============================================================

export const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', '.next', '__pycache__', '.cache',
  '.git', '.svn', '.hg', 'build', '.turbo', '.nuxt', '.output',
  'coverage', '.nyc_output', '.parcel-cache', '.vercel',
])

// ============================================================
// Cosine Similarity
// ============================================================

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

// ============================================================
// VectorStore
// ============================================================

/**
 * JSON file-based vector storage with cosine similarity search.
 * Stores entries in .wzxclaw/index/vectors.jsonl (one JSON per line).
 */
export class VectorStore {
  private indexDir: string
  private vectorsPath: string
  private metaPath: string
  private cache: IndexEntry[] | null = null

  constructor(workspaceRoot: string) {
    this.indexDir = path.join(workspaceRoot, '.wzxclaw', 'index')
    this.vectorsPath = path.join(this.indexDir, 'vectors.jsonl')
    this.metaPath = path.join(this.indexDir, 'meta.json')
  }

  /**
   * Ensure the index directory exists (async, called before I/O operations).
   */
  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.indexDir, { recursive: true })
  }

  /**
   * Generate a unique ID for an entry based on file path and line.
   */
  private generateId(filePath: string, startLine: number): string {
    return createHash('sha256').update(`${filePath}:${startLine}`).digest('hex').slice(0, 16)
  }

  /**
   * Merge entries into storage. Appends new entries, rewrites file periodically.
   */
  async upsert(entries: IndexEntry[]): Promise<void> {
    // Load existing entries
    const existing = await this.loadAll()
    const existingMap = new Map<string, IndexEntry>()

    for (const entry of existing) {
      existingMap.set(entry.id, entry)
    }

    // Merge new entries
    for (const entry of entries) {
      existingMap.set(entry.id, entry)
    }

    // Write all entries
    const allEntries = Array.from(existingMap.values())
    await this.writeAll(allEntries)

    // Update cache with final state
    this.cache = allEntries
  }

  /**
   * Remove all entries for a given file.
   */
  async deleteByFile(filePath: string): Promise<void> {
    const existing = await this.loadAll()
    const filtered = existing.filter(e => e.filePath !== filePath)
    await this.writeAll(filtered)
    this.cache = filtered
  }

  /**
   * Search for entries most similar to the query embedding.
   * Returns top-K results sorted by cosine similarity score descending.
   */
  search(queryEmbedding: number[], topK: number = 10): SearchResult[] {
    const entries = this.cache
    if (!entries || entries.length === 0) return []

    const scored: SearchResult[] = []

    for (const entry of entries) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding)
      scored.push({
        filePath: entry.filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        content: entry.content,
        score,
      })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  /**
   * Get total number of indexed entries.
   */
  async getEntryCount(): Promise<number> {
    const entries = await this.loadAll()
    return entries.length
  }

  /**
   * Release the in-memory embedding cache without touching on-disk data.
   * Call this when switching workspaces to free memory.
   */
  releaseCache(): void {
    this.cache = null
  }

  /**
   * Clear entire index directory.
   */
  async clear(): Promise<void> {
    try {
      await fsp.rm(this.indexDir, { recursive: true, force: true })
      await this.ensureDir()
    } catch {
      // Ignore errors during cleanup
    }
    this.cache = null
  }

  /**
   * Load all entries from vectors.jsonl.
   */
  async loadAll(): Promise<IndexEntry[]> {
    if (this.cache) return this.cache

    try {
      await fsp.access(this.vectorsPath)
    } catch {
      this.cache = []
      return []
    }

    try {
      const content = await fsp.readFile(this.vectorsPath, 'utf-8')
      const lines = content.split('\n').filter(line => line.trim().length > 0)
      this.cache = lines.map(line => JSON.parse(line) as IndexEntry)
      return this.cache
    } catch {
      this.cache = []
      return []
    }
  }

  /**
   * Write all entries to vectors.jsonl and update meta.json.
   */
  private async writeAll(entries: IndexEntry[]): Promise<void> {
    await this.ensureDir()
    const lines = entries.map(e => JSON.stringify(e))
    await fsp.writeFile(this.vectorsPath, lines.join('\n') + '\n', 'utf-8')

    // Update meta.json
    const meta = {
      version: 1,
      created: Date.now(),
      fileCount: new Set(entries.map(e => e.filePath)).size,
    }
    await fsp.writeFile(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8')
  }
}
