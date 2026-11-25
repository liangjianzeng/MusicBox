import 'dart:async';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../../../shared/widgets/ai_badge.dart';
import 'mv_network_image.dart';
import 'mv_theme.dart';

/// MV 竖屏 9:16 播放器（video_player 官方件直接驱动，未用 chewie ——
/// 本机离线 pub 缓存无 chewie，UI 控件自绘，保持零新增下载）。
///
/// 诚实降级：url 为空 / 初始化失败 / 播放出错时，渲染「海报 + 视频暂不可用」
/// 占位，绝不渲染假画面。
class MvVideoPlayer extends StatefulWidget {
  const MvVideoPlayer({
    super.key,
    required this.url,
    this.coverUrl,
    this.aspectRatio = 9 / 16,
    this.placeholderHint = '视频暂不可用',
    this.autoPlay = false,
  });

  final String? url;
  final String? coverUrl;
  final double aspectRatio;
  final String placeholderHint;

  /// 就绪后自动开播（首映礼揭晓页用；默认不自动播）
  final bool autoPlay;

  @override
  State<MvVideoPlayer> createState() => _MvVideoPlayerState();
}

class _MvVideoPlayerState extends State<MvVideoPlayer> {
  VideoPlayerController? _controller;
  Object? _error;
  bool _initializing = false;
  bool _showControls = true;
  Timer? _hideTimer;
  int _initGeneration = 0;

  @override
  void initState() {
    super.initState();
    _init();
  }

  @override
  void didUpdateWidget(covariant MvVideoPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      // URL 变更立即使旧初始化结果失效，再安全释放旧 controller 并初始化新片源。
      _initGeneration++;
      final old = _controller;
      _controller = null;
      if (old != null) {
        old.removeListener(_onTick);
        unawaited(old.dispose());
      }
      _hideTimer?.cancel();
      setState(() {
        _error = null;
        _initializing = false;
        _showControls = true;
      });
      _init();
    }
  }

  Future<void> _init() async {
    final generation = ++_initGeneration;
    final url = widget.url;
    final previous = _controller;
    _controller = null;
    if (previous != null) {
      previous.removeListener(_onTick);
      unawaited(previous.dispose());
    }
    _hideTimer?.cancel();
    if (url == null || url.isEmpty) {
      if (mounted) {
        setState(() {
          _initializing = false;
          _error = null;
        });
      }
      return;
    }
    setState(() {
      _initializing = true;
      _error = null;
      _showControls = true;
    });
    VideoPlayerController? c;
    try {
      c = VideoPlayerController.networkUrl(Uri.parse(url));
      await c.initialize();
      if (!mounted || generation != _initGeneration) {
        await c.dispose();
        return;
      }
      c.addListener(_onTick);
      setState(() {
        _controller = c;
        _initializing = false;
      });
      if (widget.autoPlay) c.play();
      _scheduleHide();
    } catch (e) {
      if (c != null) unawaited(c.dispose());
      if (!mounted || generation != _initGeneration) return;
      setState(() {
        _initializing = false;
        _error = e;
      });
    }
  }

  void _onTick() {
    if (mounted) setState(() {});
  }

  void _togglePlay() {
    final c = _controller;
    if (c == null || !c.value.isInitialized) return;
    setState(() {
      if (c.value.isPlaying) {
        c.pause();
      } else {
        c.play();
      }
      _showControls = true;
    });
    _scheduleHide();
  }

  void _scheduleHide() {
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(seconds: 3), () {
      if (mounted && (_controller?.value.isPlaying ?? false)) {
        setState(() => _showControls = false);
      }
    });
  }

  @override
  void dispose() {
    _initGeneration++;
    _hideTimer?.cancel();
    _controller?.removeListener(_onTick);
    final controller = _controller;
    _controller = null;
    if (controller != null) unawaited(controller.dispose());
    super.dispose();
  }

  String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final c = _controller;
    final stage = context.mvColors.inverseSurface;
    final foreground = context.mvColors.onInverseSurface;
    Widget body;
    if (widget.url == null || widget.url!.isEmpty) {
      body = _placeholder(context, '还没有可播的视频');
    } else if (_initializing) {
      body = Center(
          child: SizedBox(
              width: 28,
              height: 28,
              child: CircularProgressIndicator(
                  strokeWidth: 2.5, color: foreground)));
    } else if (c == null || !c.value.isInitialized || _error != null) {
      body = _placeholder(context, widget.placeholderHint);
    } else {
      body = Stack(
        alignment: Alignment.center,
        children: [
          VideoPlayer(c),
          if (_showControls)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                color: context.mvColors.scrim.withValues(alpha: 0.58),
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
                child: Row(
                  children: [
                    Tooltip(
                      message: c.value.isPlaying ? '暂停视频' : '播放视频',
                      child: IconButton(
                        onPressed: _togglePlay,
                        iconSize: 26,
                        color: foreground,
                        icon: Icon(c.value.isPlaying
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded),
                      ),
                    ),
                    Expanded(
                      child: Builder(builder: (_) {
                        final durMs = c.value.duration.inMilliseconds;
                        final posMs = c.value.position.inMilliseconds
                            .clamp(0, durMs > 0 ? durMs : 0);
                        return Slider(
                          value: posMs.toDouble(),
                          max: (durMs > 0 ? durMs : 1).toDouble(),
                          semanticFormatterCallback: (v) =>
                              '${_fmt(Duration(milliseconds: v.round()))} / ${_fmt(c.value.duration)}',
                          onChanged: (v) {
                            c.seekTo(Duration(milliseconds: v.toInt()));
                            _scheduleHide();
                          },
                        );
                      }),
                    ),
                    Text(
                      '${_fmt(c.value.position)}/${_fmt(c.value.duration)}',
                      style: TextStyle(fontSize: 11, color: foreground),
                    ),
                  ],
                ),
              ),
            ),
          const Positioned(top: 8, right: 8, child: AiBadge(small: true)),
        ],
      );
    }
    return Semantics(
      label: 'MV 视频播放器',
      hint: c?.value.isPlaying == true ? '正在播放，点击画面显示或隐藏控件' : '点击画面显示控件',
      child: GestureDetector(
        onTap: () {
          if (c?.value.isInitialized ?? false) {
            setState(() => _showControls = !_showControls);
            _scheduleHide();
          }
        },
        child: ColoredBox(
          color: stage,
          child: AspectRatio(aspectRatio: widget.aspectRatio, child: body),
        ),
      ),
    );
  }

  Widget _placeholder(BuildContext context, String hint) {
    final foreground = context.mvColors.onInverseSurface;
    return Stack(
      fit: StackFit.expand,
      children: [
        if ((widget.coverUrl ?? '').isNotEmpty)
          MvNetworkImage(
              url: widget.coverUrl!, cacheWidth: 720, semanticLabel: '视频封面')
        else
          Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  context.mvColors.inverseSurface,
                  context.mvColors.inverseSurface.withValues(alpha: 0.82),
                ],
              ),
            ),
          ),
        Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.videocam_off_outlined, color: foreground, size: 30),
              const SizedBox(height: 8),
              Text(hint,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: foreground, fontSize: 12)),
              if (_error != null) ...[
                const SizedBox(height: 4),
                Text('（连接/片源异常，可重试）',
                    style: TextStyle(
                        color: foreground.withValues(alpha: 0.72),
                        fontSize: 11)),
                TextButton(
                  onPressed: _init,
                  child: Text('重试', style: TextStyle(color: foreground)),
                ),
              ],
            ],
          ),
        ),
        if ((widget.coverUrl ?? '').isNotEmpty)
          Positioned(
            top: 6,
            left: 6,
            child: MvZoomButton(
              label: '放大视频封面',
              onPressed: () => showMvImagePreview(context,
                  url: widget.coverUrl!, title: '视频封面'),
            ),
          ),
      ],
    );
  }
}

/// 全屏竖屏播放页（成片/定妆视频揭晓用）
class MvVideoPlayerPage extends StatelessWidget {
  const MvVideoPlayerPage({
    super.key,
    required this.url,
    required this.title,
    this.coverUrl,
    this.placeholderHint = '视频暂不可用',
  });

  final String? url;
  final String title;
  final String? coverUrl;
  final String placeholderHint;

  static void push(
    BuildContext context, {
    required String? url,
    required String title,
    String? coverUrl,
    String placeholderHint = '视频暂不可用',
  }) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MvVideoPlayerPage(
        url: url,
        title: title,
        coverUrl: coverUrl,
        placeholderHint: placeholderHint,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.mvColors.inverseSurface,
      appBar: AppBar(
        title: Text(title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 16)),
        backgroundColor: context.mvColors.inverseSurface,
        foregroundColor: context.mvColors.onInverseSurface,
      ),
      body: Center(
        child: MvVideoPlayer(
          url: url,
          coverUrl: coverUrl,
          placeholderHint: placeholderHint,
        ),
      ),
    );
  }
}
