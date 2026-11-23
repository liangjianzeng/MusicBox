import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../../shared/widgets/ai_badge.dart';
import '../../shared/widgets/waveform_canvas.dart';
import 'player_provider.dart';

/// 全屏播放页：大波形（可拖拽 seek）+ 上下曲
class PlayerPage extends ConsumerStatefulWidget {
  const PlayerPage({super.key});

  @override
  ConsumerState<PlayerPage> createState() => _PlayerPageState();
}

class _PlayerPageState extends ConsumerState<PlayerPage> {
  List<double>? _peaks;

  @override
  void initState() {
    super.initState();
    _loadPeaks();
  }

  Future<void> _loadPeaks() async {
    final cur = ref.read(playerProvider).current;
    if (cur?.waveformUrl != null) {
      final p = await ref.read(apiClientProvider).fetchPeaks(cur!.waveformUrl!);
      if (mounted && p != null && p.isNotEmpty) {
        setState(() => _peaks = p);
      }
    }
  }

  String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '${d.inHours > 0 ? '${d.inHours}:' : ''}$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(playerProvider);
    final cur = st.current;
    if (cur == null) {
      return const Scaffold(
        body: Center(child: Text('没有正在播放的作品')),
      );
    }
    final notifier = ref.read(playerProvider.notifier);
    final peaks = _peaks ?? pseudoPeaks(cur.id, n: 96);
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              Row(
                children: [
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.keyboard_arrow_down_rounded),
                  ),
                  const Spacer(),
                  const AiBadge(),
                ],
              ),
              const Spacer(),
              // 大封面块（渐变占位）
              Container(
                width: 220,
                height: 220,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(24),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [scheme.primary.withValues(alpha: .7), const Color(0xFF1E1B2E)],
                  ),
                ),
                child: const Center(
                    child: Text('🎵', style: TextStyle(fontSize: 72))),
              ),
              const SizedBox(height: 24),
              Text(cur.title.isEmpty ? '未命名作品' : cur.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text(
                [
                  if (cur.mood != null) cur.mood!,
                  ...cur.genres,
                  if (cur.bpm != null) 'BPM ${cur.bpm}',
                ].join(' · '),
                style: const TextStyle(color: Colors.white54),
              ),
              const SizedBox(height: 24),
              // 波形 + 拖拽 seek
              StreamBuilder<Duration>(
                stream: notifier.audio.positionStream,
                builder: (ctx, posSnap) {
                  final pos = posSnap.data ?? Duration.zero;
                  return StreamBuilder<Duration?>(
                    stream: notifier.audio.durationStream,
                    builder: (ctx, durSnap) {
                      final dur = durSnap.data ??
                          Duration(seconds: cur.durationSec.round());
                      final progress = dur.inMilliseconds == 0
                          ? 0.0
                          : pos.inMilliseconds / dur.inMilliseconds;
                      return Column(
                        children: [
                          WaveformCanvas(
                            peaks: peaks,
                            progress: progress,
                            height: 64,
                            barWidth: 3,
                            gap: 3,
                            onSeek: (frac) => notifier.seek(
                                Duration(
                                    milliseconds:
                                        (dur.inMilliseconds * frac).round())),
                          ),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 2),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text(_fmt(pos),
                                    style: const TextStyle(
                                        fontSize: 12, color: Colors.white54)),
                                Text(_fmt(dur),
                                    style: const TextStyle(
                                        fontSize: 12, color: Colors.white54)),
                              ],
                            ),
                          ),
                        ],
                      );
                    },
                  );
                },
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IconButton(
                      iconSize: 40,
                      onPressed: notifier.prev,
                      icon: const Icon(Icons.skip_previous_rounded)),
                  const SizedBox(width: 12),
                  StreamBuilder<bool>(
                    stream: notifier.audio.playingStream,
                    initialData: st.playing,
                    builder: (ctx, snap) {
                      final playing = snap.data ?? st.playing;
                      return FilledButton(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(76, 76),
                          shape: const CircleBorder(),
                        ),
                        onPressed: notifier.toggle,
                        child: Icon(
                          playing
                              ? Icons.pause_rounded
                              : Icons.play_arrow_rounded,
                          size: 40,
                        ),
                      );
                    },
                  ),
                  const SizedBox(width: 12),
                  IconButton(
                      iconSize: 40,
                      onPressed: notifier.next,
                      icon: const Icon(Icons.skip_next_rounded)),
                ],
              ),
              const Spacer(),
              // 队列缩略列表
              SizedBox(
                height: 72,
                child: ListView.builder(
                  scrollDirection: Axis.horizontal,
                  itemCount: st.queue.length,
                  itemBuilder: (ctx, i) {
                    final w = st.queue[i];
                    final active = i == st.index;
                    return Padding(
                      padding: const EdgeInsets.only(right: 10),
                      child: ChoiceChip(
                        label: SizedBox(
                          width: 110,
                          child: Text(w.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis),
                        ),
                        selected: active,
                        onSelected: (_) =>
                            notifier.playQueue(st.queue, i),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }
}
