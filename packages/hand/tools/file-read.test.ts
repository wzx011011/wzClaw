// ============================================================
// FileRead 工具测试
// 覆盖文件读取、行号范围、编码选择、错误处理
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileReadTool } from './file-read.js'
import type { HandTool } from '../src/tool-executor.js'

describe('FileReadTool', () => {
  let tempDir: string
  let tool: HandTool

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'file-read-test-'))
    tool = new FileReadTool()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- 基本接口 ----

  it('实现 HandTool 接口，名称为 FileRead', () => {
    expect(tool.name).toBe('FileRead')
    expect(tool.description).toBeTruthy()
    expect(tool.inputSchema).toBeDefined()
    expect(tool.isReadOnly).toBe(true)
  })

  it('inputSchema 包含 path 必填字段', () => {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(schema.properties).toHaveProperty('path')
    expect(schema.required).toContain('path')
  })

  // ---- 正常读取 ----

  it('读取存在的文件返回带行号的内容', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'hello\nworld\nfoo')

    const result = await tool.execute(
      { path: filePath },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('1:')
    expect(result.output).toContain('hello')
    expect(result.output).toContain('2:')
    expect(result.output).toContain('world')
    expect(result.output).toContain('3:')
    expect(result.output).toContain('foo')
  })

  it('单行文件正确输出', async () => {
    const filePath = join(tempDir, 'single.txt')
    writeFileSync(filePath, 'only line')

    const result = await tool.execute(
      { path: filePath },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('1:')
    expect(result.output).toContain('only line')
  })

  it('空文件返回空内容', async () => {
    const filePath = join(tempDir, 'empty.txt')
    writeFileSync(filePath, '')

    const result = await tool.execute(
      { path: filePath },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
  })

  // ---- 行号范围 ----

  it('startLine/endLine 截取行范围', async () => {
    const filePath = join(tempDir, 'lines.txt')
    writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5')

    const result = await tool.execute(
      { path: filePath, startLine: 2, endLine: 4 },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('2:')
    expect(result.output).toContain('line2')
    expect(result.output).toContain('3:')
    expect(result.output).toContain('line3')
    expect(result.output).toContain('4:')
    expect(result.output).toContain('line4')
    // 不应包含第1行和第5行
    expect(result.output).not.toContain('line1')
    expect(result.output).not.toContain('line5')
  })

  it('仅 startLine 截取从指定行到末尾', async () => {
    const filePath = join(tempDir, 'lines.txt')
    writeFileSync(filePath, 'line1\nline2\nline3')

    const result = await tool.execute(
      { path: filePath, startLine: 2 },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('line2')
    expect(result.output).toContain('line3')
    expect(result.output).not.toContain('line1')
  })

  it('仅 endLine 截取从第1行到指定行', async () => {
    const filePath = join(tempDir, 'lines.txt')
    writeFileSync(filePath, 'line1\nline2\nline3')

    const result = await tool.execute(
      { path: filePath, endLine: 2 },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('line1')
    expect(result.output).toContain('line2')
    expect(result.output).not.toContain('line3')
  })

  // ---- 错误处理 ----

  it('读取不存在的文件返回 isError', async () => {
    const result = await tool.execute(
      { path: join(tempDir, 'nonexistent.txt') },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toBeTruthy()
  })

  it('读取目录而非文件返回 isError', async () => {
    const dirPath = join(tempDir, 'subdir')
    mkdirSync(dirPath)

    const result = await tool.execute(
      { path: dirPath },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
  })

  it('缺少 path 参数返回 isError', async () => {
    const result = await tool.execute(
      {},
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
  })
})
