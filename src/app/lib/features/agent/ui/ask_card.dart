import 'package:flutter/material.dart';

import '../../create/creation_ui.dart';
import 'agent_view_model.dart';

/// 主动提问卡（方案 §6.1 / 契约 v5.5.8~⑨）。
///
/// · 每题 2–4 个选项（服务端夹死），**推荐项**用 `recommended_idx` 高亮：
///   cyan 下沿描边 + 一行「AI 推荐」小标（§11.4：不新造"推荐"色）。
/// · 必须能「跳过这题」：跳过 = 按推荐项填（与标准档同一语义），且界面上说清。
/// · 选项自带 `set` 载荷，界面只渲染 label，绝不把参数名/英文标签漏给用户。
/// · 每个可点件都有语义节点；不可点时 `hint` 说清为什么（§11.6）。
class AgentAskCard extends StatelessWidget {
  const AgentAskCard({
    super.key,
    required this.question,
    required this.selectedIdx,
    required this.skipped,
    required this.onSelect,
    required this.onSkip,
    this.enabled = true,
    this.disabledReason,
    this.leading,
  });

  final AgentAskQuestion question;
  final int? selectedIdx;
  final bool skipped;
  final ValueChanged<int> onSelect;
  final VoidCallback? onSkip;
  final bool enabled;
  final String? disabledReason;

  /// 题目上方的引导语（一般是助手说的一句话）。
  final String? leading;

  String get _whyNot => disabledReason ?? '助手还在说话，稍等一下就能选';

  @override
  Widget build(BuildContext context) {
    final rec = question.recommended;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: CreationPalette.raised,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: CreationPalette.border),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  question.title.isEmpty ? '再告诉我一件事' : question.title,
                  style: const TextStyle(
                    color: CreationPalette.text,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w800,
                    height: 1.35,
                  ),
                ),
              ),
              if (rec != null)
                Container(
                  margin: const EdgeInsets.only(left: 8, top: 2),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: CreationPalette.cyan.withValues(alpha: .12),
                    borderRadius: BorderRadius.circular(999),
                    border:
                        Border.all(color: CreationPalette.cyan.withValues(alpha: .35)),
                  ),
                  child: const Text(
                    '有推荐',
                    style: TextStyle(
                      fontSize: 10.5,
                      color: CreationPalette.cyan,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
            ],
          ),
          if ((leading ?? '').isNotEmpty || (question.hint ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                (leading ?? '').trim().isNotEmpty ? leading!.trim() : question.hint!,
                style: const TextStyle(
                  color: CreationPalette.muted,
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final opt in question.options)
                _OptionChip(
                  label: opt.label,
                  selected: selectedIdx == opt.idx,
                  recommended: rec != null && rec.idx == opt.idx,
                  enabled: enabled,
                  disabledReason: _whyNot,
                  questionTitle: question.title,
                  onTap: () => onSelect(opt.idx),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: Text(
                  _statusLine(rec),
                  style: const TextStyle(
                    color: CreationPalette.faint,
                    fontSize: 11.5,
                    height: 1.35,
                  ),
                ),
              ),
              _SkipButton(
                enabled: enabled,
                disabledReason: _whyNot,
                questionTitle: question.title,
                onTap: onSkip,
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _statusLine(AgentAskOption? rec) {
    if (selectedIdx != null) {
      final l = question.optionAt(selectedIdx!)?.label;
      return l == null ? '已选好了' : '你选了「$l」';
    }
    if (skipped) {
      return rec == null
          ? '这题先跳过，按常规做法来'
          : '已跳过，先用推荐的「${rec.label}」，随时能改';
    }
    return rec == null ? '选一个，或者跳过' : '选一个，或直接跳过用推荐的「${rec.label}」';
  }
}

class _OptionChip extends StatelessWidget {
  const _OptionChip({
    required this.label,
    required this.selected,
    required this.recommended,
    required this.enabled,
    required this.disabledReason,
    required this.questionTitle,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final bool recommended;
  final bool enabled;
  final String disabledReason;
  final String questionTitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = recommended ? CreationPalette.cyan : CreationPalette.violet;
    final foreground = selected
        ? CreationPalette.text
        : (recommended ? CreationPalette.cyan : CreationPalette.muted);
    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      hint: enabled ? null : disabledReason,
      label: '选项：$label${recommended ? '（AI 推荐）' : ''}',
      child: Opacity(
        opacity: enabled ? 1 : .4,
        child: Material(
          color: selected
              ? accent.withValues(alpha: .16)
              : CreationPalette.field.withValues(alpha: .6),
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: enabled ? onTap : null,
            child: Container(
              constraints: const BoxConstraints(minHeight: 40, minWidth: 76),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: selected
                      ? accent.withValues(alpha: .55)
                      : CreationPalette.border,
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (selected) ...[
                        Icon(Icons.check_rounded, size: 14, color: accent),
                        const SizedBox(width: 5),
                      ],
                      Flexible(
                        child: Text(
                          label,
                          style: TextStyle(
                            color: foreground,
                            fontSize: 13.5,
                            fontWeight:
                                selected ? FontWeight.w800 : FontWeight.w600,
                            height: 1.2,
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (recommended)
                    Container(
                      margin: const EdgeInsets.only(top: 5),
                      height: 2,
                      width: 26,
                      decoration: BoxDecoration(
                        color: CreationPalette.cyan.withValues(alpha: .8),
                        borderRadius: BorderRadius.circular(2),
                      ),
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

class _SkipButton extends StatelessWidget {
  const _SkipButton({
    required this.enabled,
    required this.disabledReason,
    required this.questionTitle,
    required this.onTap,
  });

  final bool enabled;
  final String disabledReason;
  final String questionTitle;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final live = enabled && onTap != null;
    return Semantics(
      button: true,
      enabled: live,
      hint: live ? null : disabledReason,
      label: '跳过这题：$questionTitle',
      child: Opacity(
        opacity: live ? 1 : .4,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: live ? onTap : null,
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '跳过这题',
                    style: TextStyle(
                      color: CreationPalette.muted,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  SizedBox(width: 3),
                  Icon(Icons.chevron_right_rounded,
                      size: 15, color: CreationPalette.faint),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 主动提问卡片区：至多 3 题，与聊天流**同屏**（不是弹层、不是分步向导）。
class AgentAskSection extends StatelessWidget {
  const AgentAskSection({
    super.key,
    required this.state,
    required this.controller,
    this.maxQuestions = kAgentAskBudget,
  });

  final AgentUiState state;
  final AgentUiController controller;
  final int maxQuestions;

  @override
  Widget build(BuildContext context) {
    final qs = state.questions.length <= maxQuestions
        ? state.questions
        : state.questions.sublist(0, maxQuestions);
    if (qs.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        CreationSectionLabel(
          '先定这几件事',
          trailing: state.unansweredCount == 0
              ? '都齐了'
              : '还差 ${state.unansweredCount} 题',
        ),
        if ((state.askLead ?? '').isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              state.askLead!,
              style: const TextStyle(
                color: CreationPalette.muted,
                fontSize: 12.5,
                height: 1.4,
              ),
            ),
          ),
        for (var i = 0; i < qs.length; i++) ...[
          AgentAskCard(
            key: ValueKey('ask_${qs[i].qIdx}'),
            question: qs[i],
            selectedIdx: state.answers[qs[i].qIdx],
            skipped: state.skipped.contains(qs[i].qIdx),
            enabled: !state.askLocked && !state.busy,
            disabledReason: state.askLocked
                ? '已经交给你拍板过了，这一轮不再改'
                : '助手还在说话，说完就能选',
            leading: i == 0 ? state.askLead : null,
            onSelect: (optIdx) => controller.selectOption(qs[i].qIdx, optIdx),
            onSkip: state.skipped.contains(qs[i].qIdx)
                ? null
                : () => controller.skipQuestion(qs[i].qIdx),
          ),
          const SizedBox(height: 10),
        ],
      ],
    );
  }
}
