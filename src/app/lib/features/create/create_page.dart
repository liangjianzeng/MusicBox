import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../assistant/assistant_surface.dart';
import 'creation_state.dart';
import 'shell_easy.dart';
import 'shell_pro.dart';
import 'shell_standard.dart';

/// 创建页：顶部 简约 / 标准 / 深度 三档切换（同一 CreationSession 状态树）
class CreatePage extends ConsumerWidget {
  const CreatePage({super.key, this.keyboardOpen});

  final bool? keyboardOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final creation = ref.watch(creationProvider);
    final tier = creation.tier;
    final inspiration = creation.prompt.trim();
    final credits = ref.watch(sessionProvider).credits;
    final isKeyboardOpen =
        keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    final shortScreen = MediaQuery.sizeOf(context).height < 640;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          if (!isKeyboardOpen && !shortScreen)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
              child: Row(
                children: [
                  const Expanded(
                    child: Text('MusicBox',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 20, fontWeight: FontWeight.w800)),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: Colors.amber.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        '⚡ ${credits?.balance ?? '--'} 积分',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Colors.amberAccent,
                            fontSize: 12,
                            fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(
                    value: 0,
                    label: Text('简约'),
                    icon: _TierIcon(Icons.auto_awesome)),
                ButtonSegment(
                    value: 1, label: Text('标准'), icon: _TierIcon(Icons.tune)),
                ButtonSegment(
                    value: 2,
                    label: Text('深度'),
                    icon: _TierIcon(Icons.equalizer)),
              ],
              selected: {tier},
              onSelectionChanged: (s) =>
                  ref.read(creationProvider.notifier).setTier(s.first),
              showSelectedIcon: false,
            ),
          ),
          if (!isKeyboardOpen && !shortScreen)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: AssistantSuggestionCard(
                title: '帮我把灵感说清楚',
                prompt: inspiration.isEmpty
                    ? '请基于当前创作页上下文，帮我把灵感说清楚，给出更具体、可直接创作的描述'
                    : '请基于当前创作页上下文，把下面的灵感整理成更具体、可直接创作的描述：\n$inspiration',
                icon: Icons.edit_note_outlined,
              ),
            ),
          Expanded(
            child: switch (tier) {
              0 => ShellEasy(keyboardOpen: isKeyboardOpen),
              1 => ShellStandard(keyboardOpen: isKeyboardOpen),
              _ => const ShellPro(),
            },
          ),
        ],
      ),
    );
  }
}

/// 三档统一图标：同尺寸、同圆角、同渐变，只换图形——避免 emoji 风格/配色不一
class _TierIcon extends StatelessWidget {
  const _TierIcon(this.icon);

  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 22,
      height: 22,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [scheme.primary, scheme.tertiary],
        ),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Icon(icon, size: 15, color: scheme.onPrimary),
    );
  }
}
