// ============================================================
// FileList 工具测试
// 覆盖目录列表、递归、glob 模式、文件元数据、错误处理
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileListTool } from './file-list.js'
import type { HandTool } from '../src/tool-executor.js'

describe('FileListTool', () => {
  let tempDir: string
  let tool: HandTool

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'file-list-test-'))
    tool = new FileListTool()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- 基本接口 ----

  it('实现 HandTool 接口，名称为 FileList', () => {
    expect(tool.name).toBe('FileList')
    expect(tool.description).toBeTruthy()
    expect(tool.inputSchema).toBeDefined()
    expect(tool.isReadOnly).toBe(true)
  })

  it('inputSchema 包含 path 必填字段', () => {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(schema.properties).toHaveProperty('path')
    expect(schema.required).toContain('path')
  })

  // ---- 正常列出 ----

  it('列出目录内容返回 JSON 数组', async () => {
    writeFileSync(join(tempDir, 'file1.txt'), 'content1')
    writeFileSync(join(tempDir, 'file2.txt'), 'content2')
    mkdirSync(join(tempDir, 'subdir'))

    const result = await tool.execute(
      { path: tempDir },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    expect(Array.isArray(entries)).toBe(true)
    expect(entries.length).toBe(3)

    const names = entries.map((e: { name: string }) => e.name)
    expect(names).toContain('file1.txt')
    expect(names).toContain('file2.txt')
    expect(names).toContain('subdir')
  })

  it('每个条目包含 name/path/size/isDir/modified', async () => {
    writeFileSync(join(tempDir, 'test.txt'), 'hello')

    const result = await tool.execute(
      { path: tempDir },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    const entry = entries.find((e: { name: string }) => e.name === 'test.txt')
    expect(entry).toBeDefined()
    expect(entry.name).toBe('test.txt')
    expect(entry.path).toBeTruthy()
    expect(typeof entry.size).toBe('number')
    expect(entry.isDir).toBe(false)
    expect(typeof entry.modified).toBe('string')
  })

  it('目录条目 isDir 为 true', async () => {
    mkdirSync(join(tempDir, 'mydir'))

    const result = await tool.execute(
      { path: tempDir },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    const dirEntry = entries.find((e: { name: string }) => e.name === 'mydir')
    expect(dirEntry.isDir).toBe(true)
  })

  // ---- 递归 ----

  it('recursive=true 递归列出子目录', async () => {
    writeFileSync(join(tempDir, 'root.txt'), 'root')
    mkdirSync(join(tempDir, 'sub'))
    writeFileSync(join(tempDir, 'sub', 'nested.txt'), 'nested')

    const result = await tool.execute(
      { path: tempDir, recursive: true },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    const names = entries.map((e: { name: string }) => e.name)
    expect(names).toContain('root.txt')
    expect(names).toContain('sub')
    expect(names).toContain('nested.txt')
  })

  it('recursive=false（默认）不递归子目录', async () => {
    mkdirSync(join(tempDir, 'sub'))
    writeFileSync(join(tempDir, 'sub', 'nested.txt'), 'nested')

    const result = await tool.execute(
      { path: tempDir },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    // 只有子目录本身，不包含子目录内的文件
    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe('sub')
    expect(entries[0].isDir).toBe(true)
  })

  // ---- glob 模式 ----

  it('pattern 参数过滤文件名', async () => {
    writeFileSync(join(tempDir, 'app.ts'), 'ts')
    writeFileSync(join(tempDir, 'app.js'), 'js')
    writeFileSync(join(tempDir, 'readme.md'), 'md')

    const result = await tool.execute(
      { path: tempDir, pattern: '*.ts' },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    const names = entries.map((e: { name: string }) => e.name)
    expect(names).toContain('app.ts')
    expect(names).not.toContain('app.js')
    expect(names).not.toContain('readme.md')
  })

  // ---- 空目录 ----

  it('空目录返回空数组', async () => {
    const result = await tool.execute(
      { path: tempDir },
      { workingDirectory: tempDir, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    expect(entries).toEqual([])
  })

  // ---- 错误处理 ----

  it('不存在的目录返回 isError', async () => {
    const result = await tool.execute(
      { path: join(tempDir, 'nonexistent') },
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
