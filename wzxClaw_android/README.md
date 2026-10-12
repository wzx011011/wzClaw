# wzxClaw Android

wzxClaw 的 Flutter 手机遥控器。应用通过自托管 NAS relay 与 Windows Companion 配对，控制 Companion 所在机器上的 ZCode app-server 会话。

## 连接模型

```text
Android App
  └─ WSS: wss://zcode.5945.top/ws
       └─ sid/hash 房间
            └─ Windows Companion + ZCode app-server
```

应用不再依赖 ngrok 或旧 Electron IDE 的 Mobile Bridge。当前页面直接消费 `ZcodeChatStore`，连接由 `ConnectionManager` 与 `lib/zcode/` 协作完成，协议形状以 `relay/zcode/APP-SERVER.md` 的实测记录为准。

## 配对

1. 在大脑节点启动桌面端（`desktop` submodule，扫码配对二维码），或运行 CLI `relay/zcode/companion.js`。
2. 确认 Companion 已连接 `wss://zcode.5945.top/ws`，并显示配对二维码。
3. 在 Android 应用中扫描二维码或打开配对链接。
4. 应用从链接读取 relay origin、`sid` 和 `hash`，完成质询认证后进入对应房间。
5. 配对信息会安全保存；同一 Companion 正常重启或重连时无需重新扫码。

配对二维码、配对 URL、`sid` 和 `hash` 都是持有者凭据。不要截图外传，不要写入日志或提交到 Git。

## 功能

- ZCode 会话列表、创建、切换与流式对话
- 工具调用、权限请求和 AskUser 交互
- 多 Companion 节点注册与切换
- 工作区、文件附件、Git 分支与状态操作
- 本地 SQLite 会话缓存、通知与前后台保活
- 语音输入和二维码扫描

## 从源码验证

前置条件为 Flutter stable 与 Java 17。

```bash
flutter pub get
flutter analyze        # CI 门禁：info 也算失败，必须 0 issues
flutter test
```

## Release 构建纪律

1. 每次出包前递增 `pubspec.yaml` 的 patch 版本和 `+buildNumber`，确保 Android `versionCode` 单调递增。
2. 若构建曾被取消，先执行 `flutter clean`，再重新获取依赖并完整构建。
3. 构建命令为 `flutter build apk --release`。
4. 用 Android SDK 的 `apksigner verify` 验证签名存在且 APK 可验证，再执行 ZIP 完整性检查。
5. 正式文件命名为 `wzxClaw-android-release-vX.Y.Z.apk`。
6. 正式 APK 上传到 NAS `/volume1/share/zcode/`，并在上传后比对 SHA-256；不要放到旧的 relay build 目录。

当前 Android 工程的 release build 使用 debug signing。根 release workflow 因此只生成经过校验的候选 artifact，不会创建正式 GitHub Release，也不会自动宣称已上传 NAS。正式分发需要在受控环境完成签名策略确认、NAS 上传和哈希复核。

## 目录

```text
lib/
├── config/       # 应用配置与主题
├── models/       # 页面和连接模型
├── pages/        # 首页、设置、扫码、目标和文件页面
├── services/     # 连接、配对、附件、Git、节点目录等服务
├── widgets/      # 聊天、工具、权限和导航组件
└── zcode/        # app-server 会话状态、relay 客户端、反向请求与缓存
```
