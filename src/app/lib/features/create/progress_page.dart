import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../core/ws_client.dart';
import '../library/work_detail_page.dart';
import 'job_track.dart';
import 'reveal_page.dart';
import 'shelf_page.dart';
import 'shelf_store.dart';
import 'task_brief_card.dart';

/// 生成进度页：任务要素 + 阶段清单 + 逐首就绪 + 后端 note 逐字当前动作。
/// 数据真源只有后端 job 的 status/progress/note 三个字段（无 stage/eta/队列位）。
class ProgressPage extends ConsumerStatefulWidget {
  const ProgressPage({
    super.key,
    required this.jobId,
    this.title = '压制唱片中',
    this.brief,
    this.plannedCount,
    this.onRetry,
    this.dspOpLabel,
  });

  final String jobId;
  final String title;

  /// 本次任务要素（提交时客户端已知），用于「这次在按什么生成」
  final TaskBrief? brief;

  /// 计划候选数（note 未带上时用来渲染逐首就绪）
  final int? plannedCount;

  /// 失败后原参数重交（返回新 job_id；null 表示不可重试）
  final Future<String?> Function()? onRetry;

  /// DSP 类任务的动作名（要素与阶段文案用）
  final String? dspOpLabel;

  static void push(BuildContext context, String jobId,
      {String title = '压制唱片中',
      TaskBrief? brief,
      int? plannedCount,
      Future<String?> Function()? onRetry,
      String? dspOpLabel}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ProgressPage(
        jobId: jobId,
        title: title,
        brief: brief,
        plannedCount: plannedCount,
        onRetry: onRetry,
        dspOpLabel: dspOpLabel,
      ),
    ));
  }

  /// 替换当前页（揭晓/意图流完成后）
  static void pushReplacement(BuildContext context, String jobId,
      {String title = '压制唱片中',
      TaskBrief? brief,
      int? plannedCount,
      Future<String?> Function()? onRetry,
      String? dspOpLabel}) {
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => ProgressPage(
        jobId: jobId,
        title: title,
        brief: brief,
        plannedCount: plannedCount,
        onRetry: onRetry,
        dspOpLabel: dspOpLabel,
      ),
    ));
  }

  @override
  ConsumerState<ProgressPage> createState() => _ProgressPageState();
}

class _ProgressPageState extends ConsumerState<ProgressPage> {
  double _progress = 0;
  String _status = 'queued';
  String _type = 'music';
  String? _note;
  Map? _error;
  List<Candidate>? _candidates;
  String? _resultWorkId;
  bool _finished = false;
  bool _retryBlocked = false; // 命中服务端 10 分钟幂等窗口
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;

  ApiClient get _api => ref.read(apiClientProvider);

  TaskBrief get _brief =>
      widget.brief ?? TaskBrief(action: widget.title.replaceAll('中', ''));

  /// 该 job 在暂存架里已记的「收下」状态（从暂存架回来续听时恢复角标）
  Map<String, String> get _shelfAdopted {
    try {
      for (final s in ref.read(shelfProvider)) {
        if (s.jobId == widget.jobId) return s.adopted;
      }
    } catch (_) {}
    return const {};
  }

  String get _shelfTitle {
    final p = (_brief.prompt ?? '').trim();
    if (p.isNotEmpty) return p.length > 14 ? '${p.substring(0, 14)}…' : p;
    final l = (_brief.lyrics ?? '').trim();
    if (l.isNotEmpty) return l.length > 14 ? '${l.substring(0, 14)}…' : l;
    final list = _candidates;
    if (list != null && list.isNotEmpty && list.first.title.isNotEmpty) {
      return list.first.title;
    }
    return '${_brief.action}候选';
  }

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _fetch());
    _wsSub = ref
        .read(wsClientProvider)
        .events
        .where((e) =>
            (e is JobProgressEvent && e.jobId == widget.jobId) ||
            (e is JobDoneEvent && e.jobId == widget.jobId))
        .listen(_onWs);
    _fetch();
    // 一进页面就挂上暂存架：中途退出/杀进程也找得回来
    scheduleMicrotask(_saveShelf);
  }

  @override
  void dispose() {
    _poll?.cancel();
    _wsSub?.cancel();
    super.dispose();
  }

  Future<void> _saveShelf({List<Candidate>? candidates}) async {
    try {
      await ref.read(shelfProvider.notifier).save(
            jobId: widget.jobId,
            title: _shelfTitle,
            brief: _brief,
            candidates: candidates ?? _candidates,
          );
    } catch (_) {}
  }

  void _onWs(WsEvent e) {
    if (!mounted) return;
    if (e is JobProgressEvent) {
      setState(() {
        _progress = e.progress / 100.0;
        _note = e.note ?? _note;
        if ((_note ?? '').isNotEmpty) _status = 'running';
      });
    } else if (e is JobDoneEvent) {
      if (e.failed) {
        _showError(e.error ?? const {'code': 'INTERNAL', 'message': '生成失败'});
      } else {
        _poll?.cancel();
        _finish(candidates: _candidatesFromResult(e.result));
      }
    }
  }

  List<Candidate>? _candidatesFromResult(Map? result) {
    final list = result?['candidates'];
    if (list is List) {
      return list.whereType<Map>().map(Candidate.fromMap).toList();
    }
    return null;
  }

  Future<void> _fetch() async {
    try {
      final job = await _api.job(widget.jobId);
      if (!mounted) return;
      setState(() {
        _status = job.status;
        _type = job.type.isEmpty ? _type : job.type;
        _progress = job.progress / 100.0;
        _note = job.note ?? _note;
        if (job.candidates != null && job.candidates!.isNotEmpty) {
          _candidates = job.candidates;
        }
        _resultWorkId = job.resultWorkId ?? _resultWorkId;
      });
      if (job.isDone) {
        _poll?.cancel();
        _finish(candidates: job.candidates ?? _candidates);
      } else if (job.isFailed) {
        _poll?.cancel();
        _showError(job.error ??
            const {'code': 'INTERNAL', 'message': '任务中断'});
      }
    } on ApiException catch (_) {
      // 网络抖动：继续轮询
    }
  }

  void _showError(Map err) {
    if (_finished) return;
    setState(() {
      _error = err;
      _finished = true;
    });
    _poll?.cancel();
    _saveShelf();
  }

  void _finish({List<Candidate>? candidates}) {
    if (_finished) return;
    _finished = true;
    _poll?.cancel();
    final list = (candidates != null && candidates.isNotEmpty)
        ? candidates
        : _candidates;
    if (list != null && list.isNotEmpty) {
      _candidates = list;
    }
    if (!mounted) return;
    if (_candidates != null && _candidates!.isNotEmpty) {
      _saveShelf(candidates: _candidates);
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => RevealPage(
          jobId: widget.jobId,
          candidates: _candidates!,
          resultWorkId: _resultWorkId,
          brief: _brief,
          adopted: _shelfAdopted,
          onRegenerate: widget.onRetry, // 提交侧持有原参数 → 「再来一批」才为真
        ),
      ));
    } else if (_resultWorkId != null) {
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => WorkDetailPage(workId: _resultWorkId!),
      ));
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('任务完成，但产物还没回来 —— 已存进「曲库 · 暂存」，稍后点它可继续看')));
      Navigator.of(context).pop();
    }
  }

  /// 「先存着」：任务继续在后台跑，产物与进度都挂在曲库·暂存
  Future<void> _leave() async {
    await _saveShelf();
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    Navigator.of(context).pop();
    messenger.showSnackBar(SnackBar(
      content: Text(_finished
          ? '已存进「曲库 · 暂存」，随时回来继续'
          : '任务还在跑，已存进「曲库 · 暂存」，回去点它可继续看进度'),
      action: SnackBarAction(
          label: '去暂存',
          onPressed: () => Navigator.of(messenger.context).push(
              MaterialPageRoute(builder: (_) => const ShelfPage()))),
    ));
  }

  /// 原参数重交。服务端 10 分钟内同参会命中幂等，把已失败的旧 job 原样还回来，
  /// 这种情况诚实告知，不假装重试成功。
  Future<void> _retry() async {
    final id = await widget.onRetry?.call();
    if (!mounted) return;
    if (id == null || id.isEmpty) return;
    if (id == widget.jobId) {
      setState(() => _retryBlocked = true);
      return;
    }
    setState(() {
      _error = null;
      _finished = false;
      _retryBlocked = false;
      _progress = 0;
      _status = 'queued';
      _note = null;
    });
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _fetch());
    _fetch();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final track = JobTrack.from(
      job: Job(
        id: widget.jobId,
        type: _type,
        status: _status,
        progress: (_progress * 100).round(),
        note: _note,
        candidates: _candidates,
      ),
      plannedCount: widget.plannedCount ?? _brief.count,
      dspOpLabel: widget.dspOpLabel,
    );

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _leave();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_brief.action.isEmpty
              ? widget.title
              : '${_brief.action}中'),
          leading: IconButton(
            icon: const Icon(Icons.keyboard_arrow_left_rounded),
            onPressed: _leave,
            tooltip: '先存着（任务继续）',
          ),
        ),
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
            children: [
              if (_error == null) ...[
                _ProgressHead(track: track, scheme: scheme),
                const SizedBox(height: 10),
                if (track.hasPerCandidate) ...[
                  _CandidateLedger(track: track),
                  const SizedBox(height: 10),
                ],
                _StageList(stages: track.stages),
              ] else ...[
                _FailedHead(error: _error!, blocked: _retryBlocked),
                const SizedBox(height: 10),
                _StageList(stages: track.stages),
              ],
              const SizedBox(height: 14),
              TaskBriefCard(brief: _brief),
              const SizedBox(height: 12),
              Row(
                children: [
                  const Icon(Icons.savings_outlined,
                      size: 14, color: Colors.white38),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      _error == null
                          ? '积分已预扣，任务失败会自动全额返还'
                          : '本次积分会全额返还（后台已入账）',
                      style: const TextStyle(
                          color: Colors.white38, fontSize: 11.5),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              if (_error != null && widget.onRetry != null)
                FilledButton.icon(
                    onPressed: _retry,
                    icon: const Icon(Icons.refresh_rounded),
                    label: Text(_retryBlocked ? '还是再试一次' : '原参数再试一次')),
              if (_error != null && widget.onRetry != null)
                const SizedBox(height: 10),
              if (_error != null)
                OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('返回修改灵感')),
              if (_error == null)
                OutlinedButton.icon(
                  onPressed: _leave,
                  icon: const Icon(Icons.bookmark_add_outlined, size: 18),
                  label: const Text('先存着，回头再看（任务继续跑）'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------- 头部：环形进度 + 后端真实当前动作 ----------------

class _ProgressHead extends StatelessWidget {
  const _ProgressHead({required this.track, required this.scheme});

  final JobTrack track;
  final ColorScheme scheme;

  @override
  Widget build(BuildContext context) {
    final pct = track.progress.clamp(0, 100);
    return Row(
      children: [
        SizedBox(
          width: 104,
          height: 104,
          child: CustomPaint(
            painter: _RingPainter(progress: pct / 100.0, color: scheme.primary),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('$pct%',
                      style: const TextStyle(
                          fontSize: 24, fontWeight: FontWeight.w800)),
                  Text(track.done ? '完成' : (track.queued ? '排队' : '压制'),
                      style: const TextStyle(
                          fontSize: 11, color: Colors.white38)),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                track.queued
                    ? '排队中，前面的灵感正在压制'
                    : (track.done ? '压制完成，正在揭晓' : '正在压制'),
                style: const TextStyle(
                    fontSize: 17, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 5),
              Text(track.currentAction,
                  style: const TextStyle(
                      fontSize: 12.5, color: Colors.white54, height: 1.3)),
              if (track.retrying)
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Colors.orange.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: const Text('后台自动重试中',
                      style:
                          TextStyle(fontSize: 11, color: Colors.orangeAccent)),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------- 逐首就绪：第 1/2/3 首 ----------------

class _CandidateLedger extends StatelessWidget {
  const _CandidateLedger({required this.track});

  final JobTrack track;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.disc_full_outlined,
                  size: 15, color: scheme.primary),
              const SizedBox(width: 6),
              const Text('逐首就绪',
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: Colors.white70)),
              const Spacer(),
              Text('${track.readyCount} / ${track.totalCount} 首已出',
                  style: const TextStyle(
                      fontSize: 11.5, color: Colors.white38)),
            ],
          ),
          const SizedBox(height: 9),
          Row(
            children: List.generate(track.totalCount, (i) {
              final n = i + 1;
              final ready = n <= track.readyCount;
              final active = !ready && n == track.readyCount + 1 && !track.failed;
              return Expanded(
                child: Container(
                  margin: EdgeInsets.only(right: i == track.totalCount - 1 ? 0 : 6),
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: ready
                        ? scheme.primary.withValues(alpha: 0.20)
                        : Colors.white.withValues(alpha: 0.05),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                        color: active
                            ? scheme.primary
                            : Colors.white.withValues(alpha: 0.08)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (ready)
                        Icon(Icons.check_circle,
                            size: 13, color: scheme.primary)
                      else if (active)
                        const SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(
                                strokeWidth: 1.8, color: Colors.white70))
                      else
                        const Icon(Icons.radio_button_unchecked,
                            size: 13, color: Colors.white24),
                      const SizedBox(width: 5),
                      Text('第 $n 首',
                          style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: ready ? FontWeight.w700 : FontWeight.w500,
                              color: ready ? Colors.white : Colors.white54)),
                    ],
                  ),
                ),
              );
            }),
          ),
        ],
      ),
    );
  }
}

// ---------------- 阶段清单 ----------------

class _StageList extends StatelessWidget {
  const _StageList({required this.stages});

  final List<JobStage> stages;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white10),
      ),
      child: Column(
        children: [
          for (var i = 0; i < stages.length; i++)
            _StageRow(
              stage: stages[i],
              last: i == stages.length - 1,
            ),
        ],
      ),
    );
  }
}

class _StageRow extends StatelessWidget {
  const _StageRow({required this.stage, required this.last});

  final JobStage stage;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (stage.state) {
      JobStageState.done => (Icons.check_circle, scheme.primary),
      JobStageState.active => (Icons.pending, Colors.amberAccent),
      JobStageState.failed => (Icons.error_outline, Colors.redAccent),
      JobStageState.pending =>
        (Icons.radio_button_unchecked, Colors.white24),
    };
    return SizedBox(
      height: 38,
      child: Row(
        children: [
          SizedBox(
            width: 26,
            child: Column(
              children: [
                Icon(icon, size: 16, color: color),
                if (!last)
                  Expanded(
                      child: Container(
                          width: 1.6,
                          margin: const EdgeInsets.symmetric(vertical: 2),
                          color: Colors.white12)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              stage.label,
              style: TextStyle(
                fontSize: 13,
                color: stage.state == JobStageState.pending
                    ? Colors.white38
                    : Colors.white,
                fontWeight:
                    stage.state == JobStageState.active ? FontWeight.w700 : null,
              ),
            ),
          ),
          if (stage.hint != null)
            Text(stage.hint!,
                style: const TextStyle(fontSize: 11.5, color: Colors.white38)),
        ],
      ),
    );
  }
}

// ---------------- 失败态 ----------------

class _FailedHead extends StatelessWidget {
  const _FailedHead({required this.error, required this.blocked});

  final Map error;
  final bool blocked;

  @override
  Widget build(BuildContext context) {
    final code = '${error['code'] ?? ''}';
    final raw = '${error['message'] ?? ''}'.trim();
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.redAccent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.redAccent.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('😢', style: TextStyle(fontSize: 30)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(zhForCode(code, raw.isEmpty ? null : raw),
                    style: const TextStyle(
                        fontSize: 15.5, fontWeight: FontWeight.w700)),
                if (raw.isNotEmpty && raw != zhForCode(code, raw)) ...[
                  const SizedBox(height: 4),
                  Text(raw,
                      style: const TextStyle(
                          fontSize: 12, color: Colors.white54, height: 1.3)),
                ],
                const SizedBox(height: 6),
                const Text('失败任务的积分已自动返还',
                    style:
                        TextStyle(fontSize: 11.5, color: Colors.white38)),
                if (blocked) ...[
                  const SizedBox(height: 6),
                  const Text(
                      '刚刚那次失败记录还在服务端 10 分钟保护窗口内：同参数重点会拿回同一条记录。'
                      '等一两分钟，或回上一页改个词再来。',
                      style: TextStyle(
                          fontSize: 11.5,
                          color: Colors.orangeAccent,
                          height: 1.35)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------- 环形进度画师 ----------------

class _RingPainter extends CustomPainter {
  _RingPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 6;
    final bg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round
      ..color = color.withValues(alpha: 0.15);
    canvas.drawCircle(center, radius, bg);
    final fg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round
      ..shader = SweepGradient(
        startAngle: -math.pi / 2,
        endAngle: 3 * math.pi / 2,
        colors: [color, color.withValues(alpha: 0.55)],
        tileMode: TileMode.clamp,
      ).createShader(Rect.fromCircle(center: center, radius: radius));
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      2 * math.pi * progress.clamp(0.0, 1.0),
      false,
      fg,
    );
  }

  @override
  bool shouldRepaint(covariant _RingPainter old) =>
      old.progress != progress || old.color != color;
}
