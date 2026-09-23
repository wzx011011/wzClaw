// web 桩：无 dart:io 平台 API，保持 WebSocketChannel.connect 默认行为。
// web 的地址族选择由浏览器自己完成（Happy Eyeballs 内建），无需双栈竞速；
// 本文件与 relay_connect_factory_real.dart 同签名（见 platform_io 门面模式）。
import 'package:web_socket_channel/web_socket_channel.dart';

WebSocketChannel connectRelay(Uri url) => WebSocketChannel.connect(url);
