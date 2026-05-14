---
phase: "07-docker-hand"
created: "2026-05-14"
---

# Phase 7: Docker Hand -- NAS 本地沙箱

## 背景

wzxClaw 的 Brain-Hands 架构已完成核心迁移（Phase 1-6）。当前架构：

- **Brain** 运行在 NAS Docker 容器中（`packages/agent-server/`），端口 8082，nginx 反代 `wss://5945.top/agent/`
- **桌面 Hand** 内嵌在 Electron 中，通过 Hand Bridge 连接 Brain
- **手机端** 通过 Capacitor 壳的 web-ui 直连 NAS Brain

**问题**: 桌面端关机后，手机发送消息时 Brain 无法执行工具（没有 Hand 在线），Agent 只有文字回复能力。

**Phase 7 目标**: 在 NAS 上运行 Docker Hand 容器，与 agent-server 同宿主机，桌面离线时手机仍可使用 Agent 执行文件操作和命令。

## 关键约束

1. **NAS 资源有限** — Alpine 镜像，轻量级，单进程
2. **同宿主机通信** — Hand 连接 agent-server 通过 `ws://localhost:8082/`（无需 TLS）
3. **共享 AUTH_TOKEN** — Docker Hand 与 agent-server 使用相同 token（环境变量注入）
4. **容器隔离** — NAS 卷挂载提供文件访问，ShellExecute 在容器沙箱中执行
5. **优先级路由** — HandsRouter 按注册顺序分配 priority，Docker Hand 应晚于桌面 Hand（桌面优先）

## 已有基础设施

### @wzxclaw/hand 包（Phase 3 产出）

- `HandConnection` — WebSocket 连接管理（注册/心跳/重连）
- `LocalToolExecutor` — 工具注册和执行框架（`HandTool` 接口）
- `runCli()` / `parseArgs()` — CLI 入口（支持 `--server` / `--token` / `--id`）
- EchoTool 是唯一内置工具

### agent-server HandsRouter（Phase 2 产出）

- 按 priority 路由工具调用（先注册优先）
- 心跳健康检查（30s 超时）
- `getAllDefinitions()` 聚合所有在线 Hand 的工具定义

### Docker 部署参考

- agent-server Dockerfile: 两阶段构建 `node:20-alpine`，含 better-sqlite3 native binding
- relay Dockerfile: 单阶段 `node:20-alpine`，简单 COPY + `CMD ["node", "server.js"]`
- docker-compose: environment + ports + restart: unless-stopped

## Decisions

### D-01: Docker Hand 复用 @wzxclaw/hand 包
- 不创建新包，而是创建 `packages/hand/tools/` 目录存放 NAS 工具实现
- Docker Hand 入口文件 `packages/hand/docker-entry.ts` 组装工具并启动连接

### D-02: NAS 工具集
NAS Docker Hand 注册以下工具：

| 工具名 | 功能 | 只读 |
|--------|------|------|
| FileRead | 读取 NAS 卷上的文件内容 | Yes |
| FileWrite | 写入/创建文件到 NAS 卷 | No |
| FileList | 列出目录内容（含文件大小/修改时间） | Yes |
| ShellExecute | 在容器中执行 shell 命令 | No |

WebSearch / WebFetch 不包含在 Phase 7 — 这些需要外部 API key 配置，属于后续增强。

### D-03: Docker 部署方式
- 独立 `docker-compose.hand.yml`，与 agent-server 分开容器
- 通过 Docker 网络 `wzxclaw` 连接（或直接 `--network host`）
- NAS 卷挂载: `/nas-data:/data` 提供持久化文件访问

### D-04: Docker Hand ID 格式
- `hand-docker-nas-{timestamp}` — 明确标识为 NAS Docker Hand
- 用于 HandsRouter 路由表中的识别和调试

### D-05: ShellExecute 安全限制
- 超时 30 秒
- 禁止的命令前缀: `rm -rf /`, `mkfs`, `dd if=`（容器内安全兜底）
- 工作目录限制在挂载卷内

## 工具接口定义

### FileRead
```typescript
{
  name: "FileRead",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径（NAS 卷内）" },
      encoding: { type: "string", description: "编码，默认 utf-8" },
      startLine: { type: "number", description: "起始行号（可选）" },
      endLine: { type: "number", description: "结束行号（可选）" },
    },
    required: ["path"],
  },
  isReadOnly: true,
}
// 输出: 文件内容文本（带行号）
```

### FileWrite
```typescript
{
  name: "FileWrite",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      content: { type: "string", description: "写入内容" },
      createDirs: { type: "boolean", description: "是否自动创建父目录" },
      append: { type: "boolean", description: "追加模式（默认覆盖）" },
    },
    required: ["path", "content"],
  },
  isReadOnly: false,
}
// 输出: 成功/失败消息 + 写入字节数
```

### FileList
```typescript
{
  name: "FileList",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径" },
      recursive: { type: "boolean", description: "是否递归列出子目录" },
      pattern: { type: "string", description: "文件名 glob 模式（可选）" },
    },
    required: ["path"],
  },
  isReadOnly: true,
}
// 输出: JSON 数组 [{name, path, size, isDir, modified}]
```

### ShellExecute
```typescript
{
  name: "ShellExecute",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      timeout: { type: "number", description: "超时秒数（默认 30）" },
      cwd: { type: "string", description: "工作目录（默认 /data）" },
    },
    required: ["command"],
  },
  isReadOnly: false,
}
// 输出: {stdout, stderr, exitCode}
```

## 依赖关系

- **Phase 3** (@wzxclaw/hand 包): HandConnection + LocalToolExecutor + HandTool 接口
- **Phase 6** (手机端): 手机连接 NAS Brain 后需要 Hand 在线才能使用工具
- agent-server Docker 部署已就绪，HandsRouter 已支持多 Hand 路由

## 文件规划

| 文件 | 用途 |
|------|------|
| `packages/hand/tools/file-read.ts` | FileRead 工具实现 |
| `packages/hand/tools/file-write.ts` | FileWrite 工具实现 |
| `packages/hand/tools/file-list.ts` | FileList 工具实现 |
| `packages/hand/tools/shell-execute.ts` | ShellExecute 工具实现 |
| `packages/hand/tools/index.ts` | 工具 barrel export |
| `packages/hand/docker-entry.ts` | Docker Hand 入口（组装工具 + 启动连接） |
| `packages/hand/docker-entry.test.ts` | 入口集成测试 |
| `packages/hand/Dockerfile` | Docker Hand 镜像构建 |
| `packages/hand/docker-compose.hand.yml` | Docker Compose 配置 |
| `packages/hand/tools/file-read.test.ts` | FileRead 测试 |
| `packages/hand/tools/file-write.test.ts` | FileWrite 测试 |
| `packages/hand/tools/file-list.test.ts` | FileList 测试 |
| `packages/hand/tools/shell-execute.test.ts` | ShellExecute 测试 |
