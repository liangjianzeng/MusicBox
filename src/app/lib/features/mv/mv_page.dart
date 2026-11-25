import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import 'mv_detail_page.dart';
import 'mv_models.dart';
import 'mv_reveal_page.dart';
import 'mv_progress_page.dart';
import 'mv_state.dart';
import 'mv_wizard_page.dart';
import 'widgets/mv_task_chip.dart';

/// MV tab：我的 MV 列表（进度中/已完成）+ 头部「＋ 新 MV」+ 曲库候选卡。
/// 候选区直接读既有曲库数据（works(mine) 有音轨者），每张卡即向导入口。
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
    // 后台功能开关/灰度未开放时给友好空态（服务端同样门控，双重保险）
    final rc = ref.watch(remoteConfigProvider);
    if (rc != null && !rc.mvEnabled) {
      return const SafeArea(
        bottom: false,
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.movie_creation_outlined, size: 48, color: Colors.white38),
                SizedBox(height: 12),
                Text('MV 剧场暂未开放',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                SizedBox(height: 6),
                Text('该功能正在灰度中，敬请期待',
                    style: TextStyle(fontSize: 13, color: Colors.white54)),
              ],
            ),
          ),
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
            // 头部
            Row(
              children: [
                const Text('MV 剧场',
                    style:
                        TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                const Spacer(),
                FilledButton.icon(
                  onPressed: () => _openWizard(),
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('新 MV'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text('给好歌配大片：选曲 → 选角 → 定妆 → 剧本 → 开机 → 成片',
                style: TextStyle(fontSize: 12, color: Colors.white38)),
            const SizedBox(height: 14),
            // 我的 MV 列表
            const _SectionTitle('我的 MV'),
            const SizedBox(height: 8),
            if (list.loading && list.items.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 18),
                child: Center(
                    child:
                        SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5))),
              )
            else if (list.error != null)
              _OfflineBanner(
                  text: list.error!, onRetry: () => ref.read(mvProjectsProvider.notifier).load()),
            if (list.items.isEmpty && !list.loading && list.error == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 10),
                child: Text('还没有 MV，从下面挑一首歌开拍',
                    style: TextStyle(color: Colors.white38, fontSize: 13)),
              ),
            ...list.items.map(_MvCard.new).map((w) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: w,
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
            // 曲库候选：每张已完成作品卡 = 向导入口（直达步①）
            const _SectionTitle('从曲库开一部'),
            const SizedBox(height: 8),
            if (cands.loading && cands.items.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 18),
                child: Center(
                    child:
                        SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5))),
              )
            else if (cands.error != null)
              _OfflineBanner(
                  text: cands.error!,
                  onRetry: () => ref.read(mvCandidatesProvider.notifier).load()),
            if (cands.items.isEmpty && !cands.loading && cands.error == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 10),
                child: Text('曲库还没有已完成的歌，先去「创建」做一首',
                    style: TextStyle(color: Colors.white38, fontSize: 13)),
              ),
            ...cands.items.map((w) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                        side: const BorderSide(color: Colors.white10)),
                    leading: const _SongIcon(),
                    title: Text(w.title.isEmpty ? '未命名作品' : w.title,
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text(
                      [
                        mvKindLabel(w.lyrics != null && w.lyrics!.isNotEmpty
                            ? 'vocal'
                            : 'instrumental'),
                        if (w.mood != null) w.mood!,
                        if (w.genres.isNotEmpty) w.genres.take(2).join('/'),
                        _fmtSec(w.durationSec),
                      ].join(' · '),
                      style: const TextStyle(fontSize: 11, color: Colors.white38),
                    ),
                    trailing: const Icon(Icons.movie_creation_outlined,
                        size: 20, color: Colors.white38),
                    onTap: () => _openWizard(workId: w.id, initialStep: 0),
                  ),
                )),
          ],
        ),
      ),
    );
  }

  static String _fmtSec(double sec) {
    final s = sec.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text,
        style:
            const TextStyle(fontWeight: FontWeight.w700, color: Colors.white70));
  }
}

class _SongIcon extends StatelessWidget {
  const _SongIcon();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 38,
      height: 38,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        gradient: LinearGradient(colors: [
          scheme.primary.withValues(alpha: .6),
          scheme.tertiary.withValues(alpha: .45),
        ]),
      ),
      child: const Center(
          child: Icon(Icons.music_note, size: 18, color: Colors.white)),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.text, required this.onRetry});
  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.orange.withValues(alpha: .08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.orange.withValues(alpha: .35)),
      ),
      child: Row(
        children: [
          const Icon(Icons.cloud_off_outlined,
              size: 16, color: Colors.orangeAccent),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text,
                  style:
                      const TextStyle(fontSize: 12, color: Colors.orangeAccent))),
          TextButton(
              onPressed: onRetry, child: const Text('重试', style: TextStyle(fontSize: 12))),
        ],
      ),
    );
  }
}

/// 我的 MV 卡：封面/标题/状态/进度入口 + 完成播片
class _MvCard extends ConsumerWidget {
  const _MvCard(this.mv);
  final MvSummary mv;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final done = mv.status == 'ready';
    return Material(
      color: Colors.white.withValues(alpha: .03),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        // 成片走详情页（播放器+母 work 谱系+音画报告），进度中走通告板
        onTap: () => done
            ? MvDetailPage.push(context, mvId: mv.id)
            : MvProgressPage.push(context, projectId: mv.id),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Colors.white10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                        mv.title.isEmpty ? '未命名 MV' : mv.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontWeight: FontWeight.w700, fontSize: 15)),
                  ),
                  MvProjectChip(status: mv.status),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Text(mvKindLabel(mv.kind),
                      style: const TextStyle(
                          fontSize: 11, color: Colors.white38)),
                  const SizedBox(width: 8),
                  Text(_fmt(mv.durationSec),
                      style: const TextStyle(
                          fontSize: 11, color: Colors.white38)),
                  const Spacer(),
                  if (done && (mv.videoUrl ?? '').isNotEmpty)
                    TextButton.icon(
                      onPressed: () => _play(context),
                      icon: const Icon(Icons.play_circle_outline, size: 18),
                      label: const Text('看成片', style: TextStyle(fontSize: 12)),
                    )
                  else
                    TextButton.icon(
                      onPressed: () =>
                          MvProgressPage.push(context, projectId: mv.id),
                      icon: const Icon(Icons.local_movies_outlined, size: 18),
                      label: const Text('看进度', style: TextStyle(fontSize: 12)),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _play(BuildContext context) {
    // 看成片 → 首映礼揭晓页（拉幕动画 → 海报先行 → 内联自动播放）
    MvRevealPage.push(context, mvId: mv.id);
  }

  String _fmt(double sec) {
    final s = sec.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }
}
