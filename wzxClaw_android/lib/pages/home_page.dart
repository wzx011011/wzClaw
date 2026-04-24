import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_highlight/themes/vs2015.dart';
import 'package:highlight/highlight.dart' show highlight;
import 'package:markdown/markdown.dart' as md;
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../services/chat_store.dart';
import '../services/connection_manager.dart';
import '../services/session_sync_service.dart';
import '../services/voice_input_service.dart';
import '../widgets/animated_message_item.dart';
import '../widgets/ask_user_bar.dart';
import '../widgets/connection_status_bar.dart';
import '../widgets/mic_button.dart';
import '../widgets/permission_bar.dart';
import '../widgets/plan_mode_bar.dart';
import '../widgets/project_drawer.dart';
import '../widgets/sticky_question_bar.dart';
import '../widgets/streaming_shimmer.dart';
import '../widgets/thinking_indicator.dart';
import '../widgets/tool_call_list.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();

  List<ChatMessage> _displayMessages = [];
  bool _isStreaming = false;
  bool _isWaiting = false;
  bool _showScrollFab = false;
  bool _scrollPending = false;
  int _previousGroupCount = 0;
  // Sticky question bar
  String? _stickyQuestion;
  double _stickyScrollOffset = 0.0;
  final Map<String, GlobalKey> _userMsgKeys = {};
  final Map<String, double> _userMsgRecordedOffsets = {};
  String? _desktopIdentity;
  PermissionRequest? _permissionRequest;
  StreamSubscription? _messagesSub;
  StreamSubscription? _streamingSub;
  StreamSubscription? _voiceErrorSub;
  StreamSubscription<bool>? _waitingSub;
  // Debounced connection state — avoids flicker during brief reconnects.
  WsConnectionState _visibleConnectionState = WsConnectionState.disconnected;
  Timer? _reconnectDebounceTimer;
  StreamSubscription<WsConnectionState>? _connectionStateSub;
  StreamSubscription<String?>? _desktopIdentitySub;
  StreamSubscription<PermissionRequest?>? _permissionSub;
  final FocusNode _inputFocusNode = FocusNode();

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
    _autoConnect();
    ChatStore.instance.loadHistory();

    _messagesSub = ChatStore.instance.messagesStream.listen((msgs) {
      if (mounted) {
        setState(() => _displayMessages = msgs);
        if (_isStreaming && !_showScrollFab) _scrollToBottom();
      }
    });

    _streamingSub = ChatStore.instance.streamingStream.listen((streaming) {
      if (mounted) setState(() => _isStreaming = streaming);
    });

    _waitingSub = ChatStore.instance.waitingStream.listen((waiting) {
      if (mounted) {
        setState(() => _isWaiting = waiting);
        if (waiting) _scrollToBottom();
      }
    });

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

    _desktopIdentitySub =
        ConnectionManager.instance.desktopIdentityStream.listen((identity) {
      if (mounted) setState(() => _desktopIdentity = identity);
    });

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
    _desktopIdentitySub?.cancel();
    _permissionSub?.cancel();
    _connectionStateSub?.cancel();
    _reconnectDebounceTimer?.cancel();
    _inputController.dispose();
    _scrollController.dispose();
    _inputFocusNode.dispose();
    super.dispose();
  }

  Future<void> _autoConnect() async {
    final prefs = await SharedPreferences.getInstance();
    final serverUrl = prefs.getString('server_url');
    if (serverUrl != null && serverUrl.isNotEmpty) {
      final token = prefs.getString('auth_token') ?? '';
      try {
        final uri = Uri.parse(serverUrl);
        final params = Map<String, String>.from(uri.queryParameters);
        params['role'] = 'mobile';
        if (token.isNotEmpty) params['token'] = token;
        final fullUrl = uri.replace(queryParameters: params).toString();
        ConnectionManager.instance.connect(fullUrl);
      } catch (e) {
        debugPrint('Auto-connect failed: $e');
      }
    }
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
    _updateStickyQuestion();
  }

  /// 检测已滚出顶部的用户消息，更新 sticky question bar 状态
  void _updateStickyQuestion() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;

      // 取 ListView 视口的全局坐标
      final scrollCtx = _scrollController.position.context.storageContext;
      final listBox = scrollCtx.findRenderObject() as RenderBox?;
      if (listBox == null || !listBox.attached) return;
      final viewportTop = listBox.localToGlobal(Offset.zero).dy;

      final userMsgs =
          _displayMessages.where((m) => m.role == MessageRole.user).toList();

      String? candidateQuestion;
      double candidateOffset = 0.0;

      for (final msg in userMsgs) {
        final keyStr = msg.createdAt.microsecondsSinceEpoch.toString();
        final key = _userMsgKeys[keyStr];
        if (key == null) continue;

        final ctx = key.currentContext;
        if (ctx != null) {
          final box = ctx.findRenderObject() as RenderBox?;
          if (box == null || !box.attached) continue;
          final itemTop = box.localToGlobal(Offset.zero).dy;
          final itemBottom = itemTop + box.size.height;

          // 记录滚动偏移（用于点击跳回）
          final absOffset =
              (_scrollController.offset + (itemTop - viewportTop))
                  .clamp(0.0, _scrollController.position.maxScrollExtent);
          _userMsgRecordedOffsets[keyStr] = absOffset;

          if (itemBottom < viewportTop) {
            // 完全在视口上方 — sticky 候选
            candidateQuestion = msg.content;
            candidateOffset = absOffset;
          } else {
            // 进入视口或在下方 — 停止遍历
            break;
          }
        } else if (_userMsgRecordedOffsets.containsKey(keyStr)) {
          // 已滚出屏幕（未渲染），使用上次记录的偏移
          candidateQuestion = msg.content;
          candidateOffset = _userMsgRecordedOffsets[keyStr]!;
        }
      }

      if (candidateQuestion != _stickyQuestion ||
          candidateOffset != _stickyScrollOffset) {
        setState(() {
          _stickyQuestion = candidateQuestion;
          _stickyScrollOffset = candidateOffset;
        });
      }
    });
  }

  void _sendMessage() {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;
    if (ConnectionManager.instance.state != WsConnectionState.connected) return;
    ChatStore.instance.sendMessage(text);
    _inputController.clear();
    _scrollToBottom();
  }

  void _clearSession() {
    final colors = AppColors.of(context);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgElevated,
        title: Text('清空会话', style: TextStyle(color: colors.textPrimary)),
        content:
            Text('确定要清空所有消息吗？', style: TextStyle(color: colors.textSecondary)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              ChatStore.instance.clearSession();
            },
            child: Text('清空', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    );
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
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
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
          // Return to live chat (clear active session)
          StreamBuilder<String?>(
            stream: SessionSyncService.instance.activeSessionStream,
            initialData: SessionSyncService.instance.activeSessionId,
            builder: (context, snapshot) {
              if (snapshot.data == null) return const SizedBox.shrink();
              return IconButton(
                icon: const Icon(Icons.add_comment_outlined),
                tooltip: '新对话',
                onPressed: () {
                  _inputFocusNode.unfocus();
                  SessionSyncService.instance.setActiveSession(null);
                  ChatStore.instance.switchToSession(null);
                },
              );
            },
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline),
            tooltip: '清空会话',
            onPressed: _clearSession,
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
                  return StreamBuilder<String?>(
                    stream: ConnectionManager.instance.selectedDesktopIdStream,
                    initialData: ConnectionManager.instance.selectedDesktopId,
                    builder: (context, selectedSnap) {
                      final desktops = desktopsSnap.data ?? [];
                      return ConnectionStatusBar(
                        state: _visibleConnectionState,
                        desktops: desktops,
                        selectedDesktopId: selectedSnap.data,
                        onDesktopSelect: (id) => ConnectionManager.instance.selectDesktop(id),
                        desktopIdentity: ConnectionManager.instance.desktopIdentity,
                        desktopOnline: desktops.isNotEmpty,
                        errorMessage: errorSnap.data,
                      );
                    },
                  );
                },
              );
            },
          ),
          Expanded(
            child: Stack(
              children: [
                _buildMessageList(),
                // Sticky question bar
                if (_stickyQuestion != null)
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    child: _buildStickyQuestionBar(),
                  ),
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

  Widget _buildMessageList() {
    final colors = AppColors.of(context);
    if (_displayMessages.isEmpty && !_isWaiting) {
      return Center(
        child: Text('暂无消息',
            style: TextStyle(color: colors.textMuted, fontSize: 14),),
      );
    }

    final showThinking = _isWaiting && !_isStreaming;
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
    final keyStr = msg.createdAt.microsecondsSinceEpoch.toString();
    final msgKey = _userMsgKeys.putIfAbsent(keyStr, () => GlobalKey());
    final colors = AppColors.of(context);
    final screenWidth = MediaQuery.of(context).size.width;
    return GestureDetector(
      key: msgKey,
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
            if (msg.usage != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  'In: ${_formatTokens(msg.usage!.inputTokens)} · Out: ${_formatTokens(msg.usage!.outputTokens)}',
                  style: TextStyle(color: colors.textMuted, fontSize: 10),
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

  // ── Sticky question bar ───────────────────────────────────────────

  Widget _buildStickyQuestionBar() {
    return StickyQuestionBar(
      question: _stickyQuestion!,
      onTap: () {
        _scrollController.animateTo(
          _stickyScrollOffset,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
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
                      child: Text(cmd.description, style: TextStyle(color: colors.textSecondary, fontSize: 13)),
                    ),
                  ],
                ),
              ),
            )),
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

        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(
            color: colors.bgSecondary,
            border: Border(top: BorderSide(color: colors.border, width: 0.5)),
          ),
          child: Row(
              children: [
                // Permission mode dropdown
                if (isConnected)
                  SizedBox(
                    width: 36,
                    height: 36,
                    child: IconButton(
                      onPressed: () {
                        const modes = ['always-ask', 'accept-edits', 'plan', 'bypass'];
                        const labels = ['总是询问', '允许编辑', '规划模式', '自动批准'];
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
                                      )),
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
                      hintText: isConnected
                          ? (_desktopIdentity != null
                              ? '$_desktopIdentity — 输入指令...'
                              : '输入指令...')
                          : '未连接',
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
        );
      },
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
