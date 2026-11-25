import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/widgets/ai_badge.dart';
import '../mv_models.dart';
import '../mv_state.dart';
import '../widgets/mv_common.dart';
import '../widgets/mv_theme.dart';

/// 步①选曲：从曲库「我的作品」里挑一首已完成的歌（有音轨）。
/// 卡片展示 标题 / mood / 流派 / 时长 /（歌唱曲 vs 纯音乐）。
class StepWork extends ConsumerStatefulWidget {
  const StepWork({super.key, required this.workId});

  /// 向导 family 键（起始预选项）
  final String? workId;

  @override
  ConsumerState<StepWork> createState() => _StepWorkState();
}

class _StepWorkState extends ConsumerState<StepWork> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(mvCandidatesProvider.notifier).load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(mvWizardProvider(widget.workId));
    final n = ref.read(mvWizardProvider(widget.workId).notifier);
    final cands = ref.watch(mvCandidatesProvider);

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      children: [
        const _StepHint(text: '已制曲是成片唯一音轨真源——选一首满意的歌，MV 为它配画面。'),
        SizedBox(height: 10),
        if (cands.loading && cands.items.isEmpty)
          const MvListSkeleton(count: 3, compact: true)
        else if (cands.error != null)
          _RetryRow(
              text: cands.error!,
              onRetry: () => ref.read(mvCandidatesProvider.notifier).load())
        else if (cands.items.isEmpty)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Center(
              child: Text('曲库还没有已完成的歌，先去「创建」做一首',
                  style: TextStyle(color: context.mvTextMuted)),
            ),
          )
        else
          ...cands.items.map((w) {
            final sel = state.workId == w.id;
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => n.setWork(w),
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(14),
                    color: sel
                        ? Theme.of(context)
                            .colorScheme
                            .primaryContainer
                            .withValues(alpha: .28)
                        : context.mvSurfaceRaised.withValues(alpha: .03),
                    border: Border.all(
                        color: sel
                            ? Theme.of(context).colorScheme.primary
                            : context.mvBorder),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                      w.title.isEmpty ? '未命名作品' : w.title,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                          fontWeight: FontWeight.w700)),
                                ),
                                SizedBox(width: 6),
                                if (w.aiLabel) const AiBadge(small: true),
                              ],
                            ),
                            SizedBox(height: 4),
                            Text(
                              [
                                mvKindLabel(
                                    w.lyrics != null && w.lyrics!.isNotEmpty
                                        ? 'vocal'
                                        : 'instrumental'),
                                if ((w.mood ?? '').isNotEmpty) w.mood!,
                                if (w.genres.isNotEmpty)
                                  w.genres.take(2).join('/'),
                                mvFormatDuration(w.durationSec),
                              ].join(' · '),
                              style: TextStyle(
                                  fontSize: 11.5, color: context.mvTextMuted),
                            ),
                          ],
                        ),
                      ),
                      Icon(
                        sel
                            ? Icons.check_circle_rounded
                            : Icons.circle_outlined,
                        size: 22,
                        color: sel
                            ? Theme.of(context).colorScheme.primary
                            : context.mvTextMuted,
                      ),
                    ],
                  ),
                ),
              ),
            );
          }),
        SizedBox(height: 14),
        const _StepHint(text: '一句话创意（可选，AI 编剧会参考）'),
        SizedBox(height: 6),
        TextField(
          maxLines: 2,
          maxLength: 80,
          onChanged: n.setBrief,
          decoration: InputDecoration(
            hintText: '比如：雨夜霓虹，主角边走边唱',
            isDense: true,
            counterText: '',
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
      ],
    );
  }
}

class _StepHint extends StatelessWidget {
  const _StepHint({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text,
        style:
            TextStyle(fontSize: 12, color: context.mvTextMuted, height: 1.4));
  }
}

class _RetryRow extends StatelessWidget {
  const _RetryRow({required this.text, required this.onRetry});
  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
            child: Text(text,
                style: TextStyle(fontSize: 12, color: context.mvWarning))),
        TextButton(onPressed: onRetry, child: Text('重试')),
      ],
    );
  }
}
