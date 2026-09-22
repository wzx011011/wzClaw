'use strict';

// x/history 引擎历史反向分页契约测试（柱4 2026-09-22）。
// 形状契约：{messages:[{info,parts}], hasMore}，info.id = DB 行 id，
// 与 session/messages 消息形状逐字段对齐（手机端 _mapProtocolItem 直接消费）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { queryEngineHistory, defaultEngineDbPath } = require('../lib/engine-history');

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-history-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER,
      data TEXT, sequence INTEGER NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER
    );
  `);
  return { db, dbPath, dir };
}

function insertMessage(db, { id, sessionId, seq, info, parts = [] }) {
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?)',
  ).run(id, sessionId, seq, JSON.stringify(info), seq);
  parts.forEach((part, i) => {
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, data, sequence) VALUES (?, ?, ?, ?, ?)',
    ).run(`${id}-p${i}`, id, sessionId, JSON.stringify(part), i);
  });
}

const msgInfo = (role, text) => ({
  role,
  time: { created: 1 },
  finish: role === 'assistant' ? 'stop' : undefined,
  tokens: { input: 1, output: 2 },
});

test('尾窗页：无游标返回最新 N 条（升序），hasMore 判定正确', () => {
  const { db, dbPath } = makeTempDb();
  for (let i = 0; i < 5; i++) {
    insertMessage(db, {
      id: `m${i}`, sessionId: 's1', seq: i,
      info: msgInfo(i % 2 ? 'assistant' : 'user'),
      parts: [{ type: 'text', text: `body-${i}` }],
    });
  }
  db.close();

  const page = queryEngineHistory({ dbPath, sessionId: 's1', beforeId: null, limit: 3 });
  assert.equal(page.messages.length, 3);
  assert.equal(page.hasMore, true);
  // 升序：最新 3 条 m2,m3,m4
  assert.deepEqual(page.messages.map((m) => m.info.id), ['m2', 'm3', 'm4']);
  // 形状对齐 session/messages：info.role/parts[].type 可直接消费
  assert.equal(page.messages[0].info.role, 'user');
  assert.equal(page.messages[0].parts[0].type, 'text');
  assert.equal(page.messages[0].parts[0].text, 'body-2');
});

test('beforeMessageId 游标：只取该消息之前的更早页', () => {
  const { db, dbPath } = makeTempDb();
  for (let i = 0; i < 5; i++) {
    insertMessage(db, {
      id: `m${i}`, sessionId: 's1', seq: i, info: msgInfo('user'),
      parts: [{ type: 'text', text: `body-${i}` }],
    });
  }
  db.close();

  const page = queryEngineHistory({ dbPath, sessionId: 's1', beforeId: 'm2', limit: 10 });
  assert.deepEqual(page.messages.map((m) => m.info.id), ['m0', 'm1']);
  assert.equal(page.hasMore, false);
});

test('未知会话/不存在游标：空页 + hasMore=false（确定性「没有更早」）', () => {
  const { db, dbPath } = makeTempDb();
  insertMessage(db, { id: 'm0', sessionId: 's1', seq: 0, info: msgInfo('user') });
  db.close();

  const unknownSession = queryEngineHistory({ dbPath, sessionId: 'nope', beforeId: null });
  assert.deepEqual(unknownSession, { messages: [], hasMore: false });

  const unknownCursor = queryEngineHistory({ dbPath, sessionId: 's1', beforeId: 'ghost' });
  assert.deepEqual(unknownCursor, { messages: [], hasMore: false });
});

test('畸形 part JSON 降级 unknown marker，消息不丢（设计原则 4）', () => {
  const { db, dbPath } = makeTempDb();
  db.prepare(
    'INSERT INTO message (id, session_id, data, sequence) VALUES (?, ?, ?, ?)',
  ).run('m0', 's1', JSON.stringify(msgInfo('assistant')), 0);
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, data, sequence) VALUES (?, ?, ?, ?, ?)',
  ).run('m0-bad', 'm0', 's1', '{broken json', 0);
  db.close();

  const page = queryEngineHistory({ dbPath, sessionId: 's1', beforeId: null });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].parts[0].type, 'unknown');
});

test('多会话隔离：不串其它会话的消息', () => {
  const { db, dbPath } = makeTempDb();
  insertMessage(db, { id: 'a0', sessionId: 's1', seq: 0, info: msgInfo('user') });
  insertMessage(db, { id: 'b0', sessionId: 's2', seq: 0, info: msgInfo('user') });
  db.close();

  const page = queryEngineHistory({ dbPath, sessionId: 's1', beforeId: null });
  assert.deepEqual(page.messages.map((m) => m.info.id), ['a0']);
});

test('默认引擎 DB 路径拼装', () => {
  assert.equal(
    defaultEngineDbPath('/home/u'),
    path.join('/home/u', '.zcode', 'cli', 'db', 'db.sqlite'),
  );
});
