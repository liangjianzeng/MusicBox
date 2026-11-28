import 'package:flutter/material.dart';

import '../../features/create/creation_ui.dart';

/// 主按钮：统一圆角 + 加载态
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.text,
    this.onPressed,
    this.loading = false,
    this.icon,
    this.expand = true,
    this.big = false,
    this.gradient = false,
  });

  final String text;
  final VoidCallback? onPressed;
  final bool loading;
  final IconData? icon;
  final bool expand;
  final bool big;
  final bool gradient;

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || loading;
    final foreground =
        gradient ? Colors.white : Theme.of(context).colorScheme.onPrimary;
    final content = Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: foreground,
            ),
          )
        else
          Icon(icon ?? Icons.play_arrow_rounded, color: foreground),
        const SizedBox(width: 9),
        Flexible(
          // 文案**只准一行**，装不下就整体缩放，绝不折行、绝不省略号：
          // ① 折行会让按钮随宽度长高（实测 248px 宽 71 高 → 123px 宽 114 高，
          //    在 320×568 + 2 倍字号下把整页挤出 21px，`create_layout_test` 抓到）；
          // ② 更要命的是 ellipsis 会把「· 45⚡」这种**价格**截成「生成 3 首 ·…」，
          //    用户看不见的支出等于没征得同意（契约 v5.6.15）。
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.center,
            child: Text(
              text,
              textAlign: TextAlign.center,
              maxLines: 1,
              softWrap: false,
              style: TextStyle(
                fontSize: big ? 16 : 15,
                fontWeight: FontWeight.w700,
                color: foreground,
                letterSpacing: .1,
              ),
            ),
          ),
        ),
      ],
    );
    return SizedBox(
      width: expand ? double.infinity : null,
      child: FilledButton(
        onPressed: loading ? null : onPressed,
        style: FilledButton.styleFrom(
          minimumSize: Size(0, big ? 56 : 48),
          padding: EdgeInsets.zero,
          backgroundColor: gradient
              ? Colors.transparent
              : Theme.of(context).colorScheme.primary,
          foregroundColor: foreground,
          disabledBackgroundColor:
              gradient ? CreationPalette.violet.withValues(alpha: .12) : null,
          disabledForegroundColor: gradient
              ? CreationPalette.violetBright.withValues(alpha: .45)
              : null,
          shadowColor:
              gradient ? CreationPalette.violet.withValues(alpha: .3) : null,
          elevation: gradient && !disabled ? 5 : 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(17),
          ),
        ),
        child: gradient
            ? DecoratedBox(
                decoration: BoxDecoration(
                  gradient: CreationPalette.gradient,
                  borderRadius: BorderRadius.circular(17),
                ),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  child: content,
                ),
              )
            : Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: content,
              ),
      ),
    );
  }
}
