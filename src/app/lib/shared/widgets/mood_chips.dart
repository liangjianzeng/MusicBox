import 'package:flutter/material.dart';

import '../../features/create/style_options.dart';
import 'tag_chip.dart';

/// 常用心情预设（与服务端词典同源，见 style_options.dart / 契约 v3.2）
/// 以前这里硬编 12 个、服务端词典另有一份 24 个，选「激昂/未来感」这类词
/// 服务端 dict.scan 命中不到 → BPM/tags 补全静默失效。现在只有一份定义。
final List<String> kMoodOptions =
    kMoodCatalog.map((e) => e.zh).toList(growable: false);

/// 常用流派预设（同上，18 项与词典同构）
final List<String> kGenreOptions =
    kGenreCatalog.map((e) => e.zh).toList(growable: false);

/// 心情/流派多选 chips（推荐项可高亮）
class MoodChips extends StatelessWidget {
  const MoodChips({
    super.key,
    required this.options,
    required this.selected,
    required this.onChanged,
    this.single = false,
    this.recommended = const [],
  });

  final List<String> options;
  final List<String> selected;
  final ValueChanged<List<String>> onChanged;
  final bool single;

  /// 推荐项（如意图卡假设的流派），显示星标
  final List<String> recommended;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 7,
      runSpacing: 7,
      children: options.map((o) {
        final isSel = selected.contains(o);
        final isRec = recommended.contains(o);
        return TagChip(
          label: Text(isRec && !isSel ? '$o ★' : o),
          selected: isSel,
          onTap: () {
            if (single) {
              onChanged(isSel ? const [] : [o]);
            } else {
              final next = [...selected];
              if (isSel) {
                next.remove(o);
              } else {
                next.add(o);
              }
              onChanged(next);
            }
          },
        );
      }).toList(),
    );
  }
}
