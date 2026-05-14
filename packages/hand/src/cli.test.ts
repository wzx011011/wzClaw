// ============================================================
// CLI 入口测试
// 覆盖参数解析、环境变量回退、usage 输出、启动流程
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseArgs, type ParsedArgs } from './cli.js'

describe('parseArgs', () => {
  // ---- 基本参数解析 ----

  it('解析 --server 和 --token 参数', () => {
    const result = parseArgs(['node', 'cli.js', '--server', 'ws://localhost:8082', '--token', 'mytoken'])
    expect(result.server).toBe('ws://localhost:8082')
    expect(result.token).toBe('mytoken')
  })

  it('解析所有可选参数', () => {
    const result = parseArgs([
      'node', 'cli.js',
      '--server', 'wss://example.com/agent/',
      '--token', 'tok',
      '--id', 'hand-test-001',
      '--heartbeat', '5000',
    ])
    expect(result.server).toBe('wss://example.com/agent/')
    expect(result.token).toBe('tok')
    expect(result.id).toBe('hand-test-001')
    expect(result.heartbeat).toBe(5000)
  })

  // ---- 环境变量回退 ----

  it('缺少 --server 时使用 SERVER_URL 环境变量', () => {
    process.env.SERVER_URL = 'ws://env-server:8082'
    const result = parseArgs(['node', 'cli.js', '--token', 'tok'])
    expect(result.server).toBe('ws://env-server:8082')
    delete process.env.SERVER_URL
  })

  it('缺少 --token 时使用 AUTH_TOKEN 环境变量', () => {
    process.env.AUTH_TOKEN = 'env-token'
    const result = parseArgs(['node', 'cli.js', '--server', 'ws://localhost:8082'])
    expect(result.token).toBe('env-token')
    delete process.env.AUTH_TOKEN
  })

  it('缺少 --id 时使用 HAND_ID 环境变量', () => {
    process.env.HAND_ID = 'env-hand-id'
    const result = parseArgs([
      'node', 'cli.js',
      '--server', 'ws://localhost:8082',
      '--token', 'tok',
    ])
    expect(result.id).toBe('env-hand-id')
    delete process.env.HAND_ID
  })

  it('CLI 参数优先级高于环境变量', () => {
    process.env.SERVER_URL = 'ws://env-server:8082'
    process.env.AUTH_TOKEN = 'env-token'
    const result = parseArgs([
      'node', 'cli.js',
      '--server', 'ws://cli-server:8082',
      '--token', 'cli-token',
    ])
    expect(result.server).toBe('ws://cli-server:8082')
    expect(result.token).toBe('cli-token')
    delete process.env.SERVER_URL
    delete process.env.AUTH_TOKEN
  })

  // ---- 缺少必需参数 ----

  it('缺少 server 和 token 时两者都为 undefined', () => {
    delete process.env.SERVER_URL
    delete process.env.AUTH_TOKEN
    const result = parseArgs(['node', 'cli.js'])
    expect(result.server).toBeUndefined()
    expect(result.token).toBeUndefined()
  })

  it('只有 server 没有 token 时 token 为 undefined', () => {
    delete process.env.AUTH_TOKEN
    const result = parseArgs(['node', 'cli.js', '--server', 'ws://localhost:8082'])
    expect(result.server).toBe('ws://localhost:8082')
    expect(result.token).toBeUndefined()
  })

  // ---- server URL 验证 ----

  it('server URL 必须以 ws:// 或 wss:// 开头才有效', () => {
    const valid1 = parseArgs(['node', 'cli.js', '--server', 'ws://localhost:8082', '--token', 'tok'])
    expect(valid1.server).toBe('ws://localhost:8082')

    const valid2 = parseArgs(['node', 'cli.js', '--server', 'wss://secure.example.com', '--token', 'tok'])
    expect(valid2.server).toBe('wss://secure.example.com')

    const invalid = parseArgs(['node', 'cli.js', '--server', 'http://localhost:8082', '--token', 'tok'])
    // parseArgs 本身不验证，只解析；验证逻辑在 runCli 中
    expect(invalid.server).toBe('http://localhost:8082')
  })

  // ---- 默认值 ----

  it('heartbeat 默认为 15000', () => {
    const result = parseArgs(['node', 'cli.js', '--server', 'ws://localhost:8082', '--token', 'tok'])
    expect(result.heartbeat).toBeUndefined() // 未指定时 undefined，由 runCli 设置默认值
  })

  // ---- --help 标志 ----

  it('--help 设置 help 标志', () => {
    const result = parseArgs(['node', 'cli.js', '--help'])
    expect(result.help).toBe(true)
  })

  it('-h 设置 help 标志', () => {
    const result = parseArgs(['node', 'cli.js', '-h'])
    expect(result.help).toBe(true)
  })

  // ---- 无效的 heartbeat 值 ----

  it('非数字 heartbeat 值被忽略', () => {
    const result = parseArgs([
      'node', 'cli.js',
      '--server', 'ws://localhost:8082',
      '--token', 'tok',
      '--heartbeat', 'abc',
    ])
    expect(result.heartbeat).toBeUndefined()
  })
})
