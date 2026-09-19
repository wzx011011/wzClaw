import 'package:markdown/markdown.dart' as md;

import '../models/file_types.dart';

/// 共享实例：MarkdownBody 每帧重建时传同一对象，避免触发无谓的重新解析
final filePathLinkSyntax = FilePathLinkSyntax();

/// 裸绝对路径 → file:// 链接的行内语法，挂进 flutter_markdown 解析层
/// （MarkdownBody 的 inlineSyntaxes）。
///
/// 放在解析层而不是做正则文本预处理，代码块/行内 code/已有链接的语义
/// 全部由 markdown 解析器本身保证：
/// - fenced / 缩进代码块是块级节点，不进行内联解析——天然不改写；
///   （正则预处理版本对缩进代码块是盲的，这是重写的直接原因）
/// - 行内 code 由 CodeSyntax 在反引号处整体消费——天然不改写；
/// - 已有链接的 `(目的地)` 不做内联解析——天然不改写。
class FilePathLinkSyntax extends md.InlineSyntax {
  FilePathLinkSyntax() : super(_pathPattern);

  /// 盘符根（`E:\`、`E:/`）或 `/` 开头的连续路径字符；排除空白、markdown
  /// 语法字符、全角标点（中文句读）与 Windows 文件名非法字符 `*?"`——
  /// 含这些字符的候选不可能是真实路径（还可能吞掉强调语法起始符）。
  /// 全角标点用 \u 转义书写（曾有编辑把字面全角引号写成 ASCII 引号
  /// 终止 raw string 的事故，转义写法免疫）。
  // 全角集：，。；：！？、（）【】《》“”‘’…—
  static const _pathPattern =
      '(?:[A-Za-z]:[\\\\/]|[\\\\/])[^\\s`(){}\\[\\]<>|;*?"'
      '\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001'
      '\uFF08\uFF09\u3010\u3011\u300A\u300B'
      '\u201C\u201D\u2018\u2019\u2026\u2014]*';

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final raw = match.group(0)!;
    final path = _trimToKnownPath(raw);
    // InlineSyntax 约定：pattern 已匹配时 onMatch 必须消费文本（返回 false
    // 会让解析器原地重试）。非已知文件路径整段按普通文本放行。
    if (path == null) {
      parser.addNode(md.Text(raw));
      return true;
    }
    final normalized = path.replaceAll('\\', '/');
    final withSlash = normalized.startsWith('/') ? normalized : '/$normalized';
    final name = normalized.split('/').where((s) => s.isNotEmpty).last;
    parser.addNode(
      md.Element.text('a', name)..attributes['href'] = 'file://$withSlash',
    );
    // trim 剥掉的尾部标点回填为文本（match 消费长度含它们）
    final rest = raw.substring(path.length);
    if (rest.isNotEmpty) parser.addNode(md.Text(rest));
    return true;
  }

  /// 句尾跟随的普通标点（逐个剥离，直到剩余串是已知扩展名路径）
  /// 句尾跟随的普通标点（逐个剥离，直到剩余串是已知扩展名路径）。
  /// 全角集用 \u 转义书写（同 _pathPattern 的原因）。
  // 全角部分：、。，；：！？）】》」』…
  static const _trailingPunctuation =
      '.,;:!?\'"`'
      '\u3001\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F'
      '\uFF09\u3011\u300B\u300D\u300F\u2026';

  /// 剥离尾部标点后若以已知扩展名结尾则返回该路径，否则 null
  static String? _trimToKnownPath(String candidate) {
    var s = candidate;
    while (s.isNotEmpty && _trailingPunctuation.contains(s[s.length - 1])) {
      s = s.substring(0, s.length - 1);
      if (isKnownFileExtension(s)) return s;
    }
    if (s.isEmpty) return null;
    // 候选开头即分隔符，必须至少还有一段路径内容
    final normalized = s.replaceAll('\\', '/');
    if (!normalized.contains('/', 1)) return null;
    return isKnownFileExtension(s) ? s : null;
  }
}

/// 链接 href → 节点侧文件路径；非文件链接（http/https/锚点等）返回 null。
/// 兼容：我们生成的 `file:///E:/a/x.png`、`file:///home/u/x.png`，
/// 以及 AI 手写的裸路径目的地 `E:\a\x.png` / `/home/u/x.png`。
/// Windows 路径统一回传 `E:/ai/x.png` 盘符形态（companion 侧
/// path.resolve 对盘符形态语义明确）。
String? fileLinkToPath(String href) {
  var s = href.trim();
  if (s.isEmpty) return null;
  if (s.toLowerCase().startsWith('file://')) {
    var rest = s.substring('file://'.length).replaceAll(RegExp(r'^/+'), '');
    rest = Uri.decodeFull(rest);
    if (rest.length >= 2 && rest.codeUnitAt(1) == 0x3A /* ':' */) {
      return rest; // E:/ai/x.png
    }
    return '/$rest'; // home/u/x.png → /home/u/x.png（Unix 绝对形态）
  }
  final lower = s.toLowerCase();
  if (lower.length >= 2 && lower.codeUnitAt(1) == 0x3A) return s; // E:\a\x.png
  if (s.startsWith('/')) return s; // /home/u/x.png
  return null;
}
