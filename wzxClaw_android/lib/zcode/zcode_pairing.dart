// ============================================================
// zcode_pairing — 配对 URL 解析与持久化模型
//
// 配对 URL 形如：https://zcode.5945.top/pair?sid=<uuid>&hash=<base64>
// 推导 relay 地址：https→wss / http→ws，路径 /pair → /ws
// hash 校验：标准 base64 的 32 字节（43 字符 + '='）
// ============================================================

/// 配对信息
class ZcodePairingInfo {
  final String relayWsUrl;
  final String sid;
  final String hash;

  const ZcodePairingInfo({required this.relayWsUrl, required this.sid, required this.hash});

  Map<String, dynamic> toJson() => {'relayWsUrl': relayWsUrl, 'sid': sid, 'hash': hash};

  static ZcodePairingInfo? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final info = ZcodePairingInfo(
      relayWsUrl: json['relayWsUrl'] as String? ?? '',
      sid: json['sid'] as String? ?? '',
      hash: json['hash'] as String? ?? '',
    );
    return _isValidHash(info.hash) && info.sid.isNotEmpty && info.relayWsUrl.isNotEmpty ? info : null;
  }
}

final RegExp _hashRe = RegExp(r'^[A-Za-z0-9+/]{43}=$');

bool _isValidHash(String hash) => _hashRe.hasMatch(hash);

/// 解析配对 URL；无效返回 null
ZcodePairingInfo? parsePairingUrl(String url) {
  try {
    final uri = Uri.parse(url.trim());
    if (!uri.isScheme('https') && !uri.isScheme('http')) return null;
    final sid = uri.queryParameters['sid'] ?? '';
    final hash = uri.queryParameters['hash'] ?? '';
    if (sid.isEmpty || sid.length > 256 || !_isValidHash(hash)) return null;
    final wsScheme = uri.isScheme('https') ? 'wss' : 'ws';
    return ZcodePairingInfo(
      relayWsUrl: '$wsScheme://${uri.host}${uri.hasPort ? ':${uri.port}' : ''}/ws',
      sid: sid,
      hash: hash,
    );
  } catch (_) {
    return null;
  }
}
