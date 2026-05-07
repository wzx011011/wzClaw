// Quick DB inspection
const path = require('path');
const dbPath = process.argv[2];
const sid = process.argv[3];
let Database;
try { Database = require('better-sqlite3'); } catch (e) { console.error('better-sqlite3 not installed — using sqlite3 fallback'); process.exit(2); }
const db = new Database(dbPath, { readonly: true });
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
console.log('Tables:', tables.map(t => t.name).join(', '));
for (const t of tables) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
    console.log(`  ${t.name} columns:`, cols.map(c => c.name).join(','));
  } catch (e) {}
}
const sess = db.prepare(`SELECT * FROM sessions`).all();
console.log('Sessions table rows:', sess.length);
sess.forEach(s => console.log(' ', JSON.stringify(s).slice(0,200)));
const msgCount = db.prepare(`SELECT session_id, COUNT(*) AS n FROM messages GROUP BY session_id`).all();
console.log('Message counts per session:');
msgCount.forEach(r => console.log(' ', r.session_id, '=>', r.n));
if (sid) {
  const target = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid);
  console.log(`\nFor session ${sid}: ${target.n} messages`);
  const sample = db.prepare(`SELECT id, role, substr(content,1,80) AS preview, created_at FROM messages WHERE session_id=? ORDER BY created_at LIMIT 3`).all(sid);
  console.log('First 3:'); sample.forEach(r => console.log(' ', JSON.stringify(r)));
  const last = db.prepare(`SELECT id, role, substr(content,1,80) AS preview, created_at FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT 3`).all(sid);
  console.log('Last 3:'); last.forEach(r => console.log(' ', JSON.stringify(r)));
}
