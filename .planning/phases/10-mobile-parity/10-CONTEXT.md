---
phase: "10-mobile-parity"
created: "2026-05-16"
depends_on: ["06-mobile-capacitor", "07-docker-hand", "08-hand-pluggable"]
---

# Phase 10: 手机端体验回归 Flutter 等价

## 背景

Phase 6 用 Capacitor 壳替换 Flutter，目标是 "**先把聊天打通**"。当前 web-ui mobile 仅有 ChatPanel + Sidebar overlay + Settings；原 Flutter 项目（master）的 **FileBrowserPage / FileViewerPage / DesktopPicker / MicButton / PermissionBar / PlanModeBar / WorkspacePickerCard / StreamingShimmer / AnimatedMessageItem** 全部未补齐。

手机端从"原生 Material 应用"实际降级为"WebView + 一条 @media 断点"。

## 目标

让 Capacitor web-ui mobile 在功能 / 触感 / 视觉上与 master Flutter 对齐：

1. 文件浏览 / 查看（基于 NAS Hand FileList/FileRead）
2. 多 Hand 在线时的 DesktopPicker（选择执行端）
3. 语音输入 MicButton（Capacitor speech-to-text）
4. 浮动 PermissionBar / PlanModeBar（独立显示，不挤压 ChatPanel）
5. 微动效（StreamingShimmer / AnimatedMessageItem / 触感反馈）
6. 底部 Tab 导航（聊天 / 文件 / 会话 / 设置）

## 关键约束

1. **不引入 React Native** — 仍走 Capacitor + Web，复用 web-ui
2. **桌面端不受影响** — 用 capability flag `isMobile && isNative`，移动专用组件不在桌面渲染
3. **离线降级** — 文件浏览页连不上 NAS Hand 时显示 "Hand 离线" 占位，不报错
4. **包体积** — 手机端构建排除 Monaco/xterm（已由 Phase 9 处理），新增功能不超 +200KB gzip

## Decisions

### D-01: Capacitor 原生能力依赖清单

| 能力 | Capacitor 插件 |
|---|---|
| 语音输入 | `@capacitor-community/speech-recognition` |
| 触觉反馈 | `@capacitor/haptics` |
| 状态栏主题 | `@capacitor/status-bar` |
| 文件下载 | `@capacitor/filesystem`（保存查看到的文件到本地） |
| 安全键盘适配 | `@capacitor/keyboard` |
| App 生命周期 | `@capacitor/app` |

### D-02: 移动专用布局（Mobile Shell）

```
┌─────────────────────────┐
│ TopBar (会话标题 + 工具) │
├─────────────────────────┤
│                         │
│   Tab 内容区             │
│                         │
├─────────────────────────┤
│ FloatingBar (浮动通知)   │← PermissionBar / PlanModeBar 浮在内容上方
├─────────────────────────┤
│ [💬聊天][📁文件][⏱会话][⚙] │← BottomTabBar
└─────────────────────────┘
```

桌面端 / 平板（>768px）走 IDELayout（Phase 9）；手机走这个 Shell。由 `useCapabilities().mobileShell` 切换。

### D-03: 文件浏览基于 DataSource.fs

不再单独写 IPC，复用 Phase 9 的 DataSource.fs。手机端 ws-source 把 fs.tree/read 转译成 NAS Hand 的 FileList/FileRead。

### D-04: Capacitor 项目位置

新建 `capacitor/` 根目录（与 `wzxClaw_android/` 并列），不复用 Flutter 项目路径。
- `webDir` 指向 `../packages/web-ui/dist`
- Android Gradle 配置参考 `wzxClaw_android/android/` 中已有配置（SDK/NDK 版本、签名等）
- `wzxClaw_android/` 保持 DEPRECATED 状态，不删除不修改

**Why:** Flutter 和 Capacitor 共享 `android/` 子目录，混合会破坏双方构建系统。独立目录保持清晰分离。

### D-05: 执行范围 — 全部 5 个 Plan 均可执行

本地已安装 Android SDK，wzxClaw_android/android/ 中有可复用的 Gradle/SDK 配置。
所有 5 个 Plan（10-01 到 10-04）均可执行，无需拆分。
Capacitor 原生插件（MicButton/Haptics/StatusBar/Keyboard）在浏览器端用 no-op 降级。

### D-06: DesktopPicker 数据来源

agent-server `/health` 端点（Phase 7）已经返回 hands 信息。扩展为 `GET /admin/hands` 返回 `[{id, type: 'desktop'|'docker', capabilities, priority}]`，UI 选择后用 `chat:send` 带 `targetHandId` 字段。Phase 2 HandsRouter 改为支持目标指定（不强制按 priority）。

## 文件规划（5 个 Plan）

### Plan 10-01: 移动 Shell + 底部 Tab 导航

| 文件 | 用途 |
|---|---|
| `packages/web-ui/src/layouts/MobileShell.tsx` | 移动专用布局容器 |
| `packages/web-ui/src/components/mobile/BottomTabBar.tsx` | 底部 4 Tab |
| `packages/web-ui/src/components/mobile/TopBar.tsx` | 顶部栏 |
| `packages/web-ui/src/components/mobile/FloatingBar.tsx` | 浮动信息条容器 |
| `packages/web-ui/src/hooks/useCapabilities.ts` | 增加 mobileShell flag |
| `packages/web-ui/src/App.tsx` | 路由：mobileShell ? <MobileShell /> : <IDELayout /> |

### Plan 10-02: FileBrowserPage + FileViewerPage（手机文件浏览）

| 文件 | 用途 |
|---|---|
| `packages/web-ui/src/pages/mobile/FileBrowserPage.tsx` | 文件列表（FileList 工具） |
| `packages/web-ui/src/pages/mobile/FileViewerPage.tsx` | 文件预览（FileRead，code/img/text） |
| `packages/web-ui/src/components/mobile/FileItem.tsx` | 列表行 |
| `packages/web-ui/src/components/mobile/PathBreadcrumb.tsx` | 面包屑 |
| `packages/web-ui/src/stores/file-browser-store.ts` | 当前路径 / 历史 / 收藏 |

### Plan 10-03: DesktopPicker + 浮动 PermissionBar / PlanModeBar

| 文件 | 用途 |
|---|---|
| `packages/agent-server/src/admin/hands-list.ts` | GET /admin/hands |
| `packages/agent-server/src/hands-router.ts` | 支持 targetHandId 路由 |
| `packages/web-ui/src/components/mobile/DesktopPicker.tsx` | 多 Hand 选择卡 |
| `packages/web-ui/src/components/mobile/PermissionBar.tsx` | 浮动权限请求条 |
| `packages/web-ui/src/components/mobile/PlanModeBar.tsx` | Plan 模式指示条 |
| `packages/web-ui/src/stores/hand-store.ts` | 在线 Hand 列表 + 当前选择 |

### Plan 10-04: 原生能力：MicButton + Haptics + StatusBar + Keyboard

| 文件 | 用途 |
|---|---|
| `packages/web-ui/src/components/mobile/MicButton.tsx` | 长按录音 → speech-to-text → 填入输入框 |
| `packages/web-ui/src/native/haptics.ts` | 工具调用完成 / 权限请求时触感反馈 |
| `packages/web-ui/src/native/status-bar.ts` | 启动时根据主题设置状态栏 |
| `packages/web-ui/src/native/keyboard.ts` | 键盘弹出时调整 ChatPanel 高度 |
| `packages/web-ui/src/native/index.ts` | 平台 detect + plugin wrapper（web 端降级 no-op） |
| `capacitor/capacitor.config.json` | 注册插件 + 权限声明 |

### Plan 10-05: 微动效 + 视觉一致性

| 文件 | 用途 |
|---|---|
| `packages/web-ui/src/components/chat/StreamingShimmer.tsx` | 流式占位动效 |
| `packages/web-ui/src/components/chat/AnimatedMessageItem.tsx` | 消息进入动画（Framer Motion 或 CSS） |
| `packages/web-ui/src/components/mobile/ConnectionStatusBar.tsx` | 连接状态浮动指示 |
| `packages/web-ui/src/styles/mobile.css` | 重构：补齐 master Flutter 主题 token（间距/圆角/阴影） |
| `packages/web-ui/src/components/mobile/AskUserBar.tsx` | 底部用户问答输入（替代 modal） |

## 验收

- [ ] APK 安装后底部 4 Tab 切换流畅，聊天/文件/会话/设置功能完整
- [ ] 文件 Tab 可浏览 NAS `/data` 目录并打开文本/图片预览
- [ ] 多 Hand 在线时（桌面 + Docker），手机端 DesktopPicker 可选择目标
- [ ] 长按 MicButton 弹出录音 UI，松开后文字进入输入框
- [ ] 工具调用完成时手机有触觉反馈
- [ ] 视觉对照表（10-VISUAL.md）— master Flutter 截图 vs 新版 Capacitor 截图逐屏对比
- [ ] Phase 8 E2E L2 用例 N01-N10 全部通过
- [ ] APK 体积 ≤ 80 MB（master Flutter 69 MB 基线 + Capacitor 开销）

## 风险

- **R-10-1 Capacitor speech-recognition 中文识别精度** — 国产手机 Google Speech 可能不可用，需测试国内/海外双场景，必要时切换厂商 SDK
- **R-10-2 BottomTabBar 抢键盘焦点** — Android 键盘弹出推上来时 Tab 条飘移，需 keyboard 插件配合 `resize: 'native'`
- **R-10-3 视觉一致性主观判断** — 引入 10-VISUAL.md 截图对照，最终由用户审核而非自动化
- **R-10-4 浏览器端能力降级** — MicButton/Haptics 在 PC 浏览器调试时要 graceful no-op，不能 throw
- **R-10-5 多 Hand 路由破坏现有协议** — `targetHandId` 是新字段，桌面 Hand Bridge 需兼容（旧版无字段时回退 priority）
