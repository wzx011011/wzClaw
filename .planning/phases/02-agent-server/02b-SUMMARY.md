---
phase: 02-agent-server
plan: 02b
subsystem: hand-routing
tags: [hands-router, tool-executor, websocket, routing]
dependency_graph:
  requires: [02a]
  provides: [HandsRouter, HandAwareToolExecutor, hand-registration, tool-routing]
  affects: [packages/agent-server]
tech_stack:
  added: [ws, crypto.randomUUID]
  patterns: [Map-based-registry, priority-routing, promise-pending-calls, timeout-fallback]
key_files:
  created:
    - packages/agent-server/src/hands-router.ts
    - packages/agent-server/src/hands-router.test.ts
    - packages/agent-server/src/hand-aware-tool-executor.ts
    - packages/agent-server/src/hand-aware-tool-executor.test.ts
  modified:
    - packages/agent-server/src/index.ts
decisions:
  - "先注册优先（priority 自增，越小越高）替代手动 priority 配置"
  - "checkHealth 更新阈值而非主动标记，isHealthy 实时计算"
  - "30s 执行超时、30s 心跳超时使用相同默认值"
  - "未知工具 isReadOnly 返回 false（保守策略）"
  - "handleResult 忽略未知 callId（已超时或已清理的场景）"
metrics:
  duration: 384s
  completed: 2026-05-14
  tasks: 2
  files: 5
  tests: 39
---

# Phase 02 Plan 02b: Hand Routing + Tool Execution Summary

Hand 路由层完整实现：HandsRouter 管理 Hand 注册/路由/健康检查，HandAwareToolExecutor 实现 IToolExecutor 接口将工具调用路由到在线 Hand。

## What Was Built

### Task 1: HandsRouter (24 tests)

Map-based Hand 路由器，管理 Hand 连接的生命周期：

- **register/unregister**: 添加/移除 Hand，自增 priority（先注册优先）
- **findHand(toolName)**: 遍历健康 Hand，返回优先级最高的匹配
- **getAllDefinitions()**: 聚合所有健康 Hand 的工具定义，同名去重保留最高优先级
- **健康检查**: isHealthy 基于 lastHeartbeat 实时计算，30s 超时阈值
- **重复注册**: 同一 handId 覆盖条目但保留原始 priority

### Task 2: HandAwareToolExecutor (15 tests)

IToolExecutor 实现，路由工具调用到在线 Hand：

- **execute()**: findHand → 发送 hand:execute → Promise 等待 hand:result
- **getDefinitions()**: 委托 HandsRouter.getAllDefinitions()
- **isReadOnly()**: 从 Hand 定义中读取，未知工具返回 false
- **超时 fallback**: 30s 无响应返回超时错误
- **断连 fallback**: handleHandDisconnect 清理所有 pending calls

## TDD Gate Compliance

| Gate    | Commit   | Description                         |
|---------|----------|-------------------------------------|
| RED     | fc309f7  | HandsRouter failing tests           |
| GREEN   | 7bc97b4  | HandsRouter implementation          |
| RED     | c972ac3  | HandAwareToolExecutor failing tests |
| GREEN   | 1e451d2  | HandAwareToolExecutor implementation |

All TDD gates satisfied.

## Deviations from Plan

None - plan executed exactly as written.

## Threat Model Compliance

| Threat  | Disposition | Status                                                        |
|---------|-------------|---------------------------------------------------------------|
| T-02b-01 (S) hand:register | accept | Hand 连接通过 Token 认证后注册内容可信 |
| T-02b-02 (D) ToolExecutor   | mitigate | 30s 超时防止 Hand 无响应阻塞 agent |
| T-02b-03 (I) hand:result    | accept | 单用户环境，伪造结果影响有限 |

## Test Results

```
4 test files, 65 tests passed
- auth.test.ts: 10 tests
- hands-router.test.ts: 24 tests
- hand-aware-tool-executor.test.ts: 15 tests
- session-sqlite.test.ts: 16 tests

TypeScript: 0 errors
```

## Self-Check: PASSED

All 6 files verified present. All 3 plan commits verified in git log.
