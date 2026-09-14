/// Information about a connected desktop, as reported by the relay.
class DesktopInfo {
  final String desktopId;
  final String? name;
  final String? platform;
  final int connectedAt; // epoch ms

  const DesktopInfo({
    required this.desktopId,
    this.name,
    this.platform,
    required this.connectedAt,
  });

  factory DesktopInfo.fromJson(Map<String, dynamic> json) {
    return DesktopInfo(
      desktopId: json['desktopId'] as String? ?? '',
      name: json['name'] as String?,
      platform: json['platform'] as String?,
      connectedAt: (json['connectedAt'] as num?)?.toInt() ?? 0,
    );
  }

  /// Display label for the desktop.
  String get displayLabel => name ?? platform ?? 'Desktop';

  @override
  String toString() => 'DesktopInfo(id: $desktopId, name: $name, platform: $platform)';
}
