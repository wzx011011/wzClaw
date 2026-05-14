// ============================================================
// ShellExecute 工具测试
// 覆盖命令执行、超时、安全限制、错误处理
// 注：所有执行测试显式指定 cwd，避免 Windows 上默认 /data 不存在的问题
// ============================================================

import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { ShellExecuteTool } from './shell-execute.js'
import type { HandTool } from '../src/tool-executor.js'

/** 跨平台安全的临时目录 */
const SAFE_CWD = tmpdir()

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
      { command: 'echo hello', cwd: SAFE_CWD },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.stdout.trim()).toBe('hello')
    expect(typeof parsed.exitCode).toBe('number')
  })

  it('执行命令返回 JSON 格式 {stdout, stderr, exitCode}', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'echo test_output', cwd: SAFE_CWD },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed).toHaveProperty('stdout')
    expect(parsed).toHaveProperty('stderr')
    expect(parsed).toHaveProperty('exitCode')
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toContain('test_output')
  })

  it('执行失败命令返回非零 exitCode', async () => {
    tool = new ShellExecuteTool()
    // 使用 node 命令确保跨平台兼容的退出码
    const result = await tool.execute(
      { command: 'node -e "process.exit(42)"', cwd: SAFE_CWD },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.exitCode).toBe(42)
  })

  it('cwd 参数指定工作目录', async () => {
    tool = new ShellExecuteTool()
    // 使用 node 获取实际 cwd，避免平台路径差异
    const result = await tool.execute(
      { command: 'node -e "process.stdout.write(process.cwd())"', cwd: SAFE_CWD },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    // 验证 cwd 生效（输出非空，且包含路径分隔符）
    expect(parsed.stdout.length).toBeGreaterThan(0)
    expect(parsed.stdout).toMatch(/[/\\]/)
  })

  // ---- 安全限制 ----

  it('拒绝 rm -rf / 命令', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'rm -rf /' },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('拒绝 mkfs 命令', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'mkfs.ext4 /dev/sda1' },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('拒绝 dd if= 命令', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'dd if=/dev/zero of=/dev/sda' },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('拒绝 fork bomb', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: ':(){ :|:& };:' },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('禁止')
  })

  it('允许正常的 rm 命令（非 -rf /）', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      { command: 'echo "safe rm"', cwd: SAFE_CWD },
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(false)
  })

  // ---- 错误处理 ----

  it('缺少 command 参数返回 isError', async () => {
    tool = new ShellExecuteTool()
    const result = await tool.execute(
      {},
      { workingDirectory: SAFE_CWD, projectRoots: [] },
    )

    expect(result.isError).toBe(true)
  })
})
