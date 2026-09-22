# wzxClaw

个人 AI 远程控制系统。现役运行时统一为 ZCode app-server；Android 是遥控端，大脑节点（companion + ZCode app-server 子进程）可安装在任意环境——桌面形态唯一为开源 ZCode 桌面端 fork（`desktop` submodule），双方通过自托管 NAS relay 会合。工具执行发生在大脑节点所在机器，relay 只负责认证、房间和双向转发。

## 当前架构

```text
Android App（Flutter，纯遥控器）
  └─ WSS + sid/hash 配对
       └─ NAS relay: wss://zcode.5945.top/ws
            └─ 大脑节点 = 桌面端（desktop submodule，内嵌 companion-core）
                 或 relay/zcode/companion.js（CLI 常驻）
                 └─ ZCode app-server 子进程
```

配对二维码或链接中的 `sid`/`hash` 是持有者凭据，不应写入日志、提交到 Git 或在公开渠道传递。房间身份由 companion 持久化，正常重启和重连无需重新扫码。

## 产品地图

| 路径 | 状态 | 职责 |
|---|---|---|
| `wzxClaw_android/` | 现役 | Flutter 手机遥控器；聊天、会话、权限、文件、Git 与多节点切换 |
| `desktop/`（submodule） | 现役 | 唯一桌面形态：开源 ZCode 桌面端 fork（wzx011011/ZCode，分支 `feat/wzxcompanion-integration`），内嵌 companion-core（逐字拷贝自 `relay/zcode`）——扫码配对、桌面宠物、完整 IDE 三合一 |
| `relay/zcode/` | 现役 | sid/hash 房间 relay、CLI companion、协议探针与回归测试 |
| `docs/`、`IMPLEMENTATION-PLAN.md` | Historical | 历史方案和 UI 原型，不代表当前实现或路线图 |

> 历史组件 `wzxClaw_desktop/`（Legacy Electron IDE）与 `companion_app/`（旧桌面
> companion 壳）已于 2026-09-21 删除，恢复一律从 git 历史取源码。

协议实测记录见 [`relay/zcode/APP-SERVER.md`](relay/zcode/APP-SERVER.md)。工作约定与发布纪律见 [`AGENTS.md`](AGENTS.md)。各组件的具体开发说明见对应目录 README。

## 开发与验证

### Relay 与 CLI Companion

```bash
cd relay/zcode
npm ci
npm test
```

测试命令包含 `--test-force-exit`，用于确保子进程和长连接不会阻塞 CI 退出。

### 桌面端（desktop submodule）

```bash
cd desktop
pnpm install
pnpm --filter @zcode/desktop build
```

relay 核心变更后必须先同步 companion-core（逐字拷贝、双侧同 commit 提交）：

```bash
node scripts/sync-companion-core.mjs   # 缺省目标 = <repoRoot>/desktop
```

### Android

```bash
cd wzxClaw_android
flutter pub get
flutter analyze        # CI 门禁：info 也算失败，必须 0 issues
flutter test
flutter build apk --release
```

Android 正式出包必须先递增 `pubspec.yaml` 的 patch 版本和 build number，执行干净构建，并通过 `apksigner verify` 与 ZIP 完整性检查。正式 APK 命名为 `wzxClaw-android-release-vX.Y.Z.apk`，上传到 NAS `/volume1/share/zcode/` 后还需比对哈希（发布后半程一律手工，见 AGENTS.md）。

## CI 与 Release

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：主门禁，验证 relay/CLI Companion（Node 24）与 Android（Flutter 3.41.6），info 也算失败。
- [`.github/workflows/release.yml`](.github/workflows/release.yml)：`android-v*` 标签触发，只产 candidate artifact。

Android 标签任务只生成经过版本、签名存在性和 ZIP 完整性检查的候选 artifact。由于当前工程使用 debug signing，且 GitHub runner 未配置 NAS 凭据，该任务不会创建正式 GitHub Release，也不会宣称完成 NAS 发布；发布后半程（relay docker cp、桌面端出包、APK 上传 NAS）按 AGENTS.md 手工执行。

## 发布标签

- Android 候选：`android-vX.Y.Z`，必须与 `wzxClaw_android/pubspec.yaml` 的版本名一致。

## License

仓库中的不同组件可能有不同授权约束；以各组件声明和实际分发许可为准。
