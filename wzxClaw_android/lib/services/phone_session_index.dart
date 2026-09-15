import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 手机本地会话索引条目（Option A「会话独立」）。
///
/// 手机创建的会话只记录在本地：sessionId + 所属设备 + 标题（取首条
/// 消息前缀）+ 工作区。抽屉列表以此为准，不再依赖引擎 session/list
/// （那会把桌面端自建会话混进来，且各引擎之间互不可见）。
class PhoneSessionEntry {
  final String sessionId;
  final String deviceSid;

  /// 设备显示名（快照，设备改名后旧条目沿用旧名，仅用于分组展示）
  final String? deviceName;
  final String title;

  /// 首条用户消息原文（重命名前的兜底标题来源）
  final String? firstMessage;
  final int createdAt; // epoch ms
  final int updatedAt; // epoch ms
  final String? workspaceKey;
  final String? workspacePath;

  const PhoneSessionEntry({
    required this.sessionId,
    required this.deviceSid,
    this.deviceName,
    required this.title,
    this.firstMessage,
    required this.createdAt,
    required this.updatedAt,
    this.workspaceKey,
    this.workspacePath,
  });

  Map<String, dynamic> toJson() => {
        'sessionId': sessionId,
        'deviceSid': deviceSid,
        if (deviceName != null) 'deviceName': deviceName,
        'title': title,
        if (firstMessage != null) 'firstMessage': firstMessage,
        'createdAt': createdAt,
        'updatedAt': updatedAt,
        if (workspaceKey != null) 'workspaceKey': workspaceKey,
        if (workspacePath != null) 'workspacePath': workspacePath,
      };

  factory PhoneSessionEntry.fromJson(Map<String, dynamic> json) =>
      PhoneSessionEntry(
        sessionId: json['sessionId'] as String? ?? '',
        deviceSid: json['deviceSid'] as String? ?? '',
        deviceName: json['deviceName'] as String?,
        title: json['title'] as String? ?? '（无标题会话）',
        firstMessage: json['firstMessage'] as String?,
        createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
        updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
        workspaceKey: json['workspaceKey'] as String?,
        workspacePath: json['workspacePath'] as String?,
      );

  PhoneSessionEntry copyWith({
    String? title,
    int? updatedAt,
    String? workspaceKey,
    String? workspacePath,
  }) =>
      PhoneSessionEntry(
        sessionId: sessionId,
        deviceSid: deviceSid,
        deviceName: deviceName,
        title: title ?? this.title,
        firstMessage: firstMessage,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
        workspaceKey: workspaceKey ?? this.workspaceKey,
        workspacePath: workspacePath ?? this.workspacePath,
      );
}

/// 每台设备记住的工作区（新建会话复用，避免每次都向引擎发现）。
class DeviceWorkspace {
  final String deviceSid;
  final String workspaceKey;
  final String workspacePath;

  const DeviceWorkspace({
    required this.deviceSid,
    required this.workspaceKey,
    required this.workspacePath,
  });

  /// 工作区显示名：路径末段（/workspace → workspace）
  String get displayName {
    final p = workspacePath.replaceAll('\\', '/');
    final seg = p.split('/').where((s) => s.isNotEmpty).toList();
    return seg.isEmpty ? p : seg.last;
  }
}

/// 手机本地会话索引（SharedPreferences JSON 持久化，量级小无需上 SQLite）。
class PhoneSessionIndex {
  PhoneSessionIndex._();

  static final PhoneSessionIndex _instance = PhoneSessionIndex._();
  static PhoneSessionIndex get instance => _instance;

  static const _entriesKey = 'phone_session_index_v1';
  static const _deviceWsKey = 'phone_device_workspace_v1';

  /// 标题长度上限：取首条消息前 30 字
  static const titleMaxLength = 30;

  final _changesController =
      StreamController<List<PhoneSessionEntry>>.broadcast();
  Stream<List<PhoneSessionEntry>> get changes => _changesController.stream;

  List<PhoneSessionEntry>? _entriesCache;
  Map<String, DeviceWorkspace>? _deviceWsCache;
  bool _loaded = false;

  /// 由首条用户消息派生会话标题：压缩空白后取前 30 字。
  static String deriveTitle(String firstMessage) {
    final compact = firstMessage.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (compact.isEmpty) return '（无标题会话）';
    if (compact.length <= titleMaxLength) return compact;
    return '${compact.substring(0, titleMaxLength)}…';
  }

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_entriesKey) ?? const [];
    _entriesCache = [
      for (final json in raw)
        if (json.isNotEmpty)
          PhoneSessionEntry.fromJson(
            Map<String, dynamic>.from(jsonDecode(json) as Map? ?? const {}),
          ),
    ];
    final wsRaw = prefs.getString(_deviceWsKey) ?? '';
    _deviceWsCache = {};
    if (wsRaw.isNotEmpty) {
      final map = jsonDecode(wsRaw);
      if (map is Map<String, dynamic>) {
        map.forEach((sid, value) {
          if (value is Map) {
            final key = value['workspaceKey'] as String?;
            final path = value['workspacePath'] as String?;
            if (key != null && key.isNotEmpty && path != null && path.isNotEmpty) {
              _deviceWsCache![sid] = DeviceWorkspace(
                deviceSid: sid,
                workspaceKey: key,
                workspacePath: path,
              );
            }
          }
        });
      }
    }
    _loaded = true;
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_entriesKey, [
      for (final e in _entriesCache ?? const <PhoneSessionEntry>[])
        jsonEncode(e.toJson()),
    ]);
    final wsJson = jsonEncode({
      for (final e in _deviceWsCache?.values ?? const <DeviceWorkspace>[])
        e.deviceSid: {
          'workspaceKey': e.workspaceKey,
          'workspacePath': e.workspacePath,
        },
    });
    await prefs.setString(_deviceWsKey, wsJson);
  }

  // ── 查询 ──────────────────────────────────────────────

  /// 某台设备的会话（updatedAt 倒序）。deviceSid 为空时返回全部。
  Future<List<PhoneSessionEntry>> sessionsForDevice(String deviceSid) async {
    await _ensureLoaded();
    final list = (_entriesCache ?? const <PhoneSessionEntry>[])
        .where((e) => deviceSid.isEmpty || e.deviceSid == deviceSid)
        .toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return List.unmodifiable(list);
  }

  Future<PhoneSessionEntry?> find(String sessionId) async {
    await _ensureLoaded();
    return (_entriesCache ?? const <PhoneSessionEntry>[])
        .where((e) => e.sessionId == sessionId)
        .firstOrNull;
  }

  Future<DeviceWorkspace?> workspaceFor(String deviceSid) async {
    await _ensureLoaded();
    return deviceSid.isEmpty ? null : _deviceWsCache?[deviceSid];
  }

  // ── 变更 ──────────────────────────────────────────────

  /// 写入/更新一条索引。已存在时保留 createdAt 与首条消息。
  Future<void> upsert(PhoneSessionEntry entry) async {
    await _ensureLoaded();
    final entries = _entriesCache ??= <PhoneSessionEntry>[];
    final idx = entries.indexWhere((e) => e.sessionId == entry.sessionId);
    if (idx >= 0) {
      final old = entries[idx];
      entries[idx] = PhoneSessionEntry(
        sessionId: entry.sessionId,
        deviceSid: entry.deviceSid,
        deviceName: entry.deviceName ?? old.deviceName,
        title: entry.title,
        firstMessage: entry.firstMessage ?? old.firstMessage,
        createdAt: old.createdAt,
        updatedAt: entry.updatedAt,
        workspaceKey: entry.workspaceKey ?? old.workspaceKey,
        workspacePath: entry.workspacePath ?? old.workspacePath,
      );
    } else {
      entries.add(entry);
    }
    await _persist();
    _emit();
  }

  /// 删除 = 仅删手机索引条目，引擎侧会话副本保留（Option A 语义）。
  Future<void> remove(String sessionId) async {
    await _ensureLoaded();
    (_entriesCache ??= <PhoneSessionEntry>[])
        .removeWhere((e) => e.sessionId == sessionId);
    await _persist();
    _emit();
  }

  Future<void> rename(String sessionId, String title) async {
    await _ensureLoaded();
    final entries = _entriesCache;
    if (entries == null) return;
    final idx = entries.indexWhere((e) => e.sessionId == sessionId);
    if (idx == -1) return;
    entries[idx] = entries[idx].copyWith(title: title);
    await _persist();
    _emit();
  }

  /// 会话有新活动时刷新 updatedAt（保持列表排序贴合真实使用）。
  Future<void> touch(String sessionId, {int? updatedAt}) async {
    await _ensureLoaded();
    final entries = _entriesCache;
    if (entries == null) return;
    final idx = entries.indexWhere((e) => e.sessionId == sessionId);
    if (idx == -1) return;
    entries[idx] = entries[idx]
        .copyWith(updatedAt: updatedAt ?? DateTime.now().millisecondsSinceEpoch);
    await _persist();
    _emit();
  }

  Future<void> setDeviceWorkspace(
      String deviceSid, String workspaceKey, String workspacePath,) async {
    await _ensureLoaded();
    if (deviceSid.isEmpty || workspaceKey.isEmpty || workspacePath.isEmpty) {
      return;
    }
    (_deviceWsCache ??= {})[deviceSid] = DeviceWorkspace(
      deviceSid: deviceSid,
      workspaceKey: workspaceKey,
      workspacePath: workspacePath,
    );
    await _persist();
  }

  void _emit() {
    _changesController.add(List.unmodifiable(_entriesCache ?? const []));
  }

  /// 仅测试用：清空内存缓存，下一个用例重新从 mock prefs 读取。
  @visibleForTesting
  static void resetForTest() {
    _instance._loaded = false;
    _instance._entriesCache = null;
    _instance._deviceWsCache = null;
  }
}
