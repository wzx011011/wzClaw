const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
const sid = process.argv[3];

// Check duplicates by (created_at, role, content)
const dups = db.prepare(`
  SELECT created_at, role, substr(content,1,50) AS preview, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
  FROM messages
  WHERE session_id=?
  GROUP BY created_at, role, content
  HAVING COUNT(*) > 1
  ORDER BY created_at
`).all(sid);
console.log('Duplicate groups:', dups.length);
dups.slice(0, 20).forEach(d => console.log(' ', d.created_at, d.role, `(${d.n}x)`, 'ids=' + d.ids, d.preview));

// Distinct count
const distinct = db.prepare(`SELECT COUNT(DISTINCT created_at || '|' || role || '|' || content) AS n FROM messages WHERE session_id=?`).get(sid);
console.log('\nDistinct (created_at,role,content) tuples:', distinct.n);

// By role
console.log('\nBy role:');
db.prepare(`SELECT role, COUNT(*) AS n FROM messages WHERE session_id=? GROUP BY role`).all(sid).forEach(r => console.log(' ', r.role, r.n));
