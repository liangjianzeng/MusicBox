import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../creation/tier_config.dart';
import 'creation_state.dart';
import 'creation_ui.dart';
import 'shell_easy.dart';
import 'shell_pro.dart';
import 'shell_replica.dart';
import 'shell_standard.dart';

/// 创建页：顶部档位条**数据驱动**（简约/标准/深度/复刻/智能体，灰度决定谁出现），
/// 同一 CreationSession 状态树。契约 v5.5.15 + v5.7.2：tier 是持久化身份、显示顺序
/// 由 `CreationTiers.visible(...)` 给出；本页就是 tier_config 的接线收口点 ——
/// 此前 tabs 硬编三档、`resolveStoredTier` 零调用点，残留 tier=3 会静默落进深度档。
class CreatePage extends ConsumerWidget {
  const CreatePage({super.key, this.keyboardOpen});

  final bool? keyboardOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final creation = ref.watch(creationProvider);
    final tier = creation.tier;
    final rc = ref.watch(remoteConfigProvider);
    final specs = CreationTiers.visible(
      cocreateEnabled: cocreateEnabledOf(rc),
      replicaEnabled: replicaEnabledOf(rc),
    );
    final isKeyboardOpen =
        keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    final shortScreen = MediaQuery.sizeOf(context).height < 640;

    // 残留不可见档位（灰度关闭后的 tier=3/4、或越界值）：渲染回落简约，并把持久化
    // 一次性拉回 —— postFrame 里改状态，不在 build 途中动 provider。
    var selectedIndex = specs.indexWhere((s) => s.tier == tier);
    if (selectedIndex == -1) {
      selectedIndex = 0;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(creationProvider.notifier).setTier(CreationTiers.tierEasy);
      });
    }
    final currentTier = specs[selectedIndex].tier;

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
                  const SizedBox(height: 16),
                ],
                CreationTierTabs(
                  specs: specs,
                  selected: selectedIndex,
                  onChanged: (index) => ref
                      .read(creationProvider.notifier)
                      .setTier(specs[index].tier),
                ),
                SizedBox(height: isKeyboardOpen ? 8 : 12),
                Expanded(
                  child: switch (currentTier) {
                    CreationTiers.tierEasy =>
                      ShellEasy(keyboardOpen: isKeyboardOpen),
                    CreationTiers.tierStandard =>
                      ShellStandard(keyboardOpen: isKeyboardOpen),
                    CreationTiers.tierReplica => ShellReplica(),
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
