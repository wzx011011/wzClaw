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
// companion 本地 x/* 扩展错误。error.code 必须始终是数字；可读分类放进
// error.data.reason，避免 Android 把字符串 code 降级成泛化 -32000。
const ERR_X_BAD_PARAMS = -32100;
const ERR_X_GIT_TIMEOUT = -32101;
const ERR_X_GIT_FAILED = -32102;
// 下载目标不存在/工作区外/会话失效——「找不到」与「参数畸形」分开报，
// 手机端据此分别提示「暂不支持下载工作区外的文件」与「参数错误」。
const ERR_X_NOT_FOUND = -32103;
// x/* 未归类失败的兜底（此前误用 -32102「git 失败」，语义错位）。
const ERR_X_FAILED = -32104;

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
  ERR_X_BAD_PARAMS, ERR_X_GIT_TIMEOUT, ERR_X_GIT_FAILED, ERR_X_NOT_FOUND,
  ERR_X_FAILED,
  isFastMethod, classifyFrame };
