import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'creation_state.dart';
import 'creation_ui.dart';
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
    final isKeyboardOpen =
        keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    final shortScreen = MediaQuery.sizeOf(context).height < 640;
    return SafeArea(
      bottom: false,
      child: Stack(
        children: [
          const CreationBackdrop(),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
            child: Column(
              children: [
                if (!isKeyboardOpen && !shortScreen) ...[
                  Row(
                    children: [
                      Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          gradient: const LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [
                              CreationPalette.cyan,
                              CreationPalette.blue,
                            ],
                          ),
                          borderRadius: BorderRadius.circular(10),
                          boxShadow: [
                            BoxShadow(
                              color:
                                  CreationPalette.cyan.withValues(alpha: .18),
                              blurRadius: 14,
                            ),
                          ],
                        ),
                        child: const Icon(
                          Icons.graphic_eq_rounded,
                          color: Colors.white,
                          size: 19,
                        ),
                      ),
                      const SizedBox(width: 10),
                      const Expanded(
                        child: Text(
                          'MusicBox',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: CreationPalette.text,
                            fontSize: 20,
                            height: 1.1,
                            fontWeight: FontWeight.w800,
                            letterSpacing: -.4,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                ],
                CreationTierTabs(
                  selected: tier,
                  onChanged: (value) =>
                      ref.read(creationProvider.notifier).setTier(value),
                ),
                SizedBox(height: isKeyboardOpen ? 8 : 12),
                Expanded(
                  child: switch (tier) {
                    0 => ShellEasy(keyboardOpen: isKeyboardOpen),
                    1 => ShellStandard(keyboardOpen: isKeyboardOpen),
                    _ => const ShellPro(),
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
