import 'dart:math';

import 'package:flutter/material.dart';

/// 由作品 id 生成确定性伪波形（peaks 未就绪时占位）
List<double> pseudoPeaks(String seed, {int n = 64}) {
  final rnd = Random(seed.hashCode & 0x7fffffff);
  return List<double>.generate(n, (i) {
    final shape = 0.35 + 0.65 * (sin(i / 4.0 + (seed.hashCode % 7)).abs());
    final v = (0.15 + 0.85 * rnd.nextDouble()) * shape;
    return v.clamp(0.06, 1.0);
  });
}

/// 波形画布：peaks 峰值条 + 已播进度高亮，可拖拽 seek
class WaveformCanvas extends StatelessWidget {
  const WaveformCanvas({
    super.key,
    required this.peaks,
    this.progress = 0,
    this.height = 48,
    this.barWidth = 3,
    this.gap = 2.5,
    this.color,
    this.progressColor,
    this.onSeek,
  });

  final List<double> peaks;
  final double progress; // 0-1
  final double height;
  final double barWidth;
  final double gap;
  final Color? color;
  final Color? progressColor;
  final ValueChanged<double>? onSeek; // 归一化位置

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: onSeek == null
          ? null
          : (d) => onSeek!((d.localPosition.dx / (context.size?.width ?? 1)).clamp(0.0, 1.0)),
      onHorizontalDragUpdate: onSeek == null
          ? null
          : (d) => onSeek!((d.localPosition.dx / (context.size?.width ?? 1)).clamp(0.0, 1.0)),
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: CustomPaint(
          painter: _WaveformPainter(
            peaks: peaks,
            progress: progress,
            barWidth: barWidth,
            gap: gap,
            color: color ?? scheme.surfaceContainerHighest,
            progressColor: progressColor ?? scheme.primary,
          ),
        ),
      ),
    );
  }
}

class _WaveformPainter extends CustomPainter {
  _WaveformPainter({
    required this.peaks,
    required this.progress,
    required this.barWidth,
    required this.gap,
    required this.color,
    required this.progressColor,
  });

  final List<double> peaks;
  final double progress;
  final double barWidth;
  final double gap;
  final Color color;
  final Color progressColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (peaks.isEmpty) return;
    final pitch = barWidth + gap;
    final count = max(1, (size.width / pitch).floor());
    final playedX = size.width * progress.clamp(0.0, 1.0);
    final midY = size.height / 2;
    // 归一化峰值
    var maxV = 0.0;
    for (final p in peaks) {
      if (p > maxV) maxV = p;
    }
    if (maxV <= 0) maxV = 1;
    final playedPaint = Paint()
      ..color = progressColor
      ..strokeWidth = barWidth
      ..strokeCap = StrokeCap.round;
    final restPaint = Paint()
      ..color = color
      ..strokeWidth = barWidth
      ..strokeCap = StrokeCap.round;
    for (int i = 0; i < count; i++) {
      final v = peaks[(i * peaks.length) ~/ count].abs() / maxV;
      final h = (size.height * (0.08 + 0.86 * v)).clamp(2.0, size.height);
      final x = i * pitch + barWidth / 2;
      canvas.drawLine(
        Offset(x, midY - h / 2),
        Offset(x, midY + h / 2),
        x <= playedX ? playedPaint : restPaint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _WaveformPainter old) =>
      old.progress != progress ||
      old.peaks != peaks ||
      old.color != color ||
      old.progressColor != progressColor;
}
