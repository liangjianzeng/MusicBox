import 'package:flutter/material.dart';

/// MV 域内主题语义。深色延续低对比分层，浅色直接使用 Material 3 的
/// surface/onSurface/outline，避免页面各自写死 whiteXX。
extension MvSchemeColors on ColorScheme {
  Color get mvSuccess => brightness == Brightness.dark
      ? Colors.greenAccent
      : const Color(0xFF176B45);
  Color get mvWarning => brightness == Brightness.dark
      ? Colors.amberAccent
      : const Color(0xFF8A4B00);
  Color get mvError => brightness == Brightness.dark
      ? Colors.redAccent
      : const Color(0xFFB3261E);
  Color get mvInfo => brightness == Brightness.dark
      ? Colors.cyanAccent
      : const Color(0xFF006874);

  /// scrim 始终是深色遮罩，浅色主题需要反色前景保证对比度。
  Color get mvOnScrim =>
      brightness == Brightness.dark ? onSurface : onInverseSurface;

  Color get mvSurface => surfaceContainerLow;
  Color get mvSurfaceRaised => surfaceContainerHigh;
  Color get mvBorder => outlineVariant.withValues(
        alpha: brightness == Brightness.dark ? 0.42 : 0.75,
      );
  Color get mvTextPrimary => onSurface;
  Color get mvTextSecondary => onSurfaceVariant;
  Color get mvTextMuted => onSurfaceVariant.withValues(alpha: 0.68);
}

extension MvThemeContext on BuildContext {
  ColorScheme get mvColors => Theme.of(this).colorScheme;
  TextTheme get mvText => Theme.of(this).textTheme;
  Color get mvSurface => mvColors.mvSurface;
  Color get mvSurfaceRaised => mvColors.mvSurfaceRaised;
  Color get mvBorder => mvColors.mvBorder;
  Color get mvTextPrimary => mvColors.mvTextPrimary;
  Color get mvTextSecondary => mvColors.mvTextSecondary;
  Color get mvTextMuted => mvColors.mvTextMuted;
  Color get mvSuccess => mvColors.mvSuccess;
  Color get mvWarning => mvColors.mvWarning;
  Color get mvError => mvColors.mvError;
  Color get mvInfo => mvColors.mvInfo;
  Color get mvOnScrim => mvColors.mvOnScrim;
}
