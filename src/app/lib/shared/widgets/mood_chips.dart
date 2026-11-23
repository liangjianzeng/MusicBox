import 'package:flutter/material.dart';

/// 常用心情预设
const kMoodOptions = [
  '欢快', '舒缓', '激昂', '忧郁', '浪漫', '治愈',
  '梦幻', '复古', '未来感', '紧张', '温暖', '孤独',
];

/// 常用流派预设
const kGenreOptions = [
  '流行', '摇滚', '电子', '民谣', '嘻哈', '古典',
  '爵士', 'R&B', '国风', '氛围', '舞曲', '乡村',
];

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
      spacing: 8,
      runSpacing: 6,
      children: options.map((o) {
        final isSel = selected.contains(o);
        final isRec = recommended.contains(o);
        return ChoiceChip(
          label: Text(isRec && !isSel ? '$o ★' : o),
          selected: isSel,
          onSelected: (v) {
            if (single) {
              onChanged(v ? [o] : const []);
            } else {
              final next = [...selected];
              if (v) {
                next.add(o);
              } else {
                next.remove(o);
              }
              onChanged(next);
            }
          },
        );
      }).toList(),
    );
  }
}
