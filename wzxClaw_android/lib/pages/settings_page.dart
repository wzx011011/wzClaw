import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../main.dart' show themeNotifier, accentNotifier;
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_keepalive_controller.dart';
import '../zcode/zcode_pairing.dart';

/// 设置页：远程控制配对状态、后台保活、本地缓存与主题设置。
///
/// 数据源为 [ZcodeChatStore] 全局单例（AnimatedBuilder 监听重建），
/// 配对/重连/解除配对等动作均委托 store，本页不再持有旧 relay 协议栈。
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  /// 后台保活开关初始值（null = 尚未从 prefs 读到，开关行暂不渲染）
  bool? _backgroundKeepAliveEnabled;

  static const _backgroundKeepAliveEnabledKey = 'background_keepalive_enabled';

  @override
  void initState() {
    super.initState();
    _loadSavedValues();
  }

  Future<void> _loadSavedValues() async {
    final prefs = await SharedPreferences.getInstance();
    // 直接读同 key 的 pref：controller 尚未被 main 接线初始化时不依赖它
    _backgroundKeepAliveEnabled =
        prefs.getBool(_backgroundKeepAliveEnabledKey) ?? false;
    if (!mounted) return;
    setState(() {});
  }

  Future<void> _toggleBackgroundKeepAlive(bool value) async {
    // 等 controller 写完 pref/停好前台服务再刷新开关，避免与真实状态漂移
    await ZcodeKeepAliveController.instance.setEnabled(value);
    if (!mounted) return;
    setState(() => _backgroundKeepAliveEnabled = value);
  }

  /// 显式重连（store 未配对时内部为 no-op；按钮仅已配对时可用）
  void _reconnect() {
    unawaited(ZcodeChatStore.instance.reconnect());
  }

  /// 通用确认框（旧页确认框样式）：返回是否点了确认键
  Future<bool> _confirmDialog(
    AppColors colors, {
    required String title,
    required String content,
    required String confirmLabel,
    required Color confirmColor,
  }) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgPrimary,
        title: Text(
          title,
          style: TextStyle(color: colors.textPrimary),
        ),
        content: Text(
          content,
          style: TextStyle(color: colors.textSecondary, fontSize: 14),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(
              '取消',
              style: TextStyle(color: colors.textSecondary),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(
              confirmLabel,
              style: TextStyle(color: confirmColor),
            ),
          ),
        ],
      ),
    );
    return confirmed == true;
  }

  /// 解除配对（二次确认）
  Future<void> _confirmUnpair() async {
    final colors = AppColors.of(context);
    final confirmed = await _confirmDialog(
      colors,
      title: '解除配对？',
      content: '解除后将与桌面 ZCode 断开连接，需要重新扫码配对。',
      confirmLabel: '解除',
      confirmColor: colors.error,
    );
    if (!confirmed) return;
    ZcodeChatStore.instance.unpair();
  }

  Future<void> _confirmAndClearCache() async {
    final colors = AppColors.of(context);
    final confirmed = await _confirmDialog(
      colors,
      title: '清空本地缓存？',
      content: '将清除手机端所有已缓存的会话与消息。'
          '若当前已连接桌面，会立即重新同步；否则下次连接时再同步。',
      confirmLabel: '清空',
      confirmColor: colors.accent,
    );

    if (!confirmed) return;
    if (!mounted) return;

    try {
      await ZcodeChatStore.instance.clearLocalCache();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('本地缓存已清空')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('清空失败：$e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);

    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        title: const Text('设置'),
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // -- 远程控制（配对状态 + 重连/解除配对） --
          Text(
            '远程控制',
            style: TextStyle(color: colors.textSecondary, fontSize: 14),
          ),
          const SizedBox(height: 8),
          AnimatedBuilder(
            animation: ZcodeChatStore.instance,
            builder: (context, _) =>
                _buildRemoteControlCard(ZcodeChatStore.instance, colors),
          ),
          const SizedBox(height: 24),

          // -- 后台保持连接（prefs 读取完成前不渲染，避免开关值闪跳） --
          if (_backgroundKeepAliveEnabled != null)
            SwitchListTile(
              title: Text(
                '后台保持连接',
                style: TextStyle(
                  color: colors.textPrimary,
                  fontSize: 14,
                ),
              ),
              subtitle: Text(
                '切到后台后启用常驻通知与前台服务，尽量保持与桌面 ZCode 在线',
                style: TextStyle(
                  color: colors.textSecondary,
                  fontSize: 13,
                ),
              ),
              value: _backgroundKeepAliveEnabled!,
              activeTrackColor: colors.accent.withValues(alpha: 0.4),
              activeThumbColor: colors.accent,
              inactiveThumbColor: colors.textSecondary,
              inactiveTrackColor: colors.border,
              onChanged: _toggleBackgroundKeepAlive,
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            ),
          const SizedBox(height: 24),

          // -- Clear local cache --
          Text(
            '本地数据',
            style: TextStyle(color: colors.textSecondary, fontSize: 14),
          ),
          const SizedBox(height: 8),
          Container(
            decoration: BoxDecoration(
              color: colors.bgSecondary,
              borderRadius: BorderRadius.circular(8),
            ),
            child: ListTile(
              leading: Icon(
                Icons.cleaning_services_outlined,
                color: colors.accent,
              ),
              title: Text(
                '清空本地缓存',
                style: TextStyle(
                  color: colors.textPrimary,
                  fontSize: 14,
                ),
              ),
              subtitle: Text(
                '清除手机端缓存的消息和会话元数据；下次打开会从桌面端重新同步',
                style: TextStyle(
                  color: colors.textSecondary,
                  fontSize: 12,
                ),
              ),
              onTap: _confirmAndClearCache,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
          ),
          const SizedBox(height: 24),

          // -- Theme mode selector --
          Text(
            '主题模式',
            style: TextStyle(color: colors.textSecondary, fontSize: 14),
          ),
          const SizedBox(height: 8),
          ValueListenableBuilder<ThemeMode>(
            valueListenable: themeNotifier,
            builder: (context, currentMode, _) {
              return Container(
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: colors.bgSecondary,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    _themeButton('跟随系统', ThemeMode.system, currentMode, colors),
                    _themeButton('浅色', ThemeMode.light, currentMode, colors),
                    _themeButton('深色', ThemeMode.dark, currentMode, colors),
                  ],
                ),
              );
            },
          ),

          const SizedBox(height: 16),

          // -- Accent color selector --
          Text(
            '主题颜色',
            style: TextStyle(color: colors.textSecondary, fontSize: 14),
          ),
          const SizedBox(height: 8),
          ValueListenableBuilder<String>(
            valueListenable: accentNotifier,
            builder: (context, currentAccent, _) {
              return Row(
                children: [
                  _accentButton('紫色', 'purple', const Color(0xFF7C3AED), currentAccent, colors),
                  const SizedBox(width: 8),
                  _accentButton('绿色', 'green', const Color(0xFF10B981), currentAccent, colors),
                ],
              );
            },
          ),

          const SizedBox(height: 24),

          // -- Version info --
          Center(
            child: Text(
              'wzxClaw Android v2.0',
              style: TextStyle(color: colors.textMuted, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  /// 远程控制卡：已配对显示中继 host 与连接态 + 重连/解除配对按钮；
  /// 未配对显示引导文案（配对入口在首页扫码）。
  Widget _buildRemoteControlCard(ZcodeChatStore store, AppColors colors) {
    final pairing = store.pairing;
    final paired = pairing != null;
    // 连接中禁用重连，防连点重复重建客户端
    final canReconnect = paired && store.connState != ZcodeConnState.connecting;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (paired) ...[
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _connStateColor(store.connState, colors),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    _relayHostLabel(pairing),
                    style: TextStyle(color: colors.textPrimary, fontSize: 14),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Text(
                  _connStateLabel(store.connState),
                  style: TextStyle(
                    color: _connStateColor(store.connState, colors),
                    fontSize: 13,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: canReconnect ? _reconnect : null,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: colors.textPrimary,
                      disabledForegroundColor: colors.textMuted,
                      side: BorderSide(color: colors.border),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    child: const Text('重连'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton(
                    onPressed: _confirmUnpair,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: colors.textSecondary,
                      side: BorderSide(color: colors.border),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    child: const Text('解除配对'),
                  ),
                ),
              ],
            ),
          ] else ...[
            Text(
              '未配对',
              style: TextStyle(
                color: colors.textSecondary,
                fontSize: 14,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '在首页完成扫码配对',
              style: TextStyle(color: colors.textMuted, fontSize: 13),
            ),
          ],
        ],
      ),
    );
  }

  /// 连接态文案（映射 ZcodeConnState）
  String _connStateLabel(ZcodeConnState state) {
    switch (state) {
      case ZcodeConnState.matched:
        return '已连接';
      case ZcodeConnState.connecting:
        return '连接中';
      case ZcodeConnState.waiting:
        return '等待桌面';
      case ZcodeConnState.idle:
        return '未连接';
    }
  }

  /// 连接态圆点颜色
  Color _connStateColor(ZcodeConnState state, AppColors colors) {
    switch (state) {
      case ZcodeConnState.matched:
        return colors.success;
      case ZcodeConnState.connecting:
      case ZcodeConnState.waiting:
        return colors.warning;
      case ZcodeConnState.idle:
        return colors.error;
    }
  }

  /// 从配对信息的中继地址推导展示用 host（语义同 zcode_pairing 的
  /// relayWsUrl 推导：wss://host[:port]/ws → host[:port]）
  String _relayHostLabel(ZcodePairingInfo pairing) {
    final uri = Uri.tryParse(pairing.relayWsUrl);
    if (uri == null || uri.host.isEmpty) return pairing.relayWsUrl;
    return uri.hasPort ? '${uri.host}:${uri.port}' : uri.host;
  }

  Widget _themeButton(String label, ThemeMode mode, ThemeMode current, AppColors colors) {
    final selected = mode == current;
    return Expanded(
      child: GestureDetector(
        onTap: () async {
          themeNotifier.value = mode;
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('theme_mode', mode == ThemeMode.light ? 'light' : mode == ThemeMode.dark ? 'dark' : 'system');
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected ? colors.accent.withValues(alpha: 0.15) : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border: selected ? Border.all(color: colors.accent, width: 1.5) : null,
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: selected ? colors.accent : colors.textSecondary,
              fontSize: 13,
              fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
            ),
          ),
        ),
      ),
    );
  }

  Widget _accentButton(String label, String accent, Color color, String current, AppColors colors) {
    final selected = accent == current;
    return Expanded(
      child: GestureDetector(
        onTap: () async {
          accentNotifier.value = accent;
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('accent_color', accent);
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected ? color.withValues(alpha: 0.15) : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border: selected ? Border.all(color: color, width: 1.5) : null,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 6),
              Text(
                label,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: selected ? color : colors.textSecondary,
                  fontSize: 13,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
