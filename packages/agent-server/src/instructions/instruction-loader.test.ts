import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadInstructions } from './instruction-loader.js'

describe('instruction-loader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty sections when no files exist', () => {
    const result = loadInstructions(tmpDir)
    expect(result.skills).toBe('')
    expect(result.commands).toBe('')
    expect(result.memory).toBe('')
    expect(result.merged).toBe('')
  })

  it('loads MEMORY.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'Remember this')
    const result = loadInstructions(tmpDir)
    expect(result.memory).toBe('Remember this')
    expect(result.merged).toContain('Remember this')
    expect(result.merged).toContain('# Memory')
  })

  it('loads commands/*.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'commands'))
    fs.writeFileSync(path.join(tmpDir, 'commands', 'foo.md'), 'Command foo content')
    fs.writeFileSync(path.join(tmpDir, 'commands', 'bar.md'), 'Command bar content')
    const result = loadInstructions(tmpDir)
    expect(result.commands).toContain('Command foo content')
    expect(result.commands).toContain('Command bar content')
    expect(result.merged).toContain('# Commands')
  })

  it('loads skills/*.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'skills'))
    fs.writeFileSync(path.join(tmpDir, 'skills', 'test.md'), 'Skill content')
    const result = loadInstructions(tmpDir)
    expect(result.skills).toBe('Skill content')
    expect(result.merged).toContain('# Skills')
  })

  it('merges all sections in order: memory, commands, skills', () => {
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'Memory')
    fs.mkdirSync(path.join(tmpDir, 'commands'))
    fs.writeFileSync(path.join(tmpDir, 'commands', 'cmd.md'), 'Command')
    fs.mkdirSync(path.join(tmpDir, 'skills'))
    fs.writeFileSync(path.join(tmpDir, 'skills', 'sk.md'), 'Skill')
    const result = loadInstructions(tmpDir)
    const memIdx = result.merged.indexOf('Memory')
    const cmdIdx = result.merged.indexOf('Command')
    const skIdx = result.merged.indexOf('Skill')
    expect(memIdx).toBeLessThan(cmdIdx)
    expect(cmdIdx).toBeLessThan(skIdx)
  })

  it('ignores non-.md files in commands/ and skills/', () => {
    fs.mkdirSync(path.join(tmpDir, 'commands'))
    fs.writeFileSync(path.join(tmpDir, 'commands', 'test.txt'), 'Not a command')
    fs.writeFileSync(path.join(tmpDir, 'commands', 'real.md'), 'Real command')
    const result = loadInstructions(tmpDir)
    expect(result.commands).toBe('Real command')
  })

  it('sorts files alphabetically', () => {
    fs.mkdirSync(path.join(tmpDir, 'skills'))
    fs.writeFileSync(path.join(tmpDir, 'skills', 'z-skill.md'), 'Z skill')
    fs.writeFileSync(path.join(tmpDir, 'skills', 'a-skill.md'), 'A skill')
    const result = loadInstructions(tmpDir)
    const aIdx = result.skills.indexOf('A skill')
    const zIdx = result.skills.indexOf('Z skill')
    expect(aIdx).toBeLessThan(zIdx)
  })
})
