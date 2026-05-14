// ============================================================
// FileWrite 工具测试
// 覆盖文件写入、创建目录、追加模式、错误处理
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileWriteTool } from './file-write.js'
import type { HandTool } from '../src/tool-executor.js'

describe('FileWriteTool', () => {
  let tempDir: string
  let tool: HandTool

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'file-write-test-'))
    tool = new FileWriteTool()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- 基本接口 ----

  it('实现 HandTool 接口，名称为 FileWrite', () => {
    expect(tool.name).toBe('FileWrite')
    expect(tool.description).toBeTruthy()
    expect(tool.inputSchema).toBeDefined()
    expect(tool.isReadOnly).toBe(false)
  })

  it('inputSchema 包含 path 和 content 必填字段', () => {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(schema.properties).toHaveProperty('path')
    expect(schema.properties).toHaveProperty('content')
    expect(schema.required).toContain('path')
    expect(schema.required).toContain('content')
  })

  // ---- 正常写入 ----

  it('写入内容到文件', async () => {
    const filePath = join(tempDir, 'output.txt')

    const result = await tool.execute(
      { path: filePath, content: 'hello world' },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Successfully')
    expect(result.output).toContain('bytes')
    // 验证文件确实被写入
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world')
  })

  it('写入 UTF-8 内容（中文）', async () => {
    const filePath = join(tempDir, 'chinese.txt')

    const result = await tool.execute(
      { path: filePath, content: '你好世界' },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('你好世界')
  })

  it('覆盖已有文件', async () => {
    const filePath = join(tempDir, 'overwrite.txt')
    // 先写入初始内容
    const { writeFileSync } = await import('node:fs')
    writeFileSync(filePath, 'old content')

    const result = await tool.execute(
      { path: filePath, content: 'new content' },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('new content')
  })

  // ---- 追加模式 ----

  it('append=true 追加而非覆盖', async () => {
    const filePath = join(tempDir, 'append.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(filePath, 'first ')

    const result = await tool.execute(
      { path: filePath, content: 'second', append: true },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('first second')
  })

  // ---- 创建目录 ----

  it('createDirs=true 自动创建父目录', async () => {
    const filePath = join(tempDir, 'a', 'b', 'deep.txt')

    const result = await tool.execute(
      { path: filePath, content: 'deep content', createDirs: true },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('deep content')
  })

  it('createDirs=false 不创建父目录时返回错误', async () => {
    const filePath = join(tempDir, 'nonexist', 'file.txt')

    const result = await tool.execute(
      { path: filePath, content: 'fail' },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(existsSync(filePath)).toBe(false)
  })

  // ---- 错误处理 ----

  it('缺少 path 参数返回 isError', async () => {
    const result = await tool.execute(
      { content: 'no path' },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
  })

  it('缺少 content 参数返回 isError', async () => {
    const result = await tool.execute(
      { path: join(tempDir, 'test.txt') },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
  })
})
