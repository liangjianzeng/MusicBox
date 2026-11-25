import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'mv_theme.dart';

/// MV 缩略图统一入口：固定加载占位避免布局跳动，按设备像素比解码，
/// 失败时保留同尺寸主题化占位，绝不闪退。
class MvNetworkImage extends StatelessWidget {
  const MvNetworkImage({
    super.key,
    required this.url,
    required this.cacheWidth,
    this.fit = BoxFit.cover,
    this.semanticLabel,
    this.errorIcon = Icons.broken_image_outlined,
  });

  final String url;
  final int cacheWidth;
  final BoxFit fit;
  final String? semanticLabel;
  final IconData errorIcon;

  @override
  Widget build(BuildContext context) {
    final ratio = MediaQuery.devicePixelRatioOf(context);
    final decodeWidth = math.max(1, (cacheWidth * ratio).round());
    return Semantics(
      image: true,
      label: semanticLabel,
      child: Image.network(
        url,
        fit: fit,
        cacheWidth: decodeWidth,
        filterQuality: FilterQuality.medium,
        loadingBuilder: (_, child, progress) => progress == null
            ? child
            : ColoredBox(
                color: context.mvSurfaceRaised,
                child: const Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              ),
        errorBuilder: (_, __, ___) => ColoredBox(
          color: context.mvSurfaceRaised,
          child: Center(
            child: Icon(errorIcon, size: 18, color: context.mvTextMuted),
          ),
        ),
      ),
    );
  }
}

/// 分镜/定妆帧大图预览：可缩放、可拖动，保持主题化加载/失败态。
Future<void> showMvImagePreview(
  BuildContext context, {
  required String url,
  String title = '画面预览',
}) {
  return showDialog<void>(
    context: context,
    builder: (ctx) => Dialog(
      insetPadding: const EdgeInsets.all(12),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1000, maxHeight: 900),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AppBar(
              automaticallyImplyLeading: false,
              title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
              actions: [
                IconButton(
                  tooltip: '关闭大图',
                  onPressed: () => Navigator.pop(ctx),
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            Flexible(
              child: AspectRatio(
                aspectRatio: 1,
                child: InteractiveViewer(
                  minScale: 1,
                  maxScale: 5,
                  child: Semantics(
                    label: '$title，可双指缩放',
                    image: true,
                    child: MvNetworkImage(
                      url: url,
                      cacheWidth: 1200,
                      fit: BoxFit.contain,
                      semanticLabel: title,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// 覆盖在图上的放大按钮，缩略图本身仍保留选择/长按编辑手势。
class MvZoomButton extends StatelessWidget {
  const MvZoomButton({super.key, required this.onPressed, this.label = '放大预览'});

  final VoidCallback onPressed;
  final String label;

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: label,
        style: IconButton.styleFrom(
          backgroundColor: context.mvColors.scrim.withValues(alpha: 0.58),
          foregroundColor: context.mvOnScrim,
          minimumSize: const Size(32, 32),
          padding: EdgeInsets.zero,
        ),
        onPressed: onPressed,
        icon: const Icon(Icons.zoom_out_map, size: 16),
      );
}
