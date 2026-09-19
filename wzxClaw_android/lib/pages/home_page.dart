import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_highlight/themes/vs2015.dart';
import 'package:highlight/highlight.dart' show highlight;
import 'package:markdown/markdown.dart' as md;
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../models/ui_prefs.dart';
import '../services/attachment_service.dart';
import '../services/connection_manager.dart';
import '../services/file_download_service.dart';
import '../services/node_catalog_service.dart';
import '../services/git_service.dart';
import '../services/chat_runtime_service.dart';
import '../widgets/animated_message_item.dart';
import '../widgets/ask_user_bar.dart';
import '../widgets/connection_status_bar.dart';
import '../widgets/git_branch_sheet.dart';
import '../widgets/status_panel_card.dart';
import '../widgets/permission_bar.dart';
import '../widgets/project_drawer.dart';

import '../widgets/turn_block.dart';
import '../widgets/workspace_switcher_sheet.dart';
import '../widgets/markdown_path_link.dart';
import '../zcode/zcode_chat_store.dart';

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
  bool _isSessionLoading = false; // 切换会话时等待引擎返回数据
  bool _showScrollFab = false;
  bool _scrollPending = false;
  int _previousGroupCount = 0;
  // 跟踪上次渲染的会话 id
  String? _lastRenderedSessionId;
  String? _workspaceName;

  /// 悬浮状态面板开关（AppBar 心跳图标切换）
  bool _showStatusPanel = false;
  // Debounced connection state — avoids flicker during brief reconnects.
  WsConnectionState _visibleConnectionState = WsConnectionState.disconnected;
  Timer? _reconnectDebounceTimer;

  /// 回合运行中的 1Hz 心跳：增量暂停时页面不重建，tok/s 衰减与
  /// 「正在工作… Xs」会冻结——心跳补上这两个读数的时间维度
  /// （每秒一次 setState，远低于流式期逐增量重建的频率）
  Timer? _busyTickTimer;
  StreamSubscription<WsConnectionState>? _connectionStateSub;
  StreamSubscription<String>? _uiNoticesSub;
  final FocusNode _inputFocusNode = FocusNode();

  /// 直连栈数据源（R1 换接线）：连接层不变（ConnectionManager 供帧），
  /// 页面只认识数据容器
  ZcodeChatStore get _store => ZcodeChatStore.instance;

  // thinkingContent 是 getter（随 notifyListeners 推进），而思维链面板
  // 组件吃 Stream<String>——页内广播桥做范式转换，组件签名不变
  final StreamController<String> _thinkingCtrl =
      StreamController<String>.broadcast();
  String? _lastThinking;
  String? _lastShownError;

  /// 新任务态选择的思考档位：引擎无节点级默认档位，暂存到会话创建后补发
  String? _pendingThoughtLevel;
  String? _pendingPermissionMode;

  /// 待发送附件：上传成功后路径会作为消息文本引用交给 agent 的 Read 工具。
  final List<AttachmentUpload> _attachments = [];

  /// 活动下载任务（确认中/拉取中/预览待保存）。终态即移除并按结果提示，
  /// 状态不持久化（消息行会被权威合并原位替换，挂消息本体必被覆盖）。
  final List<FileDownloadTask> _downloads = [];

  /// 输入草稿（按会话上下文：activeSessionId ?? '__new__'）。切会话/
  /// 新任务各留各的；当前草稿持久化（composer_draft_*），重启可恢复。
  final Map<String, String> _drafts = {};
  String _draftKey = '__new__';
  Timer? _draftPersistTimer;

  /// 上滑加载更早的进行中标记与「已到最早」提示（每会话提示一次）
  bool _loadingOlder = false;
  bool _oldestNoticeShown = false;

  String _composeOutgoing(String text, Iterable<AttachmentUpload> attachments) {
    final refs = attachments.map((a) => '[附件已上传到节点: ${a.nodePath}]').join('\n');
    return refs.isEmpty ? text : '$refs\n$text';
  }

  void _removeSentAttachments(Iterable<AttachmentUpload> attachments) {
    setState(() => _attachments.removeWhere(attachments.contains));
  }

  Future<void> _pickAndUploadAttachment({required bool camera}) async {
    final upload = await AttachmentService.pickAndUpload(
      source: camera ? ImageSource.camera : ImageSource.gallery,
      onCreated: (record) {
        if (mounted) setState(() => _attachments.add(record));
      },
      onChanged: (_) {
        if (mounted) setState(() {});
      },
    );
    if (upload != null && !_attachments.contains(upload) && mounted) {
      setState(() => _attachments.add(upload));
    }
    if (upload != null && upload.error != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(upload.error!),
          duration: const Duration(seconds: 3),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  void _removeAttachment(AttachmentUpload attachment) {
    setState(() => _attachments.remove(attachment));
  }

  /// 当前草稿持久化（单对键：最后活动上下文才恢复，避免键无限增长）
  Future<void> _persistCurrentDraft() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('composer_draft_sid', _draftKey);
      await prefs.setString('composer_draft_text', _drafts[_draftKey] ?? '');
    } catch (_) {/* 草稿尽力而为 */}
  }

  Future<void> _restorePersistedDraft(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final savedSid = prefs.getString('composer_draft_sid');
      final savedText = prefs.getString('composer_draft_text');
      if (savedSid != key || savedText == null || savedText.isEmpty) return;
      if (_inputController.text.isNotEmpty) return; // 已有输入不覆盖
      _drafts[key] = savedText;
      _inputController.text = savedText;
      _inputController.selection =
          TextSelection.collapsed(offset: savedText.length);
    } catch (_) {/* 草稿尽力而为 */}
  }

  /// 发送/入队即消费草稿：内存与持久化同步清
  void _consumeDraft() {
    _drafts.remove(_draftKey);
    _draftPersistTimer?.cancel();
    unawaited(() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.remove('composer_draft_sid');
        await prefs.remove('composer_draft_text');
      } catch (_) {}
    }());
  }

  /// AI 回答长按菜单：复制全文 / 引用到输入框
  void _showTurnActions(String answerMarkdown) {
    final colors = AppColors.of(context);
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: Icon(
                  Icons.copy_all_outlined,
                  size: 20,
                  color: colors.textSecondary,
                ),
                title: Text(
                  '复制全文',
                  style: TextStyle(color: colors.textPrimary, fontSize: 14),
                ),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: answerMarkdown));
                  Navigator.pop(sheetContext);
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('回答已复制'),
                      duration: Duration(seconds: 2),
                      behavior: SnackBarBehavior.floating,
                    ),
                  );
                },
              ),
              ListTile(
                leading: Icon(
                  Icons.reply_outlined,
                  size: 20,
                  color: colors.textSecondary,
                ),
                title: Text(
                  '引用到输入框',
                  style: TextStyle(color: colors.textPrimary, fontSize: 14),
                ),
                onTap: () {
                  Navigator.pop(sheetContext);
                  final quoted = answerMarkdown
                      .split('\n')
                      .map((line) => '> $line')
                      .join('\n');
                  final current = _inputController.text;
                  _inputController.text =
                      current.isEmpty ? '$quoted\n' : '$current\n$quoted\n';
                  _inputController.selection = TextSelection.collapsed(
                    offset: _inputController.text.length,
                  );
                  _inputFocusNode.requestFocus();
                },
              ),
            ],
          ),
        );
      },
    );
  }

  // ── 文件下载到手机（确认 → 可预览 → 再确认保存）────────────────────

  /// 下载入口：正文 file:// 链接与 Write 工具行下载图标都汇到这里。
  /// 先 begin 拿文件名/大小（工作区外在此步报错），再弹确认面板；
  /// 同一路径已有进行中的任务时不重复登记，直接重开确认面板。
  Future<void> _startFileDownload(String nodePath) async {
    final existing = _downloads
        .where((t) => t.nodePath == nodePath && !t.isFinished)
        .toList();
    if (existing.isNotEmpty) {
      _showDownloadConfirmSheet(existing.first);
      return;
    }
    final task = await FileDownloadService.begin(nodePath);
    if (!mounted) return;
    if (task.phase == FileDownloadPhase.failed) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(task.error ?? '无法下载该文件'),
          duration: const Duration(seconds: 3),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    setState(() => _downloads.add(task));
    _showDownloadConfirmSheet(task);
  }

  void _showDownloadConfirmSheet(FileDownloadTask task) {
    final colors = AppColors.of(context);
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 22),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.insert_drive_file_outlined,
                      size: 18,
                      color: colors.textMuted,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        task.name,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  '${_formatBytes(task.size)} · 节点工作区文件',
                  style: TextStyle(color: colors.textMuted, fontSize: 12.5),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () {
                          Navigator.pop(sheetContext);
                          FileDownloadService.pull(
                            task,
                            forPreview: true,
                            onChanged: _onDownloadChanged,
                          );
                        },
                        icon: const Icon(Icons.visibility_outlined, size: 16),
                        label: const Text('预览'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () {
                          Navigator.pop(sheetContext);
                          FileDownloadService.pull(
                            task,
                            forPreview: false,
                            onChanged: _onDownloadChanged,
                          );
                        },
                        icon: const Icon(Icons.download_outlined, size: 16),
                        label: const Text('直接下载'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                SizedBox(
                  width: double.infinity,
                  child: TextButton(
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: task.nodePath));
                      Navigator.pop(sheetContext);
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('节点路径已复制'),
                          duration: Duration(seconds: 2),
                          behavior: SnackBarBehavior.floating,
                        ),
                      );
                    },
                    child: Text(
                      '复制节点路径',
                      style: TextStyle(color: colors.textMuted, fontSize: 13),
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

  /// 服务回调：终态在 setState 内出列并按结果提示；进行中仅刷新 chip
  void _onDownloadChanged(FileDownloadTask task) {
    if (!mounted) return;
    setState(() {
      if (task.isFinished) _downloads.remove(task);
    });
    if (!task.isFinished) return;
    String message;
    switch (task.phase) {
      case FileDownloadPhase.saved:
        message = '已保存到${_savedLabel(task)}';
      case FileDownloadPhase.failed:
        message = task.error ?? '下载失败';
      default:
        return; // cancelled：放弃预览/主动取消不打扰
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        duration: const Duration(seconds: 3),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  /// 保存位置的可读标签（当前唯一保存路径 = 公共下载文件夹）
  String _savedLabel(FileDownloadTask task) => '下载文件夹：${task.name}';

  String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }

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
    // 直连栈单一监听入口：ChangeNotifier → 页面状态（替代旧 4 流订阅）。
    // 初始同步回种流式/等待/权限/会话初值：重进页面若回合正在跑，
    // 否则发送按钮形态短暂错误、消息会直发而非入队
    _store.addListener(_onStoreChanged);
    _syncFromStore(initial: true);
    // 回车发送偏好变化时重建输入栏（textInputAction 跟随）
    UiPrefs.enterToSend.addListener(_onUiPrefChanged);

    // store 轻量通告（如反向请求等待超时）→ SnackBar
    _uiNoticesSub = _store.uiNotices.listen((message) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 3),
          behavior: SnackBarBehavior.floating,
        ),
      );
    });

    _scrollController.addListener(_onScroll);

    // 工作区选择态在直连栈 store 里（欢迎页选择/最近会话回退）；
    // 变化时刷新当前分支（companion x/* 扩展，见 git_service.dart）
    _store.addListener(_onWorkspaceChanged);
    _onWorkspaceChanged();

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
        _reconnectDebounceTimer = Timer(const Duration(milliseconds: 1200), () {
          if (mounted) setState(() => _visibleConnectionState = state);
        });
      }
    });
  }

  @override
  void dispose() {
    _store.removeListener(_onStoreChanged);
    UiPrefs.enterToSend.removeListener(_onUiPrefChanged);
    _uiNoticesSub?.cancel();
    _connectionStateSub?.cancel();
    _draftPersistTimer?.cancel();
    // 退出前持久化当前草稿（先入 map，异步写 prefs 不再碰 controller）
    _drafts[_draftKey] = _inputController.text;
    if (_inputController.text.isNotEmpty) unawaited(_persistCurrentDraft());
    _reconnectDebounceTimer?.cancel();
    _busyTickTimer?.cancel();
    _queueFlushTimer?.cancel();
    _thinkingCtrl.close();
    _inputController.dispose();
    _scrollController.dispose();
    _inputFocusNode.dispose();
    super.dispose();
  }

  /// store → 页面状态单向同步（ChangeNotifier 单一入口）
  void _onStoreChanged() => _syncFromStore();

  void _onUiPrefChanged() {
    if (mounted) setState(() {});
  }

  void _syncFromStore({bool initial = false}) {
    if (!mounted) return;
    final sid = _store.activeSessionId;
    if (sid != _lastRenderedSessionId) {
      // 草稿按会话上下文换手：存旧、载新（切会话不再丢输入）
      if (!initial) _drafts[_draftKey] = _inputController.text;
      _draftKey = sid ?? '__new__';
      _lastRenderedSessionId = sid;
      if (!initial) {
        _showScrollFab = false;
        _slashSuggestions = [];
        _loadingOlder = false;
        _oldestNoticeShown = false;
        _inputController.text = _drafts[_draftKey] ?? '';
        _inputController.selection = TextSelection.collapsed(
          offset: _inputController.text.length,
        );
        // 排队消息属于原会话上下文，切会话即清（不留到别的会话发出）
        _sendQueue.clear();
      } else {
        // 冷启动恢复：持久化草稿仅当会话上下文匹配时载入
        unawaited(_restorePersistedDraft(_draftKey));
      }
    }
    final thinking = _store.liveThinkingText;
    if (thinking != _lastThinking) {
      _lastThinking = thinking;
      _thinkingCtrl.add(thinking);
    }
    setState(() {
      _displayMessages = _store.messages;
      _isStreaming = _store.isStreaming;
      _isWaiting = _store.isWaitingForResponse;
      _isSessionLoading = _store.sessionOpening;
    });
    // 回合运行中起 1Hz 心跳（tok/s 衰减/已耗时不随增量暂停而冻结）
    final busy = _isStreaming || _isWaiting;
    if (busy && _busyTickTimer == null) {
      _busyTickTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!busy) {
      _busyTickTimer?.cancel();
      _busyTickTimer = null;
    }
    if ((_isStreaming || _isWaiting) &&
        !_showScrollFab &&
        _displayMessages.isNotEmpty) {
      _scrollToBottom();
    }
    // 回合边界 → 冲排队队列（500ms 去抖在 _scheduleQueueFlush 内）
    if (!_isStreaming && !_isWaiting) _scheduleQueueFlush();

    // 发送失败等业务错误：store.error 上浮为 SnackBar（模型卡路径已退役，
    // 自愈失败也走这里）
    final err = _store.error;
    final hasBlockedCard = _store.modelBlockedContent != null;
    if (err != null && err != _lastShownError && !hasBlockedCard) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(err),
          duration: const Duration(seconds: 3),
          behavior: SnackBarBehavior.floating,
        ),
      );
      _store.clearError();
    }
    _lastShownError = err;
  }

  /// 工作区选择变化（欢迎页选择/最近会话回退）→ 分支刷新 + chip 刷新
  void _onWorkspaceChanged() {
    if (!mounted) return;
    final path = _store.selectedWorkspacePath;
    setState(() => _workspaceName = _workspaceDisplayName(path));
    GitService.instance.refreshBranch(path);
  }

  /// 工作区名：取路径末段（E:\ai\wzxClaw → wzxClaw；非路径原样）
  String _workspaceDisplayName(String? path) {
    if (path == null || path.isEmpty) return '';
    final normalized =
        path.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
    final idx = normalized.lastIndexOf('/');
    return idx >= 0 && idx < normalized.length - 1
        ? normalized.substring(idx + 1)
        : path;
  }

  void _onScroll() {
    if (_scrollController.position.pixels <= 50 &&
        !_loadingOlder &&
        _store.activeSessionId != null) {
      unawaited(_loadOlderWithFeedback());
    }
    // Show/hide scroll-to-bottom FAB
    final distanceFromBottom = _scrollController.position.maxScrollExtent -
        _scrollController.position.pixels;
    final shouldShow = distanceFromBottom > 100;
    if (shouldShow != _showScrollFab) {
      setState(() => _showScrollFab = shouldShow);
    }
  }

  /// 上滑加载更早：加载中顶部细进度条；一次无新增 = 到底，提示一次
  Future<void> _loadOlderWithFeedback() async {
    setState(() => _loadingOlder = true);
    try {
      final added = await _store.loadOlderMessages();
      if (added == 0 && mounted && !_oldestNoticeShown) {
        _oldestNoticeShown = true; // 每会话只提示一次，不反复打扰
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('已经是最早的消息了'),
            duration: Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _loadingOlder = false);
    }
  }

  void _sendMessage() {
    if (ConnectionManager.instance.state != WsConnectionState.connected) {
      // 不静默丢弃：提示并保留输入（用户打完字点发送必须有下文）
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('未连接桌面，消息未发送'),
          duration: Duration(seconds: 3),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    final inputText = _inputController.text.trim();
    final readyAttachments = _attachments.where((a) => a.done).toList();
    if (inputText.isEmpty && readyAttachments.isEmpty) return;
    final text = _composeOutgoing(inputText, readyAttachments);
    // 流式进行中：改为排队（对齐官方 ZCode「继续输入以排队后续修改」）
    if (_isStreaming || _isWaiting) {
      setState(() => _sendQueue.add(_QueuedSend(text)));
      _removeSentAttachments(readyAttachments);
      _inputController.clear();
      _consumeDraft();
      return;
    }
    // Option A：没有活动会话 = 处于「新任务」欢迎态，首条消息触发建会话
    if (_store.activeSessionId == null) {
      _startNewConversation(
        text,
        attachments: readyAttachments,
        retryText: inputText,
      );
      return;
    }
    unawaited(_store.sendMessage(text));
    _removeSentAttachments(readyAttachments);
    _inputController.clear();
    _consumeDraft();
    _scrollToBottom();
  }

  /// 队列消息「↑ 立即」：不等当前 turn 结束马上发
  void _sendQueuedNow(_QueuedSend item) {
    setState(() => _sendQueue.remove(item));
    if (_store.activeSessionId == null) {
      _startNewConversation(item.text, requeueOnFailure: item);
      return;
    }
    unawaited(_store.sendMessage(item.text));
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
      if (_store.activeSessionId == null) {
        _startNewConversation(item.text, requeueOnFailure: item);
      } else {
        unawaited(_store.sendMessage(item.text));
        _scrollToBottom();
      }
    });
  }

  Future<void> _startNewConversation(
    String text, {
    _QueuedSend? requeueOnFailure,
    List<AttachmentUpload> attachments = const [],
    String? retryText,
  }) async {
    _inputController.clear();
    _consumeDraft();
    _scrollToBottom();
    // 直连栈：先建会话（引擎 create），成功后发首条
    await _store.newSession();
    final newSid = _store.activeSessionId;
    if (newSid == null) {
      // 失败不蒸发：排队来源回插队首（保持原顺序），输入来源回填输入框
      if (requeueOnFailure != null) {
        setState(() => _sendQueue.insert(0, requeueOnFailure));
      } else {
        _inputController.text = retryText ?? text;
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('创建会话失败，请检查连接后重试'),
            duration: Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
      return;
    }
    // 新任务态暂存的思考档位：会话建好后补发（失败不阻断首条消息，
    // 失败原因已进 store.error）
    final pendingLevel = _pendingThoughtLevel;
    if (pendingLevel != null) {
      _pendingThoughtLevel = null;
      await _store.setThoughtLevel(pendingLevel);
    }
    final pendingMode = _pendingPermissionMode;
    if (pendingMode != null) {
      _pendingPermissionMode = null;
      await _store.setMode(pendingMode);
    }
    unawaited(_store.sendMessage(text));
    if (attachments.isNotEmpty) _removeSentAttachments(attachments);
  }

  Future<void> _editQueued(_QueuedSend item) async {
    final controller = TextEditingController(text: item.text);
    final newText = await showDialog<String>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AppColors.of(dialogCtx).bgSecondary,
        title: Text(
          '编辑排队消息',
          style: TextStyle(
            color: AppColors.of(dialogCtx).textPrimary,
            fontSize: 16,
          ),
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
            child: Text(
              '取消',
              style: TextStyle(color: AppColors.of(dialogCtx).textSecondary),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx, controller.text.trim()),
            child: Text(
              '保存',
              style: TextStyle(color: AppColors.of(dialogCtx).accent),
            ),
          ),
        ],
      ),
    );
    if (newText == null || newText.isEmpty || newText == item.text) return;
    if (!mounted) return;
    setState(() => item.text = newText);
  }

  /// 排队条：流式期间显示在输入框上方。对齐官方样式：每条排队消息一张
  /// 独立圆角卡片（消息文本 + ↑立即 + 编辑 + 删除），支持拖拽排序。
  Widget _buildSendQueueStrip(AppColors colors) {
    if (_sendQueue.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
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
    return Container(
      key: ValueKey(item.id),
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Icon(
                Icons.drag_indicator,
                size: 18,
                color: colors.textMuted,
              ),
            ),
          ),
          Expanded(
            child: Text(
              item.text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.textPrimary, fontSize: 13),
            ),
          ),
          const SizedBox(width: 8),
          // ↑ 立即：不等当前 turn 结束
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => _sendQueuedNow(item),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: colors.bgInput,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Icon(Icons.north, size: 11, color: colors.textPrimary),
                  const SizedBox(width: 3),
                  Text(
                    '立即',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            icon: Icon(
              Icons.edit_outlined,
              size: 17,
              color: colors.textSecondary,
            ),
            tooltip: '编辑',
            onPressed: () => _editQueued(item),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            icon: Icon(
              Icons.delete_outline,
              size: 17,
              color: colors.textSecondary,
            ),
            tooltip: '删除',
            onPressed: () => setState(() => _sendQueue.remove(item)),
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
                Clipboard.setData(ClipboardData(text: msg.text));
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
                  unawaited(_store.sendMessage(msg.text));
                },
              ),
            ListTile(
              leading: Icon(Icons.share, color: colors.textSecondary),
              title: Text('分享', style: TextStyle(color: colors.textPrimary)),
              onTap: () {
                Navigator.pop(ctx);
                Clipboard.setData(ClipboardData(text: msg.text));
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
        title: _buildTitle(colors),
        iconTheme: IconThemeData(color: colors.textPrimary),
        actions: [
          // 切换桌面：返回设备列表（LandingPage）重新选择/切换桌面
          IconButton(
            icon: const Icon(Icons.swap_horiz_outlined),
            tooltip: '切换桌面端',
            onPressed: () {
              Navigator.pushNamedAndRemoveUntil(context, '/', (_) => false);
            },
          ),
          // 新对话：进入「新任务」欢迎态（引擎会话等首条消息发出时才创建）
          IconButton(
            icon: const Icon(Icons.add_comment_outlined),
            tooltip: '新任务',
            onPressed: () {
              _inputFocusNode.unfocus();
              _store.closeSessionView();
            },
          ),
          // 悬浮状态面板：Git 工具/目标/进程/智能体一站式（官方 chat.statusPanel 还原）
          IconButton(
            icon: Icon(
              Icons.monitor_heart_outlined,
              color: _showStatusPanel ? colors.accent : null,
            ),
            tooltip: '状态面板',
            onPressed: () =>
                setState(() => _showStatusPanel = !_showStatusPanel),
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: '设置',
            onPressed: () => Navigator.pushNamed(context, '/settings'),
          ),
        ],
      ),
      drawer: const ProjectDrawer(),
      // 悬浮状态面板挂在消息层之上（Stack 顶层；面板自带拖动/胶囊）
      body: Stack(
        children: [
          Column(
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
                        desktopIdentity:
                            ConnectionManager.instance.desktopIdentity,
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
                            child: Icon(
                              Icons.keyboard_arrow_down,
                              color: colors.textPrimary,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (_store.activePermission != null)
                PermissionBar(request: _store.activePermission!),
              if (_store.activeAskUser != null)
                AskUserBar(question: _store.activeAskUser!),
              _buildSlashSuggestions(),
              _buildInputBar(),
            ],
          ),
          if (_showStatusPanel)
            FloatingStatusPanel(
              onClose: () => setState(() => _showStatusPanel = false),
              onOpenBranchSheet: (wsPath) {
                if (wsPath.isEmpty) return;
                showGitBranchSheet(context, workspacePath: wsPath);
              },
              sessionBusy: _isStreaming || _isWaiting,
              workspacePath: _store.selectedWorkspacePath,
            ),
        ],
      ),
    );
  }

  /// appbar 标题：wzxClaw + 当前会话名（直连栈查表）
  Widget _buildTitle(AppColors colors) {
    final sid = _store.activeSessionId;
    if (sid == null) {
      return Text('wzxClaw', style: TextStyle(color: colors.textPrimary));
    }
    final match = _store.sessions.where((s) => s.sessionId == sid);
    final title = match.isNotEmpty ? match.first.title : 'Session';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'wzxClaw',
          style: TextStyle(color: colors.textPrimary, fontSize: 16),
        ),
        Text(
          title,
          style: TextStyle(color: colors.textSecondary, fontSize: 11),
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }

  // ── Message list ───────────────────────────────────────────────────

  /// 切换会话时的骨架屏占位，模拟即将出现的消息气泡形状。
  Widget _buildSessionLoadingSkeleton(AppColors colors) {
    final screenWidth = MediaQuery.of(context).size.width;
    // 固定宽度比例，模拟长短不一的消息气泡
    final rows = [
      (align: Alignment.centerRight, w: screenWidth * 0.55),
      (align: Alignment.centerLeft, w: screenWidth * 0.75),
      (align: Alignment.centerLeft, w: screenWidth * 0.60),
      (align: Alignment.centerLeft, w: screenWidth * 0.45),
      (align: Alignment.centerRight, w: screenWidth * 0.50),
      (align: Alignment.centerLeft, w: screenWidth * 0.70),
    ];
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      physics: const NeverScrollableScrollPhysics(),
      children: rows
          .map(
            (r) => Align(
              alignment: r.align,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: _SkeletonBox(
                  width: r.w,
                  height: 36,
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          )
          .toList(),
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
                // 工作区 + 分支选择：只出现在新建会话页
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildWorkspaceChip(colors),
                    const SizedBox(width: 10),
                    _buildBranchChip(colors),
                  ],
                ),
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

  /// 当前工作区 chip：点按弹切换器；工作区来自直连栈选择态
  Widget _buildWorkspaceChip(AppColors colors) {
    final wsName = _workspaceDisplayName(_store.selectedWorkspacePath);
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
          _store.activeSessionId == null) {
        return _buildWelcomeView(colors);
      }
      return Center(
        child: Text(
          '暂无消息',
          style: TextStyle(color: colors.textMuted, fontSize: 14),
        ),
      );
    }

    final showBlockedCard = _store.modelBlockedContent != null &&
        _store.modelBlockedSessionId == _store.activeSessionId;

    // ── 回合分桶（canonical timeline）：用户消息独立成块；assistant 消息
    //（含 info.agent 子智能体消息）按序进入回合块，TurnBlockView 按引擎
    // 原序渲染思考/正文/工具/子智能体行。没有任何旁路分组。
    final blocks = <Object>[];
    var turnBuf = <ChatMessage>[];
    void flushTurn() {
      if (turnBuf.isEmpty) return;
      blocks.add(_TurnEntry(List.of(turnBuf)));
      turnBuf = <ChatMessage>[];
    }

    for (final msg in _displayMessages) {
      if (msg.role == MessageRole.user) {
        flushTurn();
        blocks.add(msg);
        continue;
      }
      turnBuf.add(msg);
    }
    flushTurn();

    final itemCount = blocks.length + (showBlockedCard ? 1 : 0);
    // Only animate newly appended messages (not full replacement from session switch).
    // If prev count was 0 (empty or just switched), skip animation entirely.
    final prevCount = _previousGroupCount > 0 ? _previousGroupCount : itemCount;
    _previousGroupCount = blocks.length;

    final list = ListView.builder(
      controller: _scrollController,
      // 左右 16：与抽屉/欢迎页留白一致；原 4px 内容几乎贴屏幕边
      //（2026-09-18 用户反馈左右间距太小）
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        if (showBlockedCard && index == blocks.length) {
          return _buildModelBlockedCard(colors);
        }
        final block = blocks[index];
        Widget child;
        if (block is _TurnEntry) {
          final isLast = index == blocks.length - 1;
          final busy = isLast && (_isStreaming || _isWaiting);
          child = TurnBlockView(
            vm: buildTurnVM(
              block.messages,
              busy: busy,
              totalDuration: !busy && isLast && _store.lastTurnMs != null
                  ? Duration(milliseconds: _store.lastTurnMs!)
                  : null,
              // 回合指标：运行中实时（tok/s 为估算），完成后最近一次权威值
              firstTokenMs: busy
                  ? _store.firstTokenLatencyMs
                  : (isLast ? _store.lastFirstTokenMs : null),
              tokensPerSecond: busy
                  ? _store.estimatedTokensPerSecond
                  : (isLast ? _store.lastTurnTokensPerSecond : null),
              tpsIsEstimate: busy,
              busyElapsed: busy ? _store.streamElapsed : null,
            ),
            defaultCollapsed: isLast ? null : true,
            // 流式中降级纯文本（防半截 markdown 裸露 + 逐 chunk 全量重解析）
            answerBuilder: (md, streaming) =>
                _buildMarkdownBody(md, isStreaming: streaming),
            onDownloadFile: _startFileDownload,
            onAnswerLongPress: _showTurnActions,
          );
        } else {
          child = _buildUserBubble(block as ChatMessage);
        }
        // Animate only newly appended items
        if (index >= prevCount) {
          return AnimatedMessageItem(child: child);
        }
        return child;
      },
    );
    // 上滑加载更早时顶部细进度条（有反馈，不再无声）
    if (_loadingOlder) {
      return Column(
        children: [
          const LinearProgressIndicator(minHeight: 2),
          Expanded(child: list),
        ],
      );
    }
    return list;
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
          child: Text(
            msg.text,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 13,
              height: 1.5,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildMarkdownBody(String rawContent, {bool isStreaming = false}) {
    final colors = AppColors.of(context);
    // Strip <details>...</details> blocks — tool outputs render as tool rows
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
          fontWeight: FontWeight.bold,
        ),
        h2: TextStyle(
          color: colors.textPrimary,
          fontSize: 14,
          fontWeight: FontWeight.bold,
        ),
        h3: TextStyle(
          color: colors.textPrimary,
          fontSize: 13,
          fontWeight: FontWeight.bold,
        ),
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
      // 裸绝对路径（已知扩展名）→ file:// 链接，挂在解析层：代码块/
      // 行内 code/已有链接由 markdown 解析器语义天然保护
      inlineSyntaxes: [filePathLinkSyntax],
      onTapLink: (text, href, title) {
        final nodePath = href == null ? null : fileLinkToPath(href);
        if (nodePath != null) {
          // 节点文件链接（正文转链/工具产物/AI 手写）→ 确认下载
          _startFileDownload(nodePath);
          return;
        }
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

  // ── Slash command autocomplete ────────────────────────────────────

  void _onInputChanged(String text) {
    // 草稿防抖持久化（切会话内存保留 + 重启可恢复）
    _draftPersistTimer?.cancel();
    _draftPersistTimer = Timer(const Duration(milliseconds: 600), () {
      _drafts[_draftKey] = text;
      unawaited(_persistCurrentDraft());
    });
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
                  Text(
                    '命令',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.pop(ctx),
                    icon: Icon(Icons.close, color: colors.textMuted, size: 20),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            ..._allSlashCommands.map(
              (cmd) => InkWell(
                onTap: () {
                  Navigator.pop(ctx);
                  _inputController.text = cmd.command;
                  _inputController.selection = TextSelection.fromPosition(
                    TextPosition(offset: cmd.command.length),
                  );
                  _sendMessage();
                },
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
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
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  // ── Input bar（V3 容器式：输入整行在上、工具栏在下；弹层自按钮向上展开） ──

  final GlobalKey _plusBtnKey = GlobalKey();
  final GlobalKey _modeBtnKey = GlobalKey();
  final GlobalKey _usageBtnKey = GlobalKey();
  final GlobalKey _modelBtnKey = GlobalKey();
  final GlobalKey _effortBtnKey = GlobalKey();

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
          padding: EdgeInsets.fromLTRB(8, 4, 8, 6 + bottomInset),
          child: Column(
            children: [
              // 下载任务条：确认中/拉取中/预览待保存的任务在此显示
              if (_downloads.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(6, 0, 6, 6),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        for (final task in _downloads)
                          _FileDownloadChip(
                            task: task,
                            onChanged: _onDownloadChanged,
                            onShowSheet: () => _showDownloadConfirmSheet(task),
                          ),
                      ],
                    ),
                  ),
                ),
              if (_attachments.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(6, 0, 6, 6),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        for (final attachment in _attachments)
                          _AttachmentChip(
                            attachment: attachment,
                            onRemove: () => _removeAttachment(attachment),
                          ),
                      ],
                    ),
                  ),
                ),
              // 工作区/分支胶囊只出现在「新任务」欢迎页（会话中切换工作区
              // 语义未定，先不暴露——用户 2026-09-17 定）
              _buildSendQueueStrip(colors),
              _buildComposerContainer(colors, isConnected),
            ],
          ),
        );
      },
    );
  }

  /// 容器式输入区：单容器包住输入与工具栏（对齐官方 ZCode 输入区）。
  Widget _buildComposerContainer(AppColors colors, bool isConnected) {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        children: [
          // 输入内容独占上方整行；生成中不锁输入，提示切换为排队语
          TextField(
            controller: _inputController,
            focusNode: _inputFocusNode,
            enabled: isConnected,
            style: TextStyle(color: colors.textPrimary, fontSize: 14.5),
            decoration: InputDecoration(
              hintText: !isConnected
                  ? '未连接'
                  : (_isStreaming || _isWaiting)
                      ? '继续输入以排队后续修改'
                      : '提出后续修改要求',
              hintStyle: TextStyle(color: colors.textMuted, fontSize: 14),
              border: InputBorder.none,
              isDense: true,
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
            ),
            maxLines: 6,
            minLines: 1,
            keyboardType: TextInputType.multiline,
            // 回车发送偏好（设置页开关）：开 = 键盘发送键直接发送；
            // 关 = 回车换行，点按钮发送
            textInputAction: UiPrefs.enterToSend.value
                ? TextInputAction.send
                : TextInputAction.newline,
            onSubmitted: UiPrefs.enterToSend.value
                ? (_) {
                    if (_inputController.text.trim().isNotEmpty) {
                      _sendMessage();
                    }
                  }
                : null,
            onChanged: _onInputChanged,
          ),
          const SizedBox(height: 8),
          _buildComposerToolbar(colors, isConnected),
        ],
      ),
    );
  }

  /// 工具栏：左「+ · 权限模式」，右「用量 · 模型 · 档位 · 发送/停止」。
  /// 权限模式弹层直连栈化：展示引擎权威模式，选择经 store.setMode 直发。
  Widget _buildComposerToolbar(AppColors colors, bool isConnected) {
    // 官方样式：完全访问激活色
    const modeOrange = Color(0xFFE8A33D);
    final busy = _isStreaming || _isWaiting;

    Widget iconBtn({
      required GlobalKey key,
      required String tip,
      required IconData icon,
      required VoidCallback? onTap,
      Color? color,
    }) =>
        SizedBox(
          key: key,
          width: 30,
          height: 30,
          child: IconButton(
            onPressed: onTap,
            icon: Icon(icon, size: 20, color: color ?? colors.textSecondary),
            padding: EdgeInsets.zero,
            tooltip: tip,
          ),
        );

    // UI 四档 ↔ 引擎模式映射（词典同 CM._uiToServerMode；语义最近对应，
    // 非等价：always-ask↔build、accept-edits↔edit；auto 显示回落 build）
    const modeNames = {
      'build': '变更前确认',
      'edit': '自动编辑',
      'plan': '计划模式',
      'yolo': '完全访问',
      'auto': '变更前确认',
    };
    final serverMode = _store.sessionMode;
    // 新任务态的暂存档位必须回显到按钮上：否则选完没有任何可见变化，
    // 会被当成「设置不了」（2026-09-17 用户反馈）
    final pendingMode =
        _store.activeSessionId == null ? _pendingPermissionMode : null;
    final effectiveMode = pendingMode ?? serverMode;
    final modeLabel = (modeNames[effectiveMode] ?? '权限模式') +
        (pendingMode != null ? '·待生效' : '');
    final modeColor = pendingMode != null || effectiveMode == 'yolo'
        ? modeOrange
        : colors.textSecondary;

    return Row(
      children: [
        iconBtn(
          key: _plusBtnKey,
          tip: '附加',
          icon: Icons.add,
          onTap: isConnected ? _showAttachPopup : null,
        ),
        const SizedBox(width: 4),
        SizedBox(
          key: _modeBtnKey,
          height: 30,
          child: IconButton(
            onPressed: isConnected ? _showPermissionPopup : null,
            padding: const EdgeInsets.symmetric(horizontal: 6),
            tooltip: '权限模式',
            icon: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.security_outlined, size: 18, color: modeColor),
                Text(
                  modeLabel,
                  style: TextStyle(
                    color: modeColor,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 2),
                Icon(Icons.expand_more, size: 13, color: modeColor),
              ],
            ),
          ),
        ),
        const Spacer(),
        // 上下文用量：必须已有会话（新任务态不可点，语义对齐官方）
        iconBtn(
          key: _usageBtnKey,
          tip: '上下文用量',
          icon: Icons.donut_large,
          onTap: isConnected && _store.activeSessionId != null
              ? _showUsagePopup
              : null,
        ),
        const SizedBox(width: 2),
        iconBtn(
          key: _modelBtnKey,
          tip: '模型',
          icon: Icons.view_in_ar_outlined,
          onTap: isConnected ? _showModelPopup : null,
        ),
        const SizedBox(width: 2),
        iconBtn(
          key: _effortBtnKey,
          tip: '思考档位',
          icon: Icons.psychology_outlined,
          onTap: isConnected ? _showEffortPopup : null,
        ),
        const SizedBox(width: 8),
        // 发送/停止：浅色圆角方块（V3：空闲 ↑ 箭头、生成中实心方块）
        SizedBox(
          width: 30,
          height: 30,
          child: IconButton(
            onPressed: busy
                ? () => unawaited(_store.stopGeneration())
                : (isConnected ? _sendMessage : null),
            style: IconButton.styleFrom(
              backgroundColor:
                  isConnected ? const Color(0xFFE8E8E8) : colors.bgTertiary,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(9),
              ),
            ),
            padding: EdgeInsets.zero,
            tooltip: busy ? '停止生成' : '发送',
            icon: Icon(
              busy ? Icons.stop : Icons.arrow_upward,
              size: 18,
              color: isConnected ? const Color(0xFF17181A) : colors.textMuted,
            ),
          ),
        ),
      ],
    );
  }

  /// 输入区弹层统一骨架：底部抽屉（与工作区/分支抽屉同模式）。
  /// 旧实现 showMenu + 估算坐标会跳位、Material 菜单样式也与官方不符
  /// （2026-09-17 用户反馈）；抽屉位置固定、可承载富内容。
  Future<T?> _showComposerSheet<T>({
    required WidgetBuilder builder,
    bool isScrollControlled = false,
  }) {
    final colors = AppColors.of(context);
    return showModalBottomSheet<T>(
      context: context,
      backgroundColor: colors.bgSecondary,
      isScrollControlled: isScrollControlled,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(top: 10, bottom: 4),
                decoration: BoxDecoration(
                  color: colors.textMuted.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            builder(ctx),
          ],
        ),
      ),
    );
  }

  /// 「+」附加菜单：图片经 companion x/file/* 上传，路径作为消息引用发送。
  Future<void> _showAttachPopup() async {
    _inputFocusNode.unfocus();
    final colors = AppColors.of(context);
    final items = [
      ('gallery', Icons.attach_file, '添加附件（图片）', null),
      ('camera', Icons.photo_camera_outlined, '拍照附件', null),
      ('commands', Icons.terminal, '使用 / 选择能力', null),
    ];
    await _showComposerSheet<void>(
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (action, icon, label, note) in items)
              ListTile(
                dense: true,
                enabled: note == null,
                leading: Icon(
                  icon,
                  size: 20,
                  color: note == null ? colors.textPrimary : colors.textMuted,
                ),
                title: Row(
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        color: note == null
                            ? colors.textPrimary
                            : colors.textMuted,
                        fontSize: 14,
                      ),
                    ),
                    if (note != null) ...[
                      const SizedBox(width: 6),
                      Text(
                        '（$note）',
                        style: TextStyle(
                          color: colors.textMuted,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ],
                ),
                onTap: note == null
                    ? () {
                        Navigator.pop(ctx);
                        if (action == 'gallery') {
                          unawaited(_pickAndUploadAttachment(camera: false));
                        } else if (action == 'camera') {
                          unawaited(_pickAndUploadAttachment(camera: true));
                        } else if (action == 'commands') {
                          _showCommandSheet();
                        }
                      }
                    : null,
              ),
          ],
        ),
      ),
    );
  }

  /// 权限模式弹层（直连栈版）：展示引擎权威模式（state.updated 快照回填），
  /// 选择经 store.setMode 直发。词典与 CM._uiToServerMode 同源——UI 四档 ↔
  /// 引擎枚举语义最近对应（非等价：always-ask↔build、accept-edits↔edit），
  /// auto 显示回落 build 档。
  Future<void> _showPermissionPopup() async {
    _inputFocusNode.unfocus();
    const tiers = [
      ('build', '变更前确认', '改文件前先问我。', Icons.pan_tool_outlined),
      ('edit', '自动编辑', '自动编辑文件。', Icons.shield_outlined),
      ('plan', '计划模式', '编辑前先出计划。', Icons.checklist_outlined),
      ('yolo', '完全访问', '减少确认次数。', Icons.lock_open_outlined),
    ];
    final colors = AppColors.of(context);
    final current = _pendingPermissionMode ?? _store.sessionMode;
    final chosen = await _showComposerSheet<String>(
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (mode, label, subtitle, icon) in tiers)
              ListTile(
                dense: true,
                leading: Icon(
                  icon,
                  size: 20,
                  color: mode == current ? colors.accent : colors.textSecondary,
                ),
                title: Text(
                  label,
                  style: TextStyle(
                    color: mode == current ? colors.accent : colors.textPrimary,
                    fontWeight:
                        mode == current ? FontWeight.w600 : FontWeight.normal,
                    fontSize: 14,
                  ),
                ),
                subtitle: Text(
                  subtitle,
                  style: TextStyle(
                    color: colors.textMuted,
                    fontSize: 11,
                  ),
                ),
                trailing: mode == current
                    ? Icon(Icons.check, size: 18, color: colors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, mode),
              ),
          ],
        ),
      ),
    );
    if (chosen == null) return;
    if (_store.activeSessionId == null) {
      setState(() => _pendingPermissionMode = chosen);
      if (!mounted) return;
      final label =
          tiers.firstWhere((t) => t.$1 == chosen, orElse: () => tiers[0]).$2;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('权限模式「$label」将在新会话生效'),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    unawaited(_store.setMode(chosen));
  }

  /// 上下文用量弹层：session/usage 实测数据。对齐官方「上下文容量」面板的
  /// 信息结构（标题行 + 分段占比条 + 彩点明细），但只展示协议实测字段——
  /// 协议无 contextWindow（不显示容量百分比）、无分类拆分（消息/MCP 等官方
  /// 分类来自其云端计费，不可伪造）。缓存命中率 = 缓存读/(输入+缓存读)，实测可导出。
  Future<void> _showUsagePopup() async {
    final sessionId = _store.activeSessionId;
    if (sessionId == null) return;
    _inputFocusNode.unfocus();
    final colors = AppColors.of(context);
    // future 只构造一次（弹层构建期间不会重发请求）
    final usageFuture = ChatRuntimeService.instance.usage(sessionId);
    await _showComposerSheet(
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
        child: FutureBuilder<ChatUsageInfo>(
          future: usageFuture,
          builder: (ctx, snap) {
            Widget body;
            if (snap.connectionState != ConnectionState.done) {
              body = const Center(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            } else if (snap.hasError) {
              body = Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Text(
                  '用量获取失败（协议未提供上下文窗口时无法显示容量百分比）',
                  style: TextStyle(color: colors.textMuted, fontSize: 12.5),
                ),
              );
            } else {
              final u = snap.data!;
              const segColors = [
                Color(0xFF3B82F6), // 输入
                Color(0xFF10B981), // 输出
                Color(0xFFA855F7), // 推理
                Color(0xFFF59E0B), // 缓存读
              ];
              final segments = [
                ('输入', u.inputTokens),
                ('输出', u.outputTokens),
                ('推理', u.reasoningTokens),
                ('缓存读取', u.cacheReadTokens),
              ];
              final sum = segments.fold<int>(0, (n, s) => n + s.$2);
              final cacheHit = (u.inputTokens + u.cacheReadTokens) > 0
                  ? u.cacheReadTokens / (u.inputTokens + u.cacheReadTokens)
                  : null;
              body = Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        'Token 用量',
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        '共 ${_fmtTokens(u.totalTokens)}',
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 12.5,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // 分段占比条（各分量占可归因总量）
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: SizedBox(
                      height: 6,
                      child: sum == 0
                          ? ColoredBox(
                              color: colors.textMuted.withValues(alpha: 0.2),
                            )
                          : Row(
                              children: [
                                for (var i = 0; i < segments.length; i++)
                                  if (segments[i].$2 > 0)
                                    Expanded(
                                      flex: segments[i].$2,
                                      child: ColoredBox(color: segColors[i]),
                                    ),
                              ],
                            ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  for (var i = 0; i < segments.length; i++)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: segColors[i],
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 9),
                          Text(
                            segments[i].$1,
                            style: TextStyle(
                              color: colors.textSecondary,
                              fontSize: 13,
                            ),
                          ),
                          const Spacer(),
                          Text(
                            '${_fmtTokens(segments[i].$2)}'
                            '（${sum == 0 ? 0 : (segments[i].$2 * 100 / sum).toStringAsFixed(1)}%）',
                            style: TextStyle(
                              color: colors.textPrimary,
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  Divider(height: 22, color: colors.border),
                  Row(
                    children: [
                      Text(
                        '平均缓存命中率',
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 13,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        cacheHit == null
                            ? '—'
                            : '${(cacheHit * 100).toStringAsFixed(1)}%',
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Text(
                        '模型请求次数',
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 13,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        '${u.modelRequestCount}',
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text(
                    '引擎协议未提供上下文窗口上限与分类拆分（消息/MCP 等），'
                    '故不显示容量百分比；额度信息仅官方账号通道提供。',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,
                      height: 1.5,
                    ),
                  ),
                ],
              );
            }
            return body;
          },
        ),
      ),
    );
  }

  /// 模型弹层：优先节点目录（x/model/catalog，引擎实测可用 + 导入快照，
  /// 标记默认模型，支持「设为节点默认」）；旧 companion 无该扩展时回退
  /// 引擎 resume 目录（会话内切换）。快照独有模型标注「快照」——可用性
  /// 未经引擎证实，点选走既有 setModel 链路失败会显性提示。
  /// [retryContent] 非空时（模型不可用错误卡片进入），切换成功后自动重发原文。
  Future<void> _showModelPopup({String? retryContent}) async {
    // 新任务态（无会话）也允许选模型：目录与默认模型是节点级（x/model/*），
    // 选择落盘为节点默认、将要创建的会话应用（companion 实测语义）。
    // [retryContent] = 「模型不可用」卡片的重发原文（仅会话内流程）。
    final sessionId = _store.activeSessionId;
    _inputFocusNode.unfocus();
    final colors = AppColors.of(context);
    final catalogFuture = NodeCatalogService.instance.modelCatalog();
    await _showComposerSheet(
      isScrollControlled: true,
      builder: (ctx) => ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(ctx).size.height * 0.65,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
          child: FutureBuilder<NodeModelCatalog>(
            future: catalogFuture,
            builder: (ctx, snap) {
              Widget body;
              if (snap.connectionState != ConnectionState.done) {
                body = const Center(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                );
              } else if (snap.hasError || (snap.data?.models.isEmpty ?? true)) {
                body = Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Text(
                    snap.hasError
                        ? '模型目录获取失败，请检查与大脑节点的连接'
                        : '暂无可用模型：请检查桌面端 ZCode 登录状态与模型配置',
                    style: TextStyle(color: colors.textMuted, fontSize: 12.5),
                  ),
                );
              } else {
                final catalog = snap.data!;
                // 层级分组（对齐桌面选择器）：provider 显示名分组、套餐组置顶；
                // 组头点击折叠/展开，默认展开套餐组与含默认模型的组
                final groups = <String, List<NodeModelEntry>>{};
                for (final m in catalog.models) {
                  (groups[m.groupLabel(m.providerId)] ??= []).add(m);
                }
                final orderedNames = [
                  ...groups.keys
                      .where((n) => groups[n]!.any((m) => m.planGroup)),
                  ...groups.keys
                      .where((n) => !groups[n]!.any((m) => m.planGroup)),
                ];
                final defaultKey = catalog.defaultModel?.key;
                final expandedGroups = <String>{
                  for (final name in orderedNames)
                    if (groups[name]!
                        .any((m) => m.planGroup || m.key == defaultKey))
                      name,
                };
                if (expandedGroups.isEmpty && orderedNames.isNotEmpty) {
                  expandedGroups.add(orderedNames.first);
                }
                body = StatefulBuilder(
                  builder: (sheetCtx, setModalState) => Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            '选择模型',
                            style: TextStyle(
                              color: colors.textPrimary,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const Spacer(),
                          Text(
                            '共 ${catalog.models.length} 个',
                            style: TextStyle(
                              color: colors.textMuted,
                              fontSize: 11.5,
                            ),
                          ),
                        ],
                      ),
                      if (catalog.degraded)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            '引擎目录暂不可用，仅显示导入快照',
                            style: TextStyle(
                              color: colors.warning,
                              fontSize: 11.5,
                            ),
                          ),
                        ),
                      for (final name in orderedNames) ...[
                        InkWell(
                          borderRadius: BorderRadius.circular(8),
                          onTap: () => setModalState(() {
                            if (!expandedGroups.remove(name)) {
                              expandedGroups.add(name);
                            }
                          }),
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(0, 14, 0, 2),
                            child: Row(
                              children: [
                                Text(
                                  name,
                                  style: TextStyle(
                                    color: colors.textPrimary,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  '${groups[name]!.length}',
                                  style: TextStyle(
                                    color: colors.textMuted,
                                    fontSize: 11,
                                  ),
                                ),
                                const Spacer(),
                                Icon(
                                  expandedGroups.contains(name)
                                      ? Icons.keyboard_arrow_up
                                      : Icons.keyboard_arrow_down,
                                  size: 18,
                                  color: colors.textMuted,
                                ),
                              ],
                            ),
                          ),
                        ),
                        if (expandedGroups.contains(name))
                          for (final m in groups[name]!)
                            InkWell(
                              borderRadius: BorderRadius.circular(8),
                              onTap: () async {
                                Navigator.of(sheetCtx).pop();
                                await _applyModelChoice(
                                  sessionId,
                                  SessionModelUse(
                                    providerId: m.providerId,
                                    modelId: m.modelId,
                                  ),
                                  retryContent: retryContent,
                                );
                              },
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                  vertical: 9,
                                ),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        m.displayLabel,
                                        style: TextStyle(
                                          color: colors.textPrimary,
                                          fontSize: 13.5,
                                        ),
                                      ),
                                    ),
                                    if (m.vision)
                                      _modelTag(colors, '视觉', colors.textMuted),
                                    if (catalog.defaultModel != null &&
                                        catalog.defaultModel!.key == m.key) ...[
                                      _modelTag(colors, '默认', colors.accent),
                                      const SizedBox(width: 6),
                                      Icon(
                                        Icons.check,
                                        size: 16,
                                        color: colors.accent,
                                      ),
                                    ] else if (m.source == 'imported')
                                      _modelTag(colors, '快照', colors.warning),
                                  ],
                                ),
                              ),
                            ),
                      ],
                    ],
                  ),
                );
              }
              return body;
            },
          ),
        ),
      ),
    );
  }

  Widget _modelTag(AppColors colors, String label, Color color) => Container(
        margin: const EdgeInsets.only(left: 6),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: color,
            fontSize: 10,
          ),
        ),
      );

  /// 「模型不可用」操作卡片（会话尾部）：自动自愈失败后等待用户介入——
  /// 选可用模型重试（带原文重发）或迁移到全新会话。
  Widget _buildModelBlockedCard(AppColors colors) {
    final content = _store.modelBlockedContent ?? '';
    final reason = _store.modelBlockedReason ?? '';
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.assistantBubble,
        border: Border.all(color: colors.error.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.warning_amber_rounded, size: 16, color: colors.error),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '历史任务使用的模型已不可用',
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            reason,
            style: TextStyle(
              color: colors.textSecondary,
              fontSize: 12,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: () => _showModelPopup(retryContent: content),
                  icon: const Icon(Icons.view_in_ar_outlined, size: 15),
                  label: const Text(
                    '选择可用模型重试',
                    style: TextStyle(fontSize: 12),
                  ),
                  style: FilledButton.styleFrom(
                    backgroundColor: colors.accent,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 8),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _migrateBlockedToNewSession,
                  icon: const Icon(Icons.post_add_outlined, size: 15),
                  label: const Text('新建会话', style: TextStyle(fontSize: 12)),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: colors.textSecondary,
                    padding: const EdgeInsets.symmetric(vertical: 8),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 卡片「新建会话」：把被阻塞原文迁移到全新会话发出（一步迁移）。
  /// 旧会话坏在模型配置上，/clear 也走 session/send 同样被拒（实测死循环），
  /// 必须经 session/create 建新会话。
  Future<void> _migrateBlockedToNewSession() async {
    final content = _store.modelBlockedContent ?? '';
    _store.clearModelBlocked();
    await _store.newSession();
    if (_store.activeSessionId == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('新建会话失败，请检查与大脑节点的连接'),
            duration: Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
      return;
    }
    unawaited(_store.sendMessage(content));
  }

  /// 应用模型选择：有会话 → 会话内 setModel（非默认模型时顺带设节点默认）；
  /// 无会话（新任务态）→ 仅落盘节点默认（新会话应用，companion 实测语义）。
  /// [retryContent] = 「模型不可用」卡片的重发原文：切换成功后自动重发，
  /// 并清除阻塞卡。
  Future<void> _applyModelChoice(
    String? sessionId,
    SessionModelUse m, {
    String? retryContent,
  }) async {
    try {
      if (sessionId != null) {
        final changed = await _store.setModel(m.providerId, m.modelId);
        if (!changed) throw StateError(_store.error ?? '切换模型失败');
        _store.clearModelBlocked();
      }
      var configuredDefault = false;
      if (sessionId == null) {
        // 新任务态：节点默认是新会话生效的唯一途径，必设
        try {
          await NodeCatalogService.instance.configureDefault(
            providerId: m.providerId,
            modelId: m.modelId,
          );
          configuredDefault = true;
        } catch (e) {
          debugPrint('[model] 设为节点默认失败: $e');
        }
      }
      if (mounted) {
        final msg = sessionId == null
            ? (configuredDefault
                ? '已设为节点默认 ${m.modelId}，新会话生效'
                : '设默认失败，请检查与大脑节点的连接')
            : '已切换到 ${m.modelId}';
        if (sessionId != null || configuredDefault) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(msg),
              duration: const Duration(seconds: 2),
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
      }
      if (sessionId != null &&
          retryContent != null &&
          retryContent.isNotEmpty) {
        await _store.sendMessage(retryContent);
      }
    } catch (e) {
      if (mounted) _runtimeErrorSnack(e);
    }
  }

  /// 思考档位弹层：低/高/最高（对齐官方三档）。会话内 = 引擎
  /// session/setThoughtLevel；新任务态 = 暂存待应用档位，会话创建后自动补发
  /// （引擎无节点级默认档位，只能会话级设置——已按实测协议确认）。
  Future<void> _showEffortPopup() async {
    final sessionId = _store.activeSessionId;
    _inputFocusNode.unfocus();
    final colors = AppColors.of(context);
    const levels = [
      ('低', 'low', '响应更快，适合简单修改与快速问答'),
      ('高', 'high', '平衡速度与推理深度，日常开发推荐'),
      ('最高', 'max', '最深入的推理，复杂任务适用、耗时更长'),
    ];
    final current = _store.thoughtLevel;
    final chosen = await _showComposerSheet<String>(
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (label, value, subtitle) in levels)
              ListTile(
                dense: true,
                title: Text(
                  label,
                  style: TextStyle(
                    color:
                        current == value ? colors.accent : colors.textPrimary,
                    fontWeight:
                        current == value ? FontWeight.w600 : FontWeight.normal,
                    fontSize: 14,
                  ),
                ),
                subtitle: Text(
                  subtitle,
                  style: TextStyle(color: colors.textMuted, fontSize: 11.5),
                ),
                trailing: current == value
                    ? Icon(Icons.check, size: 18, color: colors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, value),
              ),
          ],
        ),
      ),
    );
    if (chosen == null) return;
    if (sessionId == null) {
      // 新任务态暂存：直接落到 store 状态，弹层勾选立即回显；
      // 会话创建后由 _startNewConversation 补发引擎
      setState(() => _pendingThoughtLevel = chosen);
      _store.thoughtLevel = chosen;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('思考档位将在新会话生效'),
            duration: Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
      return;
    }
    // 统一走直连栈 store：乐观回显（thoughtLevel）+ 引擎生效一体完成。
    // 旧路径 ChatRuntimeService 只写引擎不回 store，UI 勾选永不更新
    // （2026-09-17 迁移审计 split-brain #2）。失败时 store._error 已带原因。
    final ok = await _store.setThoughtLevel(chosen);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_store.error ?? '设置思考档位失败'),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  void _runtimeErrorSnack(Object e) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('操作失败: $e'),
        duration: const Duration(seconds: 3),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  String _fmtTokens(int n) {
    if (n >= 10000) return '${(n / 10000).toStringAsFixed(1)} 万';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
    return '$n';
  }

  /// git 分支 chip：显示当前工作区分支；点按弹分支选择器（companion x/* 扩展）
  Widget _buildBranchChip(AppColors colors) {
    return ValueListenableBuilder<String?>(
      valueListenable: GitService.instance.currentBranch,
      builder: (context, branch, _) {
        final wsPath = _store.selectedWorkspacePath;
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

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.attachment, required this.onRemove});

  final AttachmentUpload attachment;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Container(
      constraints: const BoxConstraints(maxWidth: 200),
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        border: Border.all(
          color: attachment.error != null ? colors.error : colors.border,
        ),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.insert_drive_file_outlined,
                size: 13,
                color: colors.textMuted,
              ),
              const SizedBox(width: 5),
              Flexible(
                child: Text(
                  attachment.name,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 12,
                  ),
                ),
              ),
              IconButton(
                onPressed: onRemove,
                constraints:
                    const BoxConstraints.tightFor(width: 24, height: 24),
                padding: EdgeInsets.zero,
                tooltip: '移除附件',
                icon: Icon(Icons.close, size: 14, color: colors.textMuted),
              ),
            ],
          ),
          if (attachment.error != null)
            Text(
              attachment.error!,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.error, fontSize: 10.5),
            )
          else if (attachment.done)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.check_circle, size: 11, color: colors.success),
                const SizedBox(width: 3),
                Text(
                  '已上传',
                  style: TextStyle(color: colors.textMuted, fontSize: 10.5),
                ),
              ],
            )
          else
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 60,
                  child: LinearProgressIndicator(
                    value: attachment.progress,
                    minHeight: 3,
                    color: colors.accent,
                    backgroundColor: colors.border,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  '${(attachment.progress * 100).toStringAsFixed(0)}%',
                  style: TextStyle(color: colors.textMuted, fontSize: 10.5),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// 排队中的待发消息（见 _sendQueue）
/// 回合块条目：一个回合内的有序消息切片（工具 + 助手文本，不含用户消息）
class _TurnEntry {
  const _TurnEntry(this.messages);
  final List<ChatMessage> messages;
}

class _QueuedSend {
  final String id;
  String text;
  _QueuedSend(this.text)
      : id = DateTime.now().microsecondsSinceEpoch.toString();
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
                    fontFamily: 'monospace',
                  ),
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
                      Text(
                        'Copy',
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 11,
                        ),
                      ),
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
  const _SkeletonBox({
    required this.width,
    required this.height,
    this.borderRadius,
  });

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

// ── Slash command model ───────────────────────────────────────────────

class _SlashCommand {
  final String command;
  final String description;
  const _SlashCommand(this.command, this.description);
}

/// 文件下载任务 chip：awaitingChoice 点击重开确认面板；pulling 显示进度
/// 可点按取消；previewing 提供「保存 / 放弃」（预览失败时说明原因并保留
/// 保存路径——预览不可用不代表文件不可用）。
class _FileDownloadChip extends StatelessWidget {
  const _FileDownloadChip({
    required this.task,
    required this.onChanged,
    required this.onShowSheet,
  });

  final FileDownloadTask task;
  final void Function(FileDownloadTask) onChanged;
  final VoidCallback onShowSheet;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.fromLTRB(10, 6, 6, 6),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.download_outlined, size: 13, color: colors.textMuted),
              const SizedBox(width: 5),
              Flexible(
                child: InkWell(
                  onTap: task.phase == FileDownloadPhase.awaitingChoice
                      ? onShowSheet
                      : null,
                  child: Text(
                    task.name,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: colors.textPrimary, fontSize: 12),
                  ),
                ),
              ),
              if (task.phase == FileDownloadPhase.pulling) ...[
                const SizedBox(width: 6),
                _ChipAction(
                  label: '取消',
                  onTap: () => FileDownloadService.cancel(
                    task,
                    onChanged: onChanged,
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 4),
          switch (task.phase) {
            FileDownloadPhase.awaitingChoice => Text(
                '点击选择操作',
                style: TextStyle(color: colors.textMuted, fontSize: 10.5),
              ),
            FileDownloadPhase.pulling => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 60,
                    child: LinearProgressIndicator(
                      value: task.progress,
                      minHeight: 3,
                      color: colors.accent,
                      backgroundColor: colors.border,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '${task.received == 0 ? '' : '${task.received ~/ 1024}KB / '}${task.size ~/ 1024}KB',
                    style: TextStyle(color: colors.textMuted, fontSize: 10.5),
                  ),
                ],
              ),
            FileDownloadPhase.previewing => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    task.notice ?? '预览中，可保存或放弃',
                    style: TextStyle(color: colors.textMuted, fontSize: 10.5),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      _ChipAction(
                        label: '保存',
                        emphasized: true,
                        onTap: () => FileDownloadService.saveAfterPreview(
                          task,
                          onChanged: onChanged,
                        ),
                      ),
                      const SizedBox(width: 6),
                      _ChipAction(
                        label: '放弃',
                        onTap: () => FileDownloadService.discard(
                          task,
                          onChanged: onChanged,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            _ => const SizedBox.shrink(),
          },
        ],
      ),
    );
  }
}

class _ChipAction extends StatelessWidget {
  const _ChipAction({
    required this.label,
    required this.onTap,
    this.emphasized = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool emphasized;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          border: Border.all(
            color: emphasized ? colors.accent : colors.border,
          ),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: emphasized ? colors.accent : colors.textMuted,
            fontSize: 11,
            fontWeight: emphasized ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
      ),
    );
  }
}
