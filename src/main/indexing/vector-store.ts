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
  embedding: Float32Array | number[]  // Float32Array in memory, number[] on disk
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

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
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

/** Maximum number of entries to keep in RAM. Prevents unbounded memory growth. */
const MAX_CACHE_ENTRIES = 5000

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
   * Read all entries directly from disk, bypassing the cache.
   * Used by upsert and deleteByFile to guarantee correct merge with the full dataset.
   */
  private async loadFromDisk(): Promise<IndexEntry[]> {
    try {
      await fsp.access(this.vectorsPath)
    } catch {
      return []
    }

    try {
      const content = await fsp.readFile(this.vectorsPath, 'utf-8')
      const lines = content.split('\n').filter(line => line.trim().length > 0)
      return lines.map(line => JSON.parse(line) as IndexEntry)
    } catch {
      return []
    }
  }

  /**
   * Convert number[] embeddings to Float32Array in-place for a list of entries.
   * Float32Array uses 4 bytes/element vs 8 bytes for JS number[], cutting vector RAM by ~half.
   */
  private static applyFloat32(entries: IndexEntry[]): void {
    for (const entry of entries) {
      if (Array.isArray(entry.embedding)) {
        entry.embedding = new Float32Array(entry.embedding as number[])
      }
    }
  }

  /**
   * Apply the cache cap: keep only the most-recently-modified MAX_CACHE_ENTRIES entries.
   */
  private static applyCapAndFloat32(entries: IndexEntry[]): IndexEntry[] {
    let capped: IndexEntry[]
    if (entries.length > MAX_CACHE_ENTRIES) {
      capped = entries.slice().sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CACHE_ENTRIES)
    } else {
      capped = entries
    }
    VectorStore.applyFloat32(capped)
    return capped
  }

  /**
   * Merge entries into storage. Always reads from disk for a correct merge,
   * then writes the full merged set. Updates cache with a capped view.
   */
  async upsert(entries: IndexEntry[]): Promise<void> {
    // Read from disk (not cache) so the merge is always complete
    const existing = await this.loadFromDisk()
    const existingMap = new Map<string, IndexEntry>()

    for (const entry of existing) {
      existingMap.set(entry.id, entry)
    }

    // Merge new entries
    for (const entry of entries) {
      existingMap.set(entry.id, entry)
    }

    // Write all merged entries to disk
    const merged = Array.from(existingMap.values())
    await this.writeAll(merged)

    // Update in-memory cache with cap applied
    this.cache = VectorStore.applyCapAndFloat32(merged)
  }

  /**
   * Remove all entries for a given file.
   */
  async deleteByFile(filePath: string): Promise<void> {
    const existing = await this.loadFromDisk()
    const filtered = existing.filter(e => e.filePath !== filePath)
    await this.writeAll(filtered)
    this.cache = VectorStore.applyCapAndFloat32(filtered)
  }

  /**
   * Search for entries most similar to the query embedding.
   * Returns top-K results sorted by cosine similarity score descending.
   * Async: yields to the event loop every 500 entries to avoid blocking the main thread.
   */
  async search(queryEmbedding: Float32Array | number[], topK: number = 10): Promise<SearchResult[]> {
    const entries = this.cache
    if (!entries || entries.length === 0) return []

    const scored: Array<{ score: number; entry: IndexEntry }> = []
    const BATCH = 500

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH)
      for (const entry of batch) {
        scored.push({ score: cosineSimilarity(queryEmbedding, entry.embedding), entry })
      }
      if (i + BATCH < entries.length) {
        await new Promise(r => setImmediate(r))  // yield to event loop between batches
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map(x => ({
      filePath: x.entry.filePath,
      startLine: x.entry.startLine,
      endLine: x.entry.endLine,
      content: x.entry.content,
      score: x.score,
    }))
  }

  /**
   * Get total number of indexed entries (reads from disk for accuracy).
   */
  async getEntryCount(): Promise<number> {
    const entries = await this.loadFromDisk()
    return entries.length
  }

  /**
   * Strip embedding arrays from cached entries to free RAM while keeping metadata.
   * Call this after a search session when embeddings are no longer needed in memory.
   * Subsequent searches will return empty results until the cache is refreshed via loadAll().
   */
  releaseEmbeddings(): void {
    if (!this.cache) return
    for (const entry of this.cache) {
      entry.embedding = new Float32Array(0)
    }
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
   * Load all entries from vectors.jsonl into the search cache.
   * Caps the in-memory cache at MAX_CACHE_ENTRIES (most-recently-modified entries).
   * For write operations that need the complete dataset, use loadFromDisk() directly.
   */
  async loadAll(): Promise<IndexEntry[]> {
    if (this.cache) return this.cache

    const allEntries = await this.loadFromDisk()
    this.cache = VectorStore.applyCapAndFloat32(allEntries)
    return this.cache
  }

  /**
   * Write all entries to vectors.jsonl and update meta.json.
   * Serializes Float32Array embeddings as plain number[] for JSON compatibility.
   */
  private async writeAll(entries: IndexEntry[]): Promise<void> {
    await this.ensureDir()
    const lines = entries.map(e => JSON.stringify({
      ...e,
      embedding: Array.from(e.embedding),
    }))
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
