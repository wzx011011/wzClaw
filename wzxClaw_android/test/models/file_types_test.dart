import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/file_types.dart';

void main() {
  test('mimeForName：常见扩展名映射，未知走 octet-stream', () {
    expect(mimeForName('a.png'), 'image/png');
    expect(mimeForName('B.PDF'), 'application/pdf');
    expect(mimeForName('notes.md'), 'text/markdown');
    expect(mimeForName('clip.mp4'), 'video/mp4');
    expect(
      mimeForName('table.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeForName('noext'), 'application/octet-stream');
    expect(mimeForName('weird.zzz'), 'application/octet-stream');
  });

  test('isKnownFileExtension / extensionOf：与 MIME 表同源', () {
    expect(isKnownFileExtension('a.png'), isTrue);
    expect(isKnownFileExtension('weird.zzz'), isFalse);
    expect(isKnownFileExtension('noext'), isFalse);
    // 无扩展名 / 点在末尾 / 只有扩展名形态
    expect(extensionOf('noext'), '');
    expect(extensionOf('trailing.'), '');
    expect(extensionOf('.gitignore'), 'gitignore');
  });
}
