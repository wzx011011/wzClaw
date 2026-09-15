// ============================================================
// remote_control_page — 大脑网络远程控制页（v3 P1）
//
// 复用从 U6/U7 恢复的旧协议栈（ConnectionManager / ChatStore /
// desktop_picker / connection_status_bar / permission_bar），
// 经 NAS relay（token 房间）遥控任意大脑节点（适配器 + app-server）。
//
// 职责：连接管理（relay URL + token）→ 桌面(大脑)选择 → 会话列表 →
// 流式聊天 + 停止 + 权限条。功能之外的旧能力（任务/文件/工作区）
// 按计划 D5 降级不在此页暴露。
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../models/ws_message.dart';
import '../services/connection_manager.dart';
import '../services/secure_settings.dart';
import '../widgets/connection_status_bar.dart';

/// 大脑网络远程控制页
class RemoteControlPage extends StatefulWidget {
  const RemoteControlPage({super.key});

  @override
  State<RemoteControlPage> createState() => _RemoteControlPageState();
}

class _RemoteControlPageState extends State<RemoteControlPage> {
  static const _kRelayUrlKey = 'brain_relay_url';

  final _urlController = TextEditingController();
  final _tokenController = TextEditingController();
  final _inputController = TextEditingController();
  WsConnectionState _state = WsConnectionState.disconnected;
  List<dynamic> _sessions = [];
  String? _activeSessionId;
  final List<Map<String, dynamic>> _messages = [];
  bool _loading = false;

  ConnectionManager get _manager => ConnectionManager.instance;

  @override
  void initState() {
    super.initState();
    _restoreConfig();
    _manager.stateStream.listen((s) {
      if (!mounted) return;
      setState(() => _state = s);
      if (s == WsConnectionState.connected) {
        _sendSessionList();
      }
    });
    _manager.messageStream.listen(_onMessage);
  }

  Future<void> _restoreConfig() async {
    final prefs = await SharedPreferences.getInstance();
    _urlController.text = prefs.getString(_kRelayUrlKey) ?? 'wss://5945.top/relay';
    _tokenController.text = await SecureSettings.getAuthToken();
    if (mounted) setState(() {});
  }

  Future<void> _saveConfig() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kRelayUrlKey, _urlController.text.trim());
    await SecureSettings.setAuthToken(_tokenController.text.trim());
  }

  void _connect() {
    final url = _urlController.text.trim();
    final token = _tokenController.text.trim();
    if (!url.startsWith('ws') || token.isEmpty) {
      _toast('请填写 relay 地址与 token');
      return;
    }
    _saveConfig();
    final joined = url.contains('?') ? '$url&role=mobile' : '$url?role=mobile';
    _manager.connect(joined);
  }

  void _sendSessionList() {
    final requestId = 'list-${DateTime.now().millisecondsSinceEpoch}';
    _manager.send(WsMessage(
      event: 'session:list:request',
      data: {'requestId': requestId},
    ),);
  }

  void _onMessage(WsMessage msg) {
    final data = msg.data;
    if (data is! Map) return;
    switch (msg.event) {
      case 'session:list:response':
        if (!mounted) return;
        setState(() {
          _sessions = (data['sessions'] as List? ?? [])
              .whereType<Map>()
              .map((s) => Map<String, dynamic>.from(s))
              .toList();
        });
        return;
      case 'session:load:response':
        if (!mounted) return;
        final messages = (data['messages'] as List? ?? [])
            .whereType<Map>()
            .map((m) => Map<String, dynamic>.from(m))
            .toList();
        setState(() {
          _activeSessionId = data['sessionId']?.toString();
          _messages
            ..clear()
            ..addAll(messages);
          _loading = false;
        });
        return;
      case 'session:create:response':
        final sessionId = data['sessionId']?.toString();
        if (sessionId != null && sessionId.isNotEmpty) _openSession(sessionId);
        return;
      case 'stream:agent:turn_end':
      case 'stream:agent:done':
        // 回合结束：拉一次权威消息
        final sessionId = data['sessionId']?.toString() ?? _activeSessionId;
        if (sessionId != null) _openSession(sessionId, showLoading: false);
        return;
      case 'stream:agent:text':
      case 'stream:agent:thinking':
      case 'stream:agent:tool_call':
      case 'stream:agent:tool_result':
      case 'stream:agent:error':
        // 流式增量在此简化渲染：追加到尾部消息
        if (!mounted) return;
        setState(() {
          final text = (data['content'] ?? data['output'] ?? data['error'] ?? '')
              .toString();
          if (text.isEmpty) return;
          if (_messages.isEmpty ||
              _messages.last['role'] != 'assistant') {
            _messages.add({
              'role': 'assistant',
              'content': text,
              'created_at': DateTime.now().millisecondsSinceEpoch,
            });
          } else {
            _messages.last['content'] =
                '${_messages.last['content']}$text';
          }
        });
        return;
    }
  }

  Future<void> _openSession(String sessionId, {bool showLoading = true}) async {
    final requestId = 'load-${DateTime.now().millisecondsSinceEpoch}';
    if (showLoading && mounted) setState(() => _loading = true);
    _manager.send(WsMessage(
      event: 'session:load:request',
      data: {'requestId': requestId, 'sessionId': sessionId},
    ),);
  }

  Future<void> _createSession() async {
    _manager.send(WsMessage(
      event: 'session:create:request',
      data: {'requestId': 'create-${DateTime.now().millisecondsSinceEpoch}'},
    ),);
  }

  void _sendChat(String text) {
    if (text.trim().isEmpty) return;
    _inputController.clear();
    setState(() {
      _messages.add({
        'role': 'user',
        'content': text,
        'created_at': DateTime.now().millisecondsSinceEpoch,
      });
    });
    _manager.send(WsMessage(
      event: 'command:send',
      data: {
        'content': text,
        'messageId': 'm-${DateTime.now().millisecondsSinceEpoch}',
        if (_activeSessionId != null) 'sessionId': _activeSessionId,
      },
    ),);
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final connected = _state == WsConnectionState.connected;
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        title: Text('大脑网络 · 远程控制',
            style: TextStyle(color: colors.textPrimary, fontSize: 16),),
        backgroundColor: colors.bgSecondary,
        actions: [
          IconButton(
              tooltip: '新建任务',
              icon: const Icon(Icons.add_comment_outlined),
              onPressed: connected ? _createSession : null,),
        ],
      ),
      body: Column(
        children: [
          _buildConnectCard(colors, connected),
          ConnectionStatusBar(
            state: _mapState(_state),
            workspaceName: connected ? '大脑节点已连接' : null,
          ),
          if (connected) _buildSessionStrip(colors),
          Expanded(child: _buildMessageList(colors, connected)),
          if (connected) _buildInputBar(colors, connected),
        ],
      ),
    );
  }

  Widget _buildConnectCard(AppColors colors, bool connected) {
    if (connected) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          TextField(
            controller: _urlController,
            style: TextStyle(fontSize: 13, color: colors.textPrimary),
            decoration: InputDecoration(
              labelText: 'NAS relay 地址',
              hintText: 'wss://5945.top/relay',
              labelStyle: TextStyle(fontSize: 12, color: colors.textMuted),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _tokenController,
            obscureText: true,
            style: TextStyle(fontSize: 13, color: colors.textPrimary),
            decoration: InputDecoration(
              labelText: '房间 token',
              labelStyle: TextStyle(fontSize: 12, color: colors.textMuted),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: _connect,
              icon: const Icon(Icons.link, size: 18),
              label: const Text('接入大脑网络'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSessionStrip(AppColors colors) {
    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        children: [
          for (final s in _sessions)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(
                  '${s['title'] ?? s['id']}',
                  style: const TextStyle(fontSize: 12),
                ),
                selected: _activeSessionId == s['id'],
                onSelected: (_) => _openSession(s['id'] as String),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildMessageList(AppColors colors, bool connected) {
    if (!connected) {
      return Center(
        child: Text('未连接大脑网络',
            style: TextStyle(color: colors.textMuted, fontSize: 13),),
      );
    }
    if (_loading) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_messages.isEmpty) {
      return Center(
        child: Text('选择会话或新建任务开始',
            style: TextStyle(color: colors.textMuted, fontSize: 13),),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _messages.length,
      itemBuilder: (context, index) {
        final m = _messages[index];
        final isUser = m['role'] == 'user';
        return Align(
          alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            constraints: const BoxConstraints(maxWidth: 300),
            decoration: BoxDecoration(
              color: isUser ? colors.accent.withValues(alpha: 0.18) : colors.bgSecondary,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: colors.border, width: 0.5),
            ),
            child: Text(
              '${m['content'] ?? ''}',
              style: TextStyle(fontSize: 13, color: colors.textPrimary),
            ),
          ),
        );
      },
    );
  }

  Widget _buildInputBar(AppColors colors, bool connected) {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 10),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        border: Border(top: BorderSide(color: colors.border, width: 0.5)),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _inputController,
              enabled: connected,
              onSubmitted: _sendChat,
              style: TextStyle(fontSize: 13, color: colors.textPrimary),
              decoration: InputDecoration(
                hintText: _activeSessionId == null ? '先选择或新建会话' : '发送指令…',
                hintStyle: TextStyle(color: colors.textMuted, fontSize: 13),
                filled: true,
                fillColor: colors.bgInput,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              ),
            ),
          ),
          IconButton(
            icon: Icon(Icons.send, color: colors.accent, size: 22),
            onPressed: connected ? () => _sendChat(_inputController.text) : null,
          ),
        ],
      ),
    );
  }

  WsConnectionState _mapState(WsConnectionState s) => s;
}
