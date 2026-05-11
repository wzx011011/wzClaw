# Contributing to wzxClaw

感谢你对 wzxClaw 的关注！欢迎提交 Issue 和 Pull Request。

## 开发环境设置

### 桌面端

```bash
cd wzxClaw_desktop
npm ci
npm test
npm run dev           # ⚠️ 不要在 VS Code/Cursor 内置终端中运行
```

### Android 端

```bash
cd wzxClaw_android
flutter pub get
flutter analyze --no-fatal-infos
flutter test
```

### 中继服务

```bash
cd relay
npm install
npm test
```

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[optional body]
```

### Type

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构（不新增功能也不修复 Bug） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建/工具变更 |

### Scope

- `desktop` — 桌面端 Electron 应用
- `android` — Android 伴侣应用
- `relay` — WebSocket 中继服务
- `agent` — Agent 循环 / 工具
- `llm` — LLM 网关 / API 适配器
- `ipc` — IPC 通道 / 处理器
- `ui` — 渲染进程 UI 组件
- `mobile` — 移动端通信

## 代码风格

- **TypeScript 优先**：所有新代码使用 TypeScript
- **代码注释**：使用中文
- **格式化**：项目根目录有 `.editorconfig` 和 `.prettierrc`，提交前运行 `npm run format`
- **Lint**：运行 `npm run lint` 检查代码规范

## PR 流程

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 提交变更：遵循 Conventional Commits 格式
4. 确保测试通过：`npm test`
5. 创建 Pull Request，描述变更内容和动机

## 项目结构

```
.
├── wzxClaw_desktop/    # Electron 桌面 IDE
├── wzxClaw_android/    # Flutter Android 应用
├── relay/              # WebSocket 中继服务
└── .github/workflows/  # CI/CD
```

## 报告 Bug

请使用 GitHub Issues，包含以下信息：

- 复现步骤
- 预期行为 vs 实际行为
- 操作系统和版本
- 控制台日志（如有）
