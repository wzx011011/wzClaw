'use strict';
// 完整形态渲染层：纯展示 + IPC，不直接触碰 companion
const $ = (id) => document.getElementById(id);
const logs = [];

function setState(state, text) {
  const dot = $('dot');
  dot.className = 'dot';
  if (state === 'paired' || state === 'app-server-started') dot.classList.add('paired');
  else if (state === 'waiting-pairing') dot.classList.add('waiting');
  else if (state === 'app-server-dead' || state === 'companion-error') dot.classList.add('bad');
  $('stateText').textContent = text || state;
}

function pushLog(event, detail) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logs.push(`[${t}] ${event}${detail ? ` ${detail}` : ''}`);
  if (logs.length > 200) logs.splice(0, logs.length - 200);
  $('logs').textContent = logs.join('\n');
  $('logs').scrollTop = $('logs').scrollHeight;
}

function setPairing(url, qr) {
  const img = $('qrImg');
  const empty = $('qrEmpty');
  if (qr) {
    img.src = qr;
    img.style.display = 'block';
    empty.style.display = 'none';
  } else {
    img.style.display = 'none';
    empty.style.display = 'flex';
    empty.textContent = url ? '' : '正在获取配对码…';
  }
  $('pairUrl').textContent = url || '';
}

function applySnapshot(s) {
  setState(s.state, s.stateText);
  setPairing(s.pairingUrl, s.qrDataUrl);
  $('relayUrl').value = s.config.relayUrl;
  $('cwd').value = s.config.cwd;
  $('autoStart').checked = !!s.autoStart;
  $('btnFull').classList.toggle('active', s.mode === 'full');
  $('btnPet').classList.toggle('active', s.mode === 'pet');
  for (const l of s.logs || []) pushLog(l.event, l.detail);
}

window.api.getSnapshot().then(applySnapshot);

window.api.onEvent((ev) => {
  switch (ev.type) {
    case 'log':
      pushLog(ev.payload.event, ev.payload.detail);
      break;
    case 'pairing':
      setPairing(ev.payload.url, ev.payload.qr);
      break;
    case 'state':
      setState(ev.payload.state);
      break;
    default:
      break;
  }
});

$('btnFull').addEventListener('click', () => window.api.switchMode('full'));
$('btnPet').addEventListener('click', () => window.api.switchMode('pet'));
$('btnCopy').addEventListener('click', () => {
  const url = $('pairUrl').textContent;
  if (url) navigator.clipboard.writeText(url);
});
$('btnReconnect').addEventListener('click', async () => {
  const s = await window.api.getSnapshot();
  await window.api.saveConfig({
    relayUrl: s.config.relayUrl,
    cwd: s.config.cwd,
    autoStart: s.autoStart,
  });
});
$('btnBrowse').addEventListener('click', async () => {
  const dir = await window.api.pickCwd();
  if (dir) $('cwd').value = dir;
});
$('btnSave').addEventListener('click', async () => {
  $('cfgMsg').textContent = '';
  const r = await window.api.saveConfig({
    relayUrl: $('relayUrl').value,
    cwd: $('cwd').value,
    autoStart: $('autoStart').checked,
  });
  if (!r.ok) $('cfgMsg').textContent = r.error || '保存失败';
});
