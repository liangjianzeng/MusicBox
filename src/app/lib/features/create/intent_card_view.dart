import 'package:flutter/material.dart';

import '../../core/models.dart' as mdl;

/// 意图卡：mood chips / scene / 流派假设 / confidence 条 / questions，均可点改
/// maxQuestions：傻瓜级只显第 1 题；标准级显全部
class IntentCardView extends StatelessWidget {
  const IntentCardView({
    super.key,
    required this.intent,
    this.maxQuestions,
    this.answers = const {},
    this.onAnswer,
    this.onSkipQuestion,
    this.onMoodChanged,
    this.onVocalToggled,
  });

  final mdl.Intent intent;
  final int? maxQuestions;
  final Map<int, int> answers; // q_idx -> option_idx
  final void Function(int qIdx, int optionIdx)? onAnswer;
  final void Function(int qIdx)? onSkipQuestion;
  final ValueChanged<List<String>>? onMoodChanged;
  final VoidCallback? onVocalToggled;

  String get _vocalLabel => switch (intent.vocal) {
        'song' => '人声演唱',
        'instrumental' => '纯音乐',
        _ => '人声待定',
      };

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final questions = maxQuestions == null
        ? intent.questions
        : intent.questions.take(maxQuestions!).toList();
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.psychology_alt_outlined,
                    size: 18, color: scheme.primary),
                const SizedBox(width: 6),
                const Text('AI 推测 · 可点改',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                const Spacer(),
                if (intent.sourceKind == 'voice')
                  const Icon(Icons.record_voice_over_outlined, size: 16)
                else if (intent.sourceKind == 'image')
                  const Icon(Icons.image_outlined, size: 16),
              ],
            ),
            const SizedBox(height: 8),
            // confidence 条
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: intent.confidence.clamp(0.0, 1.0),
                minHeight: 6,
              ),
            ),
            const SizedBox(height: 2),
            Text('理解置信度 ${(intent.confidence * 100).clamp(0, 100).round()}%',
                style: const TextStyle(fontSize: 11, color: Colors.white54)),
            if (intent.sceneDesc != null && intent.sceneDesc!.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(intent.sceneDesc!,
                  style: const TextStyle(fontSize: 13, height: 1.4)),
            ],
            const SizedBox(height: 10),
            // mood chips（点改）
            if (intent.mood.isNotEmpty || onMoodChanged != null)
              _Section(
                label: '心情',
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: intent.mood.toSet().map((m) {
                    return FilterChip(
                      label: Text(m),
                      selected: intent.mood.contains(m),
                      onSelected: onMoodChanged == null
                          ? null
                          : (v) {
                              final next = [...intent.mood];
                              if (v) {
                                next.add(m);
                              } else {
                                next.remove(m);
                              }
                              onMoodChanged!(next);
                            },
                    );
                  }).toList(),
                ),
              ),
            // 流派假设（点击切换人声/展示）
            if (intent.genreHypotheses.isNotEmpty)
              _Section(
                label: '流派假设',
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: intent.genreHypotheses
                      .map((g) => Chip(
                            label: Text(g, style: const TextStyle(fontSize: 12)),
                            visualDensity: VisualDensity.compact,
                          ))
                      .toList(),
                ),
              ),
            _Section(
              label: '演绎方式',
              child: InkWell(
                onTap: onVocalToggled,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(_vocalLabel,
                        style: const TextStyle(fontSize: 13)),
                    if (onVocalToggled != null)
                      const Padding(
                        padding: EdgeInsets.only(left: 4),
                        child: Icon(Icons.swap_horiz, size: 14),
                      ),
                  ],
                ),
              ),
            ),
            if (intent.durationHint != null &&
                intent.durationHint!.isNotEmpty)
              _Section(label: '时长倾向', child: Text(intent.durationHint!,
                  style: const TextStyle(fontSize: 13))),
            // 澄清题
            ...questions.asMap().entries.map((entry) {
              final q = entry.value;
              final shown = answers[q.qIdx];
              return Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${entry.key + 1}. ${q.q}',
                        style: const TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 14)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: q.options.map((o) {
                        final rec = q.recommendedIdx == o.idx;
                        return ChoiceChip(
                          label: Text(rec ? '${o.label} ★推荐' : o.label),
                          selected: shown == o.idx,
                          onSelected: onAnswer == null
                              ? null
                              : (_) => onAnswer!(q.qIdx, o.idx),
                        );
                      }).toList(),
                    ),
                    if (onSkipQuestion != null && shown == null)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          style: TextButton.styleFrom(
                            visualDensity: VisualDensity.compact,
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                          ),
                          onPressed: () => onSkipQuestion!(q.qIdx),
                          child: const Text('跳过这题',
                              style: TextStyle(fontSize: 12)),
                        ),
                      ),
                  ],
                ),
              );
            }),
            if (intent.consumed)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('这张意图卡已使用过',
                    style: TextStyle(color: Colors.white38, fontSize: 12)),
              ),
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: const TextStyle(
                  fontSize: 11,
                  color: Colors.white38,
                  fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          child,
        ],
      ),
    );
  }
}
