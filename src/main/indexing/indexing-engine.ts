// ============================================================
// IndexingEngine - Orchestrates full/incremental indexing
// ============================================================

import * as path from 'path'
import { createHash as cryptoCreateHash } from 'node:crypto'
import * as fsp from 'fs/promises'
import { CodeChunker } from './code-chunker'
import { VectorStore, BINARY_EXTENSIONS, MAX_INDEX_FILE_SIZE, SKIP_DIRS, type IndexEntry } from './vector-store'
import { EmbeddingClient } from './embedding-client'
import { getLanguageFromPath } from '../workspace/workspace-manager'

// ============================================================
// Interfaces
// ============================================================

export type IndexingStatus = 'idle' | 'indexing' | 'ready' | 'error'

export interface IndexingProgress {
  status: IndexingStatus
  fileCount: number       // total files indexed
  currentFile: string     // file currently being indexed (empty if idle/ready/error)
  error?: string
}

type ProgressCallback = (progress: IndexingProgress) => void

// ============================================================
// IndexingEngine
// ============================================================

export class IndexingEngine {
  private workspaceRoot: string
  private chunker: CodeChunker
  private vectorStore: VectorStore
  private embeddingClient: EmbeddingClient
  private progress: IndexingProgress
  private progressCallbacks: ProgressCallback[]
  private disposed = false
  private vocabPath: string

  constructor(workspaceRoot: string, embeddingClient: EmbeddingClient) {
    this.workspaceRoot = workspaceRoot
    this.chunker = new CodeChunker()
    this.vectorStore = new VectorStore(workspaceRoot)
    this.embeddingClient = embeddingClient
    this.vocabPath = path.join(workspaceRoot, '.wzxclaw', 'index', 'tfidf-vocab.json')
    this.embeddingClient.setVocabPath(this.vocabPath)
    this.progress = { status: 'idle', fileCount: 0, currentFile: '' }
    this.progressCallbacks = []
  }

  /**
   * Index the entire workspace. Walks directory, chunks files, embeds, stores.
   * Skips unchanged files based on mtime comparison (incremental).
   */
  async indexFull(): Promise<void> {
    if (this.disposed) return

    this.updateProgress({ status: 'indexing', fileCount: 0, currentFile: '' })

    try {
      const files = await this.walkWorkspace()
      let indexedCount = 0

      // Get existing entries' mtimes for incremental check
      const existingEntries = await this.vectorStore.loadAll()
      const fileMtimes = new Map<string, number>()
      for (const entry of existingEntries) {
        const existing = fileMtimes.get(entry.filePath)
        if (!existing || entry.mtime > existing) {
          fileMtimes.set(entry.filePath, entry.mtime)
        }
      }

      // Collect all chunks first, then batch embed
      const allChunks: Array<{ filePath: string; startLine: number; endLine: number; content: string; language: string; mtime: number }> = []
      const filesToIndex: string[] = []

      for (const filePath of files) {
        if (this.disposed) return

        const absolutePath = path.join(this.workspaceRoot, filePath)
        let stat: fsp.Stats
        try {
          stat = await fsp.stat(absolutePath)
        } catch {
          continue
        }

        // Skip files >100KB
        if (stat.size > MAX_INDEX_FILE_SIZE) continue

        // Skip binary files
        const ext = path.extname(absolutePath).toLowerCase()
        if (BINARY_EXTENSIONS.has(ext)) continue

        // Incremental: skip if mtime unchanged
        const storedMtime = fileMtimes.get(filePath)
        if (storedMtime && storedMtime >= stat.mtimeMs) {
          indexedCount++
          continue
        }

        this.updateProgress({ ...this.progress, currentFile: filePath })

        try {
          const content = await fsp.readFile(absolutePath, 'utf-8')
          const language = getLanguageFromPath(absolutePath)
          const chunks = this.chunker.chunkFile(filePath, content, language)

          for (const chunk of chunks) {
            allChunks.push({
              filePath: chunk.filePath,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              language: chunk.language,
              mtime: stat.mtimeMs,
            })
          }

          filesToIndex.push(filePath)
        } catch {
          // Skip files we can't read
          continue
        }
      }

      // Batch embed chunks
      if (allChunks.length > 0) {
        // Process in batches of 50
        const BATCH = 50
        for (let i = 0; i < allChunks.length; i += BATCH) {
          if (this.disposed) return

          const batch = allChunks.slice(i, i + BATCH)
          const texts = batch.map(c => c.content)
          const embeddings = await this.embeddingClient.embedBatch(texts)

          // Delete old entries for files being re-indexed
          const batchFiles = new Set(batch.map(c => c.filePath))
          for (const f of batchFiles) {
            await this.vectorStore.deleteByFile(f)
          }

          // Create IndexEntries
          const entries: IndexEntry[] = batch.map((chunk, j) => {
            const emb = embeddings[j]
            const id = `${chunk.filePath}:${chunk.startLine}`
            return {
              id: hashId(id),
              filePath: chunk.filePath,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              language: chunk.language,
              embedding: emb.embedding,
              mtime: chunk.mtime,
              embeddingType: emb.type,
            }
          })

          await this.vectorStore.upsert(entries)
          indexedCount += filesToIndex.length
        }
      }

      // Count total entries including existing ones
      const totalCount = await this.vectorStore.getEntryCount()
      this.updateProgress({ status: 'ready', fileCount: totalCount, currentFile: '' })
    } catch (err) {
      const message = (err as Error).message || String(err)
      this.updateProgress({ status: 'error', fileCount: this.progress.fileCount, currentFile: '', error: message })
    }
  }

  /**
   * Index a single file (for incremental updates on file change).
   */
  async indexFile(filePath: string): Promise<void> {
    if (this.disposed) return

    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath)
    const relativePath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/')

    // Check file size and extension
    let stat: fsp.Stats
    try {
      stat = await fsp.stat(absolutePath)
    } catch {
      return
    }
    if (stat.size > MAX_INDEX_FILE_SIZE) return

    const ext = path.extname(absolutePath).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) return

    try {
      const content = await fsp.readFile(absolutePath, 'utf-8')
      const language = getLanguageFromPath(absolutePath)
      const chunks = this.chunker.chunkFile(relativePath, content, language)

      if (chunks.length === 0) return

      const texts = chunks.map(c => c.content)
      const embeddings = await this.embeddingClient.embedBatch(texts)

      // Delete old entries for this file
      await this.vectorStore.deleteByFile(relativePath)

      // Create new entries
      const entries: IndexEntry[] = chunks.map((chunk, j) => {
        const emb = embeddings[j]
        const id = `${relativePath}:${chunk.startLine}`
        return {
          id: hashId(id),
          filePath: relativePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          language: chunk.language,
          embedding: emb.embedding,
          mtime: stat.mtimeMs,
          embeddingType: emb.type,
        }
      })

      await this.vectorStore.upsert(entries)
    } catch {
      // Skip files we can't process
    }
  }

  /**
   * Remove entries for a deleted file.
   */
  async removeFile(filePath: string): Promise<void> {
    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/')
      : filePath
    await this.vectorStore.deleteByFile(relativePath)
  }

  /**
   * Search the index for a query string.
   */
  async search(query: string, topK: number = 10): Promise<Array<{
    filePath: string
    startLine: number
    endLine: number
    content: string
    score: number
  }>> {
    if (this.disposed) return []

    const queryEmbedding = await this.embeddingClient.embed(query)
    return this.vectorStore.search(queryEmbedding.embedding, topK)
  }

  /**
   * Get current indexing status.
   */
  getStatus(): IndexingProgress {
    return { ...this.progress }
  }

  /**
   * Subscribe to progress changes. Returns unsubscribe function.
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.push(callback)
    // Immediately notify with current state
    callback({ ...this.progress })
    return () => {
      const idx = this.progressCallbacks.indexOf(callback)
      if (idx >= 0) {
        this.progressCallbacks.splice(idx, 1)
      }
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.disposed = true
    this.progressCallbacks = []
    this.vectorStore.releaseCache()
  }

  // ============================================================
  // Private
  // ============================================================

  private updateProgress(update: Partial<IndexingProgress>): void {
    this.progress = { ...this.progress, ...update }
    for (const cb of this.progressCallbacks) {
      try {
        cb({ ...this.progress })
      } catch {
        // Swallow callback errors
      }
    }
  }

  /**
   * Walk workspace directory and return relative file paths.
   * Skips SKIP_DIRS and hidden directories.
   */
  private async walkWorkspace(): Promise<string[]> {
    const files: string[] = []

    const walk = async (dir: string, relativeDir: string): Promise<void> => {
      let entries: fsp.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        // Skip hidden files/directories (including .wzxclaw index data)
        if (entry.name.startsWith('.')) continue
        // Skip known directories
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue

        const fullPath = path.join(dir, entry.name)
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name

        if (entry.isDirectory()) {
          await walk(fullPath, relativePath)
        } else if (entry.isFile()) {
          files.push(relativePath.replace(/\\/g, '/'))
        }
      }
    }

    await walk(this.workspaceRoot, '')
    return files
  }
}

// ============================================================
// Helpers
// ============================================================

function hashId(input: string): string {
  return cryptoCreateHash('sha256').update(input).digest('hex').slice(0, 16)
}
