import 'package:flutter/material.dart';

import '../models/desktop_info.dart';
import '../config/app_colors.dart';

/// Horizontal scrollable chip bar for selecting which desktop to target.
/// Only shown when multiple desktops are connected.
class DesktopPicker extends StatelessWidget {
  const DesktopPicker({
    super.key,
    required this.desktops,
    required this.selectedDesktopId,
    required this.onSelect,
  });

  final List<DesktopInfo> desktops;
  final String? selectedDesktopId;
  final ValueChanged<String?> onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            _buildChip(
              context: context,
              label: '全部桌面',
              icon: Icons.devices,
              isSelected: selectedDesktopId == null,
              onTap: () => onSelect(null),
              colors: colors,
            ),
            const SizedBox(width: 6),
            ...desktops.map((d) => Padding(
              padding: const EdgeInsets.only(right: 6),
              child: _buildChip(
                context: context,
                label: d.displayLabel,
                icon: _platformIcon(d.platform),
                isSelected: selectedDesktopId == d.desktopId,
                onTap: () => onSelect(d.desktopId),
                colors: colors,
              ),
            )),
          ],
        ),
      ),
    );
  }

  Widget _buildChip({
    required BuildContext context,
    required String label,
    required IconData icon,
    required bool isSelected,
    required VoidCallback onTap,
    required AppColors colors,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: isSelected ? colors.accent.withValues(alpha: 0.15) : colors.bgTertiary,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isSelected ? colors.accent : colors.border,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: isSelected ? colors.accent : colors.textMuted),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                color: isSelected ? colors.accent : colors.textSecondary,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }

  IconData _platformIcon(String? platform) {
    switch (platform?.toLowerCase()) {
      case 'win32': case 'windows':
        return Icons.desktop_windows;
      case 'darwin': case 'mac': case 'macos':
        return Icons.laptop_mac;
      case 'linux':
        return Icons.computer;
      default:
        return Icons.monitor;
    }
  }
}
