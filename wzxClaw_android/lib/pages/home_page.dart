// ============================================================
// ChatPage — 旧 UI 底座换芯 ZcodeChatStore
//
// 数据源：lib/zcode/zcode_chat_store.dart（ChangeNotifier 全局单例）。
// 旧 relay 协议栈（ChatStore / ConnectionManager / SessionSyncService）
// 的绑定全部移除，UI 由 AnimatedBuilder(animation: _store) 驱动；
// 交互与渲染组织方式对齐 lib/pages/zcode_page.dart 的已调通范本：
//   - 近顶滚动分页（本地缓存翻页 + 滚动偏移补偿）
//   - assistant.toolCalls 合成 tool 消息 → ToolCallGroup 渲染
//   - 权限 / AskUser 待答条（ZcodePermissionBar / ZcodeAskUserBar）
//   - 聊天连接条、错误横幅（可手动关闭）、sessionOpening 骨架屏
//   - 会话模式五档下拉（plan|build|edit|yolo|auto → session/setMode）
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_highlight/themes/vs2015.dart';
import 'package:highlight/highlight.dart' show highlight;
import 'package:markdown/markdown.dart' as md;

import '../config/app_colors.dart';
import '../models/chat_message.dart';
import '../services/voice_input_service.dart';
import '../widgets/animated_message_item.dart';
import '../widgets/mic_button.dart';
import '../widgets/project_drawer.dart';

import '../widgets/streaming_shimmer.dart';
import '../widgets/thinking_indicator.dart';
import '../widgets/tool_call_list.dart';
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_permission_widgets.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, this.store});

  /// 注入 store（测试用）；null → 内部全局单例（ZcodeChatStore 工厂）。
  /// main.dart '/chat' 路由与既有调用方依赖零参 const 构造，勿改。
  final ZcodeChatStore? store;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  // ── store：注入优先，否则消费全局单例（配对/会话状态跨页面保持）──
  // 启动恢复（restore）由入口页 ZcodePage 负责；本页不重复触发，
  // 避免把已连接的客户端强制重连。
  late final ZcodeChatStore _store = widget.store ?? ZcodeChatStore();

  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final FocusNode _inputFocusNode = FocusNode();

  String? _lastSessionId; // 检测会话切换，重置输入与动画状态
  int _previousGroupCount = 0; // AnimatedMessageItem 只动画新增项
  bool _showScrollFab = false;
  bool _scrollPending = false;
  bool _jumpAnimating = false; // 跳底动画在途：抑制误触上滑翻页
  bool _pendingSessionJump = false; // 会话已切但内容未落地：落地后补跳底
  bool _loadingOlder = false; // 上滑翻页在途防抖
  bool _noMoreOlder = false; // 当前会话缓存已翻尽（切换会话时重置）

  // ── 连接态去抖（对齐旧版 ConnectionStatusBar 行为）────────────────
  // 瞬态（connecting/waiting）持续 ≥1.2s 才更新有效状态并上条，
  // 避免移动网抖动导致连接条闪烁 + 键盘被收起；恢复 matched 立即生效。
  static const _connDebounceDelay = Duration(milliseconds: 1200);
  ZcodeConnState _effectiveConnState = ZcodeConnState.idle;
  Timer? _connDebounce;

  // ── 过滤+分组 memoize（流式高频 notify 时避免每帧全量重排）────────
  // store 的 chatMessages getter 每次返回新 List 实例（元素是同一批
  // ChatMessage 实例，内容变化时才被 copyWith 换新），故缓存键直接保存
  // 上次快照列表，逐元素 identical 校验：任一元素被替换（含中部权威
  // 合并/流式占位更新）即重算，纯重建则复用缓存。O(n) identical 扫描
  // 远轻于每帧 filter+group 的分配与重排，且不会漏掉中部更新。
  String? _groupedSessionKey;
  List<ChatMessage> _groupedSource = const [];
  List<dynamic> _groupedCache = const [];

  // ── Markdown 样式表缓存：只依赖主题色，主题色实例不变时构建一次，
  // 避免每次 notify 都换 styleSheet 身份导致已完成消息整篇重解析。
  AppColors? _styleSheetColors;
  MarkdownStyleSheet? _styleSheet;

  // <details> 块剔除（工具输出已由 ToolCallGroup 呈现）
  static final RegExp _detailsPattern = RegExp(r'<details[\s\S]*?</details>');

  StreamSubscription? _voiceErrorSub;

  // Slash command autocomplete
  // （zcode 会话仅保留 /clear：本地拦截 → 新建会话；
  // 桌面端 wzxClaw 斜杠命令不再透传，避免把死命令当聊天文本发出）
  List<_SlashCommand> _slashSuggestions = [];
  static const _allSlashCommands = [
    _SlashCommand('/clear', '新建会话'),
  ];

  @override
  void initState() {
    super.initState();
    _store.addListener(_onStoreChanged);
    _effectiveConnState = _store.connState; // 去抖基线取当前真实连接态
    // 上滑近顶自动从缓存翻页加载更早消息
    _scrollController.addListener(_onScroll);

    // 语音输入错误提示（VoiceInputService 不属于旧协议栈，保留）
    _voiceErrorSub = VoiceInputService.instance.errorStream.listen((error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(VoiceInputService.errorMessage(error)),
            duration: const Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    });
  }

  @override
  void dispose() {
    _store.removeListener(_onStoreChanged);
    _connDebounce?.cancel();
    _voiceErrorSub?.cancel();
    _inputController.dispose();
    _scrollController.dispose();
    _inputFocusNode.dispose();
    super.dispose();
  }

  /// store 变化时的副作用（重建由 AnimatedBuilder 负责）：
  /// 会话切换时清空输入框、重置动画/翻页计数并跳到底部；
  /// 流式输出时自动跟随滚动。
  void _onStoreChanged() {
    if (!mounted) return;
    _syncConnState(); // 连接态去抖（瞬态 ≥1.2s 才更新有效状态）
    if (_store.activeSessionId != _lastSessionId) {
      _lastSessionId = _store.activeSessionId;
      _previousGroupCount = 0;
      _inputController.clear();
      _slashSuggestions = [];
      _noMoreOlder = false; // 新会话的缓存翻页状态重新开始
      _showScrollFab = false; // 会话切换：重置滚动跟随状态
      // 切会话必跳底（不要求流式中）：打开不活跃的长历史会话不能落顶部。
      // 内容可能晚于切换到达（缓存/网络异步），跳底可能落在列表挂载前，
      // 故同时挂起补跳标记：内容首帧落地时再补一次。
      _pendingSessionJump = true;
      _scrollToBottom();
    }
    // 会话内容晚于切换到达：首帧内容落地时补跳底
    if (_pendingSessionJump && _store.messages.isNotEmpty) {
      _pendingSessionJump = false;
      _scrollToBottom();
    }
    // 仅用户位于近底部时才自动跟随滚动（翻阅历史时不打断视口，
    // 也避免与 _loadOlder 的偏移补偿打架）
    if (_store.activeSessionId != null &&
        (_store.isStreaming || _store.isWaitingForResponse) &&
        _nearBottom) {
      _followStreamBottom();
    }
  }

  /// 连接态去抖：瞬态（connecting/waiting）持续 ≥1.2s 才把有效状态
  /// 切过去；恢复 matched / 明确 idle 立即生效并撤销挂起的上条。
  /// 连接条显示与输入框 enable 判定都消费 _effectiveConnState。
  void _syncConnState() {
    final actual = _store.connState;
    if (actual == _effectiveConnState) {
      _connDebounce?.cancel();
      _connDebounce = null;
      return;
    }
    if (actual == ZcodeConnState.matched || actual == ZcodeConnState.idle) {
      _connDebounce?.cancel();
      _connDebounce = null;
      setState(() => _effectiveConnState = actual);
      return;
    }
    // 瞬态：延迟上条；已挂计时器则继续等待（不重置，避免抖动无限顺延）
    _connDebounce ??= Timer(_connDebounceDelay, () {
      _connDebounce = null;
      if (mounted && _effectiveConnState != _store.connState) {
        setState(() => _effectiveConnState = _store.connState);
      }
    });
  }

  /// 视口是否处于近底部（200px 内）——自动跟随滚动的判定基准
  bool get _nearBottom {
    if (!_scrollController.hasClients) return true;
    final pos = _scrollController.position;
    return pos.pixels > pos.maxScrollExtent - 200;
  }

  /// 过滤系统提醒 + 连续 tool 消息分组的 memoize 结果（见字段注释）
  List<dynamic> _groupedVisible(List<ChatMessage> messages) {
    if (_store.activeSessionId == _groupedSessionKey &&
        messages.length == _groupedSource.length) {
      var unchanged = true;
      for (var i = 0; i < messages.length; i++) {
        if (!identical(messages[i], _groupedSource[i])) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return _groupedCache;
    }
    // 过滤桌面端注入给 agent 的系统提醒（user 角色但不该展示）
    final filtered = messages
        .where((m) => !(m.role == MessageRole.user && m.isSystemInjected))
        .toList();
    _groupedSessionKey = _store.activeSessionId;
    _groupedSource = messages; // getter 每次新建列表，直接持有引用安全
    _groupedCache = _groupMessages(filtered);
    return _groupedCache;
  }

  // ── 上滑翻页（历史从本地缓存加载）────────────────────────────────

  /// 近顶触发：视口顶部 200px 逻辑像素内即预取一页更早消息。
  /// 跳底动画在途时跳过：动画从 0 起步会穿过近顶区，
  /// 误触翻页会让前插的 correctBy 偏移补偿被 tween 覆盖。
  void _onScroll() {
    if (!_scrollController.hasClients) return;
    if (_jumpAnimating) return;
    if (_scrollController.position.pixels <= 200) {
      unawaited(_loadOlder());
    }
    // Show/hide scroll-to-bottom FAB
    final distanceFromBottom = _scrollController.position.maxScrollExtent -
        _scrollController.position.pixels;
    final shouldShow = distanceFromBottom > 100;
    if (shouldShow != _showScrollFab) {
      setState(() => _showScrollFab = shouldShow);
    }
  }

  Future<void> _loadOlder() async {
    if (_loadingOlder || _noMoreOlder) return;
    final sessionId = _store.activeSessionId;
    if (sessionId == null) return;
    _loadingOlder = true;
    final beforeExtent =
        _scrollController.hasClients ? _scrollController.position.maxScrollExtent : 0.0;
    try {
      final before = _store.messages.length;
      await _store.loadOlderMessages();
      // await 期间可能已切会话：绝不把旧会话的翻页结果（无增长闩 /
      // 动画基线）套到新会话头上
      if (_store.activeSessionId != sessionId) return;
      if (_store.messages.length <= before) {
        _noMoreOlder = true; // 本次无增长（翻尽/不足额）：本会话内闩住
        return;
      }
      // 顶部前插后同步动画基线：已可见消息不因 index 平移重播入场动画
      _previousGroupCount = _groupedVisible(_store.messages).length;
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

  // ── 聊天动作 ──────────────────────────────────────────────────────

  /// 统一发送入口（输入框与「重新发送」共用）：守卫 + /clear 本地拦截。
  /// 返回是否真正进入发送流程；被守卫拒绝时调用方不清输入。
  bool _sendText(String rawText) {
    final text = rawText.trim();
    if (text.isEmpty) return false;
    if (_store.connState != ZcodeConnState.matched) return false;
    if (_store.activeSessionId == null) return false; // 未开会话：不清输入
    // /clear 本地拦截：直接新建会话，不把命令原文发给桌面端
    if (text == '/clear') {
      _inputController.clear();
      _slashSuggestions = [];
      unawaited(_store.newSession());
      return true;
    }
    unawaited(_store.sendMessage(text));
    _scrollToBottom();
    return true;
  }

  void _sendMessage() {
    if (_sendText(_inputController.text)) {
      _inputController.clear();
      _slashSuggestions = [];
    }
  }

  void _stopGeneration() {
    unawaited(_store.stopGeneration());
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
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('已复制'),
                    duration: Duration(seconds: 1),
                    behavior: SnackBarBehavior.floating,
                  ),
                );
              },
            ),
            if (msg.role == MessageRole.user)
              ListTile(
                leading: Icon(Icons.refresh, color: colors.textSecondary),
                title:
                    Text('重新发送', style: TextStyle(color: colors.textPrimary)),
                onTap: () {
                  Navigator.pop(ctx);
                  // 走统一发送入口：连接/会话守卫与 /clear 拦截与主路径一致
                  _sendText(msg.content);
                },
              ),
            ListTile(
              leading: Icon(Icons.share, color: colors.textSecondary),
              title: Text('分享', style: TextStyle(color: colors.textPrimary)),
              onTap: () {
                Navigator.pop(ctx);
                Clipboard.setData(ClipboardData(text: msg.content));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('已复制到剪贴板'),
                    duration: Duration(seconds: 1),
                    behavior: SnackBarBehavior.floating,
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  /// 一次性跳底（发送/切会话/FAB）：动画滚动。
  /// 两层 postFrameCallback：第一帧完成 setState rebuild，
  /// 第二帧 ListView 完成布局，maxScrollExtent 才准确。
  void _scrollToBottom() {
    if (_scrollPending) return; // already scheduled for this frame
    _scrollPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scrollPending = false;
        if (_scrollController.hasClients) {
          // 动画在途标记：抑制 _onScroll 在近顶区误触上滑翻页
          _jumpAnimating = true;
          _scrollController
              .animateTo(
                _scrollController.position.maxScrollExtent,
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOut,
              )
              .whenComplete(() => _jumpAnimating = false);
        }
      });
    });
  }

  /// 流式跟随：无动画 jumpTo——每条 delta 都 animateTo 会不断重启
  /// tween（滚动追不上流式输出且浪费动画）；postFrame 等布局完成，
  /// 帧间用 _scrollPending 去重。
  void _followStreamBottom() {
    if (_scrollPending) return;
    _scrollPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollPending = false;
      if (!mounted || !_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
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

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return AnimatedBuilder(
      animation: _store,
      builder: (context, _) {
        return Scaffold(
          resizeToAvoidBottomInset: false,
          backgroundColor: colors.bgPrimary,
          onDrawerChanged: (opened) {
            if (opened) _inputFocusNode.unfocus();
          },
          appBar: _buildAppBar(colors),
          drawer: const ProjectDrawer(),
          body: Column(
            children: [
              // 非已连接状态的细条提示（去抖后的有效状态，瞬态不上条）
              if (_effectiveConnState != ZcodeConnState.matched)
                _buildChatConnStrip(colors),
              Expanded(
                child: Stack(
                  children: [
                    _buildMessageList(),
                    // Scroll-to-bottom FAB
                    if (_showScrollFab)
                      Positioned(
                        right: 12,
                        bottom: 12,
                        child: FloatingActionButton.small(
                          onPressed: () {
                            _scrollToBottom();
                            setState(() => _showScrollFab = false);
                          },
                          backgroundColor: colors.bgElevated,
                          child: Icon(Icons.keyboard_arrow_down,
                              color: colors.textPrimary,),
                        ),
                      ),
                  ],
                ),
              ),
              _buildPendingRequestBar(),
              _buildErrorBar(colors),
              _buildSlashSuggestions(),
              _buildInputBar(colors),
            ],
          ),
        );
      },
    );
  }

  // ── AppBar ────────────────────────────────────────────────────────

  AppBar _buildAppBar(AppColors colors) {
    return AppBar(
      backgroundColor: colors.bgSecondary,
      // 副标题 = 当前会话标题（从 store 会话列表元信息中查找）
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('wzxClaw',
              style: TextStyle(color: colors.textPrimary, fontSize: 16),),
          Text(
            _activeSessionTitle() ?? '会话',
            style: TextStyle(color: colors.textSecondary, fontSize: 11),
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
      iconTheme: IconThemeData(color: colors.textPrimary),
      actions: [
        // 流式运行中指示
        if (_store.isStreaming)
          const Padding(
            padding: EdgeInsets.only(right: 16),
            child: SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        // 新对话：在桌面端创建新会话并切换
        IconButton(
          icon: const Icon(Icons.add_comment_outlined),
          tooltip: '新对话',
          onPressed: () {
            _inputFocusNode.unfocus();
            unawaited(_store.newSession());
          },
        ),
        IconButton(
          icon: const Icon(Icons.settings),
          tooltip: '设置',
          onPressed: () => Navigator.pushNamed(context, '/settings'),
        ),
      ],
    );
  }

  // ── 聊天连接条 ────────────────────────────────────────────────────

  /// 聊天视图顶部细状态条（去抖后的有效状态 != matched 时显示；
  /// 瞬态持续 ≥1.2s 才上条，恢复连接立即收起）
  Widget _buildChatConnStrip(AppColors colors) {
    final state = _effectiveConnState;
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

  // ── 待处理请求条（权限 / AskUser）──────────────────────────────────

  /// 输入框上方的待处理请求条：AskUser 优先，其次 Permission。
  /// 待答态直接读 store 的 notify 驱动 getter（无本地镜像 → 无残留）；
  /// store.respondXxx 自带清理 + notify，无需本地乐观置空。
  /// key 绑定请求 id：换请求时重建组件，重置计时基准。
  Widget _buildPendingRequestBar() {
    final ask = _store.activeAskUser;
    if (ask != null) {
      return ZcodeAskUserBar(
        key: ValueKey('zcode_ask_${ask.questionId}'),
        question: ask,
        onRespond: (answers, {customText}) {
          _store.respondToAskUser(ask.questionId, answers,
              customText: customText,);
        },
      );
    }
    final perm = _store.activePermission;
    if (perm != null) {
      return ZcodePermissionBar(
        key: ValueKey('zcode_perm_${perm.toolCallId}'),
        request: perm,
        onRespond: (approved) {
          _store.respondToPermission(perm.toolCallId, approved: approved);
        },
      );
    }
    return const SizedBox.shrink();
  }

  // ── 错误横幅 ──────────────────────────────────────────────────────

  /// 底部错误条（store.error），带关闭按钮（store.clearError）
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
          // 手动关闭：清除全局错误横幅
          GestureDetector(
            onTap: _store.clearError,
            child: Padding(
              padding: const EdgeInsets.all(2),
              child: Icon(Icons.close, size: 16, color: colors.error),
            ),
          ),
        ],
      ),
    );
  }

  // ── Message list ──────────────────────────────────────────────────

  /// 会话正在打开（未 materialize 且无缓存内容）时的骨架屏占位，
  /// 模拟即将出现的消息气泡形状。
  Widget _buildSessionLoadingSkeleton(AppColors colors) {
    final screenWidth = MediaQuery.of(context).size.width;
    // 固定宽度比例，模拟长短不一的消息气泡
    final rows = [
      (align: Alignment.centerRight, w: screenWidth * 0.55),
      (align: Alignment.centerLeft,  w: screenWidth * 0.75),
      (align: Alignment.centerLeft,  w: screenWidth * 0.60),
      (align: Alignment.centerLeft,  w: screenWidth * 0.45),
      (align: Alignment.centerRight, w: screenWidth * 0.50),
      (align: Alignment.centerLeft,  w: screenWidth * 0.70),
    ];
    return ListView(
      key: const ValueKey('chat_session_skeleton'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      physics: const NeverScrollableScrollPhysics(),
      children: rows.map((r) => Align(
        alignment: r.align,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: _SkeletonBox(
            width: r.w,
            height: 36,
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),).toList(),
    );
  }

  Widget _buildMessageList() {
    final colors = AppColors.of(context);
    final messages = _store.messages;
    if (messages.isEmpty && !_store.isWaitingForResponse) {
      // 正在打开会话（等待服务端/缓存回传数据）时显示骨架屏
      if (_store.sessionOpening) {
        return _buildSessionLoadingSkeleton(colors);
      }
      // 已连接但未开会话：给引导文案（AppBar 新对话按钮一键开新会话；
      // 文案必须与发送守卫一致——未开会话时不代发，避免误导用户）
      final emptyHint =
          _store.activeSessionId == null ? '点右上角「新对话」开始会话' : '暂无消息';
      return Center(
        child: Text(emptyHint,
            style: TextStyle(color: colors.textMuted, fontSize: 14),),
      );
    }

    final showThinking = _store.isWaitingForResponse;
    // 过滤系统提醒 + 连续 tool 消息分组（memoize，见字段注释）
    final grouped = _groupedVisible(messages);
    final itemCount = grouped.length + (showThinking ? 1 : 0);
    // Only animate newly appended messages (not full replacement from session switch).
    // If prev count was 0 (empty or just switched), skip animation entirely.
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
        Widget child;
        if (item is _ToolGroup) {
          child = ToolCallGroup(tools: item.messages);
        } else {
          child = _buildMessageItem(item as ChatMessage);
        }
        // Animate only newly appended items
        if (index >= prevCount) {
          return AnimatedMessageItem(child: child);
        }
        return child;
      },
    );
  }

  /// Group consecutive tool messages into _ToolGroup objects.
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
        // Should not reach here — tools are grouped by _groupMessages
        return ToolCallGroup(tools: [msg]);
    }
  }

  // ── User bubble ────────────────────────────────────────────────────

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
          child: Text(msg.content,
              style: const TextStyle(
                  color: Colors.white, fontSize: 13, height: 1.5,),),
        ),
      ),
    );
  }

  // ── Assistant block with Markdown ──────────────────────────────────

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
            // 工具调用卡片：assistant 消息附带的 toolCalls（含未知 tool
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
            // Token usage footer
            if (msg.usage != null || msg.model != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    if (msg.usage != null)
                      Text(
                        'In: ${_formatTokens(msg.usage!.inputTokens)} · Out: ${_formatTokens(msg.usage!.outputTokens)}',
                        style: TextStyle(color: colors.textMuted, fontSize: 10),
                      )
                    else
                      const SizedBox.shrink(),
                    if (msg.model != null)
                      Text(
                        msg.model!,
                        style: TextStyle(
                            color: colors.textMuted,
                            fontSize: 10,
                            fontFamily: 'monospace',),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Markdown 样式表（缓存构建，见字段注释）：只依赖主题色实例
  MarkdownStyleSheet _markdownStyleSheet(AppColors colors) {
    if (_styleSheet == null || !identical(_styleSheetColors, colors)) {
      _styleSheetColors = colors;
      _styleSheet = MarkdownStyleSheet(
        // Text
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
        // Inline code
        code: TextStyle(
          color: colors.textPrimary,
          backgroundColor: colors.bgPrimary,
          fontFamily: 'monospace',
          fontSize: 12,
        ),
        // Block code
        codeblockDecoration: BoxDecoration(
          color: colors.bgPrimary,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: colors.border),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        // Links
        a: TextStyle(color: colors.accent),
        // Blockquote
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: colors.accent, width: 3)),
        ),
        blockquotePadding: const EdgeInsets.only(left: 12, top: 4, bottom: 4),
        // Table — use tableBorder for visible contrast on dark/light backgrounds
        tableHead:
            TextStyle(color: colors.textPrimary, fontWeight: FontWeight.bold),
        tableBody: TextStyle(color: colors.textPrimary),
        tableBorder: TableBorder.all(color: colors.tableBorder),
        // Horizontal rule
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.border)),
        ),
      );
    }
    return _styleSheet!;
  }

  Widget _buildMarkdownBody(String rawContent, {bool isStreaming = false}) {
    final colors = AppColors.of(context);
    // Strip <details>...</details> blocks — tool outputs are shown via ToolCallGroup
    final content = rawContent.replaceAll(_detailsPattern, '').trim();
    if (content.isEmpty) return const SizedBox.shrink();
    // During streaming, skip markdown parsing — render plain text to avoid:
    //  - O(n) re-parse on every chunk
    //  - Broken unclosed syntax (e.g. **bold, ```code block)
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
      styleSheet: _markdownStyleSheet(colors),
      builders: {
        'code': _CodeBlockBuilder(),
      },
      onTapLink: (text, href, title) {
        if (href != null) {
          Clipboard.setData(ClipboardData(text: href));
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Link copied: $href'),
              duration: const Duration(seconds: 2),
              behavior: SnackBarBehavior.floating,
            ),
          );
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

  // ── Slash command autocomplete ────────────────────────────────────

  void _onInputChanged(String text) {
    if (text.startsWith('/')) {
      final query = text.toLowerCase();
      final matches = _allSlashCommands
          .where((cmd) => cmd.command.startsWith(query))
          .toList();
      if (matches.isNotEmpty && text.length < 20) {
        setState(() => _slashSuggestions = matches);
        return;
      }
    }
    if (_slashSuggestions.isNotEmpty) {
      setState(() => _slashSuggestions = []);
    }
  }

  void _selectSlashCommand(_SlashCommand cmd) {
    _inputController.text = cmd.command;
    _inputController.selection = TextSelection.fromPosition(
      TextPosition(offset: cmd.command.length),
    );
    setState(() => _slashSuggestions = []);
  }

  Widget _buildSlashSuggestions() {
    if (_slashSuggestions.isEmpty) return const SizedBox.shrink();
    final colors = AppColors.of(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(horizontal: 8),
      padding: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: colors.bgElevated,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: _slashSuggestions.map((cmd) {
          return InkWell(
            onTap: () => _selectSlashCommand(cmd),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Text(
                    cmd.command,
                    style: TextStyle(
                      color: colors.accent,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      fontFamily: 'monospace',
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      cmd.description,
                      style: TextStyle(
                        color: colors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        }).toList(),
      ),
    );
  }

  // ── Command bottom sheet ──────────────────────────────────────────

  void _showCommandSheet() {
    final colors = AppColors.of(context);
    _inputFocusNode.unfocus();
    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgElevated,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
              child: Row(
                children: [
                  Text('命令', style: TextStyle(color: colors.textPrimary, fontWeight: FontWeight.w600, fontSize: 15)),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.pop(ctx),
                    icon: Icon(Icons.close, color: colors.textMuted, size: 20),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            ..._allSlashCommands.map((cmd) => InkWell(
              onTap: () {
                Navigator.pop(ctx);
                _inputController.text = cmd.command;
                _inputController.selection = TextSelection.fromPosition(
                  TextPosition(offset: cmd.command.length),
                );
                _sendMessage();
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Row(
                  children: [
                    Text(
                      cmd.command,
                      style: TextStyle(color: colors.accent, fontSize: 13, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        cmd.description,
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 13,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  // ── 会话模式五档下拉 ───────────────────────────────────────────────

  /// 模式按钮显示条件：会话已打开且桌面端连接正常
  bool get _canPickMode =>
      _store.activeSessionId != null &&
      _store.connState == ZcodeConnState.matched;

  /// 会话模式五档菜单（plan|build|edit|yolo|auto → session/setMode）。
  /// [anchorContext] 是盾牌按钮的 BuildContext：菜单必须锚在按钮上方，
  /// 不能用 State 的 context（那是整个 Scaffold，锚点会跑到屏幕左上角）。
  void _showModeMenu(BuildContext anchorContext) {
    const modes = ['plan', 'build', 'edit', 'yolo', 'auto'];
    const labels = ['规划', '构建', '编辑', '全自动', '自动'];
    final colors = AppColors.of(context);
    // 当前值未知（null）时不勾选任何项
    final current = _store.sessionMode;
    // Get button position for popup placement
    final renderBox = anchorContext.findRenderObject() as RenderBox;
    final size = MediaQuery.of(anchorContext).size;
    final position = RelativeRect.fromLTRB(
      0,
      renderBox.localToGlobal(Offset.zero).dy - 250,
      size.width - renderBox.localToGlobal(Offset.zero).dx - renderBox.size.width,
      0,
    );
    showMenu<String>(
      context: context,
      position: position,
      items: List.generate(modes.length, (i) {
        final selected = modes[i] == current;
        return PopupMenuItem<String>(
          value: modes[i],
          child: Row(
            children: [
              SizedBox(
                width: 20,
                child: selected
                    ? Icon(Icons.check, size: 16, color: colors.accent)
                    : null,
              ),
              const SizedBox(width: 4),
              Text(labels[i],
                  style: TextStyle(
                    color: selected ? colors.accent : colors.textPrimary,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                  ),),
            ],
          ),
        );
      }),
    ).then((value) {
      // Prevent keyboard from appearing when popup dismisses
      _inputFocusNode.unfocus();
      if (value != null) {
        unawaited(_store.setMode(value));
      }
    });
  }

  // ── Input bar ──────────────────────────────────────────────────────

  Widget _buildInputBar(AppColors colors) {
    // 输入框 enable 跟连接条一样用去抖后的有效状态：
    // 瞬态掉线 1.2s 内不收键盘，恢复 matched 立即可发
    final matched = _effectiveConnState == ZcodeConnState.matched;

    // 由输入栏自己跟随 viewInsets 连续过渡，避免焦点触发时聊天框与系统键盘
    // 各自动画导致的错拍和回弹。
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
            // Session mode dropdown（zcode 五档；yolo 红色警示）
            if (_canPickMode)
              SizedBox(
                width: 36,
                height: 36,
                // Builder 提供按钮级 context，菜单锚点定位到盾牌图标
                child: Builder(
                  builder: (anchorContext) => IconButton(
                    onPressed: () => _showModeMenu(anchorContext),
                    icon: Icon(
                      Icons.security_outlined,
                      color: _store.sessionMode == 'yolo'
                          ? colors.error
                          : colors.textSecondary,
                      size: 20,
                    ),
                    padding: EdgeInsets.zero,
                    tooltip: '权限模式',
                  ),
                ),
              ),
            if (_canPickMode) const SizedBox(width: 2),
            // Command menu button
            SizedBox(
              width: 36,
              height: 36,
              child: IconButton(
                onPressed: matched ? _showCommandSheet : null,
                icon: Icon(
                  Icons.add_circle_outline,
                  color: matched ? colors.textSecondary : colors.textMuted,
                  size: 22,
                ),
                padding: EdgeInsets.zero,
                tooltip: '命令',
              ),
            ),
            const SizedBox(width: 2),
            Expanded(
              child: TextField(
                controller: _inputController,
                focusNode: _inputFocusNode,
                enabled: matched,
                style: TextStyle(color: colors.textPrimary, fontSize: 14),
                decoration: InputDecoration(
                  hintText: matched ? '输入指令...' : '未连接',
                  hintStyle: TextStyle(color: colors.textMuted),
                  filled: true,
                  fillColor:
                      matched ? colors.bgInput : colors.bgPrimary,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12, vertical: 8,),
                ),
                maxLines: 5,
                minLines: 1,
                keyboardType: TextInputType.multiline,
                textInputAction: TextInputAction.newline,
                onChanged: _onInputChanged,
              ),
            ),
            const SizedBox(width: 4),
            MicButton(
              onResult: (text) {
                _inputController.text = text;
                _inputController.selection = TextSelection.fromPosition(
                  TextPosition(offset: _inputController.text.length),
                );
              },
              isConnected: matched,
              isStreaming: _store.isStreaming,
            ),
            const SizedBox(width: 4),
            if (_store.isStreaming)
              IconButton(
                onPressed: _stopGeneration,
                icon:
                    Icon(Icons.stop_circle, color: colors.error, size: 28),
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
}

// ── Custom code block builder with syntax highlight + copy ────────────

class _CodeBlockBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final code = element.textContent;
    // Determine language from the element info
    String? language;
    if (element.attributes['class'] != null) {
      final cls = element.attributes['class']!;
      if (cls.startsWith('language-')) {
        language = cls.substring(9);
      }
    }

    // Skip inline code — only render block code (has newlines or explicit language)
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

    // Try syntax highlighting
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
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header: language + copy button
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
                      fontFamily: 'monospace',),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Code copied'),
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
                      Text('Copy',
                          style: TextStyle(
                              color: colors.textSecondary, fontSize: 11,),),
                    ],
                  ),
                ),
              ],
            ),
          ),
          // Code content with collapse support
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
          // Show more / less toggle for long code
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
                  _collapsed ? 'Show more ($lineCount lines)' : 'Show less',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: colors.accent,
                    fontSize: 11,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// Convert highlight.js nodes to Flutter TextSpans with vs2015 theme colors.
  List<TextSpan> _convertNodes(List<dynamic> nodes) {
    final spans = <TextSpan>[];
    for (final node in nodes) {
      if (node is String) {
        spans.add(TextSpan(text: node));
      } else if (node.className != null) {
        final style = vs2015Theme[node.className] ?? const TextStyle();
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

// ── Session loading skeleton ──────────────────────────────────────────

class _SkeletonBox extends StatefulWidget {
  final double width;
  final double height;
  final BorderRadius? borderRadius;
  const _SkeletonBox({required this.width, required this.height, this.borderRadius});

  @override
  State<_SkeletonBox> createState() => _SkeletonBoxState();
}

class _SkeletonBoxState extends State<_SkeletonBox>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
    _anim = Tween<double>(begin: 0.25, end: 0.55).animate(
      CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, __) => Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
          color: Colors.grey.withValues(alpha: _anim.value),
          borderRadius: widget.borderRadius ?? BorderRadius.circular(6),
        ),
      ),
    );
  }
}

// ── Helper for grouping consecutive tool messages ─────────────────────

class _ToolGroup {
  final List<ChatMessage> messages;
  const _ToolGroup(this.messages);
}

// ── Slash command model ───────────────────────────────────────────────

class _SlashCommand {
  final String command;
  final String description;
  const _SlashCommand(this.command, this.description);
}
