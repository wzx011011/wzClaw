// web 实现：blob:/data:/http(s) URL 走 network 渠道
import 'package:flutter/widgets.dart';

Widget buildLocalImage(
  String path, {
  double? width,
  double? height,
  BoxFit? fit,
  Widget? errorWidget,
}) =>
    Image.network(
      path,
      width: width,
      height: height,
      fit: fit,
      errorBuilder: (_, __, ___) => errorWidget ?? const SizedBox.shrink(),
    );
