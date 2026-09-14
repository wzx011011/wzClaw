'use strict';

// ZCode Protocol v1 共享常量与帧分类：companion（companion.js）与后续收敛的
// probe 脚本共用。帧格式事实源见 APP-SERVER.md「线协议（实测）」节。

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// companion 侧自造/代答的错误码（区别于 app-server 返回的 -326xx）：
// - ERR_UNHANDLED：companion 无法把请求交给 app-server（桥未启动/未登录）；
// - ERR_FRAME_TOO_LARGE：响应单条消息超 relay 1MiB 帧上限，截断兜底仍失败；
// - ERR_TIMEOUT：反向请求超时看护代答（值与 app-server 实测的 -32022 对齐）。
const ERR_UNHANDLED = -32000;
const ERR_FRAME_TOO_LARGE = -32001;
const ERR_TIMEOUT = -32022;

// 权限/确认/AskUser 类反向请求判定（决定超时看护档位）：
// - 实名：session/requestPermission（权限确认）、interaction/askUser（提问），
//   即手机端 UI 接入的两种形态（见 Flutter zcode_chat_store 的路由规则）；
// - 模式：method 含 permission / confirm / approval / approve / askUser 变体 /
//   interaction 的都视为需要人盯手机应答，放宽看护窗口。
//   注意不能用裸 "ask"——会误伤 cancelBackgroundTask 里的 "task"。
const PERMISSION_LIKE_METHOD_PATTERN = /permission|confirm|approval|approve|ask[-_]?user|interaction/i;

function isPermissionLikeMethod(method) {
  return typeof method === 'string' && PERMISSION_LIKE_METHOD_PATTERN.test(method);
}

// 帧分类（规则以 APP-SERVER.md 帧格式节为准）：
// - method + id：id 为字符串（如 "server-1"）是服务端反向请求，否则是普通请求；
// - 仅 method（无 id）：通知；
// - id + result/error（无 method）：响应（含对反向请求的应答）；
// - 其余（缺字段/非对象）：null，由调用方按坏帧处理。
function classifyFrame(frame) {
  if (!isObject(frame)) return null;
  const hasMethod = typeof frame.method === 'string';
  const hasId = frame.id != null;
  if (hasMethod && hasId) return typeof frame.id === 'string' ? 'reverse-request' : 'request';
  if (hasMethod) return 'notification';
  if (hasId && (frame.result !== undefined || frame.error !== undefined)) return 'response';
  return null;
}

module.exports = { ERR_UNHANDLED, ERR_FRAME_TOO_LARGE, ERR_TIMEOUT,
  isPermissionLikeMethod, classifyFrame };
