'use strict';

// ============================================================
// zcode-importer — 「导入本机 ZCode 配置」执行器
//
// 输入是 zcode-integration.buildImportManifest() 的脱敏清单和用户勾选；
// 输出是 Companion 自己的快照文件（userData/import-snapshot.json）。
// 铁律：
// - 只写这一份快照，绝不写 ~/.zcode 任何原文件；
// - manifest 从源头就不含凭据，本模块再按类别裁剪（双保险）；
// - 勾选为空 = 明确拒绝，不做空导入假装成功；
// - 原子写入（tmp + rename），失败不落半份。
// ============================================================

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_SCHEMA_VERSION = 1;

// 类别 → manifest 字段的白名单。新类别必须同时在这里登记。
const CATEGORY_FIELDS = {
  models: 'models',
  workspaces: 'workspaces',
  preferences: 'preferences',
  extensions: 'extensions',
};

function normalizeSelection(selection) {
  const raw = selection && typeof selection === 'object' ? selection : {};
  const picked = {};
  for (const category of Object.keys(CATEGORY_FIELDS)) {
    if (raw[category] === true) picked[category] = true;
  }
  return picked;
}

function categoryCount(category, value) {
  if (category === 'workspaces') return Array.isArray(value) ? value.length : 0;
  if (category === 'models') {
    return value && Array.isArray(value.providers) ? value.providers.length : 0;
  }
  if (category === 'preferences') {
    return value && typeof value === 'object' ? Object.keys(value).length : 0;
  }
  if (category === 'extensions') {
    return value && typeof value === 'object'
      ? (value.skills?.length || 0) + (value.plugins?.length || 0)
        + (value.commands?.length || 0) + (value.mcpCount || 0)
      : 0;
  }
  return 0;
}

// 应用导入：按勾选裁剪 manifest 并原子写入快照。
// 返回 {ok, ...}；不满足前提时 ok:false + 原因，绝不静默成功。
function applyImport({ manifest, selection, snapshotPath, fsApi = fs, now = new Date() }) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: '导入清单不可用，请先重新扫描' };
  }
  const picked = normalizeSelection(selection);
  if (Object.keys(picked).length === 0) {
    return { ok: false, error: '未选择任何要导入的内容' };
  }

  const categories = {};
  const counts = {};
  for (const category of Object.keys(picked)) {
    const value = JSON.parse(JSON.stringify(manifest[CATEGORY_FIELDS[category]] ?? null));
    categories[category] = value;
    counts[category] = categoryCount(category, value);
  }

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    importedAt: now.toISOString(),
    categories,
  };

  try {
    const dir = path.dirname(snapshotPath);
    fsApi.mkdirSync(dir, { recursive: true });
    const tempPath = `${snapshotPath}.tmp`;
    fsApi.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    fsApi.renameSync(tempPath, snapshotPath);
  } catch (e) {
    return { ok: false, error: `写入导入快照失败：${e.message}` };
  }

  return { ok: true, importedAt: snapshot.importedAt, counts };
}

// 读取现有快照（无/损坏返回 null，由 UI 显示「尚未导入」）
function readSnapshot(snapshotPath, fsApi = fs) {
  try {
    const raw = fsApi.readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

// 快照摘要（给渲染层/回执展示，不返回内容本体）
function snapshotSummary(snapshotPath, fsApi = fs) {
  const snapshot = readSnapshot(snapshotPath, fsApi);
  if (!snapshot) return null;
  const categories = snapshot.categories || {};
  const counts = {};
  for (const category of Object.keys(categories)) {
    counts[category] = categoryCount(category, categories[category]);
  }
  return { importedAt: snapshot.importedAt, counts };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  CATEGORY_FIELDS,
  normalizeSelection,
  applyImport,
  readSnapshot,
  snapshotSummary,
};
