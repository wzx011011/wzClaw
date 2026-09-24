# Contributing to wzxClaw

单人使用的个人项目，仓库不接收外部 PR；本文件描述仓库自身的开发约定。

## 开发环境设置

### Relay / CLI companion

```bash
cd relay/zcode
npm ci
npm test    # node --test --test-force-exit（子进程/长连接必须 force-exit）
```

### 桌面端（desktop submodule，唯一桌面形态）

```bash
cd desktop
pnpm install
pnpm --filter @zcode/desktop build
# relay 核心变更后先回主仓跑：
node scripts/sync-companion-core.mjs   # 同步 companion-core，双侧同 commit 提交
```

### Android 端

```bash
cd wzxClaw_android
flutter pub get
flutter analyze        # CI 门禁：info 也算失败，必须 0 issues
flutter test
```

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>
```

### Type

`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore` / `build`

### Scope

- `android` — Flutter 手机端
- `relay` — relay / CLI companion（relay/zcode）
- `desktop` — 桌面端（desktop submodule）

## 代码风格

- **代码注释**：使用中文
- **评审规则**：以根 `AGENTS.md` 的「设计原则」「编码规则」两节为准（协议
  字段以实测为准、不留假成功、静默丢弃 = 缺陷等）

## 项目结构

```
.
├── wzxClaw_android/    # Flutter Android 遥控器
├── relay/zcode/        # sid/hash 房间 relay + CLI companion + 探针/测试
├── desktop/            # 开源 ZCode 桌面端 fork（submodule，唯一桌面形态）
└── .github/workflows/  # CI/CD
```

## 报告 Bug

单人项目直接在本仓库 Issue 记录；排查手机端连接问题前先读
`AGENTS.md` 的「外部服务」节（frp 隧道/SNI 过滤的已知坑）。
