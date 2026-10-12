'use strict';

// probe-attach2 — 退路验证：图片落盘工作区 + 文本引用路径，
// agent 用 Read 工具读图，模型是否真看见（官方 Read 支持 PDF/图片）。
// 通过 = 附件特性按「companion 落盘 + 路径引用」实施。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-attach2-'));
console.log('tmp cwd:', TMP);

const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
const child = spawn(process.execPath, [local, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1; const pending = new Map(); let buf = '';
const events = [];
function send(f) { child.stdin.write(JSON.stringify(f) + '\n'); }
function request(m, p, ms = 60000) {
  const id = nextId++;
  return new Promise((r) => { pending.set(id, r); send({ id, method: m, params: p });
    setTimeout(() => { if (pending.delete(id)) r({ __timeout: true }); }, ms).unref(); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child.stdout.on('data', (c) => {
  buf += c.toString(); let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f && f.id != null && !f.method) { const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); } continue; }
    events.push(f);
    if (f.method && f.id != null) {
      if (String(f.method).includes('RuntimePreferences')) {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
      } else {
        console.log('!! reverse:', f.method);
        send({ id: f.id, error: { code: -32601, message: 'probe-attach2: denied' } });
      }
    }
  }
});
child.stderr.on('data', () => {});

function redPng() {
  const zlib = require('node:zlib');
  const w = 32, h = 32;
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = 255; raw[row + 2 + x * 3] = 0; raw[row + 3 + x * 3] = 0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  try {
    const imgPath = path.join(TMP, 'red.png');
    fs.writeFileSync(imgPath, redPng());
    console.log('图片已落盘:', imgPath);

    await sleep(800);
    const create = await request('session/create', {
      workspace: { workspaceKey: 'probe-attach2', workspacePath: TMP },
    });
    const sid = create?.result?.session?.sessionId;
    if (!sid) { console.log('FAIL create:', JSON.stringify(create).slice(0, 300)); process.exit(1); }
    console.log('sid:', sid);
    await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });

    const r1 = await request('session/send', {
      sessionId: sid,
      content: `工作区里有一张图片 red.png，请用 Read 工具读取它，然后只回答图是什么纯色。`,
    });
    console.log('send 应答:', JSON.stringify(r1).slice(0, 300));

    const t0 = Date.now();
    let answer = '';
    let sawRead = false;
    while (Date.now() - t0 < 90000) {
      await sleep(1500);
      for (const e of events) {
        const p = e.params; if (!p) continue;
        if (p?.events) {
          for (const ev of p.events) {
            const pl = ev.payload || {};
            const k = pl.kind || pl.type || '';
            if (k.includes('tool') && JSON.stringify(pl).includes('red.png')) sawRead = true;
            if (k === 'text_delta' && pl.text) answer += pl.text;
            if (k === 'turn.completed') {
              console.log('---');
              console.log('调用过读图工具:', sawRead);
              console.log('模型回复:', answer || '(无)');
              console.log('---');
              console.log(/红|red/i.test(answer) && sawRead
                ? 'VERDICT: ✅ 退路成立——落盘+路径引用，模型经 Read 看见图'
                : 'VERDICT: ⚠️ 见上述轨迹');
              child.kill(); process.exit(0);
            }
          }
        }
      }
    }
    console.log('VERDICT: ⏱ 超时');
    console.log('事件方法分布:', JSON.stringify(events.reduce((a, e) => { a[e.method || '?'] = (a[e.method || '?'] || 0) + 1; return a; }, {})));
    console.log('尾部事件:', JSON.stringify(events.slice(-3)).slice(0, 1000));
    child.kill(); process.exit(2);
  } catch (e) {
    console.error('probe error:', e);
    child.kill(); process.exit(3);
  }
})();
