import 'package:flutter/material.dart';

import '../mv_models.dart';

/// 剧组通告板 TaskChip（架构 §2：5 态镜头状态 + 项目态通用）
/// 诚实纪律：状态只来自服务端返回值，未收到数据时一律按「排队中」呈现。
class MvTaskChip extends StatelessWidget {
  const MvTaskChip({
    super.key,
    required this.status,
    this.label,
    this.trailing,
    this.badges = const [],
  });

  /// 镜头态（draft/boardReady/clipReady/synced/locked/stale）
  /// 或任务态（queued/leased/running/done/failed）
  final String status;
  final String? label; // 自定义文案（优先于 status 默认映射）
  final Widget? trailing;

  /// 降级角标（degraded / broll_subtitle 等，机检回传才显示，永不虚构）
  final List<String> badges;

  (String, Color) get _visual {
    switch (status) {
      // 剧组通告板 5 态人话：排队 / 开拍 / 对口型 / 合成 / 完成
      case 'draft':
        return ('排队中', Colors.blueGrey);
      case 'boardReady':
        return ('待开拍', Colors.cyan);
      case 'clipReady':
        return ('已拍·待合成', Colors.blue);
      case 'synced':
        return ('已对口型', Colors.teal);
      case 'locked':
        return ('完成', Colors.green);
      case 'stale':
        return ('待补拍', Colors.orange);
      case 'queued':
      case 'leased':
        return ('排队中', Colors.white38);
      case 'running':
        return ('进行中', Colors.amber);
      case 'done':
        return ('完成', Colors.green);
      case 'failed':
        return ('失败', Colors.redAccent);
      default:
        return (mvShotStatusLabel(status), Colors.white38);
    }
  }

  /// 降级角标的人话映射（机检真源才有值）
  static String _badgeLabel(String b) {
    switch (b) {
      case 'broll_subtitle':
        return '字幕强调';
      case 'degraded':
        return '降级档';
      default:
        return mvHuman(b);
    }
  }

  @override
  Widget build(BuildContext context) {
    final (text, color) = _visual;
    final active = const {'boardReady', 'clipReady', 'synced', 'running'}
        .contains(status);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: color.withValues(alpha: 0.5)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 12,
                height: 12,
                child: active
                    ? CircularProgressIndicator(strokeWidth: 2, color: color)
                    : null,
              ),
              if (active) const SizedBox(width: 5),
              Text(label ?? text,
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
                    color: Colors.orange.withValues(alpha: .16),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text(_badgeLabel(b),
                      style: const TextStyle(
                          fontSize: 9,
                          color: Colors.orangeAccent,
                          height: 1.3)),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// 项目级状态 chip（人话映射见 mvProjectStatusLabel）
class MvProjectChip extends StatelessWidget {
  const MvProjectChip({super.key, required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (status) {
      case 'ready':
        color = Colors.green;
        break;
      case 'failed':
        color = Colors.redAccent;
        break;
      case 'canceled':
        color = Colors.white30;
        break;
      default:
        color = Colors.amber;
    }
    final inProgress = mvProjectInProgress(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 12,
            height: 12,
            child: inProgress
                ? CircularProgressIndicator(strokeWidth: 2, color: color)
                : null,
          ),
          if (inProgress) const SizedBox(width: 5),
          Text(mvProjectStatusLabel(status),
              style: TextStyle(fontSize: 11, color: color, height: 1.2)),
        ],
      ),
    );
  }
}
