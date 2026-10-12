// Markdown 表格导出契约（对齐官方「复制 Markdown / 下载 CSV」，阶段 2c）。
// 覆盖：表格识别（含围栏代码块内的 | 行不误判）、分段保序、CSV 转义。
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/widgets/markdown_table_export.dart';

void main() {
  test('识别 GFM 表格：表头+分隔行+数据行，行数 = 数据行数+1', () {
    const content = '| 组件 | 规模 |\n| --- | --- |\n| relay | 408 行 |\n| store | 1.2k 行 |';
    final tables = extractTables(content);
    expect(tables, hasLength(1));
    expect(tables.single.rows, hasLength(3), reason: '表头 + 2 数据行');
    expect(tables.single.rows[0], ['组件', '规模']);
    expect(tables.single.rows[1], ['relay', '408 行']);
    expect(tables.single.rows[2], ['store', '1.2k 行']);
  });

  test('围栏代码块内的 | 行不判为表格', () {
    const content = '```\n| a | b |\n| - | - |\n```\n\n| x | y |\n| - | - |';
    final tables = extractTables(content);
    expect(tables, hasLength(1), reason: '只有围栏外的表格');
    expect(tables.single.rows[0], ['x', 'y']);
  });

  test('分段保序：文本段与表格段交错时顺序不变', () {
    const content = '前文\n\n| a | b |\n| - | - |\n\n后文';
    final segments = segmentMarkdown(content);
    expect(segments, hasLength(3));
    expect(segments[0].text, '前文');
    expect(segments[0].table, isNull);
    expect(segments[1].table, isNotNull);
    expect(segments[2].text, '后文');
  });

  test('无表格：单段透传（渲染路径零改动）', () {
    const content = '# 标题\n\n普通段落';
    final segments = segmentMarkdown(content);
    expect(extractTables(content), isEmpty);
    expect(segments.single.table, isNull);
    expect(segments.single.text, contains('# 标题'));
  });

  test('CSV 转义：逗号/引号/换行加引号包裹，内部引号翻倍；短行补空', () {
    final csv = toCsv([
      ['名称', '命令'],
      ['含逗号', 'echo "a,b"'],
      ['单列'],
    ]);
    final lines = csv.split('\n');
    expect(lines[0], '名称,命令');
    expect(lines[1], '含逗号,"echo ""a,b"""');
    expect(lines[2], '单列,', reason: '短行补空到同宽');
  });

  test('单元格 trim 与首尾管道容忍', () {
    const content = '|a | b|\n|---|---|\n| 值1 | 值2 |';
    final tables = extractTables(content);
    expect(tables.single.rows[0], ['a', 'b']);
    expect(tables.single.rows[1], ['值1', '值2']);
  });
}
