---
phase: 01-brain-hands-separation
plan: 04
type: execute
wave: 4
depends_on: ["01-brain-hands-separation-01", "01-brain-hands-separation-02", "01-brain-hands-separation-03"]
files_modified:
  - wzxClaw_desktop/src/main/brain-bridge.ts
  - wzxClaw_desktop/src/main/brain-adapters.ts
  - wzxClaw_desktop/src/main/agent/agent-loop.ts
  - wzxClaw_desktop/src/main/agent/turn-manager.ts
  - wzxClaw_desktop/src/main/ipc-handlers.ts
autonomous: false
requirements: [INFRA-08, INFRA-09]

must_haves:
  truths:
    - "桌面端通过适配器使用 brain 包的 AgentLoop"
    - "桌面端所有现有功能（聊天、工具执行、会话管理）保持正常"
    - "brain 包的 npm test 通过"
    - "桌面端 npm test 通过"
  artifacts:
    - path: "wzxClaw_desktop/src/main/brain-bridge.ts"
      provides: "桌面端到 brain 包的桥接层"
      exports: ["createDesktopAgentLoop"]
    - path: "wzxClaw_desktop/src/main/brain-adapters.ts"
      provides: "Electron 特定接口适配器实现"
      exports: ["DesktopEventSender", "DesktopObservability", "DesktopToolExecutor"]
  key_links:
    - from: "wzxClaw_desktop/src/main/brain-bridge.ts"
      to: "packages/brain/src/index.ts"
      via: "import { AgentLoop, IEventSender, ... } from '@wzxclaw/brain'"
      pattern: "from.*@wzxclaw/brain"
    - from: "wzxClaw_desktop/src/main/brain-bridge.ts"
      to: "wzxClaw_desktop/src/main/llm/gateway.ts"
      via: "LLMGateway 实现 IStreamProvider"
      pattern: "LLMGateway"
---

<objective>
创建桌面端适配器层，桥接 Electron 服务到 brain 包的接口，然后切换桌面端使用 brain 包。

Purpose: 验证 brain 包提取的完整性。如果适配器能无缝桥接所有桌面端功能，说明接口设计正确、提取完整。
Output: 桌面端通过 @wzxclaw/brain 包运行，所有现有功能保持正常。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md

<!-- 依赖 Plan 01-03 的产出 -->
@packages/brain/src/index.ts
@packages/brain/src/interfaces.ts
@packages/brain/src/agent/agent-loop.ts
@packages/brain/src/agent/turn-manager.ts

<!-- 桌面端现有代码 -->
@wzxClaw_desktop/src/main/agent/agent-loop.ts
@wzxClaw_desktop/src/main/agent/turn-manager.ts
@wzxClaw_desktop/src/main/ipc-handlers.ts
@wzxClaw_desktop/src/main/llm/gateway.ts
@wzxClaw_desktop/src/main/permission/permission-manager.ts
@wzxClaw_desktop/src/main/context/context-manager.ts
@wzxClaw_desktop/src/main/observability/langfuse-observer.ts
@wzxClaw_desktop/src/main/hooks/hook-registry.ts
@wzxClaw_desktop/src/main/tools/tool-registry.ts
@wzxClaw_desktop/package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: 创建桌面端适配器 + 桥接层</name>
  <files>
    wzxClaw_desktop/src/main/brain-bridge.ts,
    wzxClaw_desktop/src/main/brain-adapters.ts,
    wzxClaw_desktop/package.json
  </files>
  <read_first>
    wzxClaw_desktop/src/main/agent/agent-loop.ts
    wzxClaw_desktop/src/main/agent/turn-manager.ts
    wzxClaw_desktop/src/main/llm/gateway.ts
    wzxClaw_desktop/src/main/permission/permission-manager.ts
    wzxClaw_desktop/src/main/context/context-manager.ts
    wzxClaw_desktop/src/main/observability/langfuse-observer.ts
    wzxClaw_desktop/src/main/hooks/hook-registry.ts
    wzxClaw_desktop/src/main/tools/tool-registry.ts
    wzxClaw_desktop/package.json
    packages/brain/src/interfaces.ts
    packages/brain/src/agent/agent-loop.ts
  </read_first>
  <action>
1. 在 `wzxClaw_desktop/package.json` 添加依赖:
   ```json
   "@wzxclaw/brain": "file:../packages/brain"
   ```

2. 创建 `brain-adapters.ts` — Electron 特定接口实现:
   - `DesktopEventSender implements IEventSender`:
     - 包装 Electron.WebContents
     - send() 调用 webContents.send()
     - isDestroyed() 调用 webContents.isDestroyed()
   - `DesktopObservability implements IObservability`:
     - 委托给 langfuse-observer 模块的 startTrace/endTrace/getActiveTrace
   - `DesktopLogger implements ILogger`:
     - 委托给 DebugLogger（使用 Electron 路径）
   - `DesktopToolExecutor` — 不需要单独实现，因为 executeTool 闭包在 bridge 中创建:
     - bridge 中创建的 executeTool 闭包复用现有的 createExecuteToolFn 逻辑
     - 但该逻辑从 TurnManager 移出，在 bridge 层组装

3. 创建 `brain-bridge.ts` — 工厂函数:
   ```typescript
   import { AgentLoop } from '@wzxclaw/brain'
   // 或使用相对路径: import { AgentLoop } from '../../../packages/brain/src'

   export function createDesktopAgentLoop(deps: {
     gateway: LLMGateway
     toolRegistry: ToolRegistry
     permissionManager: PermissionManager
     contextManager: ContextManager
     hookRegistry?: HookRegistry
     historyManager?: FileHistoryManager
   }): AgentLoop {
     // 1. 创建适配器
     const eventSender = ... // 会在 run() 时创建，因为需要 WebContents
     const observability = new DesktopObservability()
     const logger = new DesktopLogger()

     // 2. 创建 AgentLoop（使用 brain 包的构造函数）
     return new AgentLoop(
       deps.gateway as IStreamProvider,    // LLMGateway 实现 IStreamProvider
       deps.contextManager as IContextManager,
       observability,
       deps.hookRegistry as IHookRegistry | undefined,
       logger,
     )
   }

   // 创建桌面端特有的 executeTool 闭包
   // 这段逻辑从 TurnManager.createExecuteToolFn() 搬过来
   export function createDesktopExecuteToolFn(deps: {
     toolRegistry: ToolRegistry
     permissionManager: PermissionManager
     contextManager: ContextManager
     hookRegistry?: HookRegistry
     historyManager?: FileHistoryManager
     config: AgentConfig
     abortSignal: AbortSignal
     sender?: Electron.WebContents
     workspaceId?: string
     replacementState?: ToolResultReplacementState
   }): ExecuteToolFn {
     // 搬移 TurnManager.createExecuteToolFn() 的完整逻辑到这里
     // 这是桌面端特有的工具执行逻辑（含权限审批、文件快照、Langfuse span 等）
   }
   ```

4. 关键设计决策:
   - 桌面端现有的 `src/main/agent/agent-loop.ts` 暂时保留不动
   - 新的 bridge 层创建 brain 包的 AgentLoop 实例
   - 通过 feature flag 或渐进式切换：
     - 方案 A: 直接替换 ipc-handlers.ts 中的引用（推荐，简单直接）
     - 方案 B: 添加 import alias
   - 选择方案 A: 修改 ipc-handlers.ts 中对 AgentLoop 的引用，从本地模块改为 brain-bridge

5. 确保桌面端现有测试仍然通过（不修改测试文件）
  </action>
  <verify>
    <automated>cd wzxClaw_desktop && npm install && npx tsc --noEmit && echo "OK"</automated>
  </verify>
  <done>
    - brain-adapters.ts 实现所有 brain 包接口
    - brain-bridge.ts 创建 brain AgentLoop + executeTool 闭包
    - 桌面端 tsc 编译通过
    - package.json 引用 @wzxclaw/brain
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: 验证桌面端功能完整</name>
  <what-built>桌面端通过 brain 包适配器桥接，AgentLoop 从 packages/brain/ 运行而非本地 src/main/agent/。</what-built>
  <how-to-verify>
    1. 运行桌面端测试: `cd wzxClaw_desktop && npm test`
       - 所有现有测试通过
    2. 运行 brain 包测试: `cd packages/brain && npm test`
       - 所有 brain 测试通过
    3. 启动桌面端: `cd wzxClaw_desktop && npm run dev`
       - 打开一个 chat session
       - 发送简单消息（如 "hello"），确认收到 AI 回复
       - 测试工具调用：发送 "list files in current directory"，确认 FileRead/Bash 工具正常执行
       - 测试取消：发送长任务，中途点 Cancel，确认正常中止
    4. 确认 console 无 "Electron" 相关错误来自 brain 包
  </how-to-verify>
  <resume-signal>Type "approved" if desktop works correctly, or describe specific issues</resume-signal>
</task>

</tasks>

<verification>
cd packages/brain && npm test
cd wzxClaw_desktop && npm test
</verification>

<success_criteria>
- packages/brain/ 的 npm test 通过
- wzxClaw_desktop/ 的 npm test 通过
- 桌面端通过适配器使用 brain 包，聊天功能正常
- 工具执行正常（FileRead、Bash、Grep 等）
- 会话管理正常（创建、切换、删除）
</success_criteria>

<output>
After completion, create `.planning/phases/01-brain-hands-separation/01d-SUMMARY.md`
</output>
