// ============================================================
// file_types — 文件类型共享数据（纯数据模块，无状态无依赖）
//
// 两个消费方：下载服务（preview/save 的 MIME）与正文路径转链接
// （已知扩展名准入）。放 models 层供任意层引用，禁止反向依赖服务。
// ============================================================

/// 按扩展名映射 MIME；未知类型走 application/octet-stream
const Map<String, String> _mimeTable = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
  'gif': 'image/gif',
  'svg': 'image/svg+xml',
  'pdf': 'application/pdf',
  'txt': 'text/plain',
  'md': 'text/markdown',
  'csv': 'text/csv',
  'html': 'text/html',
  'htm': 'text/html',
  'json': 'application/json',
  'xml': 'application/xml',
  'zip': 'application/zip',
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'mov': 'video/quicktime',
  'doc': 'application/msword',
  'docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

String mimeForName(String name) =>
    _mimeTable[extensionOf(name)] ?? 'application/octet-stream';

/// 「已知扩展名」判定（MIME 表同源）：markdown 裸路径转链接的准入条件
bool isKnownFileExtension(String name) => _mimeTable.containsKey(extensionOf(name));

String extensionOf(String name) {
  final idx = name.lastIndexOf('.');
  if (idx < 0 || idx == name.length - 1) return '';
  return name.substring(idx + 1).toLowerCase();
}
