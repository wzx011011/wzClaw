import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 状态面板展开策略（对齐官方 chat.summaryPanel.displayMode）
enum StatusPanelStrategy {
  /// 空闲时胶囊、回合运行中自动展开
  auto,

  /// 打开面板一律显示完整卡片
  expanded,

  /// 打开面板一律显示胶囊
  collapsed;

  static StatusPanelStrategy fromName(String? name) =>
      StatusPanelStrategy.values.firstWhere(
        (s) => s.name == name,
        orElse: () => StatusPanelStrategy.auto,
      );

  /// ⋯ 菜单显示文案（对齐官方 displayMode 三档）
  String get label => switch (this) {
        StatusPanelStrategy.auto => '自动展开',
        StatusPanelStrategy.expanded => '始终展开',
        StatusPanelStrategy.collapsed => '始终收起',
      };
}

/// 轻量 UI 偏好：跨页面共享且需即时生效的开关（ValueNotifier 驱动）。
/// 复杂偏好（主题等）仍走各自既有机制。
class UiPrefs {
  UiPrefs._();

  static const _kEnterToSend = 'enter_to_send';
  static const _kStatusPanelStrategy = 'status_panel_strategy';

  /// 回车键发送消息（关 = 回车换行，点按钮发送）
  static final ValueNotifier<bool> enterToSend = ValueNotifier<bool>(false);

  /// 状态面板展开策略（默认 auto）
  static final ValueNotifier<StatusPanelStrategy> statusPanelStrategy =
      ValueNotifier<StatusPanelStrategy>(StatusPanelStrategy.auto);

  /// App 启动时加载一次
  static Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      enterToSend.value = prefs.getBool(_kEnterToSend) ?? false;
      statusPanelStrategy.value = StatusPanelStrategy.fromName(
        prefs.getString(_kStatusPanelStrategy),
      );
    } catch (_) {/* 默认值 */}
  }

  static Future<void> setEnterToSend(bool value) async {
    enterToSend.value = value;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_kEnterToSend, value);
    } catch (_) {/* 尽力而为 */}
  }

  static Future<void> setStatusPanelStrategy(StatusPanelStrategy value) async {
    statusPanelStrategy.value = value;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kStatusPanelStrategy, value.name);
    } catch (_) {/* 尽力而为 */}
  }
}
