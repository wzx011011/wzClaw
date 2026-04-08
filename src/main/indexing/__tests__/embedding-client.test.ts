import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EmbeddingClient, type EmbeddingResult } from '../embedding-client'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('EmbeddingClient', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('isAvailable', () => {
    it('returns false when no apiKey', () => {
      const client = new EmbeddingClient({ baseURL: 'https://api.openai.com/v1' })
      expect(client.isAvailable()).toBe(false)
    })

    it('returns false when no baseURL', () => {
      const client = new EmbeddingClient({ apiKey: 'test-key' })
      expect(client.isAvailable()).toBe(false)
    })

    it('returns true when both configured', () => {
      const client = new EmbeddingClient({ apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' })
      expect(client.isAvailable()).toBe(true)
    })
  })

  describe('TF-IDF fallback', () => {
    it('falls back to TF-IDF when no API configured', async () => {
      const client = new EmbeddingClient({})
      const result = await client.embed('function hello() { return 1; }')
      expect(result.type).toBe('tfidf')
      expect(result.embedding.length).toBeGreaterThan(0)
    })

    it('produces consistent embeddings for same text', async () => {
      const client = new EmbeddingClient({})
      const r1 = await client.embed('function hello world')
      const r2 = await client.embed('function hello world')
      expect(r1.embedding).toEqual(r2.embedding)
      expect(r1.type).toBe('tfidf')
    })

    it('produces different embeddings for different texts', async () => {
      const client = new EmbeddingClient({})
      const r1 = await client.embed('function calculate sum')
      const r2 = await client.embed('render ui component')
      // They should not be identical
      let identical = true
      for (let i = 0; i < Math.min(r1.embedding.length, r2.embedding.length); i++) {
        if (r1.embedding[i] !== r2.embedding[i]) {
          identical = false
          break
        }
      }
      expect(identical).toBe(false)
    })

    it('batch embed returns same count as input', async () => {
      const client = new EmbeddingClient({})
      const texts = ['hello world', 'foo bar baz', 'test code']
      const results = await client.embedBatch(texts)
      expect(results.length).toBe(3)
      for (const r of results) {
        expect(r.type).toBe('tfidf')
        expect(r.embedding.length).toBeGreaterThan(0)
      }
    })

    it('persists TF-IDF vocabulary to disk', async () => {
      const vocabPath = path.join(tempDir, 'tfidf-vocab.json')
      const client = new EmbeddingClient({})
      client.setVocabPath(vocabPath)

      await client.embed('function hello world')

      expect(fs.existsSync(vocabPath)).toBe(true)
      const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'))
      expect(vocab.size).toBeGreaterThan(0)
      expect(vocab.terms).toBeDefined()
      expect(vocab.idf).toBeDefined()
    })

    it('loads existing vocabulary from disk', async () => {
      const vocabPath = path.join(tempDir, 'tfidf-vocab.json')

      // Create client, embed text, persist vocab
      const client1 = new EmbeddingClient({})
      client1.setVocabPath(vocabPath)
      const r1 = await client1.embed('function hello world')
      const dim1 = r1.embedding.length

      // New client loads same vocab
      const client2 = new EmbeddingClient({})
      client2.setVocabPath(vocabPath)
      const r2 = await client2.embed('function hello world')

      expect(r2.embedding.length).toBe(dim1)
      expect(r2.embedding).toEqual(r1.embedding)
    })
  })

  describe('API embedding', () => {
    it('falls back to TF-IDF when API fails', async () => {
      // Mock fetch to simulate API failure
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

      try {
        const client = new EmbeddingClient({
          apiKey: 'test-key',
          baseURL: 'https://api.example.com/v1',
        })
        const result = await client.embed('function test() {}')
        expect(result.type).toBe('tfidf')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
