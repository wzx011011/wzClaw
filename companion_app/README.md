# wzxClaw Companion App（Windows 桌面版大脑节点）

把 `relay/zcode/companion.js` 封装成 Windows GUI 应用：**安装即自动连接
NAS relay**（`wss://zcode.5945.top/ws` 烧入为默认值，可在设置里改），显示
手机配对二维码，支持在「完整形态」与「桌面宠物形态」之间切换，托盘常驻。

## 形态

- **完整形态**：状态灯 + 配对二维码/链接 + 连接设置（relay / 大脑工作目录 /
  开机自启）+ 运行日志。关窗 = 缩到托盘。
- **桌面宠物形态**：透明置顶小宠物，按连接状态变色（绿=已配对、黄=等手机、
  灰=离线、红=桥异常），气泡显示状态；宠物可拖拽，双击宠物或点「完整形态」
  回主窗，「菜单」含重启连接/退出。

托盘菜单：完整形态 / 桌面宠物形态 / 重启连接 / 开机自启 / 退出。

## 关键设计

- **内嵌而非外挂**：`cclient/` 是 `relay/zcode/companion.js` + `server.js` +
  `lib/{proof,protocol}.js` 的原样拷贝（companion 只从 server.js 取
  MAX_PAYLOAD），由 Electron 主进程 `createCompanion()` 直接驱动，不依赖
  系统 Node。
- **配对凭据共享**：数据目录仍是 `~/.wzxclaw/zcode-companion/`（mid/passhash/
  配对 URL 与 CLI companion 同一份）——**换装本 App 不换码，手机不用重扫**。
  同目录单实例锁 `companion.lock` 保证与旧实例互斥。
- **与旧计划任务二选一**：如果 `wzxClawZcodeCompanion` 计划任务还在跑，本 App
  启动会报 `ALREADY_RUNNING`（日志可见）。用本 App 前先停用/删除该计划任务。
- **首启 ZCode 健康检查**：完整窗口只读检测本机 ZCode 与 `~/.zcode`
  的安全摘要，并实际启动短生命周期 app-server `session/list` 探针；只有探针
  通过后才连接 relay、生成二维码。API Key、OAuth、SSH/MCP 登录态、配对信息、
  远程工作区、会话和日志绝不导入、展示或经 relay 传输，也不会改写 ZCode 文件。
- **runtime 三级回退（2026-09-17 策略更新）**：本机官方安装优先（宿主用同
  目录 `ZCode.exe`，版本随官方更新）→ 安装包**内嵌 runtime**（extraResources
  携带 `zcode.cjs` + 官方 packages，宿主为 Companion 自身 exe 的 Node 模式，
  Electron 41 起 Node 含 `node:sqlite` 可承载）→ PATH `zcode`。内嵌仅限自用
  安装包，**不公开分发**；登录态仍依赖 `~/.zcode`（未登录时 gate 给出引导）。
  构建由 `scripts/prepare-runtime.js`（predist 钩子）自动完成，CI 无源时产出
  无 runtime 形态，两种形态都被 `test:package` 双模式断言钉住。

## 开发与打包

```bash
cd companion_app
npm install                 # electron/electron-builder 走镜像：
                            # export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start                   # 开发运行（GUI）
npm run dist                # NSIS 安装包 + 便携单文件 → dist/
node gen-icon.js            # 重新生成图标（改 pixel() 后）
```

## 升级内嵌 companion

`relay/zcode/companion.js` / `server.js` / `lib/*` 有改动后重新拷贝到
`cclient/`（保持目录结构），回归点：冒烟脚本（见 git 历史）、配对流程、
x/* 扩展（手机端 git 分支钮依赖 `x/git/*`）。两份拷贝不同步是已知维护成本，
大改后建议把 cclient 生成脚本化。
