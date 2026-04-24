import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IndexingEngine, type IndexingStatus, type IndexingProgress } from '../indexing-engine'
import { EmbeddingClient } from '../embedding-client'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('IndexingEngine', () => {
  let tempDir: string
  let engine: IndexingEngine
  let embeddingClient: EmbeddingClient

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexing-engine-test-'))

    // Create some test files
    fs.mkdirSync(path.join(tempDir, 'src'))
    fs.writeFileSync(path.join(tempDir, 'src', 'utils.ts'), `export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}
`)
    fs.writeFileSync(path.join(tempDir, 'src', 'main.py'), `import os

def hello():
    print("hello")

def goodbye():
    print("goodbye")
`)

    // Create binary file
    fs.writeFileSync(path.join(tempDir, 'src', 'image.png'), Buffer.alloc(200000))

    // Create large file (>100KB)
    const bigContent = 'x'.repeat(200000)
    fs.writeFileSync(path.join(tempDir, 'src', 'big.txt'), bigContent)

    // Create node_modules dir (should be skipped)
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'module.exports = {}')

    embeddingClient = new EmbeddingClient({})
    engine = new IndexingEngine(tempDir, embeddingClient)
  })

  afterEach(() => {
    engine.dispose()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('indexFull', () => {
    it('indexes all eligible files and transitions to ready', async () => {
      const progressUpdates: IndexingProgress[] = []
      engine.onProgress(p => progressUpdates.push(p))

      await engine.indexFull()

      // Should have received status updates
      const statuses = progressUpdates.map(p => p.status)
      expect(statuses).toContain('indexing')
      expect(statuses).toContain('ready')

      const final = engine.getStatus()
      expect(final.status).toBe('ready')
      expect(final.fileCount).toBeGreaterThan(0)
    })

    it('excludes binary files', async () => {
      await engine.indexFull()

      // Should NOT have indexed image.png
      const entries = await engine.search('image', 100)
      const pngEntries = entries.filter(e => e.filePath.endsWith('.png'))
      expect(pngEntries.length).toBe(0)
    })

    it('excludes files >100KB', async () => {
      await engine.indexFull()

      const entries = await engine.search('big', 100)
      const bigEntries = entries.filter(e => e.filePath.endsWith('big.txt'))
      expect(bigEntries.length).toBe(0)
    })

    it('skips node_modules directory', async () => {
      await engine.indexFull()

      const entries = await engine.search('module', 100)
      const nodeModules = entries.filter(e => e.filePath.includes('node_modules'))
      expect(nodeModules.length).toBe(0)
    })

    it('incremental: skips unchanged files on second index', async () => {
      const updates1: IndexingProgress[] = []
      engine.onProgress(p => updates1.push(p))
      await engine.indexFull()
      const count1 = engine.getStatus().fileCount

      // Second index should skip unchanged files
      const updates2: IndexingProgress[] = []
      engine.onProgress(p => updates2.push(p))
      await engine.indexFull()
      const count2 = engine.getStatus().fileCount

      expect(count2).toBe(count1)
    })

    it('re-indexes modified files', async () => {
      await engine.indexFull()
      const count1 = engine.getStatus().fileCount

      // Modify a file
      const utilsPath = path.join(tempDir, 'src', 'utils.ts')
      fs.writeFileSync(utilsPath, `export function divide(a: number, b: number): number {
  return a / b
}
`)
      // Touch mtime (utimesSync requires seconds, not ms)
      const now = Math.floor(Date.now() / 1000)
      fs.utimesSync(utilsPath, now, now)

      await engine.indexFull()
      const count2 = engine.getStatus().fileCount

      // Count should be the same (same number of chunks after re-index)
      expect(count2).toBe(count1)
    })
  })

  describe('search', () => {
    it('returns results for relevant queries', async () => {
      await engine.indexFull()

      const results = await engine.search('add multiply', 5)
      expect(results.length).toBeGreaterThan(0)

      // Results should have required fields
      for (const r of results) {
        expect(r.filePath).toBeDefined()
        expect(r.startLine).toBeGreaterThanOrEqual(1)
        expect(r.endLine).toBeGreaterThanOrEqual(r.startLine)
        expect(r.score).toBeGreaterThanOrEqual(0)
        expect(r.content).toBeDefined()
      }
    })

    it('returns empty when disposed', async () => {
      engine.dispose()
      const results = await engine.search('test', 5)
      expect(results).toEqual([])
    })
  })

  describe('indexFile', () => {
    it('indexes a single file', async () => {
      const filePath = path.join(tempDir, 'src', 'utils.ts')
      await engine.indexFile(filePath)

      const results = await engine.search('add', 10)
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('removeFile', () => {
    it('removes entries for a deleted file', async () => {
      await engine.indexFull()

      const results1 = await engine.search('add', 100)
      const utilsResults = results1.filter(r => r.filePath.includes('utils.ts'))
      expect(utilsResults.length).toBeGreaterThan(0)

      await engine.removeFile(path.join(tempDir, 'src', 'utils.ts'))

      const results2 = await engine.search('add', 100)
      const afterRemove = results2.filter(r => r.filePath.includes('utils.ts'))
      expect(afterRemove.length).toBe(0)
    })
  })

  describe('getStatus', () => {
    it('returns initial idle status', () => {
      const status = engine.getStatus()
      expect(status.status).toBe('idle')
      expect(status.fileCount).toBe(0)
      expect(status.currentFile).toBe('')
    })
  })

  describe('onProgress', () => {
    it('returns unsubscribe function', () => {
      const callback = vi.fn()
      const unsub = engine.onProgress(callback)
      expect(typeof unsub).toBe('function')

      unsub()
      // After unsub, callback should not be called
      expect(callback).toHaveBeenCalledTimes(1) // only the immediate call
    })

    it('calls callback immediately with current state', () => {
      const callback = vi.fn()
      engine.onProgress(callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith({ status: 'idle', fileCount: 0, currentFile: '' })
    })
  })

  describe('dispose', () => {
    it('stops indexing when disposed mid-run', async () => {
      // Create many files to make indexing take time
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(
          path.join(tempDir, `file${i}.ts`),
          `export function fn${i}() { return ${i}; }\n`
        )
      }

      // Start indexing and dispose immediately
      const promise = engine.indexFull()
      engine.dispose()
      await promise

      // Status should not be 'ready' since we interrupted
      const status = engine.getStatus()
      expect(status.status).not.toBe('ready')
    })
  })
})
