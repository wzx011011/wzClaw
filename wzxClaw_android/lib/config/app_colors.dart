import 'package:flutter/material.dart';

/// Adaptive color palette for wzxClaw.
/// Use AppColors.of(context) in build methods to get theme-aware colors.
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.bgPrimary,
    required this.bgSecondary,
    required this.bgTertiary,
    required this.bgElevated,
    required this.bgInput,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.accent,
    required this.accentHover,
    required this.border,
    required this.tableBorder,
    required this.success,
    required this.warning,
    required this.error,
    required this.toolRunning,
    required this.toolCompleted,
    required this.toolError,
    required this.userBubble,
    required this.assistantBubble,
  });

  final Color bgPrimary;
  final Color bgSecondary;
  final Color bgTertiary;
  final Color bgElevated;
  final Color bgInput;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final Color accent;
  final Color accentHover;
  final Color border;
  final Color tableBorder;
  final Color success;
  final Color warning;
  final Color error;
  final Color toolRunning;
  final Color toolCompleted;
  final Color toolError;
  final Color userBubble;
  final Color assistantBubble;

  static AppColors of(BuildContext context) =>
      Theme.of(context).extension<AppColors>()!;

  // ── Dark theme (Midnight) ─────────────────────────────────────────
  static const dark = AppColors(
    bgPrimary: Color(0xFF181818),
    bgSecondary: Color(0xFF1F1F1F),
    bgTertiary: Color(0xFF2B2B2B),
    bgElevated: Color(0xFF323232),
    bgInput: Color(0xFF141414),
    textPrimary: Color(0xFFE0E0E0),
    textSecondary: Color(0xFF808080),
    textMuted: Color(0xFF5A5A5A),
    accent: Color(0xFF7C3AED),
    accentHover: Color(0xFF6D28D9),
    border: Color(0xFF2E2E2E),
    tableBorder: Color(0x26FFFFFF), // rgba(255,255,255,0.15)
    success: Color(0xFF4ADE80),
    warning: Color(0xFFFBBF24),
    error: Color(0xFFF87171),
    toolRunning: Color(0xFFDCB67A),
    toolCompleted: Color(0xFF89D185),
    toolError: Color(0xFFF48771),
    userBubble: Color(0xFF7C3AED),
    assistantBubble: Color(0xFF2B2B2B),
  );

  // ── Light theme ───────────────────────────────────────────────────
  static const light = AppColors(
    bgPrimary: Color(0xFFFFFFFF),
    bgSecondary: Color(0xFFF3F3F3),
    bgTertiary: Color(0xFFE8E8E8),
    bgElevated: Color(0xFFFFFFFF),
    bgInput: Color(0xFFF0F0F0),
    textPrimary: Color(0xFF1E1E1E),
    textSecondary: Color(0xFF616161),
    textMuted: Color(0xFF999999),
    accent: Color(0xFF6F42C1),
    accentHover: Color(0xFF5A32A3),
    border: Color(0xFFD4D4D4),
    tableBorder: Color(0xFFC0C0C0),
    success: Color(0xFF22863A),
    warning: Color(0xFFB08800),
    error: Color(0xFFCB2431),
    toolRunning: Color(0xFFD97706),
    toolCompleted: Color(0xFF16A34A),
    toolError: Color(0xFFDC2626),
    userBubble: Color(0xFF6F42C1),
    assistantBubble: Color(0xFFE8E8E8),
  );

  // ── Dark Green theme ─────────────────────────────────────────────
  static const darkGreen = AppColors(
    bgPrimary: Color(0xFF181818),
    bgSecondary: Color(0xFF1F1F1F),
    bgTertiary: Color(0xFF2B2B2B),
    bgElevated: Color(0xFF323232),
    bgInput: Color(0xFF141414),
    textPrimary: Color(0xFFE0E0E0),
    textSecondary: Color(0xFF808080),
    textMuted: Color(0xFF5A5A5A),
    accent: Color(0xFF10B981),
    accentHover: Color(0xFF059669),
    border: Color(0xFF2E2E2E),
    tableBorder: Color(0x26FFFFFF),
    success: Color(0xFF4ADE80),
    warning: Color(0xFFFBBF24),
    error: Color(0xFFF87171),
    toolRunning: Color(0xFFDCB67A),
    toolCompleted: Color(0xFF89D185),
    toolError: Color(0xFFF48771),
    userBubble: Color(0xFF10B981),
    assistantBubble: Color(0xFF2B2B2B),
  );

  // ── Light Green theme ─────────────────────────────────────────────
  static const lightGreen = AppColors(
    bgPrimary: Color(0xFFFFFFFF),
    bgSecondary: Color(0xFFF3F3F3),
    bgTertiary: Color(0xFFE8E8E8),
    bgElevated: Color(0xFFFFFFFF),
    bgInput: Color(0xFFF0F0F0),
    textPrimary: Color(0xFF1E1E1E),
    textSecondary: Color(0xFF616161),
    textMuted: Color(0xFF999999),
    accent: Color(0xFF059669),
    accentHover: Color(0xFF047857),
    border: Color(0xFFD4D4D4),
    tableBorder: Color(0xFFC0C0C0),
    success: Color(0xFF22863A),
    warning: Color(0xFFB08800),
    error: Color(0xFFCB2431),
    toolRunning: Color(0xFFD97706),
    toolCompleted: Color(0xFF16A34A),
    toolError: Color(0xFFDC2626),
    userBubble: Color(0xFF059669),
    assistantBubble: Color(0xFFE8E8E8),
  );

  @override
  AppColors copyWith({
    Color? bgPrimary,
    Color? bgSecondary,
    Color? bgTertiary,
    Color? bgElevated,
    Color? bgInput,
    Color? textPrimary,
    Color? textSecondary,
    Color? textMuted,
    Color? accent,
    Color? accentHover,
    Color? border,
    Color? tableBorder,
    Color? success,
    Color? warning,
    Color? error,
    Color? toolRunning,
    Color? toolCompleted,
    Color? toolError,
    Color? userBubble,
    Color? assistantBubble,
  }) =>
      AppColors(
        bgPrimary: bgPrimary ?? this.bgPrimary,
        bgSecondary: bgSecondary ?? this.bgSecondary,
        bgTertiary: bgTertiary ?? this.bgTertiary,
        bgElevated: bgElevated ?? this.bgElevated,
        bgInput: bgInput ?? this.bgInput,
        textPrimary: textPrimary ?? this.textPrimary,
        textSecondary: textSecondary ?? this.textSecondary,
        textMuted: textMuted ?? this.textMuted,
        accent: accent ?? this.accent,
        accentHover: accentHover ?? this.accentHover,
        border: border ?? this.border,
        tableBorder: tableBorder ?? this.tableBorder,
        success: success ?? this.success,
        warning: warning ?? this.warning,
        error: error ?? this.error,
        toolRunning: toolRunning ?? this.toolRunning,
        toolCompleted: toolCompleted ?? this.toolCompleted,
        toolError: toolError ?? this.toolError,
        userBubble: userBubble ?? this.userBubble,
        assistantBubble: assistantBubble ?? this.assistantBubble,
      );

  @override
  AppColors lerp(AppColors? other, double t) {
    if (other == null) return this;
    return AppColors(
      bgPrimary: Color.lerp(bgPrimary, other.bgPrimary, t)!,
      bgSecondary: Color.lerp(bgSecondary, other.bgSecondary, t)!,
      bgTertiary: Color.lerp(bgTertiary, other.bgTertiary, t)!,
      bgElevated: Color.lerp(bgElevated, other.bgElevated, t)!,
      bgInput: Color.lerp(bgInput, other.bgInput, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentHover: Color.lerp(accentHover, other.accentHover, t)!,
      border: Color.lerp(border, other.border, t)!,
      tableBorder: Color.lerp(tableBorder, other.tableBorder, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      error: Color.lerp(error, other.error, t)!,
      toolRunning: Color.lerp(toolRunning, other.toolRunning, t)!,
      toolCompleted: Color.lerp(toolCompleted, other.toolCompleted, t)!,
      toolError: Color.lerp(toolError, other.toolError, t)!,
      userBubble: Color.lerp(userBubble, other.userBubble, t)!,
      assistantBubble: Color.lerp(assistantBubble, other.assistantBubble, t)!,
    );
  }
}
