'use strict';

// 测试夹具：按指令发送指定 requestId 的 AskUser 反向请求（官方
// interaction/requestUserInput 形状），并上报 companion 转回的应答
// （tag + error.code，供测试断言「兄弟 wireId 不再代答」）。
let buf = '';
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.method === 'emit/reverse' && frame.params) {
      send({
        id: frame.params.tag,
        method: 'interaction/requestUserInput',
        params: { requestId: frame.params.requestId },
      });
    } else if (typeof frame.id === 'string' && frame.id.startsWith('srv-')
      && (frame.result !== undefined || frame.error !== undefined)) {
      send({
        method: 'fake/answered',
        params: { tag: frame.id, code: frame.error ? frame.error.code : null },
      });
    }
  }
});
