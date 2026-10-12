// Markdown 表格导出（对齐官方消息流表格的「复制 Markdown / 下载 CSV」）。
//
// 解析规则（GFM）：
// - 表格 = 表头行 + 分隔行（|---|:---:| 形态）+ 若干数据行，遇非表格行/
//   空行结束；
// - 围栏代码块（``` / ~~~）内的 | 行不参与表格识别；
// - 单元格按 | 切分并 trim，容忍首尾管道缺失。
//
// 导出语义：
// - 复制 Markdown = 表格块原文（原样保真）；
// - 下载 CSV = 标准转义（含逗号/引号/换行的单元格加引号包裹，内部引号翻倍），
//   经下载通道落 MediaStore。列数取全表最大宽度，短行补空。

/// 一个识别出的 Markdown 表格块
class MdTableBlock {
  const MdTableBlock({required this.raw, required this.rows});

  /// 表格块的原文（含表头与分隔行，原样保真用于「复制 Markdown」）
  final String raw;

  /// 解析后的单元格（rows[0] = 表头；短行已补空到同宽）
  final List<List<String>> rows;

  bool get isEmpty => rows.isEmpty;
}

/// 把 markdown 内容切分为（普通段 | 表格块）序列。
/// 普通段交给 MarkdownBody 原样渲染，表格块在渲染外挂导出操作条。
List<({String text, MdTableBlock? table})> segmentMarkdown(String content) {
  final segments = <({String text, MdTableBlock? table})>[];
  final textBuf = StringBuffer();
  var inFence = false;
  var fenceMarker = '';
  var i = 0;
  final lines = content.split('\n');
  String flush() {
    final t = textBuf.toString().trim();
    textBuf.clear();
    if (t.trim().isNotEmpty) segments.add((text: t, table: null));
    return t;
  }

  while (i < lines.length) {
    final line = lines[i];
    final fence = _fenceOf(line);
    if (inFence || fence != null) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence!;
      } else if (fence != null && fence.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      textBuf.writeln(line);
      i++;
      continue;
    }
    // 表格起始：当前行含 | 且下一行是分隔行
    if (i + 1 < lines.length &&
        line.trimLeft().startsWith('|') &&
        _isTableSeparator(lines[i + 1])) {
      flush();
      final blockLines = <String>[line, lines[i + 1]];
      i += 2;
      while (i < lines.length && _isTableRow(lines[i])) {
        blockLines.add(lines[i]);
        i++;
      }
      final raw = blockLines.join('\n');
      segments.add((
        text: raw,
        table: MdTableBlock(
          raw: raw,
          rows: _parseRows(blockLines),
        ),
      ),);
      continue;
    }
    textBuf.writeln(line);
    i++;
  }
  flush();
  return segments;
}

/// 提取全部表格块（导出动作测试与调试用）
List<MdTableBlock> extractTables(String content) => segmentMarkdown(content)
    .map((s) => s.table)
    .whereType<MdTableBlock>()
    .toList();

/// GFM CSV 转义并序列化
String toCsv(List<List<String>> rows) {
  if (rows.isEmpty) return '';
  final width = rows.fold<int>(0, (n, r) => n > r.length ? n : r.length);
  String cell(String v) {
    if (v.contains(',') || v.contains('"') || v.contains('\n')) {
      return '"${v.replaceAll('"', '""')}"';
    }
    return v;
  }

  return rows
      .map((r) => [for (var c = 0; c < width; c++) cell(c < r.length ? r[c] : '')].join(','))
      .join('\n');
}

/// 围栏标记（``` / ~~~ 及加长变体）；非围栏行返回 null
String? _fenceOf(String line) {
  final m = RegExp(r'^\s{0,3}(`{3,}|~{3,})').firstMatch(line);
  return m?.group(1);
}

bool _isTableSeparator(String line) {
  final t = line.trim();
  if (!t.contains('-') || !t.contains('|')) return false;
  // 分隔行只允许 |、-、:、空格
  return !t.replaceAll(RegExp(r'[|:\-\s]'), '').isNotEmpty;
}

bool _isTableRow(String line) {
  final t = line.trim();
  return t.isNotEmpty && t.startsWith('|') && t.endsWith('|');
}

List<List<String>> _parseRows(List<String> lines) {
  List<String> cellsOf(String line) {
    var t = line.trim();
    if (t.startsWith('|')) t = t.substring(1);
    if (t.endsWith('|')) t = t.substring(0, t.length - 1);
    // GFM 最简切分：\| 转义暂按原文保留（导出以原文为主，不追求全语义）
    return [for (final c in t.split('|')) c.trim()];
  }

  final rows = <List<String>>[];
  for (var i = 0; i < lines.length; i++) {
    if (i == 1) continue; // 分隔行不进入数据
    rows.add(cellsOf(lines[i]));
  }
  if (rows.isEmpty) return rows;
  final width = rows.fold<int>(0, (n, r) => n > r.length ? n : r.length);
  return [for (final r in rows) [for (var c = 0; c < width; c++) c < r.length ? r[c] : '']];
}
