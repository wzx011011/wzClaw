# ZCode relay + companion（手机控制 ZCode 的桥接层）

手机 wzxClaw App 通过 NAS 中继控制桌面 ZCode。架构与协议细节见 `APP-SERVER.md`
（ZCode Protocol v1 实测记录）。

```
手机 wzxClaw App ──WSS──▶ NAS relay（本目录 server.js，Docker 部署）
（扫码 sid/hash 配对）          │ data 载荷转发（配对后双向）
                              ▼
                    桌面 companion.js（device 角色）
                              │ spawn + stdio NDJSON
                              ▼
                    `zcode app-server`（ZCode Protocol v1）
```

- **relay**（`server.js`）：房间 + HMAC 质询配对，已验证协议（28 tests）。
- **companion**（`companion.js`）：桌面侧 device 角色；QR 配对 URL 自管；
  spawn 本机 `zcode app-server`；`session/requestRuntimePreferences` 反向请求自动代答，
  其余反向请求（权限确认等）转发给手机端应答；模型 token 从
  `~/.zcode/v2/config.json` 读取后仅注入子进程环境变量（不落盘、不打印、不经过 relay）。
- **probe**（`probe.js`）：早期对官方桌面远程控制协议的验证器，保留作 relay 回归测试用。

## 实测状态（2026-09-13）

**全链路已实测通过**（本机 relay + 真 zcode app-server + 模拟手机）：
`session/list`（50 个真实会话）→ `session/create`（glm-5.3）→ `session/send` →
`stream.chunk` 流式 → `turn.terminal success` → `session/stop`。
前置条件：`~/.zcode/cli/config.json` 的 model/provider 配置（形状见 APP-SERVER.md）与
桌面端 BigModel coding-plan 登录。

## 本地命令

```bash
# relay（默认 127.0.0.1:18884；--host 0.0.0.0 供容器/nginx 使用）
node server.js [--port 18884] [--host 127.0.0.1]

# companion（桌面侧，另一终端）
node companion.js --relay ws://127.0.0.1:18884/ws [--cwd <ZCode 工作区>]

# 测试（31 个：28 relay + 3 companion，含假 app-server 桥接全流程）
node --test test/relay.test.js test/companion.test.js
```

companion 启动后输出一次性配对 URL（`<origin>/pair?sid=...&hash=...`），
渲染成二维码给手机扫。sid/口令每次启动轮换；relay 断线自动重连并重新注册。
mid 持久化于 `~/.wzxclaw/zcode-companion/mid`。

## NAS 部署（已完成，2026-09-13）

- 镜像 `wzxclaw-zcode-relay`（`deploy-nas-zcode.sh` 一键重跑更新），宿主
  `127.0.0.1:18884`。
- 公网入口 `wss://zcode.5945.top/ws`（nginx 子域名反代，`/ws` Upgrade 头 +
  Origin 剥离，`/health` 健康检查）。
- companion 连接 `--relay wss://zcode.5945.top/ws`，配对 URL 为
  `https://zcode.5945.top/pair?...`。

## 手机端（wzxClaw_android / Flutter，进行中）

手机端集成在 **Flutter 原版 App**（master 主分支 `wzxClaw_android/`）中，作为与
现有"桌面 wzxClaw IDE 控制"并存的第二个模式：

- 协议层（Dart）：`lib/zcode/zcode_pairing.dart`（配对 URL 解析）+
  `lib/zcode/zcode_relay_client.dart`（probe 角色认证 + ZCode Protocol v1 RPC，
  runtime preferences 自动代答，未知反向请求默认拒绝）。
- 状态层：`lib/zcode/zcode_chat_store.dart`（配对持久化、会话列表、
  流式渲染 = 运行中轮询 `session/events` 的 `text_delta`，按 eventId 去重）。
- UI：复用 Flutter 版现有聊天组件（气泡/Markdown/工具卡片/思考指示），
  新增配对入口（复用 settings 页已有的 mobile_scanner 扫码）。
- 构建：`cd wzxClaw_android && flutter build apk`。

## 配对协议（摘要）

- device 连接 `/ws?mid=...`（头 `X-Device-ID` 同值），`device_register_init`
  {device_mid, pass_hash} → relay 派发新 `device_sid`；
- 双方 `auth_init`{role: device|probe, device_sid} → `auth_challenge`{nonce} →
  `auth_response`{proof}，`proof = base64url(HMAC-SHA256(pass_hash 字符串, nonce|role|sid))`；
- `auth_ack` / `pair_status_ack` 携带 pair_status waiting|matched；
- 配对后仅转发 `{type:'data', payload:<ZCode Protocol v1 帧>}`，路由按 socket 归属，
  不信任客户端指定目的地。

安全边界：错误消息通用化；nonce 单次有效；`timingSafeEqual` 比较；1 MiB 帧上限；
未认证/超限/重复角色一律断开；密钥只存内存。配对 URL 本身是持有者凭据，
不要进聊天/日志/git。

## API

`createRelay(options)`：`listen({port, host})` / 幂等 `close()`。
默认选项与上限同旧版（maxSockets=32、authTimeoutMs=10000、roomTtlMs=60000 等）。
`createCompanion(options)`：`start()` / `stop()`（Promise，等子进程退出）、
`pairingUrl` / `state`；回调 `onPairing(url)`、`onStateChange(state)`、
`logger(event, detail)`；可注入 `zcodeCommand`（测试用假进程）与 `v2ConfigPath`。
