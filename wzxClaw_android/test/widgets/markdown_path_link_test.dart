import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:wzxclaw_android/widgets/markdown_path_link.dart';

/// 挂上 FilePathLinkSyntax 的内联解析（与 home_page 的 MarkdownBody 同参）
List<md.Node> parse(String text) =>
    md.Document(inlineSyntaxes: [FilePathLinkSyntax()]).parseInline(text);

/// 展开节点树里的所有 a 元素
List<md.Element> anchors(List<md.Node> nodes) => [
      for (final node in nodes)
        if (node is md.Element && node.tag == 'a') node,
];

String hrefOf(md.Node node) => (node as md.Element).attributes['href']!;

void main() {
  group('FilePathLinkSyntax（markdown 解析层）', () {
    test('Windows 裸路径转为 a 节点，句尾中文标点留在文本', () {
      final nodes = parse('文件在 E:\\ai\\x\\report.pdf。请查收');
      final a = anchors(nodes);
      expect(a, hasLength(1));
      expect(hrefOf(a.single), 'file:///E:/ai/x/report.pdf');
      expect(a.single.textContent, 'report.pdf');
      expect(nodes.last.textContent, '。请查收');
    });

    test('Unix 绝对路径转链接', () {
      final a = anchors(parse('构建日志见 /home/u/build/log.txt'));
      expect(a, hasLength(1));
      expect(hrefOf(a.single), 'file:///home/u/build/log.txt');
      expect(a.single.textContent, 'log.txt');
    });

    test('正斜杠 Windows 路径同样识别', () {
      final a = anchors(parse('产出: E:/out/data.csv'));
      expect(hrefOf(a.single), 'file:///E:/out/data.csv');
    });

    test('全角标点终止候选，中文句子正常转换', () {
      final a = anchors(parse('生成完毕：E:\\out\\data.csv，请查收'));
      expect(a, hasLength(1));
      expect(hrefOf(a.single), 'file:///E:/out/data.csv');
      expect(nodesTextTail(parse('生成完毕：E:\\out\\data.csv，请查收')), '，请查收');
    });

    test('纯路径行内 code 不改写（CodeSyntax 整体消费）', () {
      final a = anchors(parse('截图已存 `E:\\shots\\a.png` 请查看'));
      expect(a, isEmpty);
    });

    test('已有 markdown 链接的目的地不嵌套改写', () {
      final a = anchors(parse('报告见 [报告](file:///E:/x/a.pdf) 与 [文档](https://x.com/y)'));
      expect(a, hasLength(2));
      expect(hrefOf(a.first), 'file:///E:/x/a.pdf');
      expect(a.first.textContent, '报告');
      expect(hrefOf(a.last), 'https://x.com/y');
    });

    test('未知扩展名 / 相对路径 / 裸目录不转换（按普通文本消费）', () {
      expect(anchors(parse('未知 out/data.zzz')), isEmpty);
      expect(anchors(parse('相对 docs/readme.md 不转')), isEmpty);
      expect(anchors(parse('目录 E:\\ai\\wzxClaw 不是文件')), isEmpty);
    });

    test('Windows 文件名非法字符 *?" 截断候选——含它们的串不是真实路径', () {
      // `*` 会吞掉强调语法起始符，必须截断
      expect(anchors(parse('看这个 /a*b.md 的输出')), isEmpty);
      expect(anchors(parse('通配 E:\\x??.md 不算路径')), isEmpty);
    });

    test('路径后跟 ASCII 标点正常剥离且标点保留', () {
      final nodes = parse('done: /tmp/build/out.zip.');
      final a = anchors(nodes);
      expect(hrefOf(a.single), 'file:///tmp/build/out.zip');
      expect(nodes.last.textContent, '.');
    });

    test('非路径斜杠文本按普通文本放行（不死循环、内容不丢）', () {
      expect(parse('/and/or').map((n) => n.textContent).join(), '/and/or');
    });
  });

  group('fileLinkToPath', () {
    test('file:/// Windows 形态还原为盘符路径', () {
      expect(fileLinkToPath('file:///E:/ai/x.png'), 'E:/ai/x.png');
    });

    test('file:/// Unix 形态保持绝对路径', () {
      expect(fileLinkToPath('file:///home/u/x.png'), '/home/u/x.png');
    });

    test('裸路径 href 原样返回', () {
      expect(fileLinkToPath(r'E:\a\x.pdf'), r'E:\a\x.pdf');
      expect(fileLinkToPath('/a/b.txt'), '/a/b.txt');
    });

    test('URL 编码中文解码', () {
      expect(fileLinkToPath('file:///E:/%E4%B8%AD%E6%96%87/a.png'), 'E:/中文/a.png');
    });

    test('非文件链接返回 null', () {
      expect(fileLinkToPath('https://x.com/a'), isNull);
      expect(fileLinkToPath('http://x.com'), isNull);
      expect(fileLinkToPath('#anchor'), isNull);
      expect(fileLinkToPath(''), isNull);
    });
  });
}

/// 取节点流最后一个文本（句尾标点断言用）
String nodesTextTail(List<md.Node> nodes) => nodes.last.textContent;
