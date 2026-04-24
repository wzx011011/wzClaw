#!/usr/bin/env npx tsx
// Debug: 直接实例化 AgentLoop 看详细错误
import { AgentLoop } from '../../src/main/agent/agent-loop'
import { LLMGateway } from '../../src/main/llm/gateway'
import { createDefaultTools } from '../../src/main/tools/tool-registry'
import { PermissionManager } from '../../src/main/permission/permission-manager'
import { ContextManager } from '../../src/main/context/context-manager'
import { prepareWorkspace } from '../../src/eval/workspace-isolation'

const task = {
  id: 'debug-test',
  source: 'test',
  language: 'python',
  difficulty: 'easy',
  description: 'Implement a simple add function that returns the sum of two numbers.',
  startingFiles: {
    'calc.py': 'def add(a, b):\n    pass\n',
    'test_calc.py': 'from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  },
  testCommand: 'cd $WORKSPACE && python -m pytest test_calc.py -v',
  metadata: { category: 'test', split: 'train' },
}

async function main() {
  const workspace = await prepareWorkspace(task)
  console.log('Workspace:', workspace.workspaceDir)

  const gateway = new LLMGateway()
  gateway.addProvider({
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
  })

  const toolRegistry = createDefaultTools(workspace.workspaceDir)
  const permMgr = new PermissionManager()
  permMgr.setMode('bypass')
  const contextMgr = new ContextManager()

  const loop = new AgentLoop(gateway, toolRegistry, permMgr, contextMgr)

  const config = {
    model: 'glm-5-turbo',
    provider: 'anthropic' as const,
    systemPrompt: 'You are a helpful coding assistant.',
    workingDirectory: workspace.workspaceDir,
    conversationId: `debug-${Date.now()}`,
    maxTurns: 3,
  }

  console.log('Starting agent loop...')
  try {
    for await (const event of loop.run(task.description, config) as any) {
      console.log('EVENT:', JSON.stringify(event))
    }
  } catch (err: any) {
    console.error('FATAL ERROR:', err.message)
    console.error('STACK:', err.stack?.slice(0, 3000))
  }

  await workspace.cleanup().catch(() => {})
}
main()
