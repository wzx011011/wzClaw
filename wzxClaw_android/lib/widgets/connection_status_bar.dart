import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import 'desktop_picker.dart';

/// A thin status bar showing the current WebSocket connection state,
/// with an optional desktop picker when multiple desktops are available.
class ConnectionStatusBar extends StatefulWidget {
  const ConnectionStatusBar({
    super.key,
    required this.state,
    this.desktops = const [],
    this.selectedDesktopId,
    this.onDesktopSelect,
    this.desktopIdentity,
    this.desktopOnline = false,
    this.errorMessage,
  });

  final WsConnectionState state;
  final List<DesktopInfo> desktops;
  final String? selectedDesktopId;
  final ValueChanged<String?>? onDesktopSelect;
  final String? desktopIdentity;
  final bool desktopOnline;
  final String? errorMessage;

  @override
  State<ConnectionStatusBar> createState() => _ConnectionStatusBarState();
}

class _ConnectionStatusBarState extends State<ConnectionStatusBar> {
  bool _errorExpanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final state = widget.state;
    final desktopOnline = widget.desktopOnline;
    final errorMessage = widget.errorMessage;
    final dotColor = _dotColor(state, desktopOnline);
    final hasError = errorMessage != null &&
        errorMessage!.isNotEmpty &&
        state != WsConnectionState.connected;

    // Determine status text
    String statusText;
    if (state == WsConnectionState.connected) {
      if (widget.desktopIdentity != null) {
        statusText = '已连接到 ${widget.desktopIdentity}';
      } else if (desktopOnline) {
        statusText = '桌面已连接';
      } else {
        statusText = '已连接中继，等待桌面';
      }
    } else {
      statusText = state.label;
    }

    final showPicker = state == WsConnectionState.connected &&
        widget.desktops.length > 1 &&
        widget.onDesktopSelect != null;

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: dotColor.withValues(alpha: 0.08),
        border: Border(
          bottom: BorderSide(
            color: dotColor.withValues(alpha: 0.3),
            width: 1,
          ),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Status row
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: dotColor,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        statusText,
                        style: TextStyle(
                          color: dotColor,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      if (hasError)
                        GestureDetector(
                          onTap: () => setState(() => _errorExpanded = !_errorExpanded),
                          child: Text(
                            errorMessage!,
                            style: TextStyle(
                              color: colors.textMuted,
                              fontSize: 11,
                            ),
                            maxLines: _errorExpanded ? null : 1,
                            overflow: _errorExpanded ? null : TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          // Desktop picker
          if (showPicker)
            DesktopPicker(
              desktops: widget.desktops,
              selectedDesktopId: widget.selectedDesktopId,
              onSelect: widget.onDesktopSelect!,
            ),
        ],
      ),
    );
  }

  Color _dotColor(WsConnectionState state, bool desktopOnline) {
    switch (state) {
      case WsConnectionState.connected:
        return desktopOnline ? Colors.green : Colors.orange;
      case WsConnectionState.connecting:
      case WsConnectionState.reconnecting:
        return Colors.orange;
      case WsConnectionState.disconnected:
        return Colors.red;
    }
  }
}
