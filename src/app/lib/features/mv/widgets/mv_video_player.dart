import 'dart:async';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../../../shared/widgets/ai_badge.dart';

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

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final url = widget.url;
    if (url == null || url.isEmpty) return;
    setState(() {
      _initializing = true;
      _error = null;
    });
    try {
      final c = VideoPlayerController.networkUrl(Uri.parse(url));
      await c.initialize();
      if (!mounted) {
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
      if (!mounted) return;
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
    _hideTimer?.cancel();
    _controller?.removeListener(_onTick);
    _controller?.dispose();
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
    Widget body;
    if (widget.url == null || widget.url!.isEmpty) {
      body = _placeholder('还没有可播的视频');
    } else if (_initializing) {
      body = const Center(
          child: SizedBox(
              width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 2.5)));
    } else if (c == null || !c.value.isInitialized || _error != null) {
      body = _placeholder(widget.placeholderHint);
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
                color: Colors.black45,
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
                child: Row(
                  children: [
                    IconButton(
                      onPressed: _togglePlay,
                      iconSize: 26,
                      color: Colors.white,
                      icon: Icon(c.value.isPlaying
                          ? Icons.pause_rounded
                          : Icons.play_arrow_rounded),
                    ),
                    Expanded(
                      child: Builder(builder: (_) {
                        final durMs = c.value.duration.inMilliseconds;
                        final posMs = c.value.position.inMilliseconds
                            .clamp(0, durMs > 0 ? durMs : 0);
                        return Slider(
                          value: posMs.toDouble(),
                          max: (durMs > 0 ? durMs : 1).toDouble(),
                          onChanged: (v) {
                            c.seekTo(Duration(milliseconds: v.toInt()));
                            _scheduleHide();
                          },
                        );
                      }),
                    ),
                    Text(
                      '${_fmt(c.value.position)}/${_fmt(c.value.duration)}',
                      style: const TextStyle(
                          fontSize: 11, color: Colors.white70),
                    ),
                  ],
                ),
              ),
            ),
          const Positioned(
              top: 8, right: 8, child: AiBadge(small: true)),
        ],
      );
    }
    return GestureDetector(
      onTap: () {
        if (c?.value.isInitialized ?? false) {
          setState(() => _showControls = !_showControls);
          _scheduleHide();
        }
      },
      child: ColoredBox(
        color: Colors.black,
        child: AspectRatio(aspectRatio: widget.aspectRatio, child: body),
      ),
    );
  }

  Widget _placeholder(String hint) {
    return Stack(
      fit: StackFit.expand,
      children: [
        if ((widget.coverUrl ?? '').isNotEmpty)
          Image.network(widget.coverUrl!,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => const SizedBox.shrink())
        else
          Container(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0xFF1C1D24), Color(0xFF12131A)],
              ),
            ),
          ),
        Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.videocam_off_outlined,
                  color: Colors.white38, size: 30),
              const SizedBox(height: 8),
              Text(hint,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white38, fontSize: 12)),
              if (_error != null) ...[
                const SizedBox(height: 4),
                const Text('（连接/片源异常，可重试）',
                    style: TextStyle(color: Colors.white24, fontSize: 11)),
                TextButton(
                  onPressed: _init,
                  child: const Text('重试',
                      style: TextStyle(color: Colors.white54)),
                ),
              ],
            ],
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

  static void push(BuildContext context, {
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
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Text(title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 16)),
        backgroundColor: Colors.black,
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
