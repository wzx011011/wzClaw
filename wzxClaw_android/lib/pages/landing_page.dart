// ============================================================
// landing_page — ZCode 配对门（旧桌面连接流程退役）
//
// 旧页基于旧 relay 协议栈（ConnectionManager + 桌面列表 +
// 工作区选择），本版换绑 lib/zcode/zcode_chat_store.dart：
// 页面只承担「配对 → 等待连接 → 进聊天」的门职责。
//
// 四态视图（AnimatedBuilder(animation: store) 驱动重建）：
//   ① 未配对（pairing == null）：扫码大按钮 / 粘贴配对链接 + companion 命令提示
//   ② connecting / waiting：脉冲圆点 + 状态文案（沿用旧页状态 B 视觉）
//   ③ idle（连接异常/掉线）：重连按钮 → store.reconnect()
//   ④ matched：自动导航进 /chat（_didNavigate 布尔防重复）
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config/app_colors.dart';
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_pair_scanner.dart';
import '../zcode/zcode_pairing.dart';

class LandingPage extends StatefulWidget {
  const LandingPage({super.key, this.store});

  /// 测试注入替身；null 时使用全局单例（app 作用域）
  final ZcodeChatStore? store;

  @override
  State<LandingPage> createState() => _LandingPageState();
}

class _LandingPageState extends State<LandingPage>
    with SingleTickerProviderStateMixin {
  // ── store：注入优先，否则全局单例 ─────────────────────────────────
  late final ZcodeChatStore _store = widget.store ?? ZcodeChatStore.instance;

  final _pairUrlController = TextEditingController(); // ① 态粘贴配对链接
  bool _didNavigate = false; // ④ matched 自动导航防重复
  String? _inlineError; // ① 态粘贴配对的行内错误提示

  // 呼吸动画控制器（② 态脉冲圆点，沿用旧页状态 B）
  late final AnimationController _pulseController;
  late final Animation<double> _pulseAnim;

  @override
  void initState() {
    super.initState();

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..repeat(reverse: true);

    _pulseAnim = Tween<double>(begin: 14, end: 22).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    _store.addListener(_onStoreChanged);
    // 注入的 store 可能已处于 matched（测试/恢复场景），补一次检查
    if (_store.connState == ZcodeConnState.matched) {
      _scheduleNavigateToChat();
    }
  }

  @override
  void dispose() {
    _store.removeListener(_onStoreChanged);
    _pulseController.dispose();
    _pairUrlController.dispose();
    _didNavigate = false; // 退出页面时复位导航标记
    super.dispose();
  }

  /// store 变化时的副作用（视图重建由 AnimatedBuilder 负责）：
  /// matched → 安排自动导航；离开 matched → 复位导航标记，
  /// 掉线重新 matched 后仍可再次自动进入
  void _onStoreChanged() {
    if (!mounted) return;
    if (_store.connState == ZcodeConnState.matched) {
      _scheduleNavigateToChat();
    } else {
      _didNavigate = false;
    }
  }

  /// 自动导航进聊天（post-frame 执行，避免在通知回调里操作导航栈）。
  /// 若本页已被其他路由盖住（用户已在聊天页），跳过推送防页面堆叠。
  void _scheduleNavigateToChat() {
    if (_didNavigate || !mounted) return;
    _didNavigate = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_didNavigate) return;
      final route = ModalRoute.of(context);
      if (route != null && !route.isCurrent) return; // 被盖住：不重复推入
      Navigator.pushNamed(context, '/chat');
    });
  }

  // ── 配对动作 ──────────────────────────────────────────────────────

  /// 解析并配对；本地可判定的失败走行内提示，store 拒绝时展示 store.error
  void _pair(String rawUrl) {
    final url = rawUrl.trim();
    if (url.isEmpty) {
      setState(() => _inlineError = '请输入配对链接');
      return;
    }
    if (parsePairingUrl(url) == null) {
      setState(
        () => _inlineError = '配对链接无效，应为 https://…/pair?sid=…&hash=… 格式',
      );
      return;
    }
    setState(() => _inlineError = null);
    _store.pair(url); // 失败时 store.error 非空，由视图展示
  }

  /// 解除配对（二次确认；等待态误触也不至于直接丢配对）
  Future<void> _confirmUnpair() async {
    final colors = AppColors.of(context);
    final confirmed = await showDialog<bool>(
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
    );
    if (confirmed == true) _store.unpair();
  }

  /// 粘贴框配对
  void _pairFromInput() => _pair(_pairUrlController.text);

  /// 扫码配对：命中后 pop 返回二维码原文
  Future<void> _startScanPairing() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const ZcodePairScannerPage()),
    );
    if (result == null || result.isEmpty || !mounted) return;
    _pair(result);
  }

  /// 复制文本到剪贴板（companion 启动命令等）
  void _copyText(AppColors colors, String text) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text('已复制', style: TextStyle(color: colors.textPrimary)),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
  }

  // ── Build ──────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text('wzxClaw',
            style: TextStyle(color: colors.textPrimary, fontSize: 18),),
        actions: [
          IconButton(
            icon: Icon(Icons.settings_outlined, color: colors.textSecondary),
            tooltip: '设置',
            onPressed: () => Navigator.pushNamed(context, '/settings'),
          ),
        ],
      ),
      body: SafeArea(
        // store 驱动重建；AnimatedSwitcher 保留旧页 350ms 视图切换
        child: AnimatedBuilder(
          animation: _store,
          builder: (context, _) => AnimatedSwitcher(
            duration: const Duration(milliseconds: 350),
            switchInCurve: Curves.easeInOut,
            switchOutCurve: Curves.easeInOut,
            child: _buildGateView(colors),
          ),
        ),
      ),
    );
  }

  // ── 四态视图分发 ────────────────────────────────────────────────────

  Widget _buildGateView(AppColors colors) {
    // ① 未配对：配对门
    if (_store.pairing == null) {
      return _buildPairingGate(colors);
    }
    switch (_store.connState) {
      case ZcodeConnState.connecting:
      case ZcodeConnState.waiting:
        return _buildConnectingState(colors); // ② 连接中/等待 companion
      case ZcodeConnState.matched:
        return _buildMatchedState(colors); // ④ 已连接：自动进聊天
      case ZcodeConnState.idle:
        return _buildDisconnectedState(colors); // ③ 异常/掉线：重连
    }
  }

  // ── ① 未配对：扫码 / 粘贴配对 ──────────────────────────────────────

  Widget _buildPairingGate(AppColors colors) {
    const companionCmd =
        'node relay/zcode/companion.js --relay wss://zcode.5945.top/ws';
    final errorText = _inlineError ?? _store.error;

    return ListView(
      key: const ValueKey('gate_unpaired'),
      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
      children: [
        const SizedBox(height: 16),
        Icon(
          Icons.terminal,
          size: 72,
          color: colors.accent.withValues(alpha: 0.9),
        ),
        const SizedBox(height: 16),
        Text('wzxClaw',
            textAlign: TextAlign.center,
            style: TextStyle(
                color: colors.textPrimary,
                fontSize: 28,
                fontWeight: FontWeight.bold,),),
        const SizedBox(height: 6),
        Text('配对桌面端 ZCode 后远程对话',
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.textSecondary, fontSize: 14),),
        const SizedBox(height: 32),
        SizedBox(
          width: double.infinity,
          height: 52,
          child: ElevatedButton.icon(
            onPressed: _startScanPairing,
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('扫码配对'),
            style: ElevatedButton.styleFrom(
              backgroundColor: colors.accent,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),),
            ),
          ),
        ),
        const SizedBox(height: 16),
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
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  isDense: true,
                ),
                onSubmitted: (_) => _pairFromInput(),
                onChanged: (_) {
                  if (_inlineError != null) {
                    setState(() => _inlineError = null);
                  }
                },
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
        // 配对失败提示（行内优先，其次 store 错误横幅文案）
        if (errorText != null) ...[
          const SizedBox(height: 12),
          Text(errorText, style: TextStyle(color: colors.error, fontSize: 12)),
        ],
        const SizedBox(height: 32),
        Text(
          '1. 在桌面端运行 companion 并显示配对二维码：',
          style: TextStyle(color: colors.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 8),
        // companion 启动命令（点击复制）
        GestureDetector(
          onTap: () => _copyText(colors, companionCmd),
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
        const SizedBox(height: 24),
      ],
    );
  }

  // ── ② 连接中 / 等待 companion（沿用旧页状态 B 视觉） ────────────────

  Widget _buildConnectingState(AppColors colors) {
    final waiting = _store.connState == ZcodeConnState.waiting;
    return Center(
      key: const ValueKey('gate_connecting'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedBuilder(
            animation: _pulseAnim,
            builder: (context, _) {
              final size = _pulseAnim.value;
              return Container(
                width: size,
                height: size,
                decoration: BoxDecoration(
                  color: waiting ? colors.warning : colors.accent,
                  shape: BoxShape.circle,
                ),
              );
            },
          ),
          const SizedBox(height: 24),
          Text(waiting ? '等待桌面端上线' : '正在连接 ZCode',
              style: TextStyle(color: colors.textPrimary, fontSize: 16),),
          const SizedBox(height: 6),
          Text(
            waiting ? '请确认桌面端 companion 已运行' : '正在与中继服务器握手',
            style: TextStyle(color: colors.textSecondary, fontSize: 13),
          ),
          if (_store.error != null) ...[
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(_store.error!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: colors.error, fontSize: 12),),
            ),
          ],
          const SizedBox(height: 32),
          TextButton(
            onPressed: _confirmUnpair,
            child: Text('取消配对', style: TextStyle(color: colors.textSecondary)),
          ),
        ],
      ),
    );
  }

  // ── ③ 连接异常 / 掉线 ───────────────────────────────────────────────

  Widget _buildDisconnectedState(AppColors colors) {
    return Center(
      key: const ValueKey('gate_disconnected'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.link_off, size: 56, color: colors.textMuted),
          const SizedBox(height: 16),
          Text('连接已断开',
              style: TextStyle(color: colors.textPrimary, fontSize: 16),),
          const SizedBox(height: 6),
          if (_store.error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(_store.error!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: colors.error, fontSize: 12),),
            ),
          const SizedBox(height: 24),
          SizedBox(
            width: 160,
            height: 44,
            child: ElevatedButton.icon(
              onPressed: () => _store.reconnect(),
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('重连'),
              style: ElevatedButton.styleFrom(
                backgroundColor: colors.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),),
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: _confirmUnpair,
            child: Text('解除配对', style: TextStyle(color: colors.textSecondary)),
          ),
        ],
      ),
    );
  }

  // ── ④ 已连接：自动导航进聊天（本视图仅为过渡帧/手动返回落点） ─────────

  Widget _buildMatchedState(AppColors colors) {
    return Center(
      key: const ValueKey('gate_matched'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              color: colors.success,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(height: 24),
          Text('已连接桌面 ZCode',
              style: TextStyle(color: colors.textPrimary, fontSize: 16),),
          const SizedBox(height: 24),
          TextButton(
            // 自动导航被跳过（如从聊天页返回）时的手动入口
            onPressed: () {
              _didNavigate = false;
              _scheduleNavigateToChat();
            },
            child: Text('进入聊天', style: TextStyle(color: colors.accent)),
          ),
        ],
      ),
    );
  }
}
