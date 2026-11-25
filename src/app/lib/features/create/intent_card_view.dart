import 'package:flutter/material.dart';

import '../../core/models.dart' as mdl;
import 'style_options.dart';

/// 意图卡：mood chips / scene / 流派假设 / confidence 条 / questions，均可点改
/// maxQuestions：简约级只显第 1 题；标准级显全部
/// 「可点改」必须回传服务端（契约 v2.19 PATCH /v1/intent/:id）：本组件只出回调，
/// 落库与保存状态由 IntentFlowPanel 负责（headerTrailing 显示保存态）。
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
    this.onGenreToggled,
    this.selectedGenres,
    this.moodSuggestions = const [],
    this.onSceneDescEdited,
    this.headerTrailing,
  });

  final mdl.Intent intent;
  final int? maxQuestions;
  final Map<int, int> answers; // q_idx -> option_idx
  final void Function(int qIdx, int optionIdx)? onAnswer;
  final void Function(int qIdx)? onSkipQuestion;
  final ValueChanged<List<String>>? onMoodChanged;
  final VoidCallback? onVocalToggled;

  /// 流派假设点改（取消 = 从流派里剔除；全取消 = 不限流派）
  final void Function(String genre, bool selected)? onGenreToggled;

  /// 已选流派（null = 视全部为已选，用于只读展示）
  final List<String>? selectedGenres;

  /// 可补充的心情预设（卡面假设之外的常见项，点一下即加入 mood）
  final List<String> moodSuggestions;

  /// 改写灵感描述（null = 不显示编辑笔）
  final VoidCallback? onSceneDescEdited;

  /// 卡头右侧的保存态徽标（保存中/已同步/保存失败·重试）
  final Widget? headerTrailing;

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
            Wrap(
              spacing: 6,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Icon(Icons.psychology_alt_outlined,
                    size: 18, color: scheme.primary),
                const Text('AI 推测 · 可点改',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                if (headerTrailing != null) headerTrailing!,
                if (intent.sourceKind == 'voice')
                  const Icon(Icons.record_voice_over_outlined, size: 16)
                else if (intent.sourceKind == 'image')
                  const Icon(Icons.image_outlined, size: 16),
              ],
            ),
            const SizedBox(height: 8),
            // confidence 条 + 低置信引导（低置信直接生成＝拿猜测去花积分）
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
            if (intent.clarifying && intent.confidence < 0.5)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'AI 还不太确定你想听什么——答下面 ${intent.questions.length} 道题会准很多',
                  style:
                      const TextStyle(fontSize: 11, color: Colors.amberAccent),
                ),
              ),
            if (intent.sceneDesc != null && intent.sceneDesc!.isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(intent.sceneDesc!,
                        style: const TextStyle(fontSize: 13, height: 1.4)),
                  ),
                  if (onSceneDescEdited != null)
                    SizedBox(
                      width: 48,
                      height: 48,
                      child: IconButton(
                        onPressed: onSceneDescEdited,
                        tooltip: '修改灵感描述',
                        padding: EdgeInsets.zero,
                        icon: const Icon(Icons.edit_outlined,
                            size: 18, color: Colors.white54),
                      ),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 10),
            // mood chips（点改 + 从预设补选）
            if (intent.mood.isNotEmpty ||
                onMoodChanged != null ||
                moodSuggestions.isNotEmpty)
              _Section(
                label: '心情',
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    ...intent.mood.toSet().map((m) {
                      return FilterChip(
                        label: Text(m),
                        selected: intent.mood.contains(m),
                        onSelected: onMoodChanged == null
                            ? null
                            : (v) {
                                final next = [...intent.mood];
                                if (v) {
                                  if (!next.contains(m)) next.add(m);
                                } else {
                                  next.remove(m);
                                }
                                onMoodChanged!(next);
                              },
                      );
                    }),
                    if (onMoodChanged != null)
                      ...moodSuggestions
                          .where((s) => !intent.mood.contains(s))
                          .take(6)
                          .map((s) => ActionChip(
                                label: Text('+ $s',
                                    style: const TextStyle(fontSize: 12)),
                                visualDensity: VisualDensity.compact,
                                onPressed: () {
                                  final next = [...intent.mood, s];
                                  onMoodChanged!(next.length > 3
                                      ? next.sublist(next.length - 3)
                                      : next);
                                },
                              )),
                  ],
                ),
              ),
            // 流派假设（点选/取消 → 回传；全取消 = 不限流派）
            // 词典兜底出来的假设常是英文 tags（pop/electronic），展示翻回中文，
            // 英文原词括注保留——用户看得懂，排查时也还在
            if (intent.genreHypotheses.isNotEmpty)
              _Section(
                label: onGenreToggled == null ? '流派假设' : '流派假设（点选你要的）',
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: intent.genreHypotheses.map((g) {
                    final zh = StyleCatalog.fallback.zhFor(g);
                    final showEn = zh != g;
                    return FilterChip(
                      label: Text(showEn ? '$zh（$g）' : g,
                          style: const TextStyle(fontSize: 12)),
                      visualDensity: VisualDensity.compact,
                      selected: selectedGenres?.contains(g) ?? true,
                      onSelected: onGenreToggled == null
                          ? null
                          : (v) => onGenreToggled!(g, v),
                    );
                  }).toList(),
                ),
              ),

            _Section(
              label: '演绎方式',
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48),
                child: InkWell(
                  onTap: onVocalToggled,
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_vocalLabel, style: const TextStyle(fontSize: 13)),
                        if (onVocalToggled != null)
                          const Padding(
                            padding: EdgeInsets.only(left: 4),
                            child: Icon(Icons.swap_horiz, size: 14),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (intent.durationHint != null && intent.durationHint!.isNotEmpty)
              _Section(
                  label: '时长倾向',
                  child: Text(intent.durationHint!,
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
