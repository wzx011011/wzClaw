'use strict';
// 完整形态渲染层：纯展示 + 专用 IPC，不直接读取本地文件或凭据。
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
  if (qr) { img.src = qr; img.style.display = 'block'; empty.style.display = 'none'; }
  else { img.style.display = 'none'; empty.style.display = 'flex'; empty.textContent = url ? '' : '正在获取配对码…'; }
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

function selectionFromUi() {
  return {
    modelMetadata: $('selectModels').checked,
    preferences: $('selectPreferences').checked,
    workspaces: $('selectWorkspaces').checked,
    extensions: $('selectExtensions').checked,
  };
}

function applySelection(selection) {
  $('selectModels').checked = selection.modelMetadata !== false;
  $('selectPreferences').checked = selection.preferences !== false;
  $('selectWorkspaces').checked = selection.workspaces === true;
  $('selectExtensions').checked = selection.extensions === true;
}

function renderDetection(detected) {
  const installed = detected.installation.status === 'found';
  $('installStatus').className = `status ${installed ? 'good' : 'warn'}`;
  $('installStatus').textContent = installed
    ? `已检测到 ZCode 安装（来源：${detected.installation.source}）。Companion 将使用它启动 app-server。`
    : '未检测到可验证的 ZCode 安装。仍可继续设置，但首次需要确认 ZCode 已安装并可从命令行调用。';
  const metadata = detected.metadata;
  const credential = detected.credentials.status === 'available' ? '检测到本地登录态' : '未检测到可用登录态';
  $('metadataStatus').className = `status ${metadata.status === 'compatible' ? 'good' : 'warn'}`;
  $('metadataStatus').textContent = `配置状态：${metadata.status}；Provider ${metadata.providers.length} 个，Skills ${metadata.skills.length} 个，插件 ${metadata.plugins.length} 个，MCP ${metadata.mcpCount} 个；${credential}。`;
}

async function openImportWizard() {
  $('importMsg').textContent = '';
  const detected = await window.api.detectZCode();
  renderDetection(detected);
  $('importOverlay').classList.remove('hidden');
}

async function bootstrap() {
  const [snapshot, firstRun] = await Promise.all([window.api.getSnapshot(), window.api.getFirstRunStatus()]);
  applySnapshot(snapshot);
  applySelection(firstRun.selection || {});
  if (!firstRun.completed) {
    renderDetection(firstRun.detected);
    $('importOverlay').classList.remove('hidden');
  }
}

bootstrap();

window.api.onEvent((ev) => {
  switch (ev.type) {
    case 'log': pushLog(ev.payload.event, ev.payload.detail); break;
    case 'pairing': setPairing(ev.payload.url, ev.payload.qr); break;
    case 'state': setState(ev.payload.state); break;
    default: break;
  }
});

$('btnFull').addEventListener('click', () => window.api.switchMode('full'));
$('btnPet').addEventListener('click', () => window.api.switchMode('pet'));
$('btnCopy').addEventListener('click', () => { const url = $('pairUrl').textContent; if (url) navigator.clipboard.writeText(url); });
$('btnReconnect').addEventListener('click', async () => {
  const s = await window.api.getSnapshot();
  await window.api.saveConfig({ relayUrl: s.config.relayUrl, cwd: s.config.cwd, autoStart: s.autoStart });
});
$('btnBrowse').addEventListener('click', async () => { const dir = await window.api.pickCwd(); if (dir) $('cwd').value = dir; });
$('btnSave').addEventListener('click', async () => {
  $('cfgMsg').textContent = '';
  const r = await window.api.saveConfig({ relayUrl: $('relayUrl').value, cwd: $('cwd').value, autoStart: $('autoStart').checked });
  if (!r.ok) $('cfgMsg').textContent = r.error || '保存失败';
});
$('btnImport').addEventListener('click', openImportWizard);
$('btnRescan').addEventListener('click', async () => { $('importMsg').textContent = ''; renderDetection(await window.api.detectZCode()); });
$('btnSkipImport').addEventListener('click', async () => {
  const r = await window.api.dismissFirstRun();
  if (r.ok) $('importOverlay').classList.add('hidden');
  else $('importMsg').textContent = r.error || '保存失败';
});
$('btnApplyImport').addEventListener('click', async () => {
  $('importMsg').textContent = '';
  const r = await window.api.applyFirstRun({
    relayUrl: $('relayUrl').value,
    cwd: $('cwd').value,
    autoStart: $('autoStart').checked,
    selection: selectionFromUi(),
  });
  if (r.ok) $('importOverlay').classList.add('hidden');
  else $('importMsg').textContent = r.error || '保存失败';
});
