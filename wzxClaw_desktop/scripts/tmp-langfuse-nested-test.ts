#!/usr/bin/env npx tsx
// ============================================================
// Langfuse Nested Span E2E 验证脚本
// 验证子 Agent 的 observations 是否正确挂载到父 trace 的 tool:Agent span 下
//
// 运行: cd wzxClaw_desktop && npx tsx scripts/tmp-langfuse-nested-test.ts
// ============================================================

import { AgentLoop } from '../src/main/agent/agent-loop'
import { LLMGateway } from '../src/main/llm/gateway'
import { createDefaultTools } from '../src/main/tools/tool-registry'
import { AgentTool } from '../src/main/tools/agent-tool'
import { PermissionManager } from '../src/main/permission/permission-manager'
import { ContextManager } from '../src/main/context/context-manager'
import { flushLangfuse } from '../src/main/observability/langfuse-observer'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000'
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-1e84dc06-43e9-4721-b2d9-f6b3134e1cc0'
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-53c306d4-557b-4893-a2d2-f5a2683f0d8e'

const authHeader = 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')

async function langfuseGet(path: string) {
  const res = await fetch(`${LANGFUSE_BASE_URL}${path}`, {
    headers: { Authorization: authHeader }
  })
  if (!res.ok) throw new Error(`Langfuse API ${path} → ${res.status} ${res.statusText}`)
  return res.json() as Promise<any>
}

async function main() {
  console.log('=== Langfuse Nested Span E2E Test ===\n')

  // 临时工作目录
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzx-nested-'))
  fs.writeFileSync(path.join(workDir, 'hello.txt'), 'Hello from nested span test!\n')
  console.log('Work dir:', workDir)

  // 记录开始时间
  const startTime = new Date()
  const conversationId = `nested-test-${Date.now()}`
  console.log('conversationId:', conversationId)
  console.log('Start time:', startTime.toISOString())
  console.log()

  // 初始化 LLMGateway
  const gateway = new LLMGateway()
  gateway.addProvider({
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://open.bigmodel.cn/api/anthropic',
  })

  const toolRegistry = createDefaultTools(workDir)
  const permMgr = new PermissionManager()
  permMgr.setMode('bypass')
  const contextMgr = new ContextManager()

  // 注册 AgentTool，用于触发 sub-agent
  const baseConfig = {
    provider: 'anthropic' as const,
    model: process.env.TEST_MODEL ?? 'glm-5-turbo',
    workingDirectory: workDir,
    projectRoots: [workDir],
  }
  toolRegistry.register(
    new AgentTool(gateway as any, toolRegistry, permMgr, contextMgr, undefined, baseConfig)
  )

  const loop = new AgentLoop(gateway, toolRegistry, permMgr, contextMgr)

  const config = {
    model: process.env.TEST_MODEL ?? 'glm-5-turbo',
    provider: 'anthropic' as const,
    systemPrompt: 'You are a helpful assistant. When asked to explore files, use the Agent tool to spawn a sub-agent that reads files.',
    workingDirectory: workDir,
    projectRoots: [workDir],
    conversationId,
    maxTurns: 5,
  }

  // 触发 sub-agent 的 prompt：明确要求使用 Agent 工具
  const prompt = `Use the Agent tool to spawn a sub-agent of type "explore" to read the file "hello.txt" in the current directory. Then report what the file contains.`

  console.log('Running agent...')
  let eventCount = 0
  let usedSubAgent = false
  try {
    for await (const event of loop.run(prompt, config) as any) {
      eventCount++
      if (event.type === 'agent:tool_call' && event.toolName === 'Agent') {
        usedSubAgent = true
        console.log('  ✓ Sub-agent spawned (Agent tool called)')
      } else if (event.type === 'agent:done') {
        console.log(`  ✓ Agent done: ${event.usage.inputTokens} input / ${event.usage.outputTokens} output tokens, ${event.turnCount} turns`)
      }
    }
  } catch (err: any) {
    console.error('Agent error:', err.message)
  }

  if (!usedSubAgent) {
    console.warn('\n⚠ Sub-agent was NOT invoked — the model did not call the Agent tool.')
    console.warn('  Nested span validation will be skipped (no nested observations to check).')
    console.warn('  Try running again or check model capability.\n')
  }

  // Flush Langfuse
  console.log('\nFlushing Langfuse...')
  await flushLangfuse()
  await new Promise(r => setTimeout(r, 4000))  // 等待 Langfuse 落库

  // ---- Langfuse API 验证 ----
  console.log('\n--- Langfuse API Validation ---')

  // 拉取最近 trace（先按 sessionId 直接查，不过滤时间——避免 API 版本差异）
  const tracesResp = await langfuseGet(`/api/public/traces?limit=20`)
  const traces: any[] = tracesResp.data ?? []
  console.log(`Total recent traces: ${traces.length}`)
  if (traces.length > 0) {
    console.log('Recent session IDs:', traces.slice(0, 5).map((t: any) => t.sessionId))
  }

  const targetTrace = traces.find((t: any) => t.sessionId === conversationId)
  if (!targetTrace) {
    console.error('✗ Target trace not found in Langfuse!')
    console.log('All traces:', traces.map((t: any) => ({ id: t.id, sessionId: t.sessionId, name: t.name })))
    process.exit(1)
  }

  console.log(`✓ Trace found: id=${targetTrace.id}, sessionId=${targetTrace.sessionId}`)
  console.log(`  input: ${JSON.stringify(targetTrace.input)?.slice(0, 80)}`)
  console.log(`  output: ${JSON.stringify(targetTrace.output)?.slice(0, 80)}`)

  // 拉取该 trace 的 observations
  const obsResp = await langfuseGet(`/api/public/observations?traceId=${targetTrace.id}&limit=50`)
  const observations: any[] = obsResp.data ?? []
  console.log(`\nObservations in trace ${targetTrace.id}: ${observations.length}`)

  const agentSpan = observations.find((o: any) => o.name === 'tool:Agent')
  const regularTurns = observations.filter((o: any) => o.name?.startsWith('turn-'))
  const subTurns = observations.filter((o: any) => o.name?.startsWith('sub-turn-'))
  const toolSpans = observations.filter((o: any) => o.name?.startsWith('tool:') && o.name !== 'tool:Agent')

  console.log(`\nObservation breakdown:`)
  console.log(`  turn-N generations: ${regularTurns.length}`)
  console.log(`  tool:Agent span: ${agentSpan ? '✓ found' : '✗ not found'}`)
  console.log(`  sub-turn-N generations (nested): ${subTurns.length}`)
  console.log(`  other tool spans: ${toolSpans.length}`)

  if (usedSubAgent) {
    // 验证 nested 关系
    if (!agentSpan) {
      console.error('\n✗ FAIL: tool:Agent span missing from trace observations!')
      process.exit(1)
    }

    if (subTurns.length === 0) {
      console.error('\n✗ FAIL: No sub-turn-N generations found — nested span not working!')
      console.log('\nAll observations:')
      for (const o of observations) {
        console.log(`  name=${o.name}, type=${o.type}, parentObservationId=${o.parentObservationId}`)
      }
      process.exit(1)
    }

    // 验证 sub-turn 的 parentObservationId = agentSpan.id
    const wrongParent = subTurns.filter((o: any) => o.parentObservationId !== agentSpan.id)
    if (wrongParent.length > 0) {
      console.error(`\n✗ FAIL: ${wrongParent.length} sub-turn(s) have wrong parentObservationId!`)
      for (const o of wrongParent) {
        console.error(`  ${o.name}: parentObservationId=${o.parentObservationId}, expected=${agentSpan.id}`)
      }
      process.exit(1)
    }

    console.log(`\n✓ PASS: All ${subTurns.length} sub-turn generation(s) correctly nested under tool:Agent span (id=${agentSpan.id})`)
  }

  // 汇总
  console.log('\n=== Summary ===')
  console.log(`Trace ID: ${targetTrace.id}`)
  console.log(`Session ID: ${targetTrace.sessionId}`)
  console.log(`Total observations: ${observations.length}`)
  if (usedSubAgent && agentSpan) {
    console.log(`tool:Agent span ID: ${agentSpan.id}`)
    console.log(`Sub-agent generations: ${subTurns.length} (all nested ✓)`)
    console.log(`\n✅ Nested span E2E PASSED`)
  } else if (!usedSubAgent) {
    console.log(`\n⚠ Nested span E2E SKIPPED (sub-agent not invoked)`)
  }

  // 清理临时目录
  fs.rmSync(workDir, { recursive: true, force: true })
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
