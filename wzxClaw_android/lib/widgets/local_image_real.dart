// io 平台实现：本地文件图
import 'dart:io';

import 'package:flutter/widgets.dart';

Widget buildLocalImage(
  String path, {
  double? width,
  double? height,
  BoxFit? fit,
  Widget? errorWidget,
}) =>
    Image.file(
      File(path),
      width: width,
      height: height,
      fit: fit,
      errorBuilder: (_, __, ___) => errorWidget ?? const SizedBox.shrink(),
    );
