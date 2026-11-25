import 'package:flutter/material.dart';

import '../mv_models.dart';
import 'mv_theme.dart';

/// 剧组通告板 TaskChip（镜头态 + 通用任务态）。
/// 颜色取自主题语义；状态只来自服务端返回值，未收到数据时按「排队中」呈现。
class MvTaskChip extends StatelessWidget {
  const MvTaskChip({
    super.key,
    required this.status,
    this.label,
    this.trailing,
    this.badges = const [],
  });

  /// 镜头态（draft/queued/boardReady/clipReady/synced/locked/stale）
  /// 或任务态（queued/leased/running/done/failed）
  final String status;
  final String? label;
  final Widget? trailing;

  /// 降级角标（degraded / broll_subtitle 等，机检回传才显示，永不虚构）
  final List<String> badges;

  (String, Color) _visual(ColorScheme scheme) => switch (status) {
        'draft' || 'queued' || 'leased' => ('排队中', scheme.mvTextMuted),
        'boardReady' => ('待开拍', scheme.primary),
        'clipReady' => ('已拍·待合成', scheme.secondary),
        'synced' => ('已对口型', scheme.tertiary),
        'locked' || 'done' => ('完成', scheme.mvSuccess),
        'stale' => ('待补拍', scheme.mvWarning),
        'running' => ('进行中', scheme.mvWarning),
        'failed' => ('失败', scheme.mvError),
        _ => (mvShotStatusLabel(status), scheme.mvTextMuted),
      };

  static String _badgeLabel(String b) => switch (b) {
        'broll_subtitle' => '字幕强调',
        'degraded' => '降级档',
        _ => mvHuman(b),
      };

  @override
  Widget build(BuildContext context) {
    final scheme = context.mvColors;
    final (text, color) = _visual(scheme);
    final active =
        const {'boardReady', 'clipReady', 'synced', 'running'}.contains(status);
    final shown = label ?? text;
    return Semantics(
      label: [shown, ...badges.map(_badgeLabel)].join('，'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: color.withValues(alpha: 0.45)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (active) ...[
                  SizedBox(
                    width: 12,
                    height: 12,
                    child:
                        CircularProgressIndicator(strokeWidth: 2, color: color),
                  ),
                  const SizedBox(width: 5),
                ],
                Text(shown,
                    style: TextStyle(fontSize: 11, color: color, height: 1.2)),
                if (trailing != null) ...[const SizedBox(width: 4), trailing!],
              ],
            ),
          ),
          if (badges.isNotEmpty) ...[
            const SizedBox(height: 3),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final b in badges)
                  Container(
                    margin: const EdgeInsets.only(left: 4),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      color: scheme.mvWarning.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(5),
                    ),
                    child: Text(
                      _badgeLabel(b),
                      style: TextStyle(
                        fontSize: 9,
                        color: scheme.mvWarning,
                        height: 1.3,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 项目级状态 chip（人话映射见 mvProjectStatusLabel）
class MvProjectChip extends StatelessWidget {
  const MvProjectChip({super.key, required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final scheme = context.mvColors;
    final color = switch (status) {
      'ready' => scheme.mvSuccess,
      'failed' => scheme.mvError,
      'canceled' => scheme.mvTextMuted,
      _ => scheme.mvWarning,
    };
    final inProgress = mvProjectInProgress(status);
    final label = mvProjectStatusLabel(status);
    return Semantics(
      label: '项目状态：$label',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: color.withValues(alpha: 0.45)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (inProgress) ...[
              SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(strokeWidth: 2, color: color),
              ),
              const SizedBox(width: 5),
            ],
            Text(label,
                style: TextStyle(fontSize: 11, color: color, height: 1.2)),
          ],
        ),
      ),
    );
  }
}
