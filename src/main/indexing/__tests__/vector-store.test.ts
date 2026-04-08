import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { VectorStore, cosineSimilarity, BINARY_EXTENSIONS, MAX_INDEX_FILE_SIZE, SKIP_DIRS, type IndexEntry, type SearchResult } from '../vector-store'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('VectorStore', () => {
  let tempDir: string
  let store: VectorStore

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-test-'))
    store = new VectorStore(tempDir)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function makeEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
    return {
      id: 'test-entry-001',
      filePath: 'src/test.ts',
      startLine: 1,
      endLine: 10,
      content: 'function hello() { return 1; }',
      language: 'typescript',
      embedding: [1.0, 0.0, 0.0],
      mtime: Date.now(),
      embeddingType: 'tfidf',
      ...overrides,
    }
  }

  describe('constructor', () => {
    it('creates .wzxclaw/index/ directory', () => {
      const indexDir = path.join(tempDir, '.wzxclaw', 'index')
      expect(fs.existsSync(indexDir)).toBe(true)
    })
  })

  describe('upsert', () => {
    it('stores entries and writes vectors.jsonl', async () => {
      const entry = makeEntry()
      await store.upsert([entry])

      const vectorsPath = path.join(tempDir, '.wzxclaw', 'index', 'vectors.jsonl')
      expect(fs.existsSync(vectorsPath)).toBe(true)
    })

    it('updates existing entry with same id', async () => {
      const entry1 = makeEntry({ id: 'same-id', content: 'old content', embedding: [1, 0, 0] })
      const entry2 = makeEntry({ id: 'same-id', content: 'new content', embedding: [0, 1, 0] })

      await store.upsert([entry1])
      await store.upsert([entry2])

      const entries = await store.loadAll()
      expect(entries.length).toBe(1)
      expect(entries[0].content).toBe('new content')
    })

    it('writes meta.json with version and fileCount', async () => {
      await store.upsert([makeEntry()])

      const metaPath = path.join(tempDir, '.wzxclaw', 'index', 'meta.json')
      expect(fs.existsSync(metaPath)).toBe(true)
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      expect(meta.version).toBe(1)
      expect(meta.fileCount).toBe(1)
    })
  })

  describe('deleteByFile', () => {
    it('removes entries for a specific file', async () => {
      const entry1 = makeEntry({ id: 'e1', filePath: 'src/a.ts' })
      const entry2 = makeEntry({ id: 'e2', filePath: 'src/b.ts' })

      await store.upsert([entry1, entry2])
      await store.deleteByFile('src/a.ts')

      const entries = await store.loadAll()
      expect(entries.length).toBe(1)
      expect(entries[0].filePath).toBe('src/b.ts')
    })
  })

  describe('search', () => {
    it('returns results sorted by cosine similarity descending', async () => {
      const entries = [
        makeEntry({ id: 'e1', content: 'function add', embedding: [1, 0, 0] }),
        makeEntry({ id: 'e2', content: 'function sub', embedding: [0.8, 0.6, 0] }),
        makeEntry({ id: 'e3', content: 'function mul', embedding: [0, 0, 1] }),
      ]

      await store.upsert(entries)

      const results = store.search([1, 0, 0], 10)
      expect(results.length).toBe(3)
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score)
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score)
    })

    it('respects topK parameter', async () => {
      const entries = Array.from({ length: 20 }, (_, i) =>
        makeEntry({ id: `e${i}`, embedding: [i / 20, 0, 0] })
      )
      await store.upsert(entries)

      const results = store.search([1, 0, 0], 5)
      expect(results.length).toBe(5)
    })

    it('returns empty array when no entries', () => {
      const results = store.search([1, 0, 0])
      expect(results).toEqual([])
    })
  })

  describe('getEntryCount', () => {
    it('returns correct count', async () => {
      await store.upsert([
        makeEntry({ id: 'e1', filePath: 'a.ts' }),
        makeEntry({ id: 'e2', filePath: 'a.ts' }),
        makeEntry({ id: 'e3', filePath: 'b.ts' }),
      ])
      expect(await store.getEntryCount()).toBe(3)
    })
  })

  describe('clear', () => {
    it('removes all entries', async () => {
      await store.upsert([makeEntry()])
      await store.clear()
      expect(await store.getEntryCount()).toBe(0)
    })
  })

  describe('loadAll', () => {
    it('returns empty array when no vectors.jsonl', async () => {
      const entries = await store.loadAll()
      expect(entries).toEqual([])
    })
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0)
  })

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })

  it('returns 0 for vectors of different lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })

  it('returns between 0 and 1 for similar vectors', () => {
    const score = cosineSimilarity([1, 2, 3], [1, 2, 4])
    expect(score).toBeGreaterThan(0.9)
    expect(score).toBeLessThan(1.0)
  })
})

describe('constants', () => {
  it('MAX_INDEX_FILE_SIZE is 100KB', () => {
    expect(MAX_INDEX_FILE_SIZE).toBe(102400)
  })

  it('BINARY_EXTENSIONS includes common binary formats', () => {
    expect(BINARY_EXTENSIONS.has('.png')).toBe(true)
    expect(BINARY_EXTENSIONS.has('.exe')).toBe(true)
    expect(BINARY_EXTENSIONS.has('.pdf')).toBe(true)
    expect(BINARY_EXTENSIONS.has('.zip')).toBe(true)
  })

  it('SKIP_DIRS includes common ignored directories', () => {
    expect(SKIP_DIRS.has('node_modules')).toBe(true)
    expect(SKIP_DIRS.has('.git')).toBe(true)
    expect(SKIP_DIRS.has('dist')).toBe(true)
    expect(SKIP_DIRS.has('build')).toBe(true)
  })
})
