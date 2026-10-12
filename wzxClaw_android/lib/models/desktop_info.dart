/// Information about a connected desktop, as reported by the relay.
class DesktopInfo {
  final String desktopId;
  final String? name;
  final String? platform;
  final int connectedAt; // epoch ms

  /// 是否在线（多配对下列表含离线桌面：在线=当前连接已匹配的桌面，
  /// 或 probe 探测到 pair_status=matched 的桌面）
  final bool online;

  const DesktopInfo({
    required this.desktopId,
    this.name,
    this.platform,
    required this.connectedAt,
    this.online = true,
  });

  factory DesktopInfo.fromJson(Map<String, dynamic> json) {
    return DesktopInfo(
      desktopId: json['desktopId'] as String? ?? '',
      name: json['name'] as String?,
      platform: json['platform'] as String?,
      connectedAt: (json['connectedAt'] as num?)?.toInt() ?? 0,
      online: json['online'] as bool? ?? true,
    );
  }

  /// Display label for the desktop.
  String get displayLabel => name ?? platform ?? 'Desktop';

  @override
  String toString() => 'DesktopInfo(id: $desktopId, name: $name, platform: $platform)';
}
