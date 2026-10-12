// ============================================================
// pairing_store — 多桌面配对持久化
//
// 配对列表按 sid 去重，并单独记录活动桌面。PairingStore 是唯一持久化入口。
// 旧 server_url 只在首次 loadAll 时迁移一次，随后无论有效与否都删除，
// 不再双写，避免旧读取方重新引入第二份事实源。
// ============================================================

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../zcode/zcode_pairing.dart';
import 'pairing_url.dart' show parsePairingUrlAny;

/// 一条已保存的桌面配对
class StoredPairing {
  final ZcodePairingInfo info;

  /// 配对加入时间（epoch ms，设备列表展示用）
  final int addedAt;

  const StoredPairing({required this.info, required this.addedAt});

  Map<String, dynamic> toJson() => {
        'info': info.toJson(),
        'addedAt': addedAt,
      };

  static StoredPairing? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final info =
        ZcodePairingInfo.fromJson(json['info'] as Map<String, dynamic>?);
    if (info == null) return null;
    return StoredPairing(
      info: info,
      addedAt: (json['addedAt'] as num?)?.toInt() ?? 0,
    );
  }
}

class PairingStore {
  PairingStore._();

  static final PairingStore instance = PairingStore._();

  static const _listKey = 'pairing_list_v1';
  static const _activeKey = 'pairing_active_sid';
  static const _legacyUrlKey = 'server_url';

  List<StoredPairing> _cache = [];
  bool _loaded = false;

  /// 仅测试使用：清空内存缓存（单例在多测试间共享状态）
  @visibleForTesting
  static void resetForTest() {
    instance._cache = [];
    instance._loaded = false;
  }

  /// 全部已保存配对（首次调用触发 server_url 旧数据迁移）
  Future<List<StoredPairing>> loadAll() async {
    if (_loaded) return List.unmodifiable(_cache);
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_listKey);
    final list = <StoredPairing>[];
    if (raw != null && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          for (final item in decoded) {
            final sp = item is Map
                ? StoredPairing.fromJson(Map<String, dynamic>.from(item))
                : null;
            if (sp != null) list.add(sp);
          }
        }
      } catch (e) {
        debugPrint('[PairingStore] 配对列表解析失败，忽略: $e');
      }
    }
    final legacyUrl = prefs.getString(_legacyUrlKey);
    if (list.isEmpty && legacyUrl != null && legacyUrl.isNotEmpty) {
      // 一次性迁移：解析失败也删除旧键，防止每次启动重复尝试。
      final parsed = parsePairingUrlAny(legacyUrl);
      if (parsed != null) {
        final name = Uri.tryParse(legacyUrl)?.queryParameters['name'];
        list.add(
          StoredPairing(
            info: ZcodePairingInfo(
              relayWsUrl: parsed.relayWsUrl,
              sid: parsed.sid,
              hash: parsed.hash,
              desktopName: (name == null || name.isEmpty) ? '桌面 ZCode' : name,
            ),
            addedAt: DateTime.now().millisecondsSinceEpoch,
          ),
        );
        await prefs.setString(_listKey, jsonEncode([list.first.toJson()]));
        await prefs.setString(_activeKey, list.first.info.sid);
      }
    }
    if (prefs.containsKey(_legacyUrlKey)) {
      await prefs.remove(_legacyUrlKey);
    }
    _cache = list;
    _loaded = true;
    return List.unmodifiable(_cache);
  }

  /// 新增/更新配对（按 sid 去重：重扫同一桌面刷新 hash 与名称，不产生重复项）。
  /// 首条配对自动设为活动桌面。
  Future<void> upsert(ZcodePairingInfo info) async {
    await loadAll();
    final idx = _cache.indexWhere((s) => s.info.sid == info.sid);
    if (idx >= 0) {
      final old = _cache[idx];
      _cache[idx] = StoredPairing(
        info: ZcodePairingInfo(
          relayWsUrl: info.relayWsUrl,
          sid: info.sid,
          hash: info.hash,
          desktopName: info.desktopName ?? old.info.desktopName,
        ),
        addedAt: old.addedAt,
      );
    } else {
      _cache = [
        ..._cache,
        StoredPairing(
          info: info,
          addedAt: DateTime.now().millisecondsSinceEpoch,
        ),
      ];
    }
    await _persist();
    final active = await activeSid();
    if (active == null || active.isEmpty) {
      await setActiveSid(info.sid);
    } else if (_cache.indexWhere((s) => s.info.sid == active) == -1) {
      // 活动项不在列表（异常态）：回落到本条
      await setActiveSid(info.sid);
    }
  }

  /// 删除配对；被删的是活动桌面时活动位清空。
  Future<void> remove(String sid) async {
    await loadAll();
    _cache = _cache.where((s) => s.info.sid != sid).toList();
    await _persist();
    final active = await activeSid();
    if (active == sid) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_activeKey);
    }
  }

  Future<String?> activeSid() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_activeKey);
  }

  /// 设置活动桌面；不存在的 sid 不写入。
  Future<void> setActiveSid(String? sid) async {
    final prefs = await SharedPreferences.getInstance();
    if (sid == null || sid.isEmpty) {
      await prefs.remove(_activeKey);
      return;
    }
    await loadAll();
    if (!_cache.any((s) => s.info.sid == sid)) return;
    await prefs.setString(_activeKey, sid);
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _listKey,
      jsonEncode([for (final s in _cache) s.toJson()]),
    );
  }
}
