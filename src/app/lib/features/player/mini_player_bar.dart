import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/widgets/waveform_canvas.dart';
import 'player_page.dart';
import 'player_provider.dart';

/// 全局常驻迷你播放条（底部导航上方）
class MiniPlayerBar extends ConsumerWidget {
  const MiniPlayerBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(playerProvider);
    final cur = st.current;
    if (cur == null) return const SizedBox.shrink();
    final notifier = ref.read(playerProvider.notifier);
    final peaks = pseudoPeaks(cur.id, n: 28);
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainerHigh,
      child: SafeArea(
        top: false,
        child: InkWell(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const PlayerPage()),
          ),
          child: SizedBox(
            height: 56,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 84,
                    child: WaveformCanvas(peaks: peaks, height: 30, barWidth: 2, gap: 2),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(cur.title.isEmpty ? '未命名作品' : cur.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w600)),
                        const Text('AI 生成 · MusicBox',
                            style: TextStyle(fontSize: 11, color: Colors.white54)),
                      ],
                    ),
                  ),
                  IconButton(
                    iconSize: 22,
                    onPressed: notifier.prev,
                    icon: const Icon(Icons.skip_previous_rounded),
                  ),
                  IconButton(
                    iconSize: 30,
                    onPressed: notifier.toggle,
                    icon: Icon(st.playing
                        ? Icons.pause_circle_filled_rounded
                        : Icons.play_circle_filled_rounded),
                  ),
                  IconButton(
                    iconSize: 22,
                    onPressed: notifier.next,
                    icon: const Icon(Icons.skip_next_rounded),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
