import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../library/work_detail_page.dart';
import 'progress_page.dart';
import 'reveal_page.dart';
import 'shelf_store.dart';

/// 灵感暂存架：最近 8 次生成的候选会话。
/// 只本地存 jobId + 要素 + 候选快照；打开时先回源 GET /v1/jobs/:id 取最新产物，
/// 网络失败再用本地候选兜底（产物是 /f/* 静态路径，不过期）。
class ShelfPage extends ConsumerStatefulWidget {
  const ShelfPage({super.key});

  @override
  ConsumerState<ShelfPage> createState() => _ShelfPageState();
}

class _ShelfPageState extends ConsumerState<ShelfPage> {
  final Map<String, String> _status = {}; // jobId -> 状态标签
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshStatus());
  }

  Future<void> _refreshStatus() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    final items = ref.read(shelfProvider);
    for (final s in items) {
      try {
        final job = await ref.read(apiClientProvider).job(s.jobId);
        if (!mounted) return;
        setState(() => _status[s.jobId] = _labelOf(job, s));
      } catch (_) {
        if (!mounted) return;
        setState(
            () => _status[s.jobId] = s.candidates.isNotEmpty ? '可离线试听' : '待确认');
      }
    }
    if (mounted) setState(() => _refreshing = false);
  }

  String _labelOf(Job job, ShelfSession s) {
    if (job.isFailed) return '没成功';
    if (job.isDone) {
      final total = job.candidates?.length ?? s.candidates.length;
      if (total == 0) return '产物未回';
      final adoptedCount = s.adopted.length;
      if (adoptedCount >= total && total > 0) return '已全部收下';
      return '待试听 ${total - adoptedCount} 首';
    }
    if (job.isQueued) return '排队中';
    return '生成中 ${job.progress}%';
  }

  Future<void> _open(ShelfSession s) async {
    Job? job;
    try {
      job = await ref.read(apiClientProvider).job(s.jobId);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (s.candidates.isEmpty) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.zh)));
        return;
      }
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('取不到最新任务信息，先用本地留存的候选试听')));
    } catch (_) {
      job = null;
    }
    if (!mounted) return;

    if (job != null && job.isFailed) {
      ProgressPage.push(context, s.jobId,
          title: '压制记录',
          brief: s.brief,
          plannedCount: s.brief.count,
          onRetry: ref.read(shelfProvider.notifier).retryHandler(s.jobId));
      return;
    }
    final cands =
        (job != null && job.candidates != null && job.candidates!.isNotEmpty)
            ? job.candidates
            : (s.candidates.isNotEmpty ? s.candidates : null);
    if (cands != null && cands.isNotEmpty) {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => RevealPage(
          jobId: s.jobId,
          candidates: cands,
          resultWorkId: job?.resultWorkId,
          brief: s.brief,
          adopted: s.adopted,
          // 服务端取不到 job 时吃的是本地快照：把"这是降级态"告诉候选页，
          // 否则收下按钮会拿着快照里的「已收下」变成没解释的死按钮（2026-11-27 真机）
          degraded: job == null,
          onRegenerate: ref.read(shelfProvider.notifier).retryHandler(s.jobId),
        ),
      ));
      return;
    }
    final rw = job?.resultWorkId;
    if (rw != null) {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => WorkDetailPage(workId: rw),
      ));
      return;
    }
    // 还在跑 / 还没产物：回到进度页
    ProgressPage.push(context, s.jobId,
        title: '压制唱片中',
        brief: s.brief,
        plannedCount: s.brief.count,
        onRetry: () => ref.read(shelfProvider.notifier).retry(s.jobId));
  }

  Future<void> _confirmDelete(ShelfSession s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('从暂存架移除？'),
        content: Text('「${s.title}」的 ${s.candidates.length} 首候选会从暂存架消失。'
            '已收下的作品不受影响，仍在曲库。'
            '如果任务仍在运行，移除不会停止后台生成，之后可能无法从暂存架找到它。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('留着')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('移除')),
        ],
      ),
    );
    if (ok == true) await ref.read(shelfProvider.notifier).remove(s.jobId);
  }

  @override
  Widget build(BuildContext context) {
    final items = ref.watch(shelfProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('灵感暂存架'),
        actions: [
          IconButton(
            onPressed: _refreshing ? null : _refreshStatus,
            icon: _refreshing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
            tooltip: '刷新状态',
          ),
        ],
      ),
      body: items.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('🗂', style: TextStyle(fontSize: 42)),
                  const SizedBox(height: 10),
                  const Text('暂存架是空的', style: TextStyle(color: Colors.white70)),
                  const SizedBox(height: 4),
                  const SizedBox(
                    width: 260,
                    child: Text(
                      '生成好但还没「收下」的候选会自动存到这里，\n退出、切页都不会丢，最多留最近 8 次。',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.white38, fontSize: 12),
                    ),
                  ),
                  const SizedBox(height: 14),
                  OutlinedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('回曲库')),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _refreshStatus,
              child: ListView.separated(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
                itemCount: items.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (ctx, i) => _ShelfCard(
                  session: items[i],
                  statusLabel: _status[items[i].jobId],
                  onOpen: () => _open(items[i]),
                  onDelete: () => _confirmDelete(items[i]),
                ),
              ),
            ),
    );
  }
}

class _ShelfCard extends StatelessWidget {
  const _ShelfCard({
    required this.session,
    required this.statusLabel,
    required this.onOpen,
    required this.onDelete,
  });

  final ShelfSession session;
  final String? statusLabel;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  String get _when {
    final t = session.updatedAt;
    if (t <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(t * 1000);
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inHours < 1) return '${diff.inMinutes} 分钟前';
    if (diff.inDays < 1) return '${diff.inHours} 小时前';
    if (diff.inDays < 7) return '${diff.inDays} 天前';
    return '${d.month}/${d.day}';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final total = session.candidates.length;
    final kept = session.adopted.length;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 12, 6, 10),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHigh.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Colors.white10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(colors: [
                        scheme.primary.withValues(alpha: .8),
                        scheme.tertiary.withValues(alpha: .6),
                      ]),
                    ),
                    child: const Center(
                        child: Text('💿', style: TextStyle(fontSize: 16))),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(session.title.isEmpty ? '灵感候选' : session.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 15, fontWeight: FontWeight.w700)),
                        const SizedBox(height: 2),
                        Text(
                          [
                            if (session.brief.headline.isNotEmpty)
                              session.brief.headline,
                            if (total > 0)
                              '共 $total 首${kept > 0 ? ' · 已收下 $kept' : ''}',
                            if (_when.isNotEmpty) _when,
                          ].join(' · '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontSize: 11.5, color: Colors.white38),
                        ),
                      ],
                    ),
                  ),
                  if (statusLabel != null)
                    Container(
                      margin: const EdgeInsets.only(right: 2),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: scheme.primary.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(statusLabel!,
                          style: TextStyle(
                              fontSize: 11,
                              color: scheme.primary,
                              fontWeight: FontWeight.w600)),
                    ),
                  IconButton(
                    onPressed: onDelete,
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.delete_outline,
                        size: 20, color: Colors.white38),
                    tooltip: '移除',
                  ),
                ],
              ),
              if (!session.brief.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(left: 46, top: 4, right: 6),
                  child: Text(
                    session.brief
                        .toRows()
                        .take(2)
                        .map((f) => '${f.label} ${f.value}')
                        .join('   '),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11.5, color: Colors.white38, height: 1.35),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.only(left: 40, top: 6),
                child: Row(
                  children: [
                    Icon(Icons.play_circle_outline,
                        size: 15, color: scheme.primary),
                    const SizedBox(width: 5),
                    Text('继续试听 / 收下',
                        style: TextStyle(fontSize: 12, color: scheme.primary)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
