// ============================================================
// zcode_desktop_registry — 多桌面注册表
//
// 一个手机 App 同时连接多台桌面端：每台桌面 = 一个配对（room）= 一个
// 独立的 ZcodeChatStore 实例（会话/流式/通知状态互不串扰）。relay 协议
// 天然支持：手机为每个桌面开一条 WebSocket 以 probe 入房（每房限 3 手机）。
//
// - `ZcodeChatStore.instance` 变为注册表活动实例的动态指针（静态 getter），
//   页面既有调用零改动；切换桌面 = 换指针 + notify。
// - 持久化：SharedPreferences 'wzxclaw-zcode-desktops'（JSON 数组）+
//   'wzxclaw-zcode-active'；旧版单配对键 'wzxclaw-zcode-pairing' 首启迁移。
// - 桌面 id = 配对 sid（确定性 sid 方案下跨重启稳定）。
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'zcode_chat_store.dart';
import 'zcode_notifier.dart';
import 'zcode_pairing.dart';

const String _kDesktopsKey = 'wzxclaw-zcode-desktops';
const String _kActiveKey = 'wzxclaw-zcode-active';
const String _kLegacyPairingKey = 'wzxclaw-zcode-pairing';
const String _provisionalId = '__provisional__';

/// 单个已配对桌面条目
class ZcodeDesktopEntry {
  final String id;
  final String name;
  final String pairingUrl;

  const ZcodeDesktopEntry({required this.id, required this.name, required this.pairingUrl});

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'pairingUrl': pairingUrl};

  static ZcodeDesktopEntry fromJson(Map<String, dynamic> json) => ZcodeDesktopEntry(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        pairingUrl: json['pairingUrl'] as String? ?? '',
      );
}

/// 多桌面注册表：持有每桌面的 store、活动指针与持久化
class ZcodeDesktopRegistry extends ChangeNotifier {
  ZcodeDesktopRegistry._() {
    // 通知初始化是 app 作用域职责（原在 store 单例构造中完成）
    unawaited(ZcodeNotifier.instance.initialize());
  }

  static final ZcodeDesktopRegistry instance = ZcodeDesktopRegistry._();

  final Map<String, ZcodeChatStore> _stores = {};
  final List<ZcodeDesktopEntry> _entries = [];
  String? _activeId;
  bool _restored = false;
  bool _notifying = false;

  /// 测试注入：替换 store 构造（默认真机构造 detached 实例）
  @visibleForTesting
  ZcodeChatStore Function(ZcodeDesktopEntry entry)? storeFactory;

  /// 仅测试使用：清空内存态（持久化与单例语义复位）
  @visibleForTesting
  void resetForTest() {
    for (final store in _stores.values) {
      store
        ..onPaired = null
        ..onUnpaired = null;
    }
    _stores.clear();
    _entries.clear();
    _activeId = null;
    _restored = false;
  }

  // ---- 状态读取 ----

  List<ZcodeDesktopEntry> get entries => List.unmodifiable(_entries);

  Iterable<ZcodeChatStore> get stores => _stores.values;

  String? get activeId => _activeId;

  /// 当前活动 store（永不为 null：无桌面时返回临时实例，页面可正常渲染
  /// 配对门/扫码，配对成功后经 onPaired 转正）
  ZcodeChatStore get activeStore {
    final active = _activeId == null ? null : _stores[_activeId];
    if (active != null) return active;
    return _ensureProvisional();
  }

  ZcodeChatStore? storeOf(String id) => _stores[id];

  // ---- 恢复（冷启动） ----

  Future<void> restore() async {
    if (_restored) return;
    _restored = true;
    final prefs = await SharedPreferences.getInstance();
    final loaded = <ZcodeDesktopEntry>[];
    final raw = prefs.getString(_kDesktopsKey);
    if (raw != null && raw.isNotEmpty) {
      try {
        final list = (jsonDecode(raw) as List)
            .whereType<Map>()
            .map((e) => ZcodeDesktopEntry.fromJson(Map<String, dynamic>.from(e)))
            .where((e) => e.id.isNotEmpty && e.pairingUrl.isNotEmpty)
            .toList();
        loaded.addAll(list);
      } catch (_) {
        // 持久化损坏 → 回退旧版单配对迁移
      }
    }
    if (loaded.isEmpty) {
      final migrated = await _loadLegacyEntry(prefs);
      if (migrated != null) loaded.add(migrated);
    }
    if (loaded.isEmpty) {
      notifyListeners();
      return; // 保留临时实例供配对门使用
    }
    for (final entry in loaded) {
      _attachEntry(entry);
    }
    final savedActive = prefs.getString(_kActiveKey);
    _activeId = _stores.containsKey(savedActive) ? savedActive : loaded.first.id;
    notifyListeners();
  }

  /// 旧版单配对迁移：'wzxclaw-zcode-pairing' 存的是 ZcodePairingInfo.toJson，
  /// 重组出配对 URL（scheme 互换 + /pair 路径）
  Future<ZcodeDesktopEntry?> _loadLegacyEntry(SharedPreferences prefs) async {
    final raw = prefs.getString(_kLegacyPairingKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final info = ZcodePairingInfo.fromJson(
        Map<String, dynamic>.from(jsonDecode(raw) as Map),
      );
      if (info == null) return null;
      final wsUri = Uri.parse(info.relayWsUrl);
      final scheme = wsUri.scheme == 'wss' ? 'https' : 'http';
      final host = '${wsUri.host}${wsUri.hasPort ? ':${wsUri.port}' : ''}';
      final url = '$scheme://$host'
          '/pair?sid=${Uri.encodeComponent(info.sid)}'
          '&hash=${Uri.encodeComponent(info.hash)}'
          '${info.desktopName == null ? '' : '&name=${Uri.encodeComponent(info.desktopName!)}'}';
      return ZcodeDesktopEntry(id: info.sid, name: info.desktopName ?? '桌面', pairingUrl: url);
    } catch (_) {
      return null;
    }
  }

  // ---- 增 / 切 / 删 ----

  /// 从配对 URL 添加桌面（同 sid 视为同一桌面：先移除旧条目再接入），
  /// 成功后置为活动桌面。返回是否成功。
  Future<bool> addFromPairingUrl(String pairingUrl, {String? name}) async {
    final info = parsePairingUrl(pairingUrl);
    if (info == null) return false;
    final id = info.sid;
    final resolvedName = (name?.isNotEmpty ?? false)
        ? name!
        : (info.desktopName?.isNotEmpty ?? false)
            ? info.desktopName!
            : '桌面 ${_entries.length + 1}';
    if (_stores.containsKey(id)) await remove(id);
    _attachEntry(ZcodeDesktopEntry(id: id, name: resolvedName, pairingUrl: pairingUrl));
    _activeId = id;
    await _persist();
    notifyListeners();
    return true;
  }

  /// 切换活动桌面
  void setActive(String id) {
    if (!_stores.containsKey(id) || _activeId == id) return;
    _activeId = id;
    unawaited(_persist());
    notifyListeners();
  }

  /// 解除配对并移除桌面；移除活动桌面时自动落到第一个剩余桌面
  Future<void> remove(String id) async {
    final store = _stores.remove(id);
    _entries.removeWhere((e) => e.id == id);
    if (_activeId == id) {
      _activeId = _entries.isEmpty ? null : _entries.first.id;
    }
    if (store != null) {
      store
        ..onPaired = null
        ..onUnpaired = null;
      store.unpair(); // void：unpair 内部已自行通知
    }
    if (_stores.isEmpty && _activeId == null) _dropProvisionalIfAny();
    await _persist();
    notifyListeners();
  }

  // ---- 内部 ----

  /// store 生命周期挂接：配对成功/解绑时同步注册表（id 轮换、条目增删）
  void _attachEntry(ZcodeDesktopEntry entry) {
    final store = storeFactory != null
        ? storeFactory!(entry)
        : ZcodeChatStore.detached();
    store
      ..desktopId = entry.id
      ..desktopName = entry.name
      ..onPaired = (String url) {
        _onStorePaired(store, url);
      }
      ..onUnpaired = () {
        _onStoreUnpaired(store);
      };
    _stores[entry.id] = store;
    _entries.removeWhere((e) => e.id == entry.id);
    _entries.add(entry);
    store.pair(entry.pairingUrl); // bool 返回；失败态由 store.error 呈现
  }

  /// 配对成功：sid 轮换（口令轮换/临时实例转正）时迁移条目 id 并保持活动指向
  void _onStorePaired(ZcodeChatStore store, String pairingUrl) {
    final newId = store.pairing?.sid;
    if (newId == null || newId.isEmpty) return;
    final oldId = store.desktopId;
    if (oldId == newId) {
      // 条目已在（常规重连/重配对同码）：仅刷新 URL 快照
      final index = _entries.indexWhere((e) => e.id == newId);
      if (index != -1) {
        _entries[index] = ZcodeDesktopEntry(
          id: newId, name: _entries[index].name, pairingUrl: pairingUrl,);
        unawaited(_persist());
      }
      return;
    }
    _stores.remove(oldId);
    _entries.removeWhere((e) => e.id == oldId);
    _entries.removeWhere((e) => e.id == newId); // 同新 id 旧条目（换码重扫）让位
    store.desktopId = newId;
    _stores[newId] = store;
    _entries.add(ZcodeDesktopEntry(
      id: newId, name: store.desktopName, pairingUrl: pairingUrl,),);
    if (_activeId == oldId || _activeId == null) _activeId = newId;
    unawaited(_persist());
    notifyListeners();
  }

  /// store 自行 unpair（设置页/抽屉删除经由 registry.remove，不会走到这里；
  /// 这里兜的是绕过注册表的解绑）——同步移除条目
  void _onStoreUnpaired(ZcodeChatStore store) {
    final id = store.desktopId;
    if (id == null || !_stores.containsKey(id)) return;
    _stores.remove(id);
    _entries.removeWhere((e) => e.id == id);
    if (_activeId == id) {
      _activeId = _entries.isEmpty ? null : _entries.first.id;
    }
    if (_stores.isEmpty) _dropProvisionalIfAny();
    unawaited(_persist());
    notifyListeners();
  }

  ZcodeChatStore _ensureProvisional() {
    final existing = _stores[_provisionalId];
    if (existing != null) return existing;
    final store = storeFactory != null
        ? storeFactory!(const ZcodeDesktopEntry(
            id: _provisionalId, name: '桌面', pairingUrl: '',),)
        : ZcodeChatStore.detached();
    store
      ..desktopId = _provisionalId
      ..desktopName = '桌面'
      ..onPaired = (String url) {
        _onStorePaired(store, url);
      }
      ..onUnpaired = () {
        _onStoreUnpaired(store);
      };
    _stores[_provisionalId] = store;
    return store;
  }

  void _dropProvisionalIfAny() {
    // 临时实例保留（instance 指针需非 null），仅确保不占真实条目
    _entries.removeWhere((e) => e.id == _provisionalId);
  }

  Future<void> _persist() async {
    if (_notifying) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kDesktopsKey,
          jsonEncode([for (final e in _entries) e.toJson()]),);
      final active = _activeId;
      if (active == null) {
        await prefs.remove(_kActiveKey);
      } else {
        await prefs.setString(_kActiveKey, active);
      }
    } catch (_) {
      // 持久化失败不阻断内存态（下次变更再写）
    }
  }

  @override
  void notifyListeners() {
    // 防重入：store 的 pair/unpair 会在本类回调里同步触发 notify
    if (_notifying) return;
    _notifying = true;
    try {
      super.notifyListeners();
    } finally {
      _notifying = false;
    }
  }
}
