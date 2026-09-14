// ============================================================
// zcode_page — ZCode 远程控制页面（UI 层）
//
// 单页多视图状态机：
//   视图1 未配对（pairing == null）→ 扫码 / 粘贴配对链接
//   视图2 会话列表（pairing != null 且 activeSessionId == null）
//   视图3 聊天（activeSessionId != null）→ 消息流 + 输入框
//
// 数据源：lib/zcode/zcode_chat_store.dart（ZcodeChatStore 契约）。
// 页面持有 store 单例（跨页面打开保持配对与会话状态），
// 通过 AnimatedBuilder 监听 notifyListeners 重建。
// 消息渲染复用 home_page 的组织方式：
//   user/assistant 气泡 + Markdown + 工具调用分组 + 流式 shimmer + thinking 指示器。
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/themes/vs2015.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:highlight/highlight.dart' show highlight;
import 'package:markdown/markdown.dart' as md;
import 'package:mobile_scanner/mobile_scanner.dart';

import '../config/app_colors.dart';
import '../models/chat_message.dart';
import '../services/chat_store.dart'
    show PermissionRequest, AskUserQuestion;
import '../widgets/animated_message_item.dart';
import '../widgets/streaming_shimmer.dart';
import '../widgets/thinking_indicator.dart';
import '../widgets/tool_call_list.dart';
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_pairing.dart';
import '../zcode/zcode_permission_widgets.dart';

/// ZCode 远程控制页面
class ZcodePage extends StatefulWidget {
  const ZcodePage({super.key});

  @override
  State<ZcodePage> createState() => _ZcodePageState();
}

class _ZcodePageState extends State<ZcodePage> {
  // ── store 单例：跨页面打开保持配对与会话状态 ──────────────────────
  static ZcodeChatStore? _storeInstance;
  static bool _restored = false; // restore() 只在单例生命周期内触发一次
  late final ZcodeChatStore _store;

  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final _pairUrlController = TextEditingController(); // 视图1 粘贴配对链接

  ZcodeConnState _lastConnState = ZcodeConnState.idle;
  String? _lastSessionId; // 检测会话切换，重置输入与动画状态
  int _previousGroupCount = 0; // AnimatedMessageItem 只动画新增项
  bool _scrollPending = false;
  bool _loadingOlder = false; // 上滑翻页在途防抖
  bool _noMoreOlder = false; // 当前会话缓存已翻尽（切换会话时重置）

  // 待处理的权限请求 / 问答（同一时间最多显示一条，AskUser 优先）
  StreamSubscription<PermissionRequest?>? _permissionSub;
  StreamSubscription<AskUserQuestion?>? _askUserSub;
  PermissionRequest? _permissionRequest;
  AskUserQuestion? _askUserQuestion;

  @override
  void initState() {
    super.initState();
    _store = _storeInstance ??= ZcodeChatStore();
    _store.addListener(_onStoreChanged);
    if (!_restored) {
      _restored = true;
      // 启动时恢复已保存的配对（自动重连）
      unawaited(_store.restore());
    }
    // 监听待处理请求（store 回 null 表示清除）
    _permissionSub = _store.permissionStream.listen((req) {
      if (mounted) setState(() => _permissionRequest = req);
    });
    _askUserSub = _store.askUserStream.listen((q) {
      if (mounted) setState(() => _askUserQuestion = q);
    });
    // 上滑近顶自动从缓存翻页加载更早消息
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _store.removeListener(_onStoreChanged);
    _permissionSub?.cancel();
    _askUserSub?.cancel();
    _inputController.dispose();
    _scrollController.dispose();
    _pairUrlController.dispose();
    super.dispose();
  }

  /// store 变化时的副作用（重建由 AnimatedBuilder 负责）：
  /// 1. 连接从非 matched → matched 时自动拉一次会话列表；
  /// 2. 会话切换时清空输入框、重置动画计数；
  /// 3. 流式输出时自动滚到底部。
  void _onStoreChanged() {
    if (!mounted) return;
    final connState = _store.connState;
    if (connState == ZcodeConnState.matched &&
        _lastConnState != ZcodeConnState.matched &&
        _store.activeSessionId == null) {
      unawaited(_store.refreshSessions());
    }
    _lastConnState = connState;

    if (_store.activeSessionId != _lastSessionId) {
      _lastSessionId = _store.activeSessionId;
      _previousGroupCount = 0;
      _inputController.clear();
      _noMoreOlder = false; // 新会话的缓存翻页状态重新开始
      // 离开聊天视图时清掉残留的待处理条（流未发 null 的兜底）
      if (_store.activeSessionId == null) {
        _permissionRequest = null;
        _askUserQuestion = null;
      }
    }

    if (_store.activeSessionId != null &&
        (_store.isStreaming || _store.isWaitingForResponse)) {
      _scrollToBottom();
    }
  }

  // ── 上滑翻页（历史从本地缓存加载）────────────────────────────────

  /// 近顶触发：视口顶部 200px 逻辑像素内即预取一页更早消息
  void _onScroll() {
    if (!_scrollController.hasClients) return;
    if (_scrollController.position.pixels <= 200) {
      unawaited(_loadOlder());
    }
  }

  Future<void> _loadOlder() async {
    if (_loadingOlder || _noMoreOlder) return;
    if (_store.activeSessionId == null) return;
    _loadingOlder = true;
    final beforeExtent =
        _scrollController.hasClients ? _scrollController.position.maxScrollExtent : 0.0;
    try {
      final added = await _store.loadOlderMessages();
      if (added == 0) {
        _noMoreOlder = true; // 缓存翻尽，本次会话内不再触发
        return;
      }
      // 顶部插入会把现有内容整体下推：按新增内容高度补偿滚动偏移，
      // 保持用户正在看的位置不动（否则每次翻页都会"跳"一下）。
      if (_scrollController.hasClients) {
        SchedulerBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !_scrollController.hasClients) return;
          final delta = _scrollController.position.maxScrollExtent - beforeExtent;
          if (delta > 0) _scrollController.position.correctBy(delta);
        });
      }
    } finally {
      _loadingOlder = false;
    }
  }

  // ── 配对动作 ──────────────────────────────────────────────────────

  /// 解析并配对；失败给出提示
  void _pair(String pairingUrl) {
    final info = parsePairingUrl(pairingUrl);
    if (info == null) {
      _showSnackBar('配对链接无效，应为 https://…/pair?sid=…&hash=… 格式');
      return;
    }
    final ok = _store.pair(pairingUrl);
    if (!ok) {
      _showSnackBar(_store.error ?? '配对失败，请重试');
    }
  }

  /// 粘贴框配对
  void _pairFromInput() {
    final url = _pairUrlController.text.trim();
    if (url.isEmpty) {
      _showSnackBar('请输入配对链接');
      return;
    }
    _pair(url);
  }

  /// 扫码配对（复用 settings 的扫码页模式）
  Future<void> _startScanPairing() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const _ZcodePairScannerPage()),
    );
    if (result == null || result.isEmpty || !mounted) return;
    _pair(result);
  }

  /// 解除配对（二次确认）
  void _confirmUnpair() {
    final colors = AppColors.of(context);
    showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgElevated,
        title: Text('解除配对', style: TextStyle(color: colors.textPrimary)),
        content: Text(
          '解除后将与桌面 ZCode 断开连接，需要重新扫码配对。',
          style: TextStyle(color: colors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('取消', style: TextStyle(color: colors.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('解除', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    ).then((confirmed) {
      if (confirmed == true) _store.unpair();
    });
  }

  void _showSnackBar(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  // ── 聊天动作 ──────────────────────────────────────────────────────

  void _sendMessage() {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;
    if (_store.connState != ZcodeConnState.matched) return;
    unawaited(_store.sendMessage(text));
    _inputController.clear();
    _scrollToBottom();
  }

  void _stopGeneration() {
    unawaited(_store.stopGeneration());
  }

  /// 两层 postFrameCallback：第一帧 setState 重建，第二帧 ListView 布局完成后
  /// maxScrollExtent 才准确（与 home_page 相同的滚动策略）。
  void _scrollToBottom() {
    if (_scrollPending) return;
    _scrollPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scrollPending = false;
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          );
        }
      });
    });
  }

  void _showMessageActions(ChatMessage msg) {
    final colors = AppColors.of(context);
    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgElevated,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.copy, color: colors.textSecondary),
              title: Text('复制文本', style: TextStyle(color: colors.textPrimary)),
              onTap: () {
                Clipboard.setData(ClipboardData(text: msg.content));
                Navigator.pop(ctx);
                _showSnackBar('已复制');
              },
            ),
          ],
        ),
      ),
    );
  }

  // ── Build ────────────────────────────────────────────────────────

  /// 当前视图：未配对 / 会话列表 / 聊天
  _ZcodeView get _view {
    if (_store.pairing == null) return _ZcodeView.pairing;
    if (_store.activeSessionId != null) return _ZcodeView.chat;
    return _ZcodeView.sessions;
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return AnimatedBuilder(
      animation: _store,
      builder: (context, _) {
        final view = _view;
        final inChat = view == _ZcodeView.chat;
        return PopScope(
          // 聊天视图内系统返回 = 关闭会话视图回到列表，而非退出页面
          canPop: !inChat,
          onPopInvokedWithResult: (didPop, result) {
            if (!didPop && _view == _ZcodeView.chat) {
              _store.closeSessionView();
            }
          },
          child: Scaffold(
            backgroundColor: colors.bgPrimary,
            appBar: _buildAppBar(colors, view),
            body: AnimatedSwitcher(
              duration: const Duration(milliseconds: 250),
              child: switch (view) {
                _ZcodeView.pairing => _buildPairingView(colors),
                _ZcodeView.sessions => _buildSessionListView(colors),
                _ZcodeView.chat => _buildChatView(colors),
              },
            ),
          ),
        );
      },
    );
  }

  AppBar _buildAppBar(AppColors colors, _ZcodeView view) {
    switch (view) {
      case _ZcodeView.chat:
        return AppBar(
          backgroundColor: colors.bgSecondary,
          foregroundColor: colors.textPrimary,
          automaticallyImplyLeading: false,
          leading: IconButton(
            icon: const Icon(Icons.arrow_back),
            tooltip: '返回会话列表',
            onPressed: _store.closeSessionView,
          ),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('ZCode',
                  style: TextStyle(color: colors.textPrimary, fontSize: 16),),
              Text(
                _activeSessionTitle() ?? '会话',
                style:
                    TextStyle(color: colors.textSecondary, fontSize: 11),
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
          actions: [
            // 运行中指示
            if (_store.isStreaming)
              const Padding(
                padding: EdgeInsets.only(right: 16),
                child: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
          ],
        );
      case _ZcodeView.sessions:
        return AppBar(
          backgroundColor: colors.bgSecondary,
          foregroundColor: colors.textPrimary,
          title: Text('ZCode 远程控制',
              style: TextStyle(color: colors.textPrimary),),
        );
      case _ZcodeView.pairing:
        return AppBar(
          backgroundColor: colors.bgSecondary,
          foregroundColor: colors.textPrimary,
          title: Text('ZCode 远程控制',
              style: TextStyle(color: colors.textPrimary),),
        );
    }
  }

  /// 从会话列表元信息中找当前会话标题
  String? _activeSessionTitle() {
    final id = _store.activeSessionId;
    if (id == null) return null;
    for (final s in _store.sessions) {
      if (s.sessionId == id) return s.title;
    }
    return null;
  }

  // ── 视图1：未配对 ─────────────────────────────────────────────────

  Widget _buildPairingView(AppColors colors) {
    const companionCmd =
        'node relay/zcode/companion.js --relay wss://zcode.5945.top/ws';
    return ListView(
      key: const ValueKey('zcode_view_pairing'),
      padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
      children: [
        const SizedBox(height: 24),
        Icon(Icons.terminal,
            size: 64, color: colors.accent.withValues(alpha: 0.9),),
        const SizedBox(height: 16),
        Text(
          'ZCode 远程控制',
          textAlign: TextAlign.center,
          style: TextStyle(
              color: colors.textPrimary, fontSize: 22, fontWeight: FontWeight.bold,),
        ),
        const SizedBox(height: 8),
        Text(
          '配对后可在手机上浏览桌面 ZCode 会话，并继续对话',
          textAlign: TextAlign.center,
          style: TextStyle(color: colors.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 32),
        Text(
          '1. 在桌面端运行 companion 并显示配对二维码：',
          style: TextStyle(color: colors.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 8),
        // companion 启动命令（点击复制）
        GestureDetector(
          onTap: () {
            Clipboard.setData(const ClipboardData(text: companionCmd));
            _showSnackBar('已复制');
          },
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: colors.bgSecondary,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: colors.border),
            ),
            child: Row(
              children: [
                Icon(Icons.copy, size: 14, color: colors.textMuted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    companionCmd,
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 11,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          '2. 扫描桌面端二维码，或粘贴配对链接完成配对',
          style: TextStyle(color: colors.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 32),
        SizedBox(
          height: 52,
          child: ElevatedButton.icon(
            onPressed: _startScanPairing,
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('扫码配对'),
            style: ElevatedButton.styleFrom(
              backgroundColor: colors.accent,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),),
            ),
          ),
        ),
        const SizedBox(height: 24),
        Text('或粘贴配对链接',
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.textMuted, fontSize: 12),),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _pairUrlController,
                style: TextStyle(color: colors.textPrimary, fontSize: 13),
                decoration: InputDecoration(
                  hintText: 'https://zcode.5945.top/pair?sid=…&hash=…',
                  hintStyle: TextStyle(color: colors.textMuted, fontSize: 12),
                  filled: true,
                  fillColor: colors.bgInput,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12, vertical: 10,),
                  isDense: true,
                ),
                onSubmitted: (_) => _pairFromInput(),
              ),
            ),
            const SizedBox(width: 8),
            ElevatedButton(
              onPressed: _pairFromInput,
              style: ElevatedButton.styleFrom(
                backgroundColor: colors.accent,
                foregroundColor: Colors.white,
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),),
              ),
              child: const Text('配对', style: TextStyle(fontSize: 13)),
            ),
          ],
        ),
        const SizedBox(height: 24),
      ],
    );
  }

  // ── 视图2：会话列表 ───────────────────────────────────────────────

  /// 顶部连接状态徽标（matched=已连接 / waiting=等待桌面端 / connecting=连接中）
  Widget _buildConnBadge(AppColors colors) {
    final state = _store.connState;
    final Color color;
    final String label;
    final String hint;
    switch (state) {
      case ZcodeConnState.matched:
        color = colors.success;
        label = '已连接';
        hint = '桌面 ZCode 在线';
      case ZcodeConnState.waiting:
        color = colors.warning;
        label = '等待桌面端';
        hint = '请确认桌面 companion 已运行';
      case ZcodeConnState.connecting:
        color = colors.accent;
        label = '连接中';
        hint = '';
      case ZcodeConnState.idle:
        color = colors.textMuted;
        label = '未连接';
        hint = '';
    }
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Text(label,
              style: TextStyle(
                  color: color, fontSize: 13, fontWeight: FontWeight.w500,),),
          if (hint.isNotEmpty) ...[
            const SizedBox(width: 4),
            Expanded(
              child: Text('· $hint',
                  style: TextStyle(color: colors.textMuted, fontSize: 12),
                  overflow: TextOverflow.ellipsis,),
            ),
          ],
        ],
      ),
    );
  }

  /// 操作按钮行：刷新 / 新建会话 / 重连 / 解除配对
  Widget _buildSessionActions(AppColors colors) {
    final matched = _store.connState == ZcodeConnState.matched;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          TextButton.icon(
            onPressed: matched
                ? () => unawaited(_store.refreshSessions())
                : null,
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('刷新', style: TextStyle(fontSize: 13)),
            style: TextButton.styleFrom(
              foregroundColor: matched ? colors.textPrimary : colors.textMuted,
              visualDensity: VisualDensity.compact,
            ),
          ),
          TextButton.icon(
            onPressed: matched ? () => unawaited(_store.newSession()) : null,
            icon: const Icon(Icons.add, size: 18),
            label: const Text('新建会话', style: TextStyle(fontSize: 13)),
            style: TextButton.styleFrom(
              foregroundColor: matched ? colors.textPrimary : colors.textMuted,
              visualDensity: VisualDensity.compact,
            ),
          ),
          TextButton.icon(
            onPressed: () => unawaited(_store.restore()),
            icon: const Icon(Icons.replay, size: 18),
            label: const Text('重连', style: TextStyle(fontSize: 13)),
            style: TextButton.styleFrom(
              foregroundColor: colors.textPrimary,
              visualDensity: VisualDensity.compact,
            ),
          ),
          TextButton.icon(
            onPressed: _confirmUnpair,
            icon: const Icon(Icons.link_off, size: 18),
            label: const Text('解除配对', style: TextStyle(fontSize: 13)),
            style: TextButton.styleFrom(
              foregroundColor: colors.error,
              visualDensity: VisualDensity.compact,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSessionListView(AppColors colors) {
    final sessions = _store.sessions;
    return Column(
      key: const ValueKey('zcode_view_sessions'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildConnBadge(colors),
        _buildSessionActions(colors),
        _buildErrorBar(colors),
        Expanded(
          child: _store.sessionsLoading
              ? Center(
                  child: CircularProgressIndicator(color: colors.accent),
                )
              : sessions.isEmpty
                  ? _buildEmptySessions(colors)
                  : RefreshIndicator(
                      color: colors.accent,
                      onRefresh: () async {
                        if (_store.connState == ZcodeConnState.matched) {
                          await _store.refreshSessions();
                        }
                      },
                      child: ListView.builder(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.only(top: 4, bottom: 12),
                        itemCount: sessions.length,
                        itemBuilder: (context, i) => _ZcodeSessionTile(
                          session: sessions[i],
                          onTap: () =>
                              unawaited(_store.openSession(sessions[i].sessionId)),
                        ),
                      ),
                    ),
        ),
      ],
    );
  }

  Widget _buildEmptySessions(AppColors colors) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 80),
        Icon(Icons.chat_bubble_outline, size: 48, color: colors.textMuted),
        const SizedBox(height: 16),
        Text('暂无会话',
            textAlign: TextAlign.center,
            style: TextStyle(
                color: colors.textPrimary,
                fontSize: 15,
                fontWeight: FontWeight.bold,),),
        const SizedBox(height: 8),
        Text(
          '在桌面端打开 ZCode 创建会话后，点击「刷新」同步',
          textAlign: TextAlign.center,
          style: TextStyle(color: colors.textSecondary, fontSize: 12),
        ),
      ],
    );
  }

  // ── 视图3：聊天 ───────────────────────────────────────────────────

  Widget _buildChatView(AppColors colors) {
    return Column(
      key: const ValueKey('zcode_view_chat'),
      children: [
        // 非已连接状态的细条提示（与 ConnectionStatusBar 同样的组织方式）
        if (_store.connState != ZcodeConnState.matched)
          _buildChatConnStrip(colors),
        Expanded(child: _buildMessageList()),
        _buildPendingRequestBar(colors),
        _buildErrorBar(colors),
        _buildInputBar(colors),
      ],
    );
  }

  /// 聊天视图顶部细状态条
  Widget _buildChatConnStrip(AppColors colors) {
    final state = _store.connState;
    final Color color;
    final String label;
    switch (state) {
      case ZcodeConnState.waiting:
        color = colors.warning;
        label = '等待桌面端，消息暂不可发送';
      case ZcodeConnState.connecting:
        color = colors.accent;
        label = '连接中…';
      case ZcodeConnState.idle:
        color = colors.textMuted;
        label = '未连接';
      case ZcodeConnState.matched:
        color = colors.success;
        label = '已连接';
    }
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        border: Border(
          bottom: BorderSide(color: color.withValues(alpha: 0.3)),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                  color: color, fontSize: 12, fontWeight: FontWeight.w500,),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  /// 消息列表（复用 home_page 的渲染方式：分组工具调用 + 气泡 + thinking）
  Widget _buildMessageList() {
    final colors = AppColors.of(context);
    final messages = _store.messages
        .where((m) => !(m.role == MessageRole.user && m.isSystemInjected))
        .toList();
    if (messages.isEmpty && !_store.isWaitingForResponse) {
      return Center(
        child: Text('暂无消息',
            style: TextStyle(color: colors.textMuted, fontSize: 14),),
      );
    }

    final showThinking = _store.isWaitingForResponse;
    final grouped = _groupMessages(messages);
    final itemCount = grouped.length + (showThinking ? 1 : 0);
    // 只动画新增项；整表替换（切换会话）不动画
    final prevCount = _previousGroupCount > 0 ? _previousGroupCount : itemCount;
    _previousGroupCount = grouped.length;

    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        if (showThinking && index == grouped.length) {
          return const ThinkingIndicator();
        }
        final item = grouped[index];
        final Widget child;
        if (item is _ToolGroup) {
          child = ToolCallGroup(tools: item.messages);
        } else {
          child = _buildMessageItem(item as ChatMessage);
        }
        if (index >= prevCount) {
          return AnimatedMessageItem(child: child);
        }
        return child;
      },
    );
  }

  /// 把连续的 tool 消息合并为一组
  List<dynamic> _groupMessages(List<ChatMessage> messages) {
    final result = <dynamic>[];
    List<ChatMessage>? currentToolGroup;
    for (final msg in messages) {
      if (msg.role == MessageRole.tool) {
        currentToolGroup ??= [];
        currentToolGroup.add(msg);
      } else {
        if (currentToolGroup != null) {
          result.add(_ToolGroup(currentToolGroup));
          currentToolGroup = null;
        }
        result.add(msg);
      }
    }
    if (currentToolGroup != null) {
      result.add(_ToolGroup(currentToolGroup));
    }
    return result;
  }

  Widget _buildMessageItem(ChatMessage msg) {
    switch (msg.role) {
      case MessageRole.user:
        return _buildUserBubble(msg);
      case MessageRole.assistant:
        return _buildAssistantBlock(msg);
      case MessageRole.tool:
        // 正常不会走到这里——tool 已被 _groupMessages 分组
        return ToolCallGroup(tools: [msg]);
    }
  }

  // ── 用户气泡（与 home_page 相同样式） ─────────────────────────────

  Widget _buildUserBubble(ChatMessage msg) {
    final colors = AppColors.of(context);
    final screenWidth = MediaQuery.of(context).size.width;
    return GestureDetector(
      onLongPress: () => _showMessageActions(msg),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          constraints: BoxConstraints(maxWidth: screenWidth * 0.80),
          margin: const EdgeInsets.symmetric(vertical: 3),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: colors.userBubble,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16),
              topRight: Radius.circular(16),
              bottomLeft: Radius.circular(16),
              bottomRight: Radius.circular(4),
            ),
          ),
          child: Text(
            msg.content,
            style: const TextStyle(
                color: Colors.white, fontSize: 13, height: 1.5,),
          ),
        ),
      ),
    );
  }

  // ── 助手气泡（Markdown + 流式 shimmer + usage 尾注） ──────────────

  Widget _buildAssistantBlock(ChatMessage msg) {
    final colors = AppColors.of(context);
    return GestureDetector(
      onLongPress: () => _showMessageActions(msg),
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: colors.assistantBubble,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(4),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildMarkdownBody(msg.content, isStreaming: msg.isStreaming),
            if (msg.isStreaming) const StreamingShimmer(),
            // 工具调用卡片：assistant 消息附带的 toolCalls（含未知 tool.*
            // kind）不丢弃——合成 tool 角色消息交给既有 ToolCallGroup
            // 渲染，任意工具名都能看到 kind 名 + 入参/出参摘要（可展开）
            if (msg.toolCalls != null && msg.toolCalls!.isNotEmpty) ...[
              const SizedBox(height: 4),
              ToolCallGroup(
                tools: [
                  for (final call in msg.toolCalls!)
                    ChatMessage(
                      role: MessageRole.tool,
                      content: '',
                      toolName: call.toolName,
                      toolStatus: call.status,
                      createdAt: msg.createdAt,
                      toolCallId: call.toolCallId,
                      toolInput: call.inputSummary,
                      toolOutput: call.outputSummary,
                    ),
                ],
              ),
            ],
            if (msg.usage != null || msg.model != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    if (msg.usage != null)
                      Text(
                        'In: ${_formatTokens(msg.usage!.inputTokens)} · '
                        'Out: ${_formatTokens(msg.usage!.outputTokens)}',
                        style:
                            TextStyle(color: colors.textMuted, fontSize: 10),
                      )
                    else
                      const SizedBox.shrink(),
                    if (msg.model != null)
                      Text(
                        msg.model!,
                        style: TextStyle(
                          color: colors.textMuted,
                          fontSize: 10,
                          fontFamily: 'monospace',
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildMarkdownBody(String rawContent, {bool isStreaming = false}) {
    final colors = AppColors.of(context);
    // 剥离 <details>…</details>——工具输出通过 ToolCallGroup 展示
    final content =
        rawContent.replaceAll(RegExp(r'<details[\s\S]*?</details>'), '').trim();
    if (content.isEmpty) return const SizedBox.shrink();
    // 流式期间跳过 Markdown 解析，渲染纯文本，避免逐块重复解析与未闭合语法
    if (isStreaming) {
      return SelectableText(
        content,
        style: TextStyle(color: colors.textPrimary, fontSize: 13, height: 1.5),
      );
    }
    return MarkdownBody(
      data: content,
      selectable: true,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      styleSheet: MarkdownStyleSheet(
        p: TextStyle(color: colors.textPrimary, fontSize: 13, height: 1.5),
        pPadding: const EdgeInsets.only(bottom: 6),
        h1: TextStyle(
            color: colors.textPrimary,
            fontSize: 16,
            fontWeight: FontWeight.bold,),
        h2: TextStyle(
            color: colors.textPrimary,
            fontSize: 14,
            fontWeight: FontWeight.bold,),
        h3: TextStyle(
            color: colors.textPrimary,
            fontSize: 13,
            fontWeight: FontWeight.bold,),
        listBullet: TextStyle(color: colors.textPrimary, fontSize: 13),
        listBulletPadding: const EdgeInsets.only(right: 6),
        code: TextStyle(
          color: colors.textPrimary,
          backgroundColor: colors.bgPrimary,
          fontFamily: 'monospace',
          fontSize: 12,
        ),
        codeblockDecoration: BoxDecoration(
          color: colors.bgPrimary,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: colors.border),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        a: TextStyle(color: colors.accent),
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: colors.accent, width: 3)),
        ),
        blockquotePadding: const EdgeInsets.only(left: 12, top: 4, bottom: 4),
        tableHead:
            TextStyle(color: colors.textPrimary, fontWeight: FontWeight.bold),
        tableBody: TextStyle(color: colors.textPrimary),
        tableBorder: TableBorder.all(color: colors.tableBorder),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.border)),
        ),
      ),
      builders: {
        'code': _CodeBlockBuilder(),
      },
      onTapLink: (text, href, title) {
        if (href != null) {
          Clipboard.setData(ClipboardData(text: href));
          _showSnackBar('已复制链接: $href');
        }
      },
    );
  }

  String _formatTokens(int tokens) {
    if (tokens >= 1000) {
      return '${(tokens / 1000).toStringAsFixed(1)}k';
    }
    return tokens.toString();
  }

  // ── 输入栏（isStreaming 时显示停止按钮） ──────────────────────────

  Widget _buildInputBar(AppColors colors) {
    final matched = _store.connState == ZcodeConnState.matched;
    // 输入栏自己跟随 viewInsets 连续过渡，避免与系统键盘动画错拍（同 home_page）
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;
    final bottomInset = keyboardInset > 0
        ? keyboardInset
        : MediaQuery.paddingOf(context).bottom;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      padding: EdgeInsets.fromLTRB(8, 6, 8, 6 + bottomInset),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        border: Border(top: BorderSide(color: colors.border, width: 0.5)),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _inputController,
              enabled: matched,
              style: TextStyle(color: colors.textPrimary, fontSize: 14),
              decoration: InputDecoration(
                hintText: matched ? '输入指令…' : '未连接',
                hintStyle: TextStyle(color: colors.textMuted),
                filled: true,
                fillColor: matched ? colors.bgInput : colors.bgPrimary,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide.none,
                ),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              ),
              maxLines: 5,
              minLines: 1,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              onSubmitted: (_) => _sendMessage(),
            ),
          ),
          const SizedBox(width: 4),
          if (_store.isStreaming)
            IconButton(
              onPressed: _stopGeneration,
              icon: Icon(Icons.stop_circle, color: colors.error, size: 28),
              tooltip: '停止生成',
            )
          else
            IconButton(
              onPressed: matched ? _sendMessage : null,
              icon: Icon(
                Icons.send,
                color: matched ? colors.accent : colors.textMuted,
              ),
              tooltip: '发送',
            ),
        ],
      ),
    );
  }

  /// 待处理请求条（输入框上方）：AskUser 优先，其次 Permission。
  /// 提交后本地立即收起（store 随后也会通过流发 null）。
  /// key 绑定请求 id：换请求时重建组件，重置倒计时基准。
  Widget _buildPendingRequestBar(AppColors colors) {
    final ask = _askUserQuestion;
    if (ask != null) {
      return ZcodeAskUserBar(
        key: ValueKey('zcode_ask_${ask.questionId}'),
        question: ask,
        onRespond: (answers, {customText}) {
          setState(() => _askUserQuestion = null);
          _store.respondToAskUser(ask.questionId, answers,
              customText: customText,);
        },
      );
    }
    final perm = _permissionRequest;
    if (perm != null) {
      return ZcodePermissionBar(
        key: ValueKey('zcode_perm_${perm.toolCallId}'),
        request: perm,
        onRespond: (approved) {
          setState(() => _permissionRequest = null);
          _store.respondToPermission(perm.toolCallId, approved: approved);
        },
      );
    }
    return const SizedBox.shrink();
  }

  /// 底部错误条（store.error）
  Widget _buildErrorBar(AppColors colors) {
    final error = _store.error;
    if (error == null || error.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: colors.error.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.error.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, size: 14, color: colors.error),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              error,
              style: TextStyle(color: colors.error, fontSize: 11, height: 1.4),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

// ── 视图枚举 ─────────────────────────────────────────────────────────

enum _ZcodeView { pairing, sessions, chat }

// ── 连续 tool 消息分组辅助 ───────────────────────────────────────────

class _ToolGroup {
  final List<ChatMessage> messages;
  const _ToolGroup(this.messages);
}

// ── ZCode 会话列表项（按 session_list_tile 样式） ────────────────────

class _ZcodeSessionTile extends StatelessWidget {
  const _ZcodeSessionTile({required this.session, required this.onTap});

  final ZcodeSessionMeta session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return InkWell(
      onTap: onTap,
      splashColor: colors.accent.withValues(alpha: 0.12),
      highlightColor: colors.accent.withValues(alpha: 0.12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Icon(Icons.chat_bubble_outline, size: 16, color: colors.textMuted),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    session.title,
                    style:
                        TextStyle(fontSize: 14, color: colors.textSecondary),
                    overflow: TextOverflow.ellipsis,
                    maxLines: 1,
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Text(
                        _formatTime(session.updatedAt),
                        style:
                            TextStyle(fontSize: 12, color: colors.textMuted),
                      ),
                      if (session.workspacePath != null &&
                          session.workspacePath!.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _workspaceLabel(session.workspacePath!),
                            style: TextStyle(
                                fontSize: 12, color: colors.textMuted,),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 18, color: colors.textMuted),
          ],
        ),
      ),
    );
  }

  /// 工作区路径只显示最后一级目录名
  String _workspaceLabel(String path) {
    final parts = path.split(RegExp(r'[/\\]'));
    return parts.isEmpty || parts.last.isEmpty ? path : parts.last;
  }

  String _formatTime(int epochMs) {
    if (epochMs == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes}分钟前';
    if (diff.inHours < 24) return '${diff.inHours}小时前';
    if (diff.inDays < 7) return '${diff.inDays}天前';
    return '${dt.month}/${dt.day}';
  }
}

// ── 配对扫码页（复用 settings_page 的扫码模式） ─────────────────────

class _ZcodePairScannerPage extends StatefulWidget {
  const _ZcodePairScannerPage();

  @override
  State<_ZcodePairScannerPage> createState() => _ZcodePairScannerPageState();
}

class _ZcodePairScannerPageState extends State<_ZcodePairScannerPage> {
  final MobileScannerController _controller = MobileScannerController();
  bool _torchOn = false;
  bool _scanned = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final size = MediaQuery.of(context).size;
    final scanSize = size.width * 0.7;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫描配对二维码'),
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
        actions: [
          IconButton(
            icon: Icon(
              _torchOn ? Icons.flash_on : Icons.flash_off,
              color: colors.textSecondary,
            ),
            onPressed: () {
              setState(() => _torchOn = !_torchOn);
              _controller.toggleTorch();
            },
            tooltip: '手电筒',
          ),
        ],
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: (capture) {
              if (_scanned) return;
              if (capture.barcodes.isEmpty) return;
              final barcode = capture.barcodes.first;
              if (barcode.rawValue != null) {
                _scanned = true;
                _controller.stop();
                Navigator.pop(context, barcode.rawValue);
              }
            },
          ),
          // 半透明遮罩 + 中央透明扫描窗
          ColorFiltered(
            colorFilter: ColorFilter.mode(
              Colors.black.withValues(alpha: 0.5),
              BlendMode.srcOut,
            ),
            child: Stack(
              children: [
                Container(
                  decoration: const BoxDecoration(
                    color: Colors.black,
                    backgroundBlendMode: BlendMode.dstOut,
                  ),
                ),
                Center(
                  child: Container(
                    width: scanSize,
                    height: scanSize,
                    decoration: BoxDecoration(
                      color: Colors.red,
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ],
            ),
          ),
          // 扫描框四角
          Center(
            child: SizedBox(
              width: scanSize,
              height: scanSize,
              child: CustomPaint(
                painter: _ScanFramePainter(color: colors.accent),
              ),
            ),
          ),
          // 提示文案
          Positioned(
            left: 0,
            right: 0,
            bottom: size.height * 0.2,
            child: Text(
              '将桌面端配对二维码放入框内自动扫描',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.textSecondary, fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }
}

/// 绘制扫描框四角括号
class _ScanFramePainter extends CustomPainter {
  final Color color;
  const _ScanFramePainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    const cornerLen = 24.0;
    const strokeWidth = 3.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    // 左上
    canvas.drawLine(const Offset(0, cornerLen), Offset.zero, paint);
    canvas.drawLine(Offset.zero, const Offset(cornerLen, 0), paint);
    // 右上
    canvas.drawLine(
        Offset(size.width - cornerLen, 0), Offset(size.width, 0), paint,);
    canvas.drawLine(
        Offset(size.width, 0), Offset(size.width, cornerLen), paint,);
    // 左下
    canvas.drawLine(Offset(0, size.height), Offset(0, size.height - cornerLen),
        paint,);
    canvas.drawLine(Offset(0, size.height), Offset(cornerLen, size.height),
        paint,);
    // 右下
    canvas.drawLine(Offset(size.width, size.height - cornerLen),
        Offset(size.width, size.height), paint,);
    canvas.drawLine(Offset(size.width - cornerLen, size.height),
        Offset(size.width, size.height), paint,);
  }

  @override
  bool shouldRepaint(covariant _ScanFramePainter oldDelegate) =>
      color != oldDelegate.color;
}

// ── 自定义代码块 builder（语法高亮 + 复制 + 折叠，同 home_page） ─────

class _CodeBlockBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final code = element.textContent;
    String? language;
    if (element.attributes['class'] != null) {
      final cls = element.attributes['class']!;
      if (cls.startsWith('language-')) {
        language = cls.substring(9);
      }
    }

    // 跳过行内代码——只渲染块级代码（含换行或有语言标注）
    final isInline = !code.contains('\n') && language == null;
    if (isInline) return null;

    return _CodeBlockWidget(code: code, language: language);
  }
}

class _CodeBlockWidget extends StatefulWidget {
  final String code;
  final String? language;

  const _CodeBlockWidget({required this.code, this.language});

  @override
  State<_CodeBlockWidget> createState() => _CodeBlockWidgetState();
}

class _CodeBlockWidgetState extends State<_CodeBlockWidget> {
  bool _collapsed = true;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final code = widget.code;
    final language = widget.language;
    final lineCount = '\n'.allMatches(code).length + 1;
    final isLong = lineCount > 15;

    // 语法高亮（失败时退化为纯文本）
    List<TextSpan> spans;
    try {
      final result = language != null
          ? highlight.parse(code, language: language)
          : highlight.parse(code, autoDetection: true);
      spans = _convertNodes(result.nodes ?? []);
    } catch (_) {
      spans = [TextSpan(text: code)];
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 头部：语言 + 复制按钮
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: colors.bgTertiary,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(6),
                topRight: Radius.circular(6),
              ),
            ),
            child: Row(
              children: [
                Text(
                  language?.toLowerCase() ?? 'code',
                  style: TextStyle(
                    color: colors.textSecondary,
                    fontSize: 11,
                    fontFamily: 'monospace',
                  ),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('已复制'),
                        duration: Duration(seconds: 1),
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  },
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.copy, size: 12, color: colors.textSecondary),
                      const SizedBox(width: 3),
                      Text('复制',
                          style: TextStyle(
                              color: colors.textSecondary, fontSize: 11,),),
                    ],
                  ),
                ),
              ],
            ),
          ),
          // 代码内容（长代码可折叠）
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeInOut,
            width: double.infinity,
            constraints: BoxConstraints(
              maxHeight: isLong && _collapsed ? 200 : 600,
            ),
            padding: const EdgeInsets.all(12),
            child: SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: SelectableText.rich(
                  TextSpan(
                    children: spans,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                      height: 1.5,
                      color: colors.textPrimary,
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (isLong)
            GestureDetector(
              onTap: () => setState(() => _collapsed = !_collapsed),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 4),
                decoration: BoxDecoration(
                  color: colors.bgTertiary,
                  borderRadius: const BorderRadius.only(
                    bottomLeft: Radius.circular(6),
                    bottomRight: Radius.circular(6),
                  ),
                ),
                child: Text(
                  _collapsed ? '展开全部（$lineCount 行）' : '收起',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: colors.accent, fontSize: 11),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// highlight.js 节点 → Flutter TextSpan（vs2015 主题配色）
  List<TextSpan> _convertNodes(List<dynamic> nodes) {
    final spans = <TextSpan>[];
    for (final node in nodes) {
      if (node is String) {
        spans.add(TextSpan(text: node));
      } else if (node.className != null) {
        final style = vs2015Theme[node.className] ??
            vs2015Theme['${node.className}'] ??
            const TextStyle();
        final children = node.children != null
            ? _convertNodes(node.children!)
            : [TextSpan(text: node.value ?? '')];
        spans.add(TextSpan(style: style, children: children));
      } else {
        if (node.children != null) {
          spans.addAll(_convertNodes(node.children!));
        } else {
          spans.add(TextSpan(text: node.value ?? ''));
        }
      }
    }
    return spans;
  }
}
