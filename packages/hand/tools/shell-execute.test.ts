// ============================================================
// ShellExecute 工具测试
// 覆盖命令执行、超时、安全限制、错误处理
// ============================================================

import { describe, it, expect } from 'vitest'
import { ShellExecuteTool } from './shell-execute.js'
import type { HandTool } from '../src/tool-executor.js'

describe('ShellExecuteTool', () => {
  let tool: HandTool

  // ---- 基本接口 ----

  it('实现 HandTool 接口，名称为 ShellExecute', () => {
    tool = new ShellExecuteTool()
    expect(tool.name).toBe('ShellExecute')
    expect(tool.description).toBeTruthy()
    expect(tool.inputSchema).toBeDefined()
    expect(tool.isReadOnly).toBe(false)
  })

  it('inputSchema 包含 command 必填字段', () => {
    tool = new ShellExecuteTool()
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(schema.properties).toHaveProperty('command')
    expect(schema.required).toContain('command')
  })

  // ---- 正常执行 ----

  it('执行 echo 命令返回 stdout', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'echo hello' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.stdout.trim()).toBe('hello')
    expect(typeof parsed.exitCode).toBe('number')
  })

  it('执行命令返回 JSON 格式 {stdout, stderr, exitCode}', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'echo test && echo err >&2' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed).toHaveProperty('stdout')
    expect(parsed).toHaveProperty('stderr')
    expect(parsed).toHaveProperty('exitCode')
    expect(parsed.exitCode).toBe(0)
  })

  it('执行失败命令返回非零 exitCode', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'exit 42' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.exitCode).toBe(42)
  })

  it('cwd 参数指定工作目录', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'pwd', cwd: '/tmp' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.stdout.trim()).toBe('/tmp')
  })

  // ---- 安全限制 ----

  it('拒绝 rm -rf / 命令', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'rm -rf /' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('拒绝 mkfs 命令', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'mkfs.ext4 /dev/sda1' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('拒绝 dd if= 命令', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'dd if=/dev/zero of=/dev/sda' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('拒绝 fork bomb', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: ':(){ :|:& };:' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('允许正常的 rm 命令（非 -rf /）', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'echo "safe rm"' },
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(false)
  })

  // ---- 错误处理 ----

  it('缺少 command 参数返回 isError', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      {},
      { workingDirectory: '/tmp', projectRoots: [] },
    )

    expect(result.isError).toBe(true)
  })
})
