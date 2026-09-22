// web 桩：同签名、无平台能力（见 platform_io.dart 门面说明）。
// 调用侧全部有 kIsWeb 早退守卫，这里的 throw 只是不可能路径的兜底。
class InternetAddressType {
  // 与 dart:io 枚举成员同名（web 构建走本桩，调用方按真名比较）；
  // 命名刻意跟随 dart:io（大写 V），忽略 lowerCamelCase 约束
  // ignore: constant_identifier_names
  static const IPv4 = 'IPv4';
  // ignore: constant_identifier_names
  static const IPv6 = 'IPv6';
  static const unixDomain = 'unixDomain';
  static const any = 'any';
}

class InternetAddress {
  const InternetAddress();

  /// 与 dart:io 对齐的实例字段（诊断面比较 addr.type 用）
  String get type => InternetAddressType.any;

  static Future<List<InternetAddress>> lookup(String host) async {
    throw UnsupportedError('InternetAddress.lookup 在 web 上不可用');
  }
}

class SecureSocket {
  SecureSocket._();

  static Future<SecureSocket> connect(
    dynamic host,
    int port, {
    Duration? timeout,
    bool Function(X509Certificate)? onBadCertificate,
  }) async {
    throw UnsupportedError('SecureSocket 在 web 上不可用');
  }

  void destroy() {}
}

class X509Certificate {
  const X509Certificate();
}

class HttpClient {
  HttpClient();

  static Future<HttpClient> findProxyFromEnvironment() async =>
      throw UnsupportedError('HttpClient 在 web 上不可用');

  Future<dynamic> getUrl(Uri url) async {
    throw UnsupportedError('HttpClient 在 web 上不可用');
  }
}

class HttpException implements Exception {
  final String message;
  const HttpException(this.message);
  @override
  String toString() => message;
}

class Platform {
  const Platform._();

  static bool get isAndroid => false;
  static bool get isIOS => false;
  static bool get isMacOS => false;
  static bool get isWindows => false;
  static bool get isLinux => false;
}
