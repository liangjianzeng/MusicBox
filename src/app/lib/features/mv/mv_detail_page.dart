import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../player/player_provider.dart';
import 'mv_api_client.dart';
import 'mv_models.dart';
import 'mv_state.dart';
import 'widgets/mv_common.dart';
import 'widgets/mv_network_image.dart';
import 'widgets/mv_task_chip.dart';
import 'widgets/mv_theme.dart';
import 'widgets/mv_video_player.dart';

/// MV 成片详情：竖屏 9:16 播放器（封面海报兜底）+ 母 work 谱系卡（试听走
/// 既有播放器）+「音画报告」入口。数据源 GET /v1/mvs/:id → {mv, parent_work}。
/// 诚实纪律：片源缺失 → 海报 + 诚实占位；报告为服务端 STUB 时渲染
/// 「报告生成中」空态，绝不把全 0 当真实数据呈现。
class MvDetailPage extends ConsumerStatefulWidget {
  const MvDetailPage({super.key, required this.mvId});
  final String mvId;

  static void push(BuildContext context, {required String mvId}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MvDetailPage(mvId: mvId),
    ));
  }

  @override
  ConsumerState<MvDetailPage> createState() => _MvDetailPageState();
}

class _MvDetailPageState extends ConsumerState<MvDetailPage> {
  bool _loading = true;
  String? _error;
  Map? _raw;

  MvApiClient get _api => ref.read(mvApiClientProvider);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final m = await _api.mvDetail(widget.mvId);
      if (!mounted) return;
      setState(() {
        _raw = m;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = mvUserVisibleError(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载失败，请重试';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('MV 详情'),
        actions: [
          IconButton(
              onPressed: _load, icon: Icon(Icons.refresh), tooltip: '刷新'),
        ],
      ),
      body: _loading
          ? ListView(
              padding: const EdgeInsets.all(16),
              children: const [MvCardSkeleton(), MvCardSkeleton()],
            )
          : _error != null
              ? MvErrorView(text: _error!, onRetry: _load)
              : _body(),
    );
  }

  Widget _body() {
    final m = (_raw?['mv'] as Map?) ?? const {};
    final project = MvProject.fromMap(m);
    final parentRaw = _raw?['parent_work'];
    final parent = parentRaw is Map ? Work.fromMap(parentRaw) : null;
    final cast = (m['cast'] as List? ?? const []).whereType<Map>().toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        // 成片播放器（9:16，封面海报兜底 + AI 角标）
        ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: MvVideoPlayer(
            url: (project.videoUrl ?? '').isEmpty ? null : project.videoUrl,
            coverUrl: project.coverUrl,
            aspectRatio: 9 / 16,
            placeholderHint: '成片暂不可播（片源或服务异常，可下拉刷新重试）',
          ),
        ),
        SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: Text(
                project.title.isEmpty ? '未命名 MV' : project.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
              ),
            ),
            MvProjectChip(status: project.status),
          ],
        ),
        SizedBox(height: 4),
        Text(
          [
            mvKindLabel(project.kind),
            if (project.durationSec > 0) mvFormatDuration(project.durationSec),
          ].join(' · '),
          style: TextStyle(fontSize: 11.5, color: context.mvTextMuted),
        ),
        if (cast.isNotEmpty) ...[
          SizedBox(height: 10),
          Row(
            children: [
              for (final c in cast.take(3))
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: _CastThumb(
                    thumb: c['thumb_url']?.toString(),
                    name: c['name']?.toString(),
                  ),
                ),
            ],
          ),
        ],
        SizedBox(height: 14),
        // 母 work 谱系卡（试听 = 既有 just_audio 播放器）
        _ParentWorkCard(parent: parent),
        SizedBox(height: 12),
        // 音画报告入口（STUB → 「报告生成中」诚实空态）
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: () => MvReportPage.push(context, projectId: widget.mvId),
            icon: Icon(Icons.query_stats_outlined, size: 18),
            label: Text('音画报告'),
          ),
        ),
      ],
    );
  }
}

class _CastThumb extends StatelessWidget {
  const _CastThumb({this.thumb, this.name});
  final String? thumb;
  final String? name;

  @override
  Widget build(BuildContext context) {
    final hasThumb = (thumb ?? '').isNotEmpty;
    return Semantics(
      label: (name ?? '').isEmpty ? '主演定妆照' : '主演 $name 的定妆照',
      button: hasThumb,
      child: Row(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(999),
            onTap: hasThumb
                ? () => showMvImagePreview(context,
                    url: thumb!, title: name ?? '主演定妆照')
                : null,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: SizedBox(
                width: 30,
                height: 30,
                child: hasThumb
                    ? MvNetworkImage(
                        url: thumb!,
                        cacheWidth: 96,
                        semanticLabel: name ?? '主演定妆照')
                    : ColoredBox(
                        color: context.mvBorder,
                        child: Icon(Icons.person_outline,
                            size: 16, color: context.mvTextMuted)),
              ),
            ),
          ),
          if ((name ?? '').isNotEmpty) ...[
            const SizedBox(width: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 72),
              child: Text(name!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style:
                      TextStyle(fontSize: 11, color: context.mvTextSecondary)),
            ),
          ],
        ],
      ),
    );
  }
}

/// 母 work 简卡：title/mood + 试听（走既有播放器；无音轨如实禁用）
class _ParentWorkCard extends ConsumerWidget {
  const _ParentWorkCard({required this.parent});
  final Work? parent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final w = parent;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.mvSurfaceRaised.withValues(alpha: .03),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: context.mvBorder),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              gradient: LinearGradient(colors: [
                Theme.of(context).colorScheme.primary.withValues(alpha: .5),
                Theme.of(context).colorScheme.tertiary.withValues(alpha: .35),
              ]),
            ),
            child: Center(
                child: Icon(Icons.music_note,
                    size: 18, color: context.mvTextPrimary)),
          ),
          SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  w == null ? '母作品已不存在' : (w.title.isEmpty ? '未命名作品' : w.title),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
                ),
                SizedBox(height: 2),
                Text(
                  w == null
                      ? '谱系关联的原始歌曲已被删除（成片不受影响）'
                      : [
                          if ((w.mood ?? '').isNotEmpty) w.mood!,
                          if (w.genres.isNotEmpty) w.genres.take(2).join('/'),
                          if ((w.bpm ?? 0) > 0) '${w.bpm} BPM',
                        ].join(' · '),
                  style: TextStyle(fontSize: 11, color: context.mvTextMuted),
                ),
              ],
            ),
          ),
          SizedBox(width: 6),
          TextButton.icon(
            onPressed: (w != null && (w.audioUrl ?? '').isNotEmpty)
                ? () => ref.read(playerProvider.notifier).playQueue([w], 0)
                : null,
            icon: Icon(Icons.play_arrow_rounded, size: 18),
            label: Text('试听', style: TextStyle(fontSize: 12)),
          ),
        ],
      ),
    );
  }
}

// ---------- 音画报告页（STUB → 「报告生成中」诚实空态，绝不当真数） ----------

class MvReportPage extends ConsumerStatefulWidget {
  const MvReportPage({super.key, required this.projectId});
  final String projectId;

  static void push(BuildContext context, {required String projectId}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MvReportPage(projectId: projectId),
    ));
  }

  @override
  ConsumerState<MvReportPage> createState() => _MvReportPageState();
}

class _MvReportPageState extends ConsumerState<MvReportPage> {
  bool _loading = true;
  String? _error;
  MvReport? _report;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final m = await ref.read(mvApiClientProvider).report(widget.projectId);
      if (!mounted) return;
      setState(() {
        _report = MvReport.fromMap(m);
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = mvUserVisibleError(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '报告加载失败，请重试';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('音画报告')),
      body: _loading
          ? Center(child: CircularProgressIndicator())
          : _error != null
              ? MvEmptyView(
                  icon: Icons.cloud_off_outlined,
                  text: _error!,
                  action: OutlinedButton.icon(
                      onPressed: _load,
                      icon: Icon(Icons.refresh),
                      label: Text('重试')),
                )
              : (_report != null && _report!.hasRealData)
                  ? _RealReport(report: _report!)
                  : MvEmptyView(
                      icon: Icons.pending_actions_outlined,
                      text: '报告生成中。\n'
                          '对齐精度、口型评分、字幕健康度等由拍摄/口型流水线产出后聚合，'
                          '当前服务端为占位数据（stub），我们不会把空数据当成结论给你。',
                    ),
    );
  }
}

class _RealReport extends StatelessWidget {
  const _RealReport({required this.report});
  final MvReport report;

  @override
  Widget build(BuildContext context) {
    final a = report.alignReport;
    final s = report.syncDist;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        _ReportCard(title: '歌词对齐', rows: [
          ('对齐句数', (a['aligned_lines'] as num?)?.toInt().toString() ?? '0'),
          (
            '平均误差',
            '${((a['mean_abs_err_ms'] as num?)?.toDouble() ?? 0).round()} ms'
          ),
          (
            '±150ms 内占比',
            '${(((a['within_150ms_ratio'] as num?)?.toDouble() ?? 0) * 100).round()}%'
          ),
        ]),
        SizedBox(height: 10),
        _ReportCard(title: '口型评分分布', rows: [
          ('样本镜数', (s['count'] as num?)?.toInt().toString() ?? '0'),
          ('均值', ((s['mean'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)),
          ('低于阈值', '${(s['below_threshold'] as num?)?.toInt() ?? 0} 镜'),
        ]),
        SizedBox(height: 10),
        _ReportCard(
            title: '乐句点命中',
            rows: [('命中率', '${(report.phraseHit * 100).round()}%')]),
        if (report.degradedShots.isNotEmpty) ...[
          SizedBox(height: 10),
          _ReportCard(title: '降级镜清单（明示）', rows: [
            for (final d in report.degradedShots) ('镜头', mvHuman(d)),
          ]),
        ],
      ],
    );
  }
}

class _ReportCard extends StatelessWidget {
  const _ReportCard({required this.title, required this.rows});
  final String title;
  final List<(String, String)> rows;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: context.mvSurfaceRaised.withValues(alpha: .03),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: context.mvBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
          SizedBox(height: 8),
          ...rows.map((r) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    Expanded(
                        child: Text(r.$1,
                            style: TextStyle(
                                fontSize: 12, color: context.mvTextSecondary))),
                    Text(r.$2,
                        style: TextStyle(
                            fontSize: 12.5, color: context.mvTextSecondary)),
                  ],
                ),
              )),
        ],
      ),
    );
  }
}
