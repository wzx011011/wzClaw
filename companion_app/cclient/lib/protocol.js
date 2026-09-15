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

// 超时档位判定（方向：默认长档）。
// 失败模式分析（2026-09-15 设计审查）：若默认短档，app-server 新增的任何
// 交互式方法不匹配模式 → 15s 后被静默代答拒绝，用户正看着手机却丢失
// 确认框；默认长档的最坏结果只是"多等一会"。因此：
// - 已知快速方法（实名白名单）走短档；
// - 其余全部按"可能需要人应答"走长档（120s）。
const FAST_METHODS = new Set([
  'session/requestRuntimePreferences',
]);

function isFastMethod(method) {
  return typeof method === 'string' && FAST_METHODS.has(method);
}

// 兼容旧名：权限类显式归长档（如今长档是默认，此函数仅表达意图）
function isPermissionLikeMethod(method) {
  return !isFastMethod(method);
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
  isFastMethod, isPermissionLikeMethod, classifyFrame };
