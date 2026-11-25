import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'mv_theme.dart';

/// MV 域内统一时长格式（列表、详情、首映礼共用）。
String mvFormatDuration(double seconds) {
  final total = math.max(0, seconds.round());
  return '${total ~/ 60}:${(total % 60).toString().padLeft(2, '0')}';
}

/// 帧格列数：窄屏 3 列、手机 4 列、平板/折叠屏更多列。
int mvFrameColumns(double width) => switch (width) {
      >= 900 => 6,
      >= 600 => 5,
      >= 360 => 4,
      _ => 3,
    };

class MvSurfaceCard extends StatelessWidget {
  const MvSurfaceCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(12),
    this.borderRadius = 14,
    this.color,
    this.borderColor,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double borderRadius;
  final Color? color;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(borderRadius);
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? context.mvSurface,
        borderRadius: radius,
        border: Border.all(color: borderColor ?? context.mvBorder),
      ),
      child: child,
    );
  }
}

class MvSectionTitle extends StatelessWidget {
  const MvSectionTitle(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Text(
        text,
        style: context.mvText.titleSmall?.copyWith(
          fontWeight: FontWeight.w700,
          color: context.mvTextPrimary,
        ),
      );
}

class MvNotice extends StatelessWidget {
  const MvNotice({
    super.key,
    required this.icon,
    required this.text,
    this.color,
    this.action,
    this.spinner = false,
  });

  final IconData icon;
  final String text;
  final Color? color;
  final Widget? action;
  final bool spinner;

  @override
  Widget build(BuildContext context) {
    final tone = color ?? context.mvColors.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tone.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (spinner)
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: tone),
            )
          else
            Icon(icon, size: 16, color: tone),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: context.mvText.bodySmall?.copyWith(
                color: context.mvTextSecondary,
                height: 1.45,
              ),
            ),
          ),
          if (action != null) ...[const SizedBox(width: 6), action!],
        ],
      ),
    );
  }
}

class MvErrorView extends StatelessWidget {
  const MvErrorView({
    super.key,
    required this.text,
    required this.onRetry,
    this.icon = Icons.snooze_rounded,
  });

  final String text;
  final VoidCallback onRetry;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 38, color: context.mvTextMuted),
              const SizedBox(height: 10),
              Text(
                text,
                textAlign: TextAlign.center,
                style: context.mvText.bodyMedium?.copyWith(
                  color: context.mvTextSecondary,
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('重试'),
              ),
            ],
          ),
        ),
      );
}

class MvEmptyView extends StatelessWidget {
  const MvEmptyView({
    super.key,
    required this.icon,
    required this.text,
    this.action,
  });

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 40, color: context.mvTextMuted),
              const SizedBox(height: 12),
              Text(
                text,
                textAlign: TextAlign.center,
                style: context.mvText.bodyMedium?.copyWith(
                  color: context.mvTextSecondary,
                  height: 1.6,
                ),
              ),
              if (action != null) ...[const SizedBox(height: 14), action!],
            ],
          ),
        ),
      );
}

/// 提交/返工进行中的返回保护。任务不会因离开而取消，但必须先让用户确认。
class MvLeaveGuard extends StatefulWidget {
  const MvLeaveGuard({
    super.key,
    required this.busy,
    required this.child,
    this.message = '操作仍在提交中。离开不会取消后台任务，但可能看不到本次回执。确定离开吗？',
  });

  final bool busy;
  final Widget child;
  final String message;

  @override
  State<MvLeaveGuard> createState() => _MvLeaveGuardState();
}

class _MvLeaveGuardState extends State<MvLeaveGuard> {
  bool _confirming = false;
  bool _allowPop = false;

  Future<void> _confirmLeave() async {
    if (_confirming) return;
    _confirming = true;
    final leave = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('离开当前页面？'),
        content: Text(widget.message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('继续等待'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('确认离开'),
          ),
        ],
      ),
    );
    _confirming = false;
    if (leave != true || !mounted) return;

    // 先临时放行一次，让 PopScope 完成真实 pop；pop 后再恢复 busy 门禁。
    // 否则继续用 canPop:false 手动 Navigator.pop 会再次触发 guard 弹窗。
    setState(() => _allowPop = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.of(context).pop();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() => _allowPop = false);
      });
    });
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: !widget.busy || _allowPop,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && widget.busy && !_allowPop) _confirmLeave();
        },
        child: widget.child,
      );
}

/// 零依赖 skeleton/shimmer。禁用动画时只显示静态占位，不制造闪烁。
class MvSkeleton extends StatefulWidget {
  const MvSkeleton({
    super.key,
    this.width,
    this.height = 14,
    this.borderRadius = 7,
  });

  final double? width;
  final double height;
  final double borderRadius;

  @override
  State<MvSkeleton> createState() => _MvSkeletonState();
}

class _MvSkeletonState extends State<MvSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  @override
  void initState() {
    super.initState();
    _ctrl.repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final base = context.mvSurfaceRaised;
    final highlight = context.mvColors.onSurface.withValues(alpha: 0.07);
    return SizedBox(
      width: widget.width,
      height: widget.height,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(widget.borderRadius),
        child: MediaQuery.disableAnimationsOf(context)
            ? ColoredBox(color: base)
            : AnimatedBuilder(
                animation: _ctrl,
                builder: (_, __) => DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment(-1 - 2 * _ctrl.value, 0),
                      end: Alignment(1 - 2 * _ctrl.value, 0),
                      colors: [base, highlight, base],
                      stops: const [0.35, 0.5, 0.65],
                    ),
                  ),
                ),
              ),
      ),
    );
  }
}

class MvCardSkeleton extends StatelessWidget {
  const MvCardSkeleton({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: MvSurfaceCard(
          borderRadius: 16,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                children: [
                  Expanded(child: MvSkeleton(height: 17)),
                  SizedBox(width: 12),
                  MvSkeleton(width: 58, height: 22, borderRadius: 11),
                ],
              ),
              const SizedBox(height: 12),
              if (!compact) const MvSkeleton(width: 180, height: 12),
              const SizedBox(height: 8),
              MvSkeleton(width: compact ? 130 : 220, height: 11),
            ],
          ),
        ),
      );
}

class MvListSkeleton extends StatelessWidget {
  const MvListSkeleton({super.key, this.count = 3, this.compact = false});

  final int count;
  final bool compact;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Column(
          children: [
            for (var i = 0; i < count; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: MvCardSkeleton(compact: compact),
              ),
          ],
        ),
      );
}
