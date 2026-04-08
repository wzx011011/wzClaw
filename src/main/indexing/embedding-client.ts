// ============================================================
// EmbeddingClient - Embedding API with TF-IDF fallback
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// Interfaces
// ============================================================

export interface EmbeddingResult {
  embedding: number[]
  type: 'api' | 'tfidf'
}

export interface EmbeddingClientConfig {
  apiKey?: string
  baseURL?: string        // embedding API base URL (e.g., https://api.openai.com/v1)
  model?: string          // embedding model name (e.g., text-embedding-3-small)
}

// ============================================================
// TF-IDF Stop Words
// ============================================================

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with',
  'from', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'its', 'just', 'me',
  'my', 'now', 'our', 'out', 'own', 'say', 'she', 'so', 'than', 'them', 'too',
  'us', 'very', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'you',
  'your', 'about', 'after', 'all', 'also', 'any', 'because', 'been', 'before',
  'between', 'both', 'can', 'could', 'did', 'do', 'does', 'done', 'down',
  'during', 'each', 'else', 'even', 'every', 'first', 'get', 'got', 'had',
  'here', 'him', 'himself', 'herself', 'how', 'if', 'into', 'may', 'more',
  'most', 'must', 'new', 'no', 'nor', 'only', 'other', 'others', 'over',
  're', 'same', 'should', 'some', 'still', 'such', 'take', 'through', 'under',
  'up', 'while', 'would', 'yet', 'yours', 'return', 'function', 'class',
  'interface', 'type', 'const', 'let', 'var', 'export', 'import', 'default',
  'async', 'await', 'new', 'this', 'void', 'null', 'undefined', 'true', 'false',
  'public', 'private', 'protected', 'static', 'extends', 'implements',
])

// ============================================================
// TF-IDF Vocabulary
// ============================================================

interface TfidfVocab {
  terms: Record<string, number>  // term -> index
  idf: Record<string, number>    // term -> IDF value
  docCount: number               // number of documents used to build vocab
  size: number                   // vocabulary size
}

// ============================================================
// EmbeddingClient
// ============================================================

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const RATE_LIMIT_DELAY_MS = 100
const BATCH_SIZE = 50
const API_TIMEOUT_MS = 10000

export class EmbeddingClient {
  private apiKey: string | undefined
  private baseURL: string | undefined
  private model: string

  // TF-IDF state
  private vocab: TfidfVocab | null = null
  private vocabPath: string | null = null
  private lastRequestTime = 0

  constructor(config: EmbeddingClientConfig) {
    this.apiKey = config.apiKey
    this.baseURL = config.baseURL
    this.model = config.model ?? DEFAULT_EMBEDDING_MODEL
  }

  /**
   * Returns true if an API key and base URL are configured.
   */
  isAvailable(): boolean {
    return !!(this.apiKey && this.baseURL)
  }

  /**
   * Set the vocabulary path for TF-IDF persistence.
   */
  setVocabPath(vocabPath: string): void {
    this.vocabPath = vocabPath
    this.loadVocab()
  }

  /**
   * Embed a single text string.
   * Uses API if available, falls back to TF-IDF.
   */
  async embed(text: string): Promise<EmbeddingResult> {
    if (this.isAvailable()) {
      try {
        return await this.embedViaAPI([text])
      } catch (err) {
        // Fall back to TF-IDF on API error
        console.warn('[EmbeddingClient] API call failed, falling back to TF-IDF:', (err as Error).message)
      }
    }

    return this.embedViaTfIdf(text)
  }

  /**
   * Embed multiple texts in a batch.
   * Uses API batch endpoint if available, falls back to TF-IDF.
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (this.isAvailable()) {
      try {
        const results: EmbeddingResult[] = []
        // Process in batches of BATCH_SIZE
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          const batch = texts.slice(i, i + BATCH_SIZE)
          const batchResults = await this.embedViaAPI(batch)
          results.push(...batchResults)

          // Rate limit between batches
          if (i + BATCH_SIZE < texts.length) {
            await this.rateLimitDelay()
          }
        }
        return results
      } catch (err) {
        console.warn('[EmbeddingClient] API batch call failed, falling back to TF-IDF:', (err as Error).message)
      }
    }

    // Update vocabulary with all texts before embedding
    this.updateVocab(texts)
    return texts.map(text => this.embedViaTfIdf(text))
  }

  /**
   * Get the dimensionality of the current embedding method.
   */
  getDimension(): number {
    if (this.isAvailable()) {
      // text-embedding-3-small is 1536 dimensions
      return 1536
    }
    return this.vocab ? this.vocab.size : 0
  }

  // ============================================================
  // API Embedding
  // ============================================================

  private async embedViaAPI(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.apiKey || !this.baseURL) {
      throw new Error('API key or base URL not configured')
    }

    await this.rateLimitDelay()

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error')
        throw new Error(`Embedding API error ${response.status}: ${errorBody}`)
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>
      }

      // Sort by index to ensure correct ordering
      const sorted = data.data.sort((a, b) => a.index - b.index)

      return sorted.map(item => ({
        embedding: item.embedding,
        type: 'api' as const,
      }))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async rateLimitDelay(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastRequestTime
    if (elapsed < RATE_LIMIT_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS - elapsed))
    }
    this.lastRequestTime = Date.now()
  }

  // ============================================================
  // TF-IDF Fallback
  // ============================================================

  /**
   * Tokenize text: lowercase, split on non-alphanumeric, remove stop words.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 1 && !STOP_WORDS.has(term))
  }

  /**
   * Update the TF-IDF vocabulary with new documents.
   */
  private updateVocab(texts: string[]): void {
    if (!this.vocab) {
      this.vocab = {
        terms: {},
        idf: {},
        docCount: 0,
        size: 0,
      }
    }

    const newDocCount = texts.length
    const termDocCount: Record<string, number> = {}

    // Count term document frequency across new texts
    for (const text of texts) {
      const terms = new Set(this.tokenize(text))
      for (const term of terms) {
        termDocCount[term] = (termDocCount[term] || 0) + 1
        if (!(term in this.vocab.terms)) {
          this.vocab.terms[term] = this.vocab.size
          this.vocab.size++
        }
      }
    }

    // Update IDF values
    const totalDocs = this.vocab.docCount + newDocCount
    for (const [term, newCount] of Object.entries(termDocCount)) {
      const existingCount = this.vocab.idf[term] ? (this.vocab.idf[term] * this.vocab.docCount) : 0
      this.vocab.idf[term] = Math.log((totalDocs + 1) / (existingCount + newCount + 1)) + 1
    }

    // Recalculate IDF for all terms
    for (const term of Object.keys(this.vocab.terms)) {
      if (!(term in termDocCount)) {
        const existingCount = this.vocab.idf[term] ? (this.vocab.idf[term] * (this.vocab.docCount || 1)) : 0
        this.vocab.idf[term] = Math.log((totalDocs + 1) / (existingCount + 1)) + 1
      }
    }

    this.vocab.docCount = totalDocs
    this.saveVocab()
  }

  /**
   * Compute TF-IDF vector for a single text.
   */
  private embedViaTfIdf(text: string): EmbeddingResult {
    if (!this.vocab || this.vocab.size === 0) {
      // No vocabulary yet -- initialize with this text
      this.updateVocab([text])
    }

    const tokens = this.tokenize(text)
    const termFreq: Record<string, number> = {}

    for (const token of tokens) {
      termFreq[token] = (termFreq[token] || 0) + 1
    }

    // Create dense vector from TF-IDF sparse representation
    const dim = this.vocab!.size
    const vector = new Array(dim).fill(0)
    let maxTf = 0

    for (const tf of Object.values(termFreq)) {
      if (tf > maxTf) maxTf = tf
    }

    for (const [term, tf] of Object.entries(termFreq)) {
      const idx = this.vocab!.terms[term]
      if (idx !== undefined) {
        // Normalized TF (0-1) * IDF
        const normalizedTf = maxTf > 0 ? tf / maxTf : 0
        vector[idx] = normalizedTf * (this.vocab!.idf[term] || 1)
      }
    }

    return { embedding: vector, type: 'tfidf' }
  }

  /**
   * Load vocabulary from disk.
   */
  private loadVocab(): void {
    if (!this.vocabPath) return

    try {
      if (fs.existsSync(this.vocabPath)) {
        const content = fs.readFileSync(this.vocabPath, 'utf-8')
        this.vocab = JSON.parse(content) as TfidfVocab
      }
    } catch (err) {
      console.warn('[EmbeddingClient] Failed to load TF-IDF vocabulary:', (err as Error).message)
      this.vocab = null
    }
  }

  /**
   * Save vocabulary to disk.
   */
  private saveVocab(): void {
    if (!this.vocabPath || !this.vocab) return

    try {
      const dir = path.dirname(this.vocabPath)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.vocabPath, JSON.stringify(this.vocab), 'utf-8')
    } catch (err) {
      console.warn('[EmbeddingClient] Failed to save TF-IDF vocabulary:', (err as Error).message)
    }
  }
}
