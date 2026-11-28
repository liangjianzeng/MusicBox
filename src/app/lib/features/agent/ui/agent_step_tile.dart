import 'package:flutter/material.dart';

import '../../create/creation_ui.dart';
import 'agent_view_model.dart';

/// 助手气泡（§11.4：MusicBox 设计系统重建，配色一律 [CreationPalette]）。
///
/// 注：P7 把 `assistant_surface.dart:664` 的 `_MessageBubble` 提成公共件后，
/// 这个应与那个合并成一份；现在先各自存在，避免本次改动去动别人的文件。
class AgentChatBubble extends StatelessWidget {
  const AgentChatBubble({super.key, required this.entry});

  final AgentChatEntry entry;

  @override
  Widget build(BuildContext context) {
    switch (entry.role) {
      case AgentEntryRole.user:
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            constraints: const BoxConstraints(maxWidth: 320),
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
            decoration: BoxDecoration(
              color: CreationPalette.violet.withValues(alpha: .16),
              borderRadius: BorderRadius.circular(14),
              border:
                  Border.all(color: CreationPalette.violet.withValues(alpha: .3)),
            ),
            child: Text(
              entry.text,
              style: const TextStyle(
                color: CreationPalette.text,
                fontSize: 13.5,
                height: 1.45,
              ),
            ),
          ),
        );
      case AgentEntryRole.notice:
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.info_outline_rounded,
                  size: 13, color: CreationPalette.faint),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  entry.text,
                  style: const TextStyle(
                    color: CreationPalette.faint,
                    fontSize: 11.5,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
        );
      case AgentEntryRole.assistant:
        return Align(
          alignment: Alignment.centerLeft,
          child: Container(
            constraints: const BoxConstraints(maxWidth: 340),
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
            decoration: BoxDecoration(
              color: CreationPalette.raised,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: CreationPalette.border),
            ),
            // 模型按 markdown 写，我们按纯文本渲染，等于把源码甩给用户看：真机（小米13
            // 2026-11-28）截图里助手原样打出「**1. 情绪基调**」、句尾还挂着「**」。
            // 只渲染成对的 **加粗**；落单的星号吞掉（流式尾巴只出一半是常态，露半个星号
            // 比没格式更像 bug）。**用户气泡不这么做** —— 那是用户自己打的字，星号归他。
            child: Text.rich(
              TextSpan(
                children: agentMarkdownSpans(
                  entry.text,
                  base: const TextStyle(
                    color: CreationPalette.text,
                    fontSize: 13.5,
                    height: 1.45,
                  ),
                ),
              ),
            ),
          ),
        );
    }
  }
}

/// 「助手在想」占位：只说它在想，绝不把思考原文（reasoning）当回复上屏。
class AgentThinkingTile extends StatelessWidget {
  const AgentThinkingTile({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          const SizedBox(
            width: 13,
            height: 13,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: const TextStyle(
                color: CreationPalette.muted,
                fontSize: 12.5,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 步骤流（§11.4：替代 TongYi-Lite 的 agent_workflow / turn_clock）。
/// 令牌色状态点：green=办完 · cyan=正在办 · amber=等你点头 · faint=没做。
/// 助手气泡的 markdown-lite：只认成对的 `**加粗**`，其余星号一律吞掉。
///
/// 为什么要专门写这个：模型的回答是按 markdown 写的（真机实录「就按这三条来：**安静专注 /
/// 纯音乐（无人声）/ Lo-fi**」），而气泡原来是裸 `Text` —— 星号被原样念出来，用户看到的是
/// 源码而不是话。落单的星号必须吞：流式输出尾巴上只写出一半 `**` 是常态。
List<InlineSpan> agentMarkdownSpans(String src, {required TextStyle base}) {
  final re = RegExp(r'\*\*([^*]+)\*\*');
  final out = <InlineSpan>[];
  var last = 0;
  for (final m in re.allMatches(src)) {
    if (m.start > last) {
      out.add(TextSpan(text: src.substring(last, m.start), style: base));
    }
    out.add(TextSpan(
      text: m.group(1),
      style: base.copyWith(fontWeight: FontWeight.w700),
    ));
    last = m.end;
  }
  if (last < src.length) {
    out.add(TextSpan(
      text: src.substring(last).replaceAll('*', ''),
      style: base,
    ));
  }
  return out;
}

class AgentStepTile extends StatelessWidget {
  const AgentStepTile({super.key, required this.step});

  final AgentStep step;

  (Color, String) get _dot {
    switch (step.state) {
      case AgentStepState.done:
        return (CreationPalette.green, '办好了');
      case AgentStepState.running:
        return (CreationPalette.cyan, '正在办');
      case AgentStepState.awaiting:
        return (CreationPalette.amber, '等你确认');
      case AgentStepState.skipped:
        return (CreationPalette.faint, '没做');
    }
  }

  @override
  Widget build(BuildContext context) {
    final (color, stateLabel) = _dot;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        label: '${step.label}，$stateLabel',
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 5, right: 8),
              child: Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                ),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    step.label,
                    style: const TextStyle(
                      color: CreationPalette.muted,
                      fontSize: 12.5,
                      height: 1.35,
                    ),
                  ),
                  if ((step.detail ?? '').isNotEmpty)
                    Text(
                      step.detail!,
                      style: const TextStyle(
                        color: CreationPalette.faint,
                        fontSize: 11.5,
                        height: 1.35,
                      ),
                    ),
                ],
              ),
            ),
            Text(
              stateLabel,
              style: TextStyle(fontSize: 10.5, color: color),
            ),
          ],
        ),
      ),
    );
  }
}

/// 步骤流容器：没有步骤就不占位。
class AgentStepFlow extends StatelessWidget {
  const AgentStepFlow({super.key, required this.steps});
  final List<AgentStep> steps;

  @override
  Widget build(BuildContext context) {
    if (steps.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(11, 9, 11, 5),
        decoration: BoxDecoration(
          color: CreationPalette.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: CreationPalette.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final s in steps) AgentStepTile(step: s),
          ],
        ),
      ),
    );
  }
}

/// 会话空态：必须给出路（§11.5），不许只留一句"暂无内容"。
///
/// 三条建议**全是要干活的事**（2026-11-28 产品拍板）：这里原来有一条「这次要花多少积分？」，
/// 等于我们主动把用户往钱上引 —— 活还没干就先谈价，是计费台不是产品。想问价的人自己会打字问，
/// 我们不摆在门面上。
class AgentChatEmpty extends StatelessWidget {
  const AgentChatEmpty({
    super.key,
    required this.onPrompt,
    this.prompts = const [
      '来一首深夜加班听的歌',
      '把刚才那首改得慢一点',
      '换个风格再来一版',
    ],
  });

  final ValueChanged<String> onPrompt;
  final List<String> prompts;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '想到什么说什么，我来把这首歌拼齐。',
          style: TextStyle(
            color: CreationPalette.muted,
            fontSize: 13,
            height: 1.45,
          ),
        ),
        const SizedBox(height: 9),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final p in prompts)
              Semantics(
                button: true,
                label: '照这句开始：$p',
                child: Material(
                  color: CreationPalette.field.withValues(alpha: .7),
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => onPrompt(p),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 8),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.north_east_rounded,
                              size: 12, color: CreationPalette.cyan),
                          const SizedBox(width: 5),
                          Text(
                            p,
                            style: const TextStyle(
                              color: CreationPalette.muted,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}
