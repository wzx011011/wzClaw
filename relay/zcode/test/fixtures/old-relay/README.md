# old-relay 测试夹具

本目录是**旧 relay（token 房间模型，`wss://5945.top/relay/`）的服务端实现副本**，
仅作为 `test/brain-adapter.test.js` 的进程内测试桩使用——brain-adapter 是旧
WsEvents 协议 ↔ app-server 帧的翻译层（v3 大脑节点核心），其端到端测试需要
一个真实的 token 房间 relay 来挂手机侧 WebSocket。

## 来源

2026-09-15 按用户指示清理 `relay/` 根目录（原 `relay/server.js` + `relay/lib/`
已删除），但 brain-adapter 测试仍依赖该实现，故从 git 历史原样迁出至此：

- 来源 commit：da99d4e（删除前的最后一个含旧 relay 源码的提交）
- `server.js` ← `relay/server.js`（模块加载即监听，导出 `server`/
  `statusInterval`；`AUTH_TOKEN`、`RELAY_DATA_DIR` 环境变量须在 require 前设置）
- `lib/` ← `relay/lib/`（auth / logger / push-provider / room）

代码未做任何改动；`push-provider.js` 不在本测试的 require 链上，仅为保持实现
完整一并迁出。生产环境的旧 relay 跑在 NAS 容器内（NAS 侧自有副本），与本
副本无关；若旧 relay 实现有后续变更，需以 git 历史为事实源对照同步。
