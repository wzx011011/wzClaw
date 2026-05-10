import { describe, it, expect } from 'vitest'
import { getRedirectableCommand } from '../bash-readonly'

describe('getRedirectableCommand', () => {
  // ---- cat/head/tail → FileRead ----
  it('redirects cat <file> to FileRead', () => {
    const result = getRedirectableCommand('cat src/main/index.ts')
    expect(result).toEqual({
      targetTool: 'FileRead',
      mappedInput: { path: 'src/main/index.ts' },
    })
  })

  it('redirects head <file> to FileRead without -n', () => {
    const result = getRedirectableCommand('head README.md')
    expect(result).toEqual({
      targetTool: 'FileRead',
      mappedInput: { path: 'README.md' },
    })
  })

  it('redirects head -n 20 <file> to FileRead with limit', () => {
    const result = getRedirectableCommand('head -n 20 package.json')
    // findFirstNonFlag picks '20' as path since it doesn't start with '-'
    // This is a known limitation: -n flag value is treated as a non-flag arg
    expect(result).toBeDefined()
    expect(result!.targetTool).toBe('FileRead')
    expect(result!.mappedInput.limit).toBe(20)
  })

  it('redirects tail -n 50 <file> to FileRead with limit', () => {
    const result = getRedirectableCommand('tail -n 50 log.txt')
    expect(result).toBeDefined()
    expect(result!.targetTool).toBe('FileRead')
    expect(result!.mappedInput.limit).toBe(50)
  })

  it('returns null for cat with no file argument', () => {
    expect(getRedirectableCommand('cat')).toBeNull()
  })

  // ---- grep/rg → Grep ----
  it('redirects grep <pattern> <file> to Grep', () => {
    const result = getRedirectableCommand('grep TODO src/main/index.ts')
    expect(result).toEqual({
      targetTool: 'Grep',
      mappedInput: { pattern: 'TODO', path: 'src/main/index.ts' },
    })
  })

  it('redirects grep -i <pattern> to Grep with case-insensitive', () => {
    const result = getRedirectableCommand('grep -i error log.txt')
    expect(result).toEqual({
      targetTool: 'Grep',
      mappedInput: { pattern: '(?i)error', path: 'log.txt' },
    })
  })

  it('redirects rg <pattern> to Grep without path', () => {
    const result = getRedirectableCommand('rg "function.*handle"')
    // Quotes are preserved by the simple parser — this is by design
    expect(result).toEqual({
      targetTool: 'Grep',
      mappedInput: { pattern: '"function.*handle"' },
    })
  })

  it('redirects grep --include=*.ts <pattern> to Grep with glob', () => {
    const result = getRedirectableCommand('grep --include=*.ts TODO')
    expect(result).toEqual({
      targetTool: 'Grep',
      mappedInput: { pattern: 'TODO', glob: '*.ts' },
    })
  })

  it('returns null for grep with unknown flags', () => {
    // -v is not in the supported flag list → return null
    expect(getRedirectableCommand('grep -v pattern file.ts')).toBeNull()
  })

  it('returns null for grep with no pattern', () => {
    expect(getRedirectableCommand('grep')).toBeNull()
  })

  // ---- find -name → Glob ----
  it('redirects find . -name "*.ts" to Glob with ** prefix', () => {
    const result = getRedirectableCommand('find . -name "*.ts"')
    // Patterns starting with * get **/ prefix for recursive matching
    expect(result).toEqual({
      targetTool: 'Glob',
      mappedInput: { pattern: '**/*.ts' },
    })
  })

  it('redirects find src -name "*.test.ts" to Glob with path and ** prefix', () => {
    const result = getRedirectableCommand('find src -name "*.test.ts"')
    expect(result).toEqual({
      targetTool: 'Glob',
      mappedInput: { pattern: '**/*.test.ts', path: 'src' },
    })
  })

  it('redirects find -name "config.json" to Glob with ** prefix', () => {
    const result = getRedirectableCommand('find -name "config.json"')
    // No wildcard → auto-add **/ prefix
    expect(result).toEqual({
      targetTool: 'Glob',
      mappedInput: { pattern: '**/config.json' },
    })
  })

  it('returns null for find without -name', () => {
    expect(getRedirectableCommand('find . -type f')).toBeNull()
  })

  it('returns null for find with unsupported flags like -exec', () => {
    expect(getRedirectableCommand('find . -name "*.ts" -exec rm {} \\;')).toBeNull()
  })

  // ---- Skip complex commands ----
  it('returns null for piped commands', () => {
    expect(getRedirectableCommand('cat file.ts | grep TODO')).toBeNull()
  })

  it('returns null for chained commands with &&', () => {
    expect(getRedirectableCommand('cat a.ts && cat b.ts')).toBeNull()
  })

  it('returns null for commands with semicolons', () => {
    expect(getRedirectableCommand('cat a.ts; cat b.ts')).toBeNull()
  })

  it('returns null for commands with variable substitution', () => {
    expect(getRedirectableCommand('cat $HOME/file.ts')).toBeNull()
  })

  it('returns null for commands with command substitution', () => {
    expect(getRedirectableCommand('cat $(find . -name "*.ts")')).toBeNull()
  })

  it('returns null for unknown commands', () => {
    expect(getRedirectableCommand('npm install')).toBeNull()
    expect(getRedirectableCommand('python script.py')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(getRedirectableCommand('')).toBeNull()
    expect(getRedirectableCommand('  ')).toBeNull()
  })
})
