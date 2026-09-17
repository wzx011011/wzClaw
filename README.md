# wzxClaw

个人 AI 远程控制系统。现役运行时统一为 ZCode app-server；Android 是遥控端，Windows Companion 是大脑节点宿主，双方通过自托管 NAS relay 会合。工具执行发生在 Companion 所在机器，relay 只负责认证、房间和双向转发。

## 当前架构

```text
Android App（Flutter）
  └─ WSS + sid/hash 配对
       └─ NAS relay: wss://zcode.5945.top/ws
            └─ Windows Companion
                 └─ ZCode app-server 子进程
```

配对二维码或链接中的 `sid`/`hash` 是持有者凭据，不应写入日志、提交到 Git 或在公开渠道传递。房间身份由 Companion 持久化，正常重启和重连无需重新扫码。

## 产品地图

| 路径 | 状态 | 职责 |
|---|---|---|
| `wzxClaw_android/` | 现役 | Flutter 手机遥控器；聊天、会话、权限、文件、Git 与多节点切换 |
| `companion_app/` | 现役 | Windows Companion GUI；连接 NAS、显示配对二维码、托盘常驻并承载 ZCode runtime |
| `relay/zcode/` | 现役 | sid/hash 房间 relay、CLI Companion、协议探针与回归测试 |
| `wzxClaw_desktop/` | Legacy | 旧 Electron IDE，仅保留维护和迁移参考，不属于主 CI 或 Release |
| `docs/`、`IMPLEMENTATION-PLAN.md` | Historical | 历史方案和 UI 原型，不代表当前实现或路线图 |

协议实测记录见 [`relay/zcode/APP-SERVER.md`](relay/zcode/APP-SERVER.md)。各组件的具体开发说明见对应目录 README。

## 开发与验证

### Relay 与 CLI Companion

```bash
cd relay/zcode
npm ci
npm test
```

测试命令包含 `--test-force-exit`，用于确保子进程和长连接不会阻塞 CI 退出。

### Windows Companion App

```bash
cd companion_app
npm ci
npm test
npm run dist:dir
```

正式 Windows 构建使用 `npm run dist`。CI 构建不包含私有 ZCode runtime，目标机器需要安装并登录官方 ZCode。

### Android

```bash
cd wzxClaw_android
flutter pub get
flutter analyze --no-fatal-infos
flutter test
flutter build apk --release
```

Android 正式出包必须先递增 `pubspec.yaml` 的 patch 版本和 build number，执行干净构建，并通过 `apksigner verify` 与 ZIP 完整性检查。正式 APK 命名为 `wzxClaw-android-release-vX.Y.Z.apk`，上传到 NAS `/volume1/share/zcode/` 后还需比对哈希。

## CI 与 Release

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：主门禁，只验证现役 relay/CLI Companion、Windows Companion App 和 Android。
- [`.github/workflows/legacy-desktop.yml`](.github/workflows/legacy-desktop.yml)：仅手动触发或 `wzxClaw_desktop/**` 变更时运行，所有作业明确标记为 Legacy。
- [`.github/workflows/release.yml`](.github/workflows/release.yml)：`android-v*` 和 `companion-v*` 标签互斥分流，不发布旧 Desktop。

Android 标签任务只生成经过版本、签名存在性和 ZIP 完整性检查的候选 artifact。由于当前工程使用 debug signing，且 GitHub runner 未配置 NAS 凭据，该任务不会创建正式 GitHub Release，也不会宣称完成 NAS 发布。Companion 使用 `companion-vX.Y.Z` 标签创建独立 GitHub Release。

## 发布标签

- Android 候选：`android-vX.Y.Z`，必须与 `wzxClaw_android/pubspec.yaml` 的版本名一致。
- Companion：`companion-vX.Y.Z`，必须与 `companion_app/package.json` 的版本一致。

## License

仓库中的不同组件可能有不同授权约束；以各组件声明和实际分发许可为准。
