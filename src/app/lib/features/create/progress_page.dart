import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../core/ws_client.dart';
import '../library/work_detail_page.dart';
import 'reveal_page.dart';

/// 生成进度页：环形进度 + WSS job.progress；queued→“排队中”；完成跳揭晓
class ProgressPage extends ConsumerStatefulWidget {
  const ProgressPage({
    super.key,
    required this.jobId,
    this.title = '压制唱片中',
    this.onRetry,
  });

  final String jobId;
  final String title;

  /// 失败后重交（返回新 job_id；null 表示不可重试）
  final Future<String?> Function()? onRetry;

  /// 普通入栈
  static void push(BuildContext context, String jobId,
      {String title = '压制唱片中', Future<String?> Function()? onRetry}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) =>
          ProgressPage(jobId: jobId, title: title, onRetry: onRetry),
    ));
  }

  /// 替换当前页（揭晓/意图流完成后）
  static void pushReplacement(BuildContext context, String jobId,
      {String title = '压制唱片中', Future<String?> Function()? onRetry}) {
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) =>
          ProgressPage(jobId: jobId, title: title, onRetry: onRetry),
    ));
  }

  @override
  ConsumerState<ProgressPage> createState() => _ProgressPageState();
}

class _ProgressPageState extends ConsumerState<ProgressPage> {
  double _progress = 0;
  String _status = 'queued';
  String? _note;
  Map? _error;
  List<Candidate>? _candidates;
  String? _resultWorkId;
  bool _finished = false;
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;

  ApiClient get _api => ref.read(apiClientProvider);

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
  }

  @override
  void dispose() {
    _poll?.cancel();
    _wsSub?.cancel();
    super.dispose();
  }

  void _onWs(WsEvent e) {
    if (!mounted) return;
    if (e is JobProgressEvent) {
      setState(() {
        _progress = e.progress / 100.0;
        _note = e.note ?? _note;
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
  }

  void _finish({List<Candidate>? candidates}) {
    if (_finished) return;
    _finished = true;
    _poll?.cancel();
    if (!mounted) return;
    if (candidates != null && candidates.isNotEmpty) {
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => RevealPage(
          jobId: widget.jobId,
          candidates: candidates,
          resultWorkId: _resultWorkId,
        ),
      ));
    } else if (_resultWorkId != null) {
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => WorkDetailPage(workId: _resultWorkId!),
      ));
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('任务完成，但未取回产物，请去曲库看看')));
      Navigator.of(context).pop();
    }
  }

  String get _statusText {
    if (_error != null) return '这次没成功';
    switch (_status) {
      case 'queued':
      case 'leased':
        return '排队中，前面的灵感正在压制…';
      case 'running':
        return _note != null && _note!.isNotEmpty ? _note! : '压制唱片中…';
      case 'done':
        return '完成！';
      default:
        return '准备中…';
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: _error == null
              ? Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CustomPaint(
                      size: const Size(160, 160),
                      painter: _RingPainter(
                          progress: _progress, color: scheme.primary),
                      child: Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('${(_progress * 100).clamp(0, 100).round()}%',
                                style: const TextStyle(
                                    fontSize: 30,
                                    fontWeight: FontWeight.w700)),
                            const Text('🎵', style: TextStyle(fontSize: 18)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 22),
                    Text(_statusText,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    const Text('积分已预扣，生成失败会自动全额返还',
                        style: TextStyle(color: Colors.white38, fontSize: 12)),
                  ],
                )
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('😢', style: TextStyle(fontSize: 48)),
                    const SizedBox(height: 12),
                    Text(_statusText,
                        style: const TextStyle(
                            fontSize: 18, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    Text(
                        zhForCode('${_error!['code'] ?? ''}',
                            _error!['message']?.toString()),
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white54)),
                    const SizedBox(height: 24),
                    if (widget.onRetry != null)
                      FilledButton.icon(
                          onPressed: () async {
                            final id = await widget.onRetry!();
                            if (id != null && mounted) {
                              setState(() {
                                _error = null;
                                _finished = false;
                                _progress = 0;
                              });
                              _poll = Timer.periodic(
                                  const Duration(seconds: 3), (_) => _fetch());
                              _fetch();
                            }
                          },
                          icon: const Icon(Icons.refresh),
                          label: const Text('再试一次')),
                    const SizedBox(height: 10),
                    OutlinedButton(
                        onPressed: () => Navigator.pop(context),
                        child: const Text('返回修改')),
                  ],
                ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 8;
    final bg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 10
      ..strokeCap = StrokeCap.round
      ..color = color.withValues(alpha: 0.15);
    canvas.drawCircle(center, radius, bg);
    final fg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 10
      ..strokeCap = StrokeCap.round
      ..color = color;
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
