'use strict';

// 引擎会话历史反向分页（x/history，柱4 2026-09-22）。
//
// 背景：app-server 的 session/messages 只支持 afterMessageId 向新翻页，
// 手机端上滑加载更早历史只能依赖本地 SQLite 缓存——换设备/清缓存后
// 中间历史永久不可达（09-20 评审「冷缓存历史缺口」P0）。引擎自身把
// 消息全量落在 ~/.zcode/cli/db/db.sqlite（message/part 表，sequence
// 会话内单调），companion 与引擎同机部署，可只读直查补上反向分页。
//
// 形状契约：返回 {messages:[{info,parts}], hasMore}，info/parts 与
// session/messages 的消息形状逐字段对齐（info.id 由行 id 回填，协议
// 响应同源——DB 就是引擎的持久层），手机端 _mapProtocolItem 无需
// 任何特殊分支即可消费。解析失败的 part 降级为 unknown marker，
// 绝不静默丢消息（设计原则 4）。

const { DatabaseSync } = require('node:sqlite');

const DEFAULT_LIMIT = 60; // 官方 snapshotTailWindowRows 同款尾窗
const MAX_LIMIT = 200; // 官方 rowsRangeMaxLimit 同款上限

/**
 * 只读查询引擎历史。
 * @param {object} opts
 * @param {string} opts.dbPath 引擎 sqlite 路径
 * @param {string} opts.sessionId 会话 id
 * @param {string|null} opts.beforeMessageId 游标：返回该消息**之前**的更早
 *   消息；null = 从尾部取（尾窗页）
 * @param {number} [opts.limit] 页大小，1..200，默认 60
 * @returns {{messages: Array<{info: object, parts: Array<object>}>, hasMore: boolean}}
 */
function queryEngineHistory({ dbPath, sessionId, beforeId, limit }) {
  const effectiveLimit = Math.min(
    Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1),
    MAX_LIMIT,
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let cursor = null;
    if (beforeId != null) {
      const anchor = db
        .prepare('SELECT sequence FROM message WHERE id = ? AND session_id = ?')
        .get(beforeId, sessionId);
      // 游标不存在（消息被截断/换了库/伪造 id）：返回空页并 hasMore=false，
      // 调用方据此停止翻页——不是错误，是确定性的「没有更早」
      if (!anchor) return { messages: [], hasMore: false };
      cursor = Number(anchor.sequence);
    }
    const rows =
      cursor == null
        ? db
            .prepare(
              'SELECT id, data FROM message WHERE session_id = ? '
                + 'ORDER BY sequence DESC LIMIT ?',
            )
            .all(sessionId, effectiveLimit + 1)
        : db
            .prepare(
              'SELECT id, data FROM message WHERE session_id = ? '
                + 'AND sequence < ? ORDER BY sequence DESC LIMIT ?',
            )
            .all(sessionId, cursor, effectiveLimit + 1);
    const hasMore = rows.length > effectiveLimit;
    // DESC 取「最新的 N+1 条」再反转 = 时间升序页（session/messages 同款
    // 升序契约，手机端按序头部插入）
    const page = rows.slice(0, effectiveLimit).reverse();
    const partStmt = db.prepare(
      'SELECT id, data FROM part WHERE message_id = ? ORDER BY sequence',
    );
    const messages = [];
    for (const row of page) {
      let info;
      try {
        info = JSON.parse(row.data);
      } catch {
        info = {};
      }
      if (info === null || typeof info !== 'object' || Array.isArray(info)) {
        info = {};
      }
      info.id = row.id;
      if (!info.sessionID) info.sessionID = sessionId;
      const parts = [];
      for (const part of partStmt.all(row.id)) {
        let parsed;
        try {
          parsed = JSON.parse(part.data);
        } catch {
          parsed = { type: 'unknown' };
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          parsed = { type: 'unknown' };
        }
        if (!parsed.id && !parsed.partId) parsed.id = part.id;
        parts.push(parsed);
      }
      messages.push({ info, parts });
    }
    return { messages, hasMore };
  } finally {
    db.close();
  }
}

/** 引擎 DB 默认路径（与 app-server CLI 同机约定） */
function defaultEngineDbPath(homeDir) {
  const path = require('node:path');
  return path.join(homeDir, '.zcode', 'cli', 'db', 'db.sqlite');
}

module.exports = { queryEngineHistory, defaultEngineDbPath, DEFAULT_LIMIT, MAX_LIMIT };
