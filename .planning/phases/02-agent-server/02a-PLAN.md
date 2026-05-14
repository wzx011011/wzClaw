---
phase: 02-agent-server
plan: 02a
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/agent-server/package.json
  - packages/agent-server/tsconfig.json
  - packages/agent-server/src/index.ts
  - packages/agent-server/src/auth.ts
  - packages/agent-server/src/session-sqlite.ts
  - packages/agent-server/src/types.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "agent-server 包可通过 npm install 安装依赖无报错"
    - "SessionStoreSqlite 可创建会话、追加消息、加载消息、列出会话、删除会话"
    - "Token 认证拒绝无效 token、接受有效 token"
    - "SQLite 使用 WAL 模式，并发读写不阻塞"
  artifacts:
    - path: "packages/agent-server/package.json"
      provides: "Package manifest with ws, better-sqlite3 dependencies"
    - path: "packages/agent-server/src/auth.ts"
      provides: "Token authentication module"
      exports: ["initAuth", "authenticate"]
    - path: "packages/agent-server/src/session-sqlite.ts"
      provides: "SQLite-backed session store"
      exports: ["SessionStoreSqlite"]
    - path: "packages/agent-server/src/types.ts"
      provides: "Server-specific type definitions"
    - path: "packages/agent-server/src/index.ts"
      provides: "Barrel exports"
  key_links:
    - from: "packages/agent-server/src/session-sqlite.ts"
      to: "packages/brain/src/interfaces.ts"
      via: "implements ISessionStore"
      pattern: "implements ISessionStore"
---

<objective>
创建 agent-server 包脚手架、Token 认证模块和 SQLite 会话存储。

Purpose: 建立 agent-server 的基础设施 —— 包结构、认证、会话持久化。这些是后续所有服务器功能的依赖项。
Output: 可编译的 agent-server 包，包含 Token 认证和 SQLite 会话存储。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/01-brain-hands-separation/01a-SUMMARY.md
@.planning/phases/01-brain-hands-separation/01b-SUMMARY.md

<interfaces>
<!-- Brain 包 DI 接口 — session-sqlite 需要实现 ISessionStore -->

From packages/brain/src/interfaces.ts:
```typescript
export interface ISessionStore {
  appendMessage(sessionId: string, message: unknown): Promise<void>
  loadSession(sessionId: string): Promise<unknown[]>
  listSessions(): Promise<Array<{ id: string; title: string; updatedAt: number }>>
  deleteSession(sessionId: string): Promise<void>
}
```

From packages/brain/src/types.ts:
```typescript
export type Message = UserMessage | AssistantMessage | ToolResultMessage
```

From packages/brain/src/agent/types.ts:
```typescript
export interface AgentConfig {
  model: string
  provider: LLMProvider
  systemPrompt: string
  workingDirectory: string
  projectRoots: string[]
  conversationId: string
  maxTurns?: number
  maxBudgetTokens?: number
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'
  langfuseParentSpan?: unknown
}
```

Relay 认证模式 (relay/lib/auth.js):
- init() 检查 AUTH_TOKEN 环境变量，未设置则 dev mode
- authenticate(token) 使用 crypto.timingSafeEqual
- Token 来源: Sec-WebSocket-Protocol header 或 query string
</interfaces>

<!-- 参考现有 relay 认证实现 -->
@relay/lib/auth.js
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: 初始化 agent-server 包 + Token 认证</name>
  <files>
    packages/agent-server/package.json,
    packages/agent-server/tsconfig.json,
    packages/agent-server/vitest.config.ts,
    packages/agent-server/src/types.ts,
    packages/agent-server/src/auth.ts,
    packages/agent-server/src/auth.test.ts,
    packages/agent-server/src/index.ts
  </files>
  <behavior>
    - auth.initAuth() 未设 AUTH_TOKEN → dev mode=true，authenticate 任何非空 token 返回 ok
    - auth.initAuth() 设 AUTH_TOKEN=abc → authenticate("abc") 返回 ok，authenticate("wrong") 返回拒绝
    - auth.authenticate("") / auth.authenticate(null) → 拒绝 (missing token)
    - auth.authenticate(undefined) → 拒绝 (missing token)
  </behavior>
  <read_first>
    packages/brain/package.json,
    packages/brain/tsconfig.json,
    relay/lib/auth.js
  </read_first>
  <action>
    1. 创建 packages/agent-server/ 目录结构。

    2. package.json:
       - name: "@wzxclaw/agent-server"
       - type: "module"
       - dependencies: "@wzxclaw/brain" (workspace:*), "ws" (^8.18.0), "better-sqlite3" (^11.0.0)
       - devDependencies: "typescript" (^5.7.0), "vitest" (^3.0.0), "@types/node" (^22.0.0), "@types/better-sqlite3" (^7.6.0), "@types/ws" (^8.5.0)

    3. tsconfig.json: 复制 brain 包的配置但改为 NodeNext + ES2022，outDir 改为 ./dist。添加 paths 别名 "@/*" -> ["./src/*"]。

    4. vitest.config.ts: 与 brain 包相同模式。

    5. src/types.ts: 定义服务器专用类型：
       - ClientConnection: { ws, sessionId?, connectedAt }
       - HandConnection: { ws, id, capabilities, definitions, lastHeartbeat }
       - ServerMessage: { event: string; data?: unknown } — 所有 WebSocket 消息的通用信封
       - ServerConfig: { port, authToken?, dbPath, systemPrompt? }

    6. src/auth.ts: 将 relay/lib/auth.js 的认证逻辑移植为 TypeScript ESM 模块。
       - initAuth(): 读取 AUTH_TOKEN 环境变量，设置 _devMode 标志
       - authenticate(token: string): { ok: boolean; reason: string }
       - 使用 crypto.timingSafeEqual 进行 timing-safe 比较
       - 保持 dev mode fallback 行为（无 AUTH_TOKEN 时接受任何 token）
       - 注意：代码注释用中文

    7. src/auth.test.ts: 编写测试覆盖所有 behavior 条目。

    8. src/index.ts: barrel export，导出 auth、types、后续的 session-sqlite 等。
  </action>
  <verify>
    <automated>cd packages/agent-server && npx vitest run src/auth.test.ts</automated>
  </verify>
  <done>
    - package.json 可 npm install 无报错
    - npx tsc --noEmit 编译通过
    - auth.test.ts 全部通过
    - auth 模块在 dev mode 和 production mode 都正确验证 token
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: SessionStoreSqlite — SQLite 会话持久化</name>
  <files>
    packages/agent-server/src/session-sqlite.ts,
    packages/agent-server/src/session-sqlite.test.ts,
    packages/agent-server/src/index.ts
  </files>
  <behavior>
    - new SessionStoreSqlite(":memory:") 创建内存数据库
    - appendMessage("s1", {role:"user",content:"hello"}) 后 loadSession("s1") 返回包含该消息的数组
    - listSessions() 返回空数组（无会话时）
    - appendMessage 后 listSessions() 返回 [{id, title, updatedAt}]
    - deleteSession("s1") 后 loadSession("s1") 返回空数组
    - loadSession("不存在") 返回空数组（不报错）
    - WAL 模式: db.pragma("journal_mode=WAL") 已设置
  </behavior>
  <read_first>
    packages/brain/src/interfaces.ts,
    packages/brain/src/types.ts
  </read_first>
  <action>
    1. 创建 src/session-sqlite.ts，实现 ISessionStore 接口。

    2. 使用 better-sqlite3（同步 API，无需 async，但接口要求 Promise 返回值，内部用 Promise.resolve 包装）。

    3. 表结构设计:
       - sessions 表: id TEXT PRIMARY KEY, title TEXT DEFAULT '', updated_at INTEGER
       - messages 表: session_id TEXT, seq INTEGER, message TEXT (JSON), FOREIGN KEY(session_id) REFERENCES sessions(id)
       - (session_id, seq) 联合主键

    4. 构造函数 SessionStoreSqlite(dbPath: string):
       - 打开数据库，设置 WAL 模式: db.pragma("journal_mode=WAL")
       - 创建表（CREATE TABLE IF NOT EXISTS）
       - 为性能创建索引

    5. appendMessage(sessionId, message):
       - 如果 sessions 表无该 sessionId，INSERT 新 session（title 取 message.content 前 50 字符）
       - INSERT INTO messages，seq 自增
       - UPDATE sessions SET updated_at = current timestamp

    6. loadSession(sessionId):
       - SELECT message FROM messages WHERE session_id = ? ORDER BY seq
       - 返回 JSON.parse 后的消息数组

    7. listSessions():
       - SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC

    8. deleteSession(sessionId):
       - DELETE FROM messages WHERE session_id = ?
       - DELETE FROM sessions WHERE id = ?
       - 使用事务保证原子性

    9. 编写 session-sqlite.test.ts，使用 ":memory:" 数据库，覆盖所有 behavior 条目。

    10. 更新 src/index.ts 导出 SessionStoreSqlite。
  </action>
  <verify>
    <automated>cd packages/agent-server && npx vitest run src/session-sqlite.test.ts</automated>
  </verify>
  <done>
    - SessionStoreSqlite 实现 ISessionStore 接口全部 4 个方法
    - WAL 模式已设置
    - 所有测试通过（内存数据库）
    - TypeScript 编译无错误
    - index.ts 导出 SessionStoreSqlite
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Network → auth | Token 从 WebSocket header/query 进入，必须验证 |
| SQLite → filesystem | 数据库文件路径需控制，防路径遍历 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02a-01 | S | auth.authenticate | mitigate | Timing-safe token comparison via crypto.timingSafeEqual |
| T-02a-02 | T | auth.authenticate | mitigate | 确保不记录 token 值到日志，仅记录前 4 字符 |
| T-02a-03 | I | session-sqlite | accept | 单用户 NAS 环境，无多租户隔离需求 |
| T-02a-04 | D | session-sqlite | mitigate | SQLite WAL 模式保证崩溃恢复 |
</threat_model>

<verification>
```bash
cd packages/agent-server
npm install
npx tsc --noEmit
npx vitest run
```
</verification>

<success_criteria>
- agent-server 包可 npm install + tsc --noEmit 通过
- auth.test.ts 全部通过：dev mode 接受任意 token，production mode 验证 AUTH_TOKEN
- session-sqlite.test.ts 全部通过：CRUD 操作正确，WAL 模式设置
- 零 Electron 依赖
</success_criteria>

<output>
After completion, create `.planning/phases/02-agent-server/02a-SUMMARY.md`
</output>
