import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/widgets/tag_chip.dart';
import 'creation_ui.dart';
import 'style_options.dart';

/// 风格选择器：把原来那个说不清的「标签（逗号分隔）：如 city pop, retro, synth」
/// 自由文本框，换成两组看得懂的中文选择项——
///  · 曲风（流派）：18 项，最多 3 个
///  · 风格点缀：24 项（乐器/质感/人声质感等），最多 6 个
/// 括注英文规范词只是让用户知道"我这条会变成模型听到的什么词"。
/// 提交值一律是规范词（wire）；目录外的自由补充另走 [FreeTagField]，
/// 且**不占**上面的配额（自己写的词不该挤掉可选项）。
class StylePicker extends ConsumerWidget {
  const StylePicker({
    super.key,
    required this.selected,
    required this.onChanged,
    this.maxGenres = 3,
    this.maxStyleWords = 6,
  });

  /// 已选规范词（wire 值，含用户自由补充的词）
  final List<String> selected;
  final ValueChanged<List<String>> onChanged;
  final int maxGenres;
  final int maxStyleWords;

  static bool _has(List<String> tags, String wire) =>
      tags.any((t) => t.toLowerCase() == wire.toLowerCase());

  /// 只数「本组目录内的词」——自由补充与其他组都不占配额
  static int _groupCount(List<StyleOption> options, List<String> tags) {
    final wires = options.map((o) => o.wire.toLowerCase()).toSet();
    return tags.where((t) => wires.contains(t.toLowerCase())).length;
  }

  void _toggle(
    BuildContext context,
    List<StyleOption> options,
    String wire,
    bool on,
    int max,
    String groupLabel,
  ) {
    final next = [...selected];
    if (on) {
      if (_has(next, wire)) return;
      if (_groupCount(options, next) >= max) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('$groupLabel最多选 $max 个，先取消一个再选'),
          duration: const Duration(seconds: 2),
        ));
        return;
      }
      next.add(wire);
    } else {
      next.removeWhere((t) => t.toLowerCase() == wire.toLowerCase());
    }
    onChanged(next);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cat = styleCatalogOf(ref);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Group(
          title: '曲风',
          options: cat.genres,
          selected: selected,
          max: maxGenres,
          groupLabel: '曲风',
          onToggle: (wire, on) =>
              _toggle(context, cat.genres, wire, on, maxGenres, '曲风'),
        ),
        const SizedBox(height: 12),
        _Group(
          title: '风格点缀',
          options: cat.styleWords,
          selected: selected,
          max: maxStyleWords,
          groupLabel: '风格点缀',
          onToggle: (wire, on) =>
              _toggle(context, cat.styleWords, wire, on, maxStyleWords, '风格点缀'),
        ),
      ],
    );
  }
}

class _Group extends StatelessWidget {
  const _Group({
    required this.title,
    required this.options,
    required this.selected,
    required this.max,
    required this.groupLabel,
    required this.onToggle,
  });

  final String title;
  final List<StyleOption> options;
  final List<String> selected;
  final int max;
  final String groupLabel;
  final void Function(String wire, bool on) onToggle;

  @override
  Widget build(BuildContext context) {
    final picked = StylePicker._groupCount(options, selected);
    final full = picked >= max;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 6,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text('$title（最多 $max 个）',
                style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                    color: CreationPalette.muted)),
            if (picked > 0)
              Text('$picked/$max',
                  style: const TextStyle(
                      fontSize: 11, color: CreationPalette.violetBright)),
          ],
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: options.map((o) {
            final sel = StylePicker._has(selected, o.wire);
            final disabled = !sel && full;
            final showEn = o.en != null && o.en!.isNotEmpty && o.en != o.zh;
            return TagChip(
              label: showEn
                  ? Text.rich(TextSpan(children: [
                      TextSpan(text: o.zh),
                      TextSpan(
                        text: ' ${o.en}',
                        style: const TextStyle(
                          fontSize: 10,
                          color: CreationPalette.faint,
                        ),
                      ),
                    ]))
                  : Text(o.zh),
              selected: sel,
              enabled: !disabled,
              onTap: () => onToggle(o.wire, !sel),
            );
          }).toList(),
        ),
      ],
    );
  }
}

/// 自由补充框（保留给深度用户的逃生口）：目录里没有的词按逗号分隔原样透传。
/// 文案说清"这是给模型的额外风格提示，不用懂英文"。
class FreeTagField extends StatelessWidget {
  const FreeTagField({
    super.key,
    required this.controller,
    required this.onChanged,
    this.label = '还有别的说法？自己补（可选）',
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Text(label,
              style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                  color: CreationPalette.muted)),
        ),
        TextField(
          controller: controller,
          onChanged: onChanged,
          style: const TextStyle(color: CreationPalette.text),
          decoration: creationFieldDecoration(
            hint: '用逗号分开，如：城市流行、说唱感、童声合唱',
            helper: '上面没列到的风格，中文英文都能填（词典里有的会自动翻成模型词）',
            dense: true,
          ),
        ),
      ],
    );
  }
}

/// 灵感示例 chips（简约档：用户不知道写什么时，点一下就填上）
class InspirationChips extends StatelessWidget {
  const InspirationChips({
    super.key,
    this.samples = kInspirationSamples,
    required this.onPick,
  });

  final List<String> samples;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 82,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        padding: EdgeInsets.zero,
        itemCount: samples.length,
        separatorBuilder: (_, __) => const SizedBox(width: 10),
        itemBuilder: (context, index) {
          final sample = samples[index];
          return SizedBox(
            width: 166,
            child: Material(
              color: CreationPalette.raised,
              borderRadius: BorderRadius.circular(18),
              child: InkWell(
                borderRadius: BorderRadius.circular(18),
                onTap: () => onPick(sample),
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: CreationPalette.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Text(
                            '0${index + 1}',
                            style: const TextStyle(
                              color: CreationPalette.violetBright,
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.2,
                            ),
                          ),
                          const Spacer(),
                          const Icon(Icons.north_east_rounded,
                              size: 15, color: CreationPalette.faint),
                        ],
                      ),
                      Text(
                        sample,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: CreationPalette.text,
                          fontSize: 14,
                          height: 1.25,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
