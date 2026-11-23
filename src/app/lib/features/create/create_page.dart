import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import 'creation_state.dart';
import 'shell_easy.dart';
import 'shell_pro.dart';
import 'shell_standard.dart';

/// 创建页：顶部 🧸傻瓜 / 🎚标准 / 🎛深度 三档切换（同一 CreationSession 状态树）
class CreatePage extends ConsumerWidget {
  const CreatePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tier = ref.watch(creationProvider).tier;
    final credits = ref.watch(sessionProvider).credits;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
            child: Row(
              children: [
                const Text('MusicBox',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                const Spacer(),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: Colors.amber.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text('⚡ ${credits?.balance ?? '--'} 积分',
                      style: const TextStyle(
                          color: Colors.amberAccent,
                          fontSize: 12,
                          fontWeight: FontWeight.w600)),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 0, label: Text('🧸 傻瓜'), icon: null),
                ButtonSegment(value: 1, label: Text('🎚 标准')),
                ButtonSegment(value: 2, label: Text('🎛 深度')),
              ],
              selected: {tier},
              onSelectionChanged: (s) =>
                  ref.read(creationProvider.notifier).setTier(s.first),
              showSelectedIcon: false,
            ),
          ),
          Expanded(
            child: switch (tier) {
              0 => const ShellEasy(),
              1 => const ShellStandard(),
              _ => const ShellPro(),
            },
          ),
        ],
      ),
    );
  }
}
