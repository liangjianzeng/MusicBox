import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import 'mv_detail_page.dart';
import 'mv_models.dart';
import 'mv_progress_page.dart';
import 'mv_state.dart';
import 'mv_wizard_page.dart';
import 'widgets/mv_common.dart';
import 'widgets/mv_task_chip.dart';
import 'widgets/mv_theme.dart';

/// MV tab：我的 MV 列表（进度中/已完成）+ 头部「＋ 新 MV」+ 曲库候选卡。
class MvPage extends ConsumerStatefulWidget {
  const MvPage({super.key});

  @override
  ConsumerState<MvPage> createState() => _MvPageState();
}

class _MvPageState extends ConsumerState<MvPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(mvProjectsProvider.notifier).load();
      ref.read(mvCandidatesProvider.notifier).load();
    });
  }

  void _openWizard({String? workId, int initialStep = 0}) {
    MvWizardPage.push(context, workId: workId, initialStep: initialStep);
  }

  @override
  Widget build(BuildContext context) {
    final rc = ref.watch(remoteConfigProvider);
    if (rc != null && !rc.mvEnabled) {
      return const SafeArea(
        bottom: false,
        child: MvEmptyView(
          icon: Icons.movie_creation_outlined,
          text: 'MV 剧场暂未开放\n该功能正在灰度中，敬请期待',
        ),
      );
    }
    final list = ref.watch(mvProjectsProvider);
    final cands = ref.watch(mvCandidatesProvider);
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: () async {
          await ref.read(mvProjectsProvider.notifier).load();
          await ref.read(mvCandidatesProvider.notifier).load();
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            Row(
              children: [
                Text(
                  'MV 剧场',
                  style: context.mvText.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: context.mvTextPrimary,
                  ),
                ),
                const Spacer(),
                FilledButton.icon(
                  onPressed: () => _openWizard(),
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('新 MV'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              '给好歌配大片：选曲 → 选角 → 定妆 → 剧本 → 开机 → 成片',
              style: context.mvText.bodySmall?.copyWith(
                color: context.mvTextSecondary,
              ),
            ),
            const SizedBox(height: 14),
            const MvSectionTitle('我的 MV'),
            const SizedBox(height: 8),
            if (list.loading && list.items.isEmpty)
              const MvListSkeleton()
            else if (list.error != null)
              MvNotice(
                icon: Icons.cloud_off_outlined,
                color: context.mvWarning,
                text: list.error!,
                action: TextButton(
                  onPressed: () => ref.read(mvProjectsProvider.notifier).load(),
                  child: const Text('重试'),
                ),
              ),
            if (list.items.isEmpty && !list.loading && list.error == null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Text(
                  '还没有 MV，从下面挑一首歌开拍',
                  style: context.mvText.bodyMedium?.copyWith(
                    color: context.mvTextSecondary,
                  ),
                ),
              ),
            ...list.items.map((mv) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _MvCard(mv),
                )),
            if (list.cursor != null)
              Center(
                child: TextButton(
                  onPressed: () =>
                      ref.read(mvProjectsProvider.notifier).loadMore(),
                  child: const Text('加载更多'),
                ),
              ),
            const SizedBox(height: 10),
            const MvSectionTitle('从曲库开一部'),
            const SizedBox(height: 8),
            if (cands.loading && cands.items.isEmpty)
              const MvListSkeleton(count: 2, compact: true)
            else if (cands.error != null)
              MvNotice(
                icon: Icons.cloud_off_outlined,
                color: context.mvWarning,
                text: cands.error!,
                action: TextButton(
                  onPressed: () =>
                      ref.read(mvCandidatesProvider.notifier).load(),
                  child: const Text('重试'),
                ),
              ),
            if (cands.items.isEmpty && !cands.loading && cands.error == null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Text(
                  '曲库还没有已完成的歌，先去「创建」做一首',
                  style: context.mvText.bodyMedium?.copyWith(
                    color: context.mvTextSecondary,
                  ),
                ),
              ),
            ...cands.items.map((w) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    tileColor: context.mvSurface,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                      side: BorderSide(color: context.mvBorder),
                    ),
                    leading: const _SongIcon(),
                    title: Text(
                      w.title.isEmpty ? '未命名作品' : w.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(
                      [
                        mvKindLabel(w.lyrics != null && w.lyrics!.isNotEmpty
                            ? 'vocal'
                            : 'instrumental'),
                        if (w.mood != null) w.mood!,
                        if (w.genres.isNotEmpty) w.genres.take(2).join('/'),
                        mvFormatDuration(w.durationSec),
                      ].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.mvText.bodySmall?.copyWith(
                        color: context.mvTextSecondary,
                      ),
                    ),
                    trailing: Icon(
                      Icons.movie_creation_outlined,
                      size: 20,
                      color: context.mvTextSecondary,
                      semanticLabel: '为这首歌创建 MV',
                    ),
                    onTap: () => _openWizard(workId: w.id, initialStep: 0),
                  ),
                )),
          ],
        ),
      ),
    );
  }
}

class _SongIcon extends StatelessWidget {
  const _SongIcon();

  @override
  Widget build(BuildContext context) {
    final scheme = context.mvColors;
    return Container(
      width: 38,
      height: 38,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        gradient: LinearGradient(colors: [
          scheme.primary.withValues(alpha: 0.6),
          scheme.tertiary.withValues(alpha: 0.45),
        ]),
      ),
      child: Icon(
        Icons.music_note,
        size: 18,
        color: scheme.onPrimaryContainer,
        semanticLabel: '歌曲',
      ),
    );
  }
}

/// 我的 MV 卡：标题/状态/时长 + 完成播片或进度入口。
class _MvCard extends StatelessWidget {
  const _MvCard(this.mv);
  final MvSummary mv;

  bool get canResume => const {'drafting', 'casting', 'scripting', 'previewed'}
      .contains(mv.status);

  void _open(BuildContext context) {
    if (canResume) {
      MvWizardPage.push(context, workId: mv.workId, projectId: mv.id);
    } else if (mv.status == 'ready') {
      MvDetailPage.push(context, mvId: mv.id);
    } else {
      MvProgressPage.push(context, projectId: mv.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final done = mv.status == 'ready';
    final title = mv.title.isEmpty ? '未命名 MV' : mv.title;
    return Semantics(
      button: true,
      label: '$title，${mvProjectStatusLabel(mv.status)}',
      hint: canResume ? '继续创作' : (done ? '查看成片详情' : '查看制作进度'),
      child: MvSurfaceCard(
        borderRadius: 16,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => _open(context),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.mvText.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: context.mvTextPrimary,
                      ),
                    ),
                  ),
                  MvProjectChip(status: mv.status),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${mvKindLabel(mv.kind)} · ${mvFormatDuration(mv.durationSec)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.mvText.bodySmall?.copyWith(
                        color: context.mvTextSecondary,
                      ),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () => _open(context),
                    icon: Icon(
                      done
                          ? Icons.play_circle_outline
                          : canResume
                              ? Icons.edit_note_outlined
                              : Icons.local_movies_outlined,
                      size: 18,
                    ),
                    label: Text(canResume ? '继续创作' : (done ? '看成片' : '看进度')),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
