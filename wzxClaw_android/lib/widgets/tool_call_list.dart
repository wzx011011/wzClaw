import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config/app_colors.dart';
import '../models/chat_message.dart';

/// Groups consecutive tool call messages into a compact list with a left
/// vertical connecting line, matching the Claude Code Agent UI style.
///
/// When there are 5+ tools, adds a collapsible workflow header showing
/// progress summary. Last 3 tools always remain visible.
class ToolCallGroup extends StatefulWidget {
  final List<ChatMessage> tools;

  const ToolCallGroup({super.key, required this.tools});

  @override
  State<ToolCallGroup> createState() => _ToolCallGroupState();
}

class _ToolCallGroupState extends State<ToolCallGroup> {
  late bool _collapsed;

  @override
  void initState() {
    super.initState();
    // Auto-collapse on init if 5+ tools and all already done (loaded from history)
    if (widget.tools.length >= 5 &&
        widget.tools.every((t) => t.toolStatus != ToolCallStatus.running)) {
      _collapsed = true;
    } else {
      _collapsed = false;
    }
  }

  @override
  void didUpdateWidget(ToolCallGroup oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Auto-collapse when all tools are done and there are many
    if (widget.tools.length >= 5) {
      final allDone =
          widget.tools.every((t) => t.toolStatus != ToolCallStatus.running);
      final hadRunning =
          oldWidget.tools.any((t) => t.toolStatus == ToolCallStatus.running);
      if (allDone && hadRunning) {
        setState(() => _collapsed = true);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.tools.isEmpty) return const SizedBox.shrink();

    final colors = AppColors.of(context);
    final showHeader = widget.tools.length >= 5;
    final doneCount = widget.tools
        .where((t) => t.toolStatus != ToolCallStatus.running)
        .length;
    final totalCount = widget.tools.length;
    final allDone = doneCount == totalCount;
    final hasError =
        widget.tools.any((t) => t.toolStatus == ToolCallStatus.error);

    // Determine which tools to show
    List<ChatMessage> visibleTools;
    if (showHeader && _collapsed) {
      visibleTools = []; // Fully hidden when collapsed
    } else {
      visibleTools = widget.tools;
    }

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Workflow header for 5+ tools
          if (showHeader)
            _WorkflowHeader(
              collapsed: _collapsed,
              doneCount: doneCount,
              totalCount: totalCount,
              allDone: allDone,
              hasError: hasError,
              tools: widget.tools,
              onToggle: () => setState(() => _collapsed = !_collapsed),
            ),
          // Tool entries with left vertical line (hidden when collapsed)
          if (visibleTools.isNotEmpty)
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Left vertical line
                  Container(
                    width: 2,
                    margin: const EdgeInsets.only(left: 14, top: 2, bottom: 2),
                    decoration: BoxDecoration(
                      color: allDone
                          ? colors.accent.withValues(alpha: 0.2)
                          : colors.accent.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(1),
                    ),
                  ),
                  const SizedBox(width: 10),
                  // Tool entries
                  Expanded(
                    child: Column(
                      children: visibleTools
                          .map((tool) => _ToolCallEntry(message: tool))
                          .toList(),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Workflow header showing progress summary for groups of 5+ tools.
class _WorkflowHeader extends StatelessWidget {
  final bool collapsed;
  final int doneCount;
  final int totalCount;
  final bool allDone;
  final bool hasError;
  final List<ChatMessage> tools;
  final VoidCallback onToggle;

  const _WorkflowHeader({
    required this.collapsed,
    required this.doneCount,
    required this.totalCount,
    required this.allDone,
    required this.hasError,
    required this.tools,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        margin: const EdgeInsets.only(bottom: 4),
        decoration: BoxDecoration(
          color: colors.bgTertiary,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          children: [
            Icon(
              collapsed ? Icons.chevron_right : Icons.expand_more,
              size: 16,
              color: colors.textSecondary,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: allDone
                  ? Text(
                      _buildSummaryText(),
                      style: TextStyle(
                        color: colors.textSecondary,
                        fontSize: 11,
                      ),
                      overflow: TextOverflow.ellipsis,
                    )
                  : _ShimmerText(
                      text: 'Working... ($doneCount/$totalCount)',
                    ),
            ),
            const SizedBox(width: 6),
            if (hasError)
              Icon(Icons.warning_amber_rounded,
                  size: 14, color: colors.toolError,)
            else if (allDone)
              Icon(Icons.check_circle_outline,
                  size: 14, color: colors.toolCompleted,)
            else
              SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 1.5,
                  color: colors.accent,
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _buildSummaryText() {
    // Count tools by name: "Read (3), Bash (2), Edit (1)"
    final counts = <String, int>{};
    for (final t in tools) {
      final name = t.toolName ?? 'Tool';
      counts[name] = (counts[name] ?? 0) + 1;
    }
    final parts = counts.entries.map((e) => '${e.key} (${e.value})').toList();
    return parts.join(', ');
  }
}

/// Shimmer text effect for "Working..." label.
class _ShimmerText extends StatefulWidget {
  final String text;
  const _ShimmerText({required this.text});

  @override
  State<_ShimmerText> createState() => _ShimmerTextState();
}

class _ShimmerTextState extends State<_ShimmerText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return AnimatedBuilder(
      animation: _controller,
      builder: (_, __) {
        final dx = _controller.value * 3 - 1;
        return ShaderMask(
          shaderCallback: (bounds) {
            return LinearGradient(
              begin: Alignment(dx - 0.3, 0),
              end: Alignment(dx + 0.3, 0),
              colors: [
                colors.textMuted,
                colors.accent,
                colors.textMuted,
              ],
              stops: const [0.0, 0.5, 1.0],
            ).createShader(bounds);
          },
          blendMode: BlendMode.srcIn,
          child: Text(
            widget.text,
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: Colors.white,
            ),
          ),
        );
      },
    );
  }
}

/// A single compact tool call row with auto-expand/collapse and timer.
class _ToolCallEntry extends StatefulWidget {
  final ChatMessage message;

  const _ToolCallEntry({required this.message});

  @override
  State<_ToolCallEntry> createState() => _ToolCallEntryState();
}

class _ToolCallEntryState extends State<_ToolCallEntry>
    with SingleTickerProviderStateMixin {
  bool _expanded = false;
  late AnimationController _spinController;
  Timer? _timer;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _spinController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );
    final status = widget.message.toolStatus ?? ToolCallStatus.running;
    final age = DateTime.now().difference(widget.message.createdAt);
    final isStale = age.inSeconds > 30; // Older than 30s = loaded from history
    if (status == ToolCallStatus.running && !isStale) {
      _spinController.repeat();
      _expanded = true; // Auto-expand running tools
      _startTimer();
    } else if (status == ToolCallStatus.error) {
      _expanded = true; // Auto-expand errors
    }
  }

  @override
  void didUpdateWidget(_ToolCallEntry oldWidget) {
    super.didUpdateWidget(oldWidget);
    final newStatus = widget.message.toolStatus ?? ToolCallStatus.running;
    final oldStatus = oldWidget.message.toolStatus ?? ToolCallStatus.running;

    if (newStatus == ToolCallStatus.running) {
      final age = DateTime.now().difference(widget.message.createdAt);
      if (age.inSeconds <= 30) {
        if (!_spinController.isAnimating) _spinController.repeat();
        if (_timer == null) _startTimer();
      }
    } else {
      _spinController.stop();
      _stopTimer();

      // Auto-collapse when transitioning from running to done
      if (oldStatus == ToolCallStatus.running &&
          newStatus == ToolCallStatus.done) {
        setState(() => _expanded = false);
      }
      // Auto-expand on error
      if (newStatus == ToolCallStatus.error && !_expanded) {
        setState(() => _expanded = true);
      }
    }
  }

  void _startTimer() {
    // Initialize from actual elapsed time since tool started (survives app backgrounding)
    _elapsed = DateTime.now().difference(widget.message.createdAt);
    _timer = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (mounted) {
        setState(() => _elapsed += const Duration(milliseconds: 100));
      }
    });
  }

  void _stopTimer() {
    _timer?.cancel();
    _timer = null;
  }

  @override
  void dispose() {
    _spinController.dispose();
    _timer?.cancel();
    super.dispose();
  }

  String _formatElapsed(Duration d) {
    if (d.inMinutes >= 1) return '${d.inMinutes}m${(d.inSeconds % 60)}s';
    if (d.inSeconds >= 10) return '${d.inSeconds}s';
    return '${(d.inMilliseconds / 1000).toStringAsFixed(1)}s';
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final msg = widget.message;
    final status = msg.toolStatus ?? ToolCallStatus.running;
    final toolName = msg.toolName ?? 'Tool';
    final hasInput = msg.toolInput != null && msg.toolInput!.isNotEmpty;
    final hasOutput = msg.toolOutput != null && msg.toolOutput!.isNotEmpty;
    final hasDetails = hasInput || hasOutput;
    final summary = msg.toolResultSummary;

    return Column(
      children: [
        // Main row
        InkWell(
          onTap:
              hasDetails ? () => setState(() => _expanded = !_expanded) : null,
          borderRadius: BorderRadius.circular(4),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
            child: Row(
              children: [
                // Tool icon
                _buildIcon(colors, toolName),
                const SizedBox(width: 8),
                // Action verb + input badge
                Expanded(
                  child: Row(
                    children: [
                      Text(
                        _actionVerb(toolName, status),
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                      if (hasInput) ...[
                        const SizedBox(width: 6),
                        Flexible(
                          child: _buildInputBadge(
                              colors, toolName, msg.toolInput!,),
                        ),
                      ],
                      // Result summary (when done and not expanded)
                      if (summary != null &&
                          status != ToolCallStatus.running &&
                          !_expanded) ...[
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            '— $summary',
                            style: TextStyle(
                              color: status == ToolCallStatus.error
                                  ? colors.toolError
                                  : colors.textMuted,
                              fontSize: 11,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 4),
                // Timer for running tools
                if (status == ToolCallStatus.running &&
                    _elapsed.inMilliseconds > 500)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Text(
                      _formatElapsed(_elapsed),
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 10,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                // Status icon
                _buildStatusIcon(colors, status),
              ],
            ),
          ),
        ),
        // Expandable details: shows input AND output simultaneously
        AnimatedSize(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeInOut,
          child: _expanded && hasDetails
              ? Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(left: 28, right: 4, bottom: 6),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: colors.bgPrimary,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: colors.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Input section
                      if (hasInput) ...[
                        Text(
                          'Input',
                          style: TextStyle(
                            color: colors.textMuted,
                            fontSize: 10,
                          ),
                        ),
                        const SizedBox(height: 4),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxHeight: 120),
                          child: SingleChildScrollView(
                            child: Text(
                              msg.toolInput!,
                              style: TextStyle(
                                color: colors.textSecondary,
                                fontSize: 11,
                                fontFamily: 'monospace',
                                height: 1.4,
                              ),
                            ),
                          ),
                        ),
                        if (hasOutput) const SizedBox(height: 8),
                      ],
                      // Output section
                      if (hasOutput) ...[
                        Row(
                          children: [
                            Text(
                              'Output',
                              style: TextStyle(
                                color: colors.textMuted,
                                fontSize: 10,
                              ),
                            ),
                            const Spacer(),
                            GestureDetector(
                              onTap: () {
                                Clipboard.setData(
                                    ClipboardData(text: msg.toolOutput!),);
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Copied'),
                                    duration: Duration(seconds: 1),
                                    behavior: SnackBarBehavior.floating,
                                  ),
                                );
                              },
                              child: Icon(Icons.copy,
                                  size: 12, color: colors.textMuted,),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxHeight: 150),
                          child: SingleChildScrollView(
                            child: Text(
                              msg.toolOutput!,
                              style: TextStyle(
                                color: colors.textSecondary,
                                fontSize: 11,
                                fontFamily: 'monospace',
                                height: 1.4,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                )
              : const SizedBox.shrink(),
        ),
      ],
    );
  }

  Widget _buildIcon(AppColors colors, String toolName) {
    IconData icon;
    switch (toolName) {
      case 'Bash':
        icon = Icons.terminal;
      case 'Read':
      case 'file-read':
        icon = Icons.description;
      case 'Write':
      case 'file-write':
        icon = Icons.edit_note;
      case 'Edit':
      case 'file-edit':
        icon = Icons.edit_note;
      case 'Glob':
        icon = Icons.folder_open;
      case 'Grep':
        icon = Icons.search;
      case 'WebSearch':
      case 'web-search':
        icon = Icons.travel_explore;
      case 'WebFetch':
      case 'web-fetch':
        icon = Icons.cloud_download_outlined;
      case 'Agent':
      case 'agent-tool':
        icon = Icons.smart_toy;
      default:
        icon = Icons.build_outlined;
    }
    return Icon(icon, size: 14, color: colors.textMuted);
  }

  String _actionVerb(String toolName, ToolCallStatus status) {
    final done = status != ToolCallStatus.running;
    switch (toolName) {
      case 'Bash':
        return done ? 'Ran' : 'Running';
      case 'Read':
      case 'file-read':
        return done ? 'Read' : 'Reading';
      case 'Write':
      case 'file-write':
        return done ? 'Wrote' : 'Writing';
      case 'Edit':
      case 'file-edit':
        return done ? 'Edited' : 'Editing';
      case 'Glob':
        return done ? 'Found' : 'Finding';
      case 'Grep':
        return done ? 'Searched' : 'Searching';
      case 'WebSearch':
      case 'web-search':
        return done ? 'Searched' : 'Searching';
      case 'WebFetch':
      case 'web-fetch':
        return done ? 'Fetched' : 'Fetching';
      case 'Agent':
      case 'agent-tool':
        return done ? 'Ran agent' : 'Running agent';
      default:
        return done ? 'Used $toolName' : 'Using $toolName';
    }
  }

  Widget _buildInputBadge(AppColors colors, String toolName, String input) {
    // Extract filename from path
    String display = input;
    if (input.contains('/') || input.contains('\\')) {
      display = input.split(RegExp(r'[/\\]')).last;
    }
    if (display.length > 40) {
      display = '${display.substring(0, 37)}...';
    }

    final badgeColor = _badgeColor(colors, toolName, display);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: badgeColor.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        display,
        style: TextStyle(
          color: badgeColor,
          fontSize: 11,
          fontFamily: toolName == 'Bash' ? 'monospace' : null,
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  Color _badgeColor(AppColors colors, String toolName, String display) {
    if (toolName == 'Bash') return const Color(0xFF9E9E9E);
    // Color by file extension
    if (display.endsWith('.dart')) return const Color(0xFF64B5F6);
    if (display.endsWith('.tsx') || display.endsWith('.ts')) {
      return const Color(0xFF4DD0E1);
    }
    if (display.endsWith('.css') || display.endsWith('.scss')) {
      return const Color(0xFFCE93D8);
    }
    if (display.endsWith('.js') || display.endsWith('.jsx')) {
      return const Color(0xFFFFD54F);
    }
    if (display.endsWith('.json')) return const Color(0xFFA5D6A7);
    if (display.endsWith('.md')) return const Color(0xFF90CAF9);
    if (display.endsWith('.py')) return const Color(0xFF81C784);
    return colors.textSecondary;
  }

  Widget _buildStatusIcon(AppColors colors, ToolCallStatus status) {
    switch (status) {
      case ToolCallStatus.running:
        return RotationTransition(
          turns: _spinController,
          child: Icon(Icons.sync, size: 14, color: colors.toolRunning),
        );
      case ToolCallStatus.done:
        return Icon(Icons.check, size: 14, color: colors.toolCompleted);
      case ToolCallStatus.error:
        return Icon(Icons.close, size: 14, color: colors.toolError);
    }
  }
}
