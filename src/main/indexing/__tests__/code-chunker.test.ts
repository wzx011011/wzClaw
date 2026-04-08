import { describe, it, expect } from 'vitest'
import { CodeChunker } from '../code-chunker'

describe('CodeChunker', () => {
  let chunker: CodeChunker

  beforeEach(() => {
    chunker = new CodeChunker()
  })

  describe('basic splitting', () => {
    it('splits TypeScript file at function boundaries', () => {
      const content = `import { x } from 'y'

function foo() {
  return 1
}

function bar() {
  return 2
}
`
      const chunks = chunker.chunkFile('src/utils.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(2)

      // Each chunk should contain a function
      const allContent = chunks.map(c => c.content).join('\n')
      expect(allContent).toContain('function foo')
      expect(allContent).toContain('function bar')
    })

    it('splits at class boundaries', () => {
      const content = `class Foo {
  method() {}
}

class Bar {
  method() {}
}
`
      const chunks = chunker.chunkFile('src/classes.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(2)

      const allContent = chunks.map(c => c.content).join('\n')
      expect(allContent).toContain('class Foo')
      expect(allContent).toContain('class Bar')
    })

    it('splits at interface boundaries', () => {
      const content = `interface Foo {
  name: string
}

interface Bar {
  age: number
}
`
      const chunks = chunker.chunkFile('src/types.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })

    it('splits at export const boundaries', () => {
      const content = `export const FOO = 1
export const BAR = 2
`
      const chunks = chunker.chunkFile('src/constants.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(1)
    })

    it('splits at type alias boundaries', () => {
      const content = `type UserProps = {
  name: string
  age: number
  email: string
}
type AdminProps = {
  role: string
  permissions: string[]
  department: string
}
`
      const chunks = chunker.chunkFile('src/types.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Python files', () => {
    it('splits Python file at def boundaries', () => {
      const content = `import os

def foo():
    return 1

def bar():
    return 2
`
      const chunks = chunker.chunkFile('src/main.py', content, 'python')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('chunk properties', () => {
    it('sets correct filePath and language', () => {
      const content = `function hello() {\n  return 'world'\n}\n`
      const chunks = chunker.chunkFile('src/test.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(1)
      expect(chunks[0].filePath).toBe('src/test.ts')
      expect(chunks[0].language).toBe('typescript')
    })

    it('sets 1-based line numbers', () => {
      const content = `// line 1\n// line 2\nfunction hello() {\n  return 'world'\n}\n`
      const chunks = chunker.chunkFile('src/test.ts', content, 'typescript')
      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1)
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
      }
    })

    it('estimates tokens as chars/4', () => {
      const content = `function hello() {\n  return 'world this is a longer string for testing'\n}\n`
      const chunks = chunker.chunkFile('src/test.ts', content, 'typescript')
      for (const chunk of chunks) {
        expect(chunk.tokenEstimate).toBe(Math.ceil(chunk.content.length / 4))
      }
    })
  })

  describe('max tokens', () => {
    it('splits chunks exceeding 512 token estimate', () => {
      // Create a large function that exceeds 512 tokens (512*4 = 2048 chars)
      const lines = ['function big() {']
      for (let i = 0; i < 200; i++) {
        lines.push(`  const x${i} = "some moderately long string value here to add chars";`)
      }
      lines.push('}')
      const content = lines.join('\n')

      const chunks = chunker.chunkFile('src/big.ts', content, 'typescript')
      for (const chunk of chunks) {
        expect(chunk.tokenEstimate).toBeLessThanOrEqual(512)
      }
    })
  })

  describe('min chunk size', () => {
    it('filters out chunks under 20 characters', () => {
      const content = `function a() {
  return 1
}

}
`
      const chunks = chunker.chunkFile('src/small.ts', content, 'typescript')
      for (const chunk of chunks) {
        expect(chunk.content.trim().length).toBeGreaterThanOrEqual(20)
      }
    })
  })

  describe('fallback splitting', () => {
    it('falls back to blank-line splitting when no boundaries found', () => {
      const content = `const a = 1
const b = 2


const c = 3
const d = 4
`
      const chunks = chunker.chunkFile('src/plain.ts', content, 'typescript')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })
  })
})
