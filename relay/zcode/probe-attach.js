'use strict';

// probe-attach — 附件入口探针：session/send 是否接受部件数组 content
//（官方图片部件形状：[{type:'text',text},{type:'image',image:base64,mediaType}]，
// 形状来源：model-io 日志实测，见 .planning/PLAN-turn-block.md §3c-1）。
//
// 实验：生成一张 32x32 纯红色 PNG，以部件数组发送，再问 agent「图是什么颜色」。
// 判定：回复含「红/red」= 模型真看见了图（入口+管线全通）；
//       zod 拒绝/-32602 = 入口不接受部件数组（记录错误 schema 提示，走落盘退路）。
// 用法: node probe-attach.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-attach-'));
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
      // 反向请求：runtimePrefs 代答 false；其余拒绝（auto 模式不应有权限请求）
      if (String(f.method).includes('RuntimePreferences')) {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
      } else {
        console.log('!! reverse:', f.method);
        send({ id: f.id, error: { code: -32601, message: 'probe-attach: denied' } });
      }
    }
  }
});
child.stderr.on('data', () => {});

/// 32x32 纯红 PNG（无依赖手搓：最小 IHDR+IDAT+IEND，行过滤字节 0）
function redPngBase64() {
  const zlib = require('node:zlib');
  const w = 32, h = 32;
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // 过滤 None
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = 255; raw[row + 2 + x * 3] = 0; raw[row + 3 + x * 3] = 0;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

(async () => {
  try {
    await sleep(800);
    const create = await request('session/create', {
      workspace: { workspaceKey: 'probe-attach', workspacePath: TMP },
    });
    const sid = create?.result?.session?.sessionId;
    if (!sid) { console.log('FAIL create:', JSON.stringify(create).slice(0, 300)); process.exit(1); }
    console.log('sid:', sid);
    await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });

    // ── 实验 1：部件数组 content ──
    const b64 = redPngBase64();
    console.log('png base64 长度:', b64.length);
    const r1 = await request('session/send', {
      sessionId: sid,
      content: [
        { type: 'text', text: '这张图是什么纯色？只回答颜色名。' },
        { type: 'image', image: b64, mediaType: 'image/png' },
      ],
    });
    console.log('实验1 send 应答:', JSON.stringify(r1).slice(0, 400));

    // 等回合结束（turn.completed 或 30s）
    const t0 = Date.now();
    let answer = '';
    while (Date.now() - t0 < 60000) {
      await sleep(1500);
      for (const e of events) {
        const p = e.params;
        if (e.method === 'session/event' && p?.events) {
          for (const ev of p.events) {
            const pl = ev.payload || {};
            if (pl.kind === 'text_delta' && pl.text) answer += pl.text;
            if (pl.kind === 'turn.completed' || pl.type === 'turn.completed') {
              console.log('---');
              console.log('回合结束。模型回复全文:', answer || '(无 text_delta)');
              console.log('---');
              console.log(answer.match(/红|red/i) ? 'VERDICT: ✅ 入口接受部件数组，模型看见了图'
                : 'VERDICT: ⚠️ 回合完成但回复未提红色 →', answer.slice(0, 200) || '无回复');
              child.kill(); process.exit(0);
            }
          }
        }
      }
    }
    console.log('VERDICT: ⏱ 超时；answer 片段:', answer.slice(0, 300) || '(空)');
    console.log('事件尾巴:', JSON.stringify(events.slice(-5)).slice(0, 600));
    child.kill(); process.exit(2);
  } catch (e) {
    console.error('probe error:', e);
    child.kill(); process.exit(3);
  }
})();
