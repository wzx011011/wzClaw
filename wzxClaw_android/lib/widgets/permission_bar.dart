import 'dart:convert';

import 'package:flutter/material.dart';
import '../config/app_colors.dart';
import '../services/chat_store.dart';

/// A bar that appears when the desktop agent requests permission for a tool.
class PermissionBar extends StatelessWidget {
  final PermissionRequest request;

  const PermissionBar({super.key, required this.request});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    String inputSummary = '';
    if (request.input.isNotEmpty) {
      final encoded = const JsonEncoder.withIndent('  ').convert(request.input);
      inputSummary =
          encoded.length > 300 ? '${encoded.substring(0, 300)}…' : encoded;
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.all(8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.toolRunning),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.security, size: 16, color: colors.toolRunning),
              const SizedBox(width: 6),
              Text(
                'Permission Request',
                style: TextStyle(
                  color: colors.toolRunning,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${request.toolName} wants to execute:',
            style: TextStyle(color: colors.textSecondary, fontSize: 12),
          ),
          if (inputSummary.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 120),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: colors.bgSecondary,
                borderRadius: BorderRadius.circular(4),
              ),
              child: SingleChildScrollView(
                child: Text(
                  inputSummary,
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 11,
                    fontFamily: 'monospace',
                    height: 1.4,
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () =>
                    ChatStore.instance.respondToPermission(request.toolCallId, false),
                style: TextButton.styleFrom(
                  foregroundColor: colors.error,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: colors.error),
                  ),
                ),
                child: const Text('Deny', style: TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () =>
                    ChatStore.instance.respondToPermission(request.toolCallId, true),
                style: TextButton.styleFrom(
                  foregroundColor: colors.success,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: colors.success),
                  ),
                ),
                child: const Text('Approve', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
