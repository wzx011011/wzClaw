// ============================================================
// pairing_url — 配对链接解析（自翻译壳迁出的幸存纯函数）
//
// R3 翻译壳退役：这两个函数与协议翻译无关（配对 URL 形状解析），
// 被 pairing_store / settings / landing 依赖，故独立成模块存活。
// ============================================================

/// 解析配对链接（宽容 scheme 版）：https/http/wss/ws 均可。
/// 旧 UI 的地址校验只放行 wss://，因此 wss 形式的配对链接也必须可用。
/// 返回 relay 的 ws 地址（wss/ws 原样保留 scheme，http(s) 按升级规则转换）。
({String relayWsUrl, String sid, String hash})? parsePairingUrlAny(String url) {
  try {
    final uri = Uri.parse(url.trim());
    final scheme = uri.scheme.toLowerCase();
    final isHttp = scheme == 'https' || scheme == 'http';
    final isWs = scheme == 'wss' || scheme == 'ws';
    if (!isHttp && !isWs) return null;
    final sid = uri.queryParameters['sid'] ?? '';
    final hash = uri.queryParameters['hash'] ?? '';
    if (sid.isEmpty || sid.length > 256 || hash.isEmpty) return null;
    final wsScheme = isHttp ? (scheme == 'https' ? 'wss' : 'ws') : scheme;
    return (
      relayWsUrl: '$wsScheme://${uri.host}${uri.hasPort ? ':${uri.port}' : ''}/ws',
      sid: sid,
      hash: hash,
    );
  } catch (_) {
    return null;
  }
}

/// 扫码结果 → 设置页地址栏应填内容（配对链接专用）。
/// https/http 升级为 wss/ws 以通过地址校验；路径与查询参数（sid/hash/name）
/// 原样保留——链接本身就是完整凭据，任何剥参都会破坏配对。
/// 非配对链接（无 sid+hash）返回 null，调用方走旧 token 二维码后处理。
String? normalizeQrScanToServerUrl(String raw) {
  if (parsePairingUrlAny(raw) == null) return null;
  final uri = Uri.parse(raw.trim());
  final scheme = uri.scheme.toLowerCase();
  final wsScheme =
      scheme == 'https' ? 'wss' : scheme == 'http' ? 'ws' : scheme;
  return uri.replace(scheme: wsScheme).toString();
}
