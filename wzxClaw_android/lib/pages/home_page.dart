import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_highlight/themes/vs2015.dart';
import 'package:highlight/highlight.dart' show highlight;
import 'package:markdown/markdown.dart' as md;

import '../config/app_colors.dart';
import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../services/app_restore_state.dart';
import '../services/chat_store.dart';
import '../services/connection_manager.dart';
import '../services/session_sync_service.dart';
import '../services/voice_input_service.dart';
import '../services/git_service.dart';
import '../services/chat_runtime_service.dart';
import '../widgets/animated_message_item.dart';
import '../widgets/ask_user_bar.dart';
import '../widgets/connection_status_bar.dart';
import '../widgets/git_branch_sheet.dart';
import '../widgets/mic_button.dart';
import '../widgets/permission_bar.dart';
import '../widgets/plan_mode_bar.dart';
import '../widgets/project_drawer.dart';

import '../widgets/streaming_shimmer.dart';
import '../widgets/thinking_indicator.dart';
import '../widgets/tool_call_list.dart';
import '../widgets/workspace_switcher_sheet.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key});

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();

  List<ChatMessage> _displayMessages = [];
  bool _isStreaming = false;
  bool _isWaiting = false;
  bool _isSessionLoading = false; // 切换会话时等待桌面端返回数据
  bool _showScrollFab = false;
  bool _scrollPending = false;
  int _previousGroupCount = 0;
  // 跟踪上次渲染的会话 id
  String? _lastRenderedSessionId;
  bool _sessionJustSwitched = false;
  String? _workspaceName;
  PermissionRequest? _permissionRequest;
  StreamSubscription? _messagesSub;
  StreamSubscription? _streamingSub;
  StreamSubscription? _voiceErrorSub;
  StreamSubscription<bool>? _waitingSub;
  StreamSubscription<bool>? _sessionLoadingSub;
  // Debounced connection state — avoids flicker during brief reconnects.
  WsConnectionState _visibleConnectionState = WsConnectionState.disconnected;
  Timer? _reconnectDebounceTimer;
  StreamSubscription<WsConnectionState>? _connectionStateSub;
  StreamSubscription<PermissionRequest?>? _permissionSub;
  StreamSubscription<WorkspaceInfo?>? _workspaceInfoSub;
  final FocusNode _inputFocusNode = FocusNode();

  // 消息排队（对齐官方 ZCode）：流式期间发送改为入队，turn 结束后依次发出。
  // 「立即」= 不等 turn 结束马上发。队列仅存内存（会话内排队，切会话即清）。
  final List<_QueuedSend> _sendQueue = [];
  Timer? _queueFlushTimer;

  // Slash command autocomplete
  List<_SlashCommand> _slashSuggestions = [];
  static const _allSlashCommands = [
    _SlashCommand('/help', '显示帮助'),
    _SlashCommand('/init', '生成 WZXCLAW.md'),
    _SlashCommand('/compact', '压缩上下文'),
    _SlashCommand('/context', '查看上下文状态'),
    _SlashCommand('/clear', '新建会话'),
    _SlashCommand('/commit', 'AI辅助Git提交'),
    _SlashCommand('/review', 'AI代码审查'),
    _SlashCommand('/insights', '生成开发洞察报告'),
  ];

  @override
  void initState() {
    super.initState();
    AppRestoreState.setLastRoute('/chat');
    if (ConnectionManager.instance.selectedDesktopId == null) {
      // Defer SQLite read to after the first frame so chat UI paints first
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ChatStore.instance.loadHistory();
      });
    }

    _messagesSub = ChatStore.instance.messagesStream.listen((msgs) {
      if (mounted) {
        // 检测会话切换
        final curSid = ChatStore.instance.currentSessionId;
        if (curSid != _lastRenderedSessionId) {
          _lastRenderedSessionId = curSid;
          _sessionJustSwitched = true;
          _showScrollFab = false;
          _slashSuggestions = [];
          _permissionRequest = null;
          _inputController.clear();
          // 排队消息属于原会话上下文，切会话即清（不留到别的会话发出）
          _sendQueue.clear();
        }
        setState(() => _displayMessages = msgs);
        if ((_isStreaming || _sessionJustSwitched) && !_showScrollFab && msgs.isNotEmpty) {
          _scrollToBottom();
          _sessionJustSwitched = false;
        }
      }
    });

    _streamingSub = ChatStore.instance.streamingStream.listen((streaming) {
      if (mounted) setState(() => _isStreaming = streaming);
      if (!streaming) _scheduleQueueFlush();
    });

    _waitingSub = ChatStore.instance.waitingStream.listen((waiting) {
      if (mounted) {
        setState(() => _isWaiting = waiting);
        if (waiting) _scrollToBottom();
      }
      if (!waiting) _scheduleQueueFlush();
    });

    _sessionLoadingSub = ChatStore.instance.sessionLoadingStream.listen((loading) {
      if (mounted) setState(() => _isSessionLoading = loading);
    });
    _isSessionLoading = ChatStore.instance.isSessionLoading;

    _permissionSub = ChatStore.instance.permissionStream.listen((req) {
      if (mounted) setState(() => _permissionRequest = req);
    });

    _scrollController.addListener(_onScroll);

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

    _workspaceInfoSub =
        SessionSyncService.instance.workspaceInfoStream.listen((info) {
      if (mounted) setState(() => _workspaceName = info?.workspaceName);
      // 工作区变化/切换后刷新当前分支（companion x/* 扩展，见 git_service.dart）
      GitService.instance.refreshBranch(info?.workspacePath);
    });
    _workspaceName = SessionSyncService.instance.workspaceInfo?.workspaceName;
    GitService.instance
        .refreshBranch(SessionSyncService.instance.workspaceInfo?.workspacePath);

    // Debounce all transient (non-connected) states so brief reconnects
    // don't flash the status bar.  We stay on the last known state until
    // the new state has been stable for 1.2 s.  Connected is always shown
    // immediately so the user gets instant positive feedback.
    _visibleConnectionState = ConnectionManager.instance.state;
    _connectionStateSub =
        ConnectionManager.instance.stateStream.listen((state) {
      _reconnectDebounceTimer?.cancel();
      if (state == WsConnectionState.connected) {
        // Show connected immediately — positive feedback, no delay needed.
        if (mounted) setState(() => _visibleConnectionState = state);
      } else {
        // Transient states (connecting / reconnecting / disconnected):
        // only show if the state persists for 1.2 s.
        _reconnectDebounceTimer =
            Timer(const Duration(milliseconds: 1200), () {
          if (mounted) setState(() => _visibleConnectionState = state);
        });
      }
    });
  }

  @override
  void dispose() {
    _messagesSub?.cancel();
    _streamingSub?.cancel();
    _waitingSub?.cancel();
    _voiceErrorSub?.cancel();
    _workspaceInfoSub?.cancel();
    _permissionSub?.cancel();
    _sessionLoadingSub?.cancel();
    _connectionStateSub?.cancel();
    _reconnectDebounceTimer?.cancel();
    _queueFlushTimer?.cancel();
    _inputController.dispose();
    _scrollController.dispose();
    _inputFocusNode.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollController.position.pixels <= 50) {
      ChatStore.instance.loadMoreMessages();
    }
    // Show/hide scroll-to-bottom FAB
    final distanceFromBottom = _scrollController.position.maxScrollExtent -
        _scrollController.position.pixels;
    final shouldShow = distanceFromBottom > 100;
    if (shouldShow != _showScrollFab) {
      setState(() => _showScrollFab = shouldShow);
    }
  }

  void _sendMessage() {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;
    if (ConnectionManager.instance.state != WsConnectionState.connected) return;
    // 流式进行中：改为排队（对齐官方 ZCode「继续输入以排队后续修改」）
    if (_isStreaming || _isWaiting) {
      setState(() => _sendQueue.add(_QueuedSend(text)));
      _inputController.clear();
      return;
    }
    // Option A：没有活动会话 = 处于「新任务」欢迎态，首条消息触发建会话
    if (ChatStore.instance.currentSessionId == null) {
      _startNewConversation(text);
      return;
    }
    ChatStore.instance.sendMessage(text);
    _inputController.clear();
    _scrollToBottom();
  }

  /// 队列消息「↑ 立即」：不等当前 turn 结束马上发
  void _sendQueuedNow(_QueuedSend item) {
    setState(() => _sendQueue.remove(item));
    if (ChatStore.instance.currentSessionId == null) {
      _startNewConversation(item.text);
      return;
    }
    ChatStore.instance.sendMessage(item.text);
    _scrollToBottom();
  }

  /// turn 结束后冲队首；500ms 去抖让 streaming/waiting 标志先落定
  void _scheduleQueueFlush() {
    if (_sendQueue.isEmpty) return;
    _queueFlushTimer?.cancel();
    _queueFlushTimer = Timer(const Duration(milliseconds: 500), () {
      if (!mounted || _isStreaming || _isWaiting) return;
      if (_sendQueue.isEmpty) return;
      final item = _sendQueue.removeAt(0);
      setState(() {});
      if (ChatStore.instance.currentSessionId == null) {
        _startNewConversation(item.text);
      } else {
        ChatStore.instance.sendMessage(item.text);
        _scrollToBottom();
      }
    });
  }

  Future<void> _editQueued(_QueuedSend item) async {
    final controller = TextEditingController(text: item.text);
    final newText = await showDialog<String>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AppColors.of(dialogCtx).bgSecondary,
        title: Text(
          '编辑排队消息',
          style: TextStyle(color: AppColors.of(dialogCtx).textPrimary, fontSize: 16),
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 4,
          minLines: 1,
          style: TextStyle(color: AppColors.of(dialogCtx).textPrimary),
          decoration: InputDecoration(
            enabledBorder: OutlineInputBorder(
              borderSide: BorderSide(color: AppColors.of(dialogCtx).border),
            ),
            focusedBorder: OutlineInputBorder(
              borderSide: BorderSide(color: AppColors.of(dialogCtx).accent),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx),
            child: Text('取消',
                style: TextStyle(color: AppColors.of(dialogCtx).textSecondary),),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx, controller.text.trim()),
            child: Text('保存', style: TextStyle(color: AppColors.of(dialogCtx).accent),),
          ),
        ],
      ),
    );
    if (newText == null || newText.isEmpty || newText == item.text) return;
    if (!mounted) return;
    setState(() => item.text = newText);
  }

  /// 排队条：流式期间显示在输入框上方（拖拽排序 + ↑立即 + 编辑 + 删除）
  Widget _buildSendQueueStrip(AppColors colors) {
    if (_sendQueue.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(4, 0, 4, 6),
      padding: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.border),
      ),
      child: ReorderableListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        buildDefaultDragHandles: false,
        onReorder: (oldIndex, newIndex) {
          setState(() {
            if (newIndex > oldIndex) newIndex--;
            final item = _sendQueue.removeAt(oldIndex);
            _sendQueue.insert(newIndex, item);
          });
        },
        children: [
          for (var i = 0; i < _sendQueue.length; i++)
            _buildQueuedTile(colors, _sendQueue[i], i),
        ],
      ),
    );
  }

  Widget _buildQueuedTile(AppColors colors, _QueuedSend item, int index) {
    return ListTile(
      key: ValueKey(item.id),
      dense: true,
      visualDensity: VisualDensity.compact,
      leading: ReorderableDragStartListener(
        index: index,
        child: Icon(Icons.drag_indicator, size: 18, color: colors.textMuted),
      ),
      title: Text(
        item.text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: colors.textPrimary, fontSize: 13),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ↑ 立即：不等当前 turn 结束
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => _sendQueuedNow(item),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: colors.bgInput,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(children: [
                Icon(Icons.north, size: 11, color: colors.textPrimary),
                const SizedBox(width: 3),
                Text(
                  '立即',
                  style: TextStyle(color: colors.textPrimary, fontSize: 12),
                ),
              ],),
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            icon: Icon(Icons.edit_outlined, size: 17, color: colors.textSecondary),
            tooltip: '编辑',
            onPressed: () => _editQueued(item),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            icon: Icon(Icons.delete_outline, size: 17, color: colors.textSecondary),
            tooltip: '删除',
            onPressed: () => setState(() => _sendQueue.remove(item)),
          ),
        ],
      ),
    );
  }

  /// 新任务首条消息：引擎建会话 → 写本地索引 → 发送。
  Future<void> _startNewConversation(String text) async {
    _inputController.clear();
    _scrollToBottom();
    final ok = await SessionSyncService.instance.startNewConversation(text);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('创建会话失败，请检查连接后重试'),
          duration: Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
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
                  ChatStore.instance.sendMessage(msg.content);
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

  void _scrollToBottom() {
    if (_scrollPending) return; // already scheduled for this frame
    _scrollPending = true;
    // 两层 postFrameCallback：第一帧完成 setState rebuild，
    // 第二帧 ListView 完成布局，maxScrollExtent 才准确。
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

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      resizeToAvoidBottomInset: false,
      backgroundColor: colors.bgPrimary,
      onDrawerChanged: (opened) {
        if (opened) _inputFocusNode.unfocus();
      },
      appBar: AppBar(
        backgroundColor: colors.bgSecondary,
        title: StreamBuilder<String?>(
          stream: SessionSyncService.instance.activeSessionStream,
          initialData: SessionSyncService.instance.activeSessionId,
          builder: (context, snapshot) {
            final sessionId = snapshot.data;
            if (sessionId == null) {
              return Text('wzxClaw',
                  style: TextStyle(color: colors.textPrimary),);
            }
            // Find session title from cached sessions
            final sessions = SessionSyncService.instance.sessions;
            final match = sessions.where((s) => s.id == sessionId);
            final title = match.isNotEmpty ? match.first.title : 'Session';
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('wzxClaw',
                    style: TextStyle(color: colors.textPrimary, fontSize: 16),),
                Text(
                  title,
                  style: TextStyle(color: colors.textSecondary, fontSize: 11),
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            );
          },
        ),
        iconTheme: IconThemeData(color: colors.textPrimary),
        actions: [
          // 切换桃面：返回设备列表（LandingPage）重新选择/切换桌面
          IconButton(
            icon: const Icon(Icons.swap_horiz_outlined),
            tooltip: '切换桃面端',
            onPressed: () {
              AppRestoreState.setLastRoute('/');
              Navigator.pushNamedAndRemoveUntil(context, '/', (_) => false);
            },
          ),
          // 新对话：进入「新任务」欢迎态（引擎会话等首条消息发出时才创建）
          IconButton(
            icon: const Icon(Icons.add_comment_outlined),
            tooltip: '新任务',
            onPressed: () async {
              _inputFocusNode.unfocus();
              await SessionSyncService.instance.enterNewConversation();
            },
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: '设置',
            onPressed: () => Navigator.pushNamed(context, '/settings'),
          ),
        ],
      ),
      drawer: const ProjectDrawer(),
      body: Column(
        children: [
          StreamBuilder<String?>(
            stream: ConnectionManager.instance.errorStream,
            initialData: ConnectionManager.instance.lastError,
            builder: (context, errorSnap) {
              return StreamBuilder<List<DesktopInfo>>(
                stream: ConnectionManager.instance.desktopsStream,
                initialData: ConnectionManager.instance.desktops,
                builder: (context, desktopsSnap) {
                  final desktops = desktopsSnap.data ?? const [];
                  return ConnectionStatusBar(
                    state: _visibleConnectionState,
                    desktopIdentity: ConnectionManager.instance.desktopIdentity,
                    desktopOnline: desktops.any((d) => d.online),
                    errorMessage: errorSnap.data,
                    workspaceName: _workspaceName,
                  );
                },
              );
            },
          ),
          Expanded(
            child: Stack(
              children: [
                _buildMessageList(),
                // Scroll-to-bottom FAB
                if (_showScrollFab)
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: AnimatedOpacity(
                      opacity: _showScrollFab ? 1.0 : 0.0,
                      duration: const Duration(milliseconds: 200),
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
                  ),
              ],
            ),
          ),
          if (_permissionRequest != null)
            PermissionBar(request: _permissionRequest!),
          StreamBuilder<Map<String, dynamic>?>(
            stream: ChatStore.instance.planModeStream,
            builder: (context, snapshot) {
              final planData = snapshot.data;
              if (planData == null) return const SizedBox.shrink();
              return PlanModeBar(planData: planData);
            },
          ),
          StreamBuilder<AskUserQuestion?>(
            stream: ChatStore.instance.askUserStream,
            builder: (context, snapshot) {
              if (snapshot.data == null) return const SizedBox.shrink();
              return AskUserBar(question: snapshot.data!);
            },
          ),
          _buildSlashSuggestions(),
          _buildTodoPanel(),
          _buildInputBar(),
        ],
      ),
    );
  }

  // ── Message list ───────────────────────────────────────────────────

  /// 切换会话时的骨架屏占位，模拟即将出现的消息气泡形状。
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

  // ── Welcome（新任务）─────────────────────────────────────────────────

  /// 按当前小时返回问候语（参考 ZCode 移动端「晚上好呀，今天辛苦啦」）
  static String _greetingForNow() {
    final hour = DateTime.now().hour;
    if (hour >= 5 && hour < 11) return '早上好呀，开始新任务吧';
    if (hour >= 11 && hour < 13) return '中午好呀，忙里偷闲搞定它';
    if (hour >= 13 && hour < 18) return '下午好呀，继续推进吧';
    if (hour >= 18 && hour < 23) return '晚上好呀，今天辛苦啦';
    return '夜深了，搞完这单就休息吧';
  }

  static const _quickPrompts = [
    ('🐞', '报错修复'),
    ('📝', '代码审查'),
    ('🧹', '重构建议'),
  ];

  /// 「新任务」欢迎页：问候 + 大 Z 水印 + 工作区 chip + 快捷提示。
  /// 首条消息发出时才在引擎创建会话（见 _startNewConversation）。
  Widget _buildWelcomeView(AppColors colors) {
    return Stack(
      children: [
        // 背景水印
        Positioned(
          top: 24,
          right: -18,
          child: IgnorePointer(
            child: Text(
              'Z',
              style: TextStyle(
                fontSize: 220,
                fontWeight: FontWeight.w900,
                fontStyle: FontStyle.italic,
                color: colors.textPrimary.withValues(alpha: 0.05),
                height: 1.0,
              ),
            ),
          ),
        ),
        Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(
                  _greetingForNow(),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 20),
                _buildWorkspaceChip(colors),
                const SizedBox(height: 36),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  alignment: WrapAlignment.center,
                  children: [
                    for (final (icon, label) in _quickPrompts)
                      _buildQuickPrompt(colors, icon, label),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// 当前工作区 chip：点按弹切换器；工作区来自本地每设备记忆
  Widget _buildWorkspaceChip(AppColors colors) {
    return StreamBuilder<WorkspaceInfo?>(
      stream: SessionSyncService.instance.workspaceInfoStream,
      initialData: SessionSyncService.instance.workspaceInfo,
      builder: (context, snap) {
        final wsName = snap.data?.workspaceName ?? '';
        final hasWs = wsName.isNotEmpty;
        return InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => showWorkspaceSwitcherSheet(context),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: colors.bgTertiary,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: colors.border),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  hasWs ? Icons.folder_outlined : Icons.folder_off_outlined,
                  size: 15,
                  color: hasWs ? colors.accent : colors.textMuted,
                ),
                const SizedBox(width: 6),
                Text(
                  hasWs ? wsName : '选择工作区',
                  style: TextStyle(
                    color: hasWs ? colors.textPrimary : colors.textMuted,
                    fontSize: 13,
                  ),
                ),
                const SizedBox(width: 2),
                Icon(
                  Icons.keyboard_arrow_down,
                  size: 16,
                  color: colors.textMuted,
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// 快捷提示 pill：点按填充输入框（不直接发送，用户可改可发）
  Widget _buildQuickPrompt(AppColors colors, String icon, String label) {
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: () {
        final prompt = switch (label) {
          '报错修复' => '帮我分析并修复下面的报错：\n\n（粘贴报错信息）',
          '代码审查' => '审查当前工作区的最近改动，指出问题和风险',
          '重构建议' => '看看我当前的项目结构，给出可落地的重构建议',
          _ => label,
        };
        _inputController.text = prompt;
        _inputController.selection = TextSelection.fromPosition(
          TextPosition(offset: _inputController.text.length),
        );
        _inputFocusNode.requestFocus();
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: colors.bgTertiary,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: colors.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(icon, style: const TextStyle(fontSize: 14)),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(color: colors.textSecondary, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList() {
    final colors = AppColors.of(context);
    if (_displayMessages.isEmpty && !_isWaiting) {
      // 正在切换会话、等待桌面端回传数据时显示骨架屏
      if (_isSessionLoading) {
        return _buildSessionLoadingSkeleton(colors);
      }
      // Option A：已连接且无活动会话 → 「新任务」欢迎页
      //（参考 ZCode 移动端：问候 + 工作区选择 + 快捷入口）
      if (_visibleConnectionState == WsConnectionState.connected &&
          ChatStore.instance.currentSessionId == null) {
        return _buildWelcomeView(colors);
      }
      return Center(
        child: Text('暂无消息',
            style: TextStyle(color: colors.textMuted, fontSize: 14),),
      );
    }

    final showThinking = _isWaiting; // agent:running 이 _isStreaming=true 로 설정해도 여전히 표시
    // Group consecutive tool messages together
    final grouped = _groupMessages(_displayMessages);
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
          return AgentThinkingBlock(thinkingStream: ChatStore.instance.thinkingStream);
        }
        final item = grouped[index];
        Widget child;
        if (item is _ToolGroup) {
          child = ToolCallGroup(tools: item.messages);
        } else if (item is _SubagentGroup) {
          child = _SubagentGroupCard(group: item, buildItem: _buildMessageItem);
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
  /// 子智能体消息（isSubagentMessage）优先按 agent 连续折叠为
  /// _SubagentGroup——与主时间线分离，修复主/子消息混排。
  List<dynamic> _groupMessages(List<ChatMessage> messages) {
    final result = <dynamic>[];
    List<ChatMessage>? currentToolGroup;
    List<ChatMessage>? currentSubGroup;

    void flushToolGroup() {
      if (currentToolGroup != null) {
        result.add(_ToolGroup(currentToolGroup!));
        currentToolGroup = null;
      }
    }

    void flushSubGroup() {
      if (currentSubGroup != null) {
        result.add(_SubagentGroup(currentSubGroup!));
        currentSubGroup = null;
      }
    }

    for (final msg in messages) {
      if (msg.isSubagentMessage) {
        flushToolGroup();
        (currentSubGroup ??= []).add(msg);
        continue;
      }
      flushSubGroup();
      if (msg.role == MessageRole.tool) {
        (currentToolGroup ??= []).add(msg);
      } else {
        result.add(msg);
      }
    }
    flushToolGroup();
    flushSubGroup();
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
            // Token usage footer
            if (msg.usage != null || msg.model != null || msg.durationMs != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    if (msg.usage != null || msg.durationMs != null)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (msg.usage != null)
                            Text(
                              'In: ${_formatTokens(msg.usage!.inputTokens)} · Out: ${_formatTokens(msg.usage!.outputTokens)}',
                              style: TextStyle(color: colors.textMuted, fontSize: 10),
                            ),
                          if (msg.durationMs != null) ...[
                            if (msg.usage != null) const SizedBox(width: 8),
                            Text(
                              '已工作 ${_formatDurationMs(msg.durationMs!)}',
                              style: TextStyle(color: colors.textMuted, fontSize: 10),
                            ),
                          ],
                        ],
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

  Widget _buildMarkdownBody(String rawContent, {bool isStreaming = false}) {
    final colors = AppColors.of(context);
    // Strip <details>...</details> blocks — tool outputs are shown via ToolCallGroup
    final content =
        rawContent.replaceAll(RegExp(r'<details[\s\S]*?</details>'), '').trim();
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
      styleSheet: MarkdownStyleSheet(
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
      ),
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

  /// 回合耗时（turn.completed duration 毫秒）→「2 分 7 秒」
  String _formatDurationMs(int ms) {
    final s = ms <= 0 ? 0 : ms ~/ 1000;
    if (s < 60) return '$s 秒';
    return '${s ~/ 60} 分 ${s % 60} 秒';
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


  // ── Todo panel ──────────────────────────────────────────────────────

  Widget _buildTodoPanel() {
    final colors = AppColors.of(context);
    final todos = ChatStore.instance.todos;
    if (todos.isEmpty) return const SizedBox.shrink();
    return Container(
      constraints: const BoxConstraints(maxHeight: 120),
      margin: const EdgeInsets.symmetric(horizontal: 8),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: todos.map((t) {
            final status = t['status'] ?? 'pending';
            final content = t['content'] ?? '';
            final icon = status == 'completed'
                ? Icons.check_circle
                : status == 'in_progress'
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked;
            final color = status == 'completed'
                ? Colors.green
                : status == 'in_progress'
                    ? colors.accent
                    : colors.textMuted;
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  Icon(icon, size: 14, color: color),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      content,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: status == 'completed' ? colors.textMuted : colors.textPrimary,
                        decoration: status == 'completed' ? TextDecoration.lineThrough : null,
                      ),
                    ),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ),
    );
  }

  // ── Input bar ──────────────────────────────────────────────────────

  Widget _buildInputBar() {
    return StreamBuilder<WsConnectionState>(
      stream: ConnectionManager.instance.stateStream,
      initialData: ConnectionManager.instance.state,
      builder: (context, snapshot) {
        final colors = AppColors.of(context);
        final state = snapshot.data ?? WsConnectionState.disconnected;
        final isConnected = state == WsConnectionState.connected;

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
          child: Column(children: [
            // 顶行：工作区 chip + git 分支 chip（对齐官方 ZCode 输入区样式）
            if (isConnected)
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
                child: Row(
                  children: [
                    _buildWorkspaceChip(colors),
                    const SizedBox(width: 8),
                    _buildBranchChip(colors),
                  ],
                ),
              ),
            // 消息排队条：流式期间发送的内容在此排队（↑立即/编辑/删除/拖拽）
            _buildSendQueueStrip(colors),
            Row(
              children: [
                // Permission mode dropdown（措辞对齐官方：变更前确认/自动编辑/计划模式/完全访问）
                if (isConnected)
                  SizedBox(
                    width: 36,
                    height: 36,
                    child: IconButton(
                      onPressed: () {
                        const modes = ['always-ask', 'accept-edits', 'plan', 'bypass'];
                        const labels = ['变更前确认', '自动编辑', '计划模式', '完全访问'];
                        const subtitles = [
                          '改文件前先问我。',
                          '自动编辑文件。',
                          '编辑前先出计划。',
                          '减少确认次数。',
                        ];
                        final current = ChatStore.instance.permissionMode;
                        // Get button position for popup placement
                        final renderBox = context.findRenderObject() as RenderBox;
                        final size = MediaQuery.of(context).size;
                        final position = RelativeRect.fromLTRB(
                          0,
                          renderBox.localToGlobal(Offset.zero).dy - 180,
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
                                  Icon(
                                    const [
                                      Icons.pan_tool_outlined,
                                      Icons.shield_outlined,
                                      Icons.checklist_outlined,
                                      Icons.lock_open_outlined,
                                    ][i],
                                    size: 16,
                                    color: selected ? colors.accent : colors.textSecondary,
                                  ),
                                  const SizedBox(width: 10),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        labels[i],
                                        style: TextStyle(
                                          color: selected ? colors.accent : colors.textPrimary,
                                          fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                                          fontSize: 14,
                                        ),
                                      ),
                                      Text(
                                        subtitles[i],
                                        style: TextStyle(
                                          color: colors.textMuted,
                                          fontSize: 11,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            );
                          }),
                        ).then((value) {
                          // Prevent keyboard from appearing when popup dismisses
                          _inputFocusNode.unfocus();
                          if (value != null) {
                            ChatStore.instance.setPermissionMode(value);
                          }
                        });
                      },
                      icon: Icon(
                        Icons.security_outlined,
                        color: ChatStore.instance.permissionMode == 'bypass'
                            ? colors.error
                            : colors.textSecondary,
                        size: 20,
                      ),
                      padding: EdgeInsets.zero,
                      tooltip: '权限模式',
                    ),
                  ),
                if (isConnected) const SizedBox(width: 2),
                // Command menu button
                SizedBox(
                  width: 36,
                  height: 36,
                  child: IconButton(
                    onPressed: isConnected ? _showCommandSheet : null,
                    icon: Icon(
                      Icons.add_circle_outline,
                      color: isConnected ? colors.textSecondary : colors.textMuted,
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
                    enabled: isConnected,
                    style: TextStyle(color: colors.textPrimary, fontSize: 14),
                    decoration: InputDecoration(
                      hintText: !isConnected
                          ? '未连接'
                          : (_isStreaming || _isWaiting)
                              ? '继续输入以排队后续修改'
                              : '向 ZCode 提问...',
                      hintStyle: TextStyle(color: colors.textMuted),
                      filled: true,
                      fillColor:
                          isConnected ? colors.bgInput : colors.bgPrimary,
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
                if (isConnected) ...[
                  // 上下文用量环：弹层展示 session/usage 实测数据
                  SizedBox(
                    width: 34,
                    height: 36,
                    child: IconButton(
                      onPressed: _showUsageSheet,
                      icon: Icon(Icons.donut_large,
                          size: 19, color: colors.textSecondary,),
                      padding: EdgeInsets.zero,
                      tooltip: '上下文用量',
                    ),
                  ),
                  // 模型：弹层列本会话历史模型（协议无目录接口，不做假目录）
                  SizedBox(
                    width: 34,
                    height: 36,
                    child: IconButton(
                      onPressed: _showModelSheet,
                      icon: Icon(Icons.view_in_ar_outlined,
                          size: 19, color: colors.textSecondary,),
                      padding: EdgeInsets.zero,
                      tooltip: '模型',
                    ),
                  ),
                  // 思考档位：低/中/高/最高（枚举未实测，错误显性上浮）
                  SizedBox(
                    width: 34,
                    height: 36,
                    child: IconButton(
                      onPressed: _showThoughtSheet,
                      icon: Icon(Icons.psychology_outlined,
                          size: 20, color: colors.textSecondary,),
                      padding: EdgeInsets.zero,
                      tooltip: '思考档位',
                    ),
                  ),
                ],
                const SizedBox(width: 4),
                MicButton(
                  onResult: (text) {
                    _inputController.text = text;
                    _inputController.selection = TextSelection.fromPosition(
                      TextPosition(offset: _inputController.text.length),
                    );
                  },
                  isConnected: isConnected,
                  isStreaming: _isStreaming,
                ),
                const SizedBox(width: 4),
                if (_isStreaming)
                  IconButton(
                    onPressed: () => ChatStore.instance.stopGeneration(),
                    icon:
                        Icon(Icons.stop_circle, color: colors.error, size: 28),
                    tooltip: '停止生成',
                  )
                else
                  IconButton(
                    onPressed: isConnected ? _sendMessage : null,
                    icon: Icon(
                      Icons.send,
                      color: isConnected ? colors.accent : colors.textMuted,
                    ),
                  ),
              ],
            ),
          ],),
        );
      },
    );
  }

  void _runtimeErrorSnack(Object e) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('操作失败: $e'),
      duration: const Duration(seconds: 3),
      behavior: SnackBarBehavior.floating,
    ),);
  }

  /// 上下文用量弹层：session/usage 实测数据（协议无 contextWindow，不显示百分比）
  Future<void> _showUsageSheet() async {
    final sessionId = ChatStore.instance.currentSessionId;
    if (sessionId == null) return;
    final colors = AppColors.of(context);
    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgSecondary,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: FutureBuilder<ChatUsageInfo>(
          future: ChatRuntimeService.instance.usage(sessionId),
          builder: (ctx, snap) {
            final rows = <(String, String)>[];
            if (snap.hasData) {
              final u = snap.data!;
              rows.addAll([
                ('总 Token', _fmtTokens(u.totalTokens)),
                ('输入', _fmtTokens(u.inputTokens)),
                ('输出', _fmtTokens(u.outputTokens)),
                ('推理', _fmtTokens(u.reasoningTokens)),
                ('缓存读', _fmtTokens(u.cacheReadTokens)),
                ('模型请求次数', '${u.modelRequestCount}'),
              ]);
            }
            return Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '会话用量',
                    style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,),
                  ),
                  const SizedBox(height: 12),
                  if (snap.connectionState != ConnectionState.done)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.symmetric(vertical: 18),
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  else if (snap.hasError)
                    Text(
                      '用量获取失败（协议未提供上下文窗口大小时无法显示百分比）',
                      style: TextStyle(color: colors.textMuted, fontSize: 13),
                    )
                  else
                    for (final (label, value) in rows)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            Text(label,
                                style: TextStyle(
                                    color: colors.textSecondary,
                                    fontSize: 13,),),
                            const Spacer(),
                            Text(value,
                                style: TextStyle(
                                    color: colors.textPrimary,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,),),
                          ],
                        ),
                      ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  String _fmtTokens(int n) {
    if (n >= 10000) return '${(n / 10000).toStringAsFixed(1)} 万';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
    return '$n';
  }

  /// 模型弹层：本会话历史模型（协议无目录接口，实测 -32601，不做假目录）
  Future<void> _showModelSheet() async {
    final sessionId = ChatStore.instance.currentSessionId;
    if (sessionId == null) return;
    final colors = AppColors.of(context);
    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgSecondary,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: FutureBuilder<List<SessionModelUse>>(
          future: ChatRuntimeService.instance.sessionModels(sessionId),
          builder: (ctx, snap) {
            Widget body;
            if (snap.connectionState != ConnectionState.done) {
              body = const Center(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 22),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            } else if (snap.hasError || (snap.data?.isEmpty ?? true)) {
              body = Padding(
                padding: const EdgeInsets.symmetric(vertical: 22),
                child: Text(
                  snap.hasError ? '模型列表获取失败' : '本会话还没有模型记录',
                  style: TextStyle(color: colors.textMuted, fontSize: 13),
                ),
              );
            } else {
              final models = snap.data!;
              body = Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final m in models)
                    ListTile(
                      dense: true,
                      leading: Icon(Icons.view_in_ar_outlined,
                          size: 18, color: colors.accent,),
                      title: Text(m.modelId,
                          style: TextStyle(
                              color: colors.textPrimary, fontSize: 14,),),
                      subtitle: Text(m.providerId,
                          style: TextStyle(
                              color: colors.textMuted, fontSize: 11,),),
                      onTap: () async {
                        Navigator.pop(ctx);
                        try {
                          await ChatRuntimeService.instance
                              .setModel(sessionId, m.providerId, m.modelId,);
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                              content: Text('已切换到 ${m.modelId}'),
                              duration: const Duration(seconds: 2),
                              behavior: SnackBarBehavior.floating,
                            ),);
                          }
                        } catch (e) {
                          if (mounted) _runtimeErrorSnack(e);
                        }
                      },
                    ),
                ],
              );
            }
            return Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '模型（本会话历史）',
                    style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '协议未提供模型目录，仅列出本会话用过的模型',
                    style: TextStyle(color: colors.textMuted, fontSize: 11),
                  ),
                  body,
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  /// 思考档位弹层：低/中/高/最高（枚举未实测，失败显性提示）
  Future<void> _showThoughtSheet() async {
    final sessionId = ChatStore.instance.currentSessionId;
    if (sessionId == null) return;
    final colors = AppColors.of(context);
    const levels = [('低', 'low'), ('中', 'medium'), ('高', 'high'), ('最高', 'max')];
    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgSecondary,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 14, 8, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final (label, value) in levels)
                ListTile(
                  dense: true,
                  leading: Icon(Icons.psychology_outlined,
                      size: 18, color: colors.textSecondary,),
                  title: Text(label,
                      style:
                          TextStyle(color: colors.textPrimary, fontSize: 14,),),
                  onTap: () async {
                    Navigator.pop(ctx);
                    try {
                      await ChatRuntimeService.instance
                          .setThoughtLevel(sessionId, value);
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                          content: Text('思考档位已设为 $label'),
                          duration: const Duration(seconds: 2),
                          behavior: SnackBarBehavior.floating,
                        ),);
                      }
                    } catch (e) {
                      if (mounted) _runtimeErrorSnack(e);
                    }
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// git 分支 chip：显示当前工作区分支；点按弹分支选择器（companion x/* 扩展）
  Widget _buildBranchChip(AppColors colors) {
    return ValueListenableBuilder<String?>(
      valueListenable: GitService.instance.currentBranch,
      builder: (context, branch, _) {
        final wsPath =
            SessionSyncService.instance.workspaceInfo?.workspacePath;
        final hasBranch = branch != null && branch.isNotEmpty;
        return InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: (wsPath == null || wsPath.isEmpty)
              ? null
              : () async {
                  final newBranch =
                      await showGitBranchSheet(context, workspacePath: wsPath);
                  if (newBranch != null) {
                    // 检出成功：刷新分支显示；新会话即在该分支上运行
                    GitService.instance.refreshBranch(wsPath);
                  }
                },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: colors.bgTertiary,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: colors.border),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.call_split,
                  size: 15,
                  color: hasBranch ? colors.accent : colors.textMuted,
                ),
                const SizedBox(width: 6),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 140),
                  child: Text(
                    hasBranch ? branch : '分支',
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: hasBranch ? colors.textPrimary : colors.textMuted,
                      fontSize: 13,
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

// ── Custom code block builder with syntax highlight + copy ────────────

/// 排队中的待发消息（见 _sendQueue）
class _QueuedSend {
  final String id;
  String text;
  _QueuedSend(this.text) : id = DateTime.now().microsecondsSinceEpoch.toString();
}

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

/// 连续子智能体消息折叠组（悬浮窗"智能体"思路在聊天流的落点）
class _SubagentGroup {
  final List<ChatMessage> messages;
  const _SubagentGroup(this.messages);

  String get agent => messages.first.agent ?? '';
  String get label {
    final a = agent;
    if (a.isEmpty) return '子智能体';
    // 常见命名 mcp__x__y / general-purpose → 取可读末段
    final parts = a.split('__');
    return parts.isNotEmpty ? parts.last : a;
  }
}

/// 子智能体消息组卡片：默认折叠为一行摘要，点击展开内部消息
/// （内部沿用主列表的分组逻辑：连续工具消息再次折叠为工具组）
class _SubagentGroupCard extends StatefulWidget {
  final _SubagentGroup group;
  final Widget Function(ChatMessage) buildItem;

  const _SubagentGroupCard({required this.group, required this.buildItem});

  @override
  State<_SubagentGroupCard> createState() => _SubagentGroupCardState();
}

class _SubagentGroupCardState extends State<_SubagentGroupCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final g = widget.group;
    final textCount =
        g.messages.where((m) => m.role == MessageRole.assistant).length;
    final hasError = g.messages
        .any((m) => m.toolCalls?.any((t) => t.isError) ?? false);

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: hasError ? Colors.redAccent.withValues(alpha: 0.4) : colors.border,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Icon(Icons.smart_toy_outlined,
                      size: 15, color: colors.accent,),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '${g.label} · $textCount 条消息',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 12,
                          color: colors.textSecondary,
                          fontWeight: FontWeight.w600,),
                    ),
                  ),
                  Icon(
                    _expanded
                        ? Icons.keyboard_arrow_up
                        : Icons.keyboard_arrow_down,
                    size: 16,
                    color: colors.textMuted,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final item in _groupMessagesNested(g.messages))
                    item is _ToolGroup
                        ? ToolCallGroup(tools: item.messages)
                        : widget.buildItem(item as ChatMessage),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 嵌套分组：组内复用连续工具折叠（组内全部同 agent，
  /// 不会再产出 _SubagentGroup）
  List<dynamic> _groupMessagesNested(List<ChatMessage> messages) =>
      _groupPlainMessages(messages);
}

/// 纯连续工具折叠（供子智能体组内使用；不产生子智能体组）
List<dynamic> _groupPlainMessages(List<ChatMessage> messages) {
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

// ── Slash command model ───────────────────────────────────────────────

class _SlashCommand {
  final String command;
  final String description;
  const _SlashCommand(this.command, this.description);
}
