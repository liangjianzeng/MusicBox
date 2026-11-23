import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../shared/widgets/ai_badge.dart';
import '../../shared/widgets/primary_button.dart';
import '../../shared/widgets/waveform_canvas.dart';
import '../player/player_provider.dart';
import 'credit_guard.dart';
import 'progress_page.dart';

/// 揭晓页：3 候选卡带翻转（AnimatedSwitcher 简版）、A/B 快切、收下、说一句改一点
class RevealPage extends ConsumerStatefulWidget {
  const RevealPage({
    super.key,
    required this.jobId,
    required this.candidates,
    this.resultWorkId,
    this.adjusted = false,
  });

  final String jobId;
  final List<Candidate> candidates;

  /// generate 任务关联的 draft work id（adopt 用）
  final String? resultWorkId;

  /// 是否由 adjust 产生（微调谱系）
  final bool adjusted;

  @override
  ConsumerState<RevealPage> createState() => _RevealPageState();
}

class _RevealPageState extends ConsumerState<RevealPage> {
  int _idx = 0;
  final Map<String, String> _adopted = {}; // candidateId -> workId
  bool _busy = false;
  bool _adjustSending = false;
  String? _clarify; // understood:false 的追问
  final TextEditingController _adjustCtrl = TextEditingController();

  Candidate get _cur => widget.candidates[_idx];

  ApiClient get _api => ref.read(apiClientProvider);

  Work _candidateToWork(Candidate c) => Work(
        id: c.id,
        title: c.title.isEmpty ? '候选 ${c.seq}' : c.title,
        status: 'draft',
        durationSec: c.durationSec,
        createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
        audioUrl: c.audioUrl,
        waveformUrl: c.waveformUrl,
      );

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  void _go(int i) {
    if (i < 0 || i >= widget.candidates.length) return;
    setState(() {
      _idx = i;
      _clarify = null;
    });
  }

  /// A/B 快切：直接对比前两首
  void _ab(int which) {
    _go(math.min(which, widget.candidates.length - 1));
    ref
        .read(playerProvider.notifier)
        .playQueue([_candidateToWork(_cur)], 0);
  }

  Future<String?> _ensureAdopted(Candidate c) async {
    final existing = _adopted[c.id];
    if (existing != null) return existing;
    // adopt 需要 work id：优先 job 的 result_work_id，退回 job id
    final workId = widget.resultWorkId ?? widget.jobId;
    final work = await _api.adopt(workId, c.id);
    _adopted[c.id] = work.id;
    await ref.read(localDbProvider).cacheWork(work);
    return work.id;
  }

  Future<void> _adopt() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await _ensureAdopted(_cur);
      _toast('已收下《${_cur.title.isEmpty ? '未命名作品' : _cur.title}》，可在曲库查看');
      if (!mounted) return;
      setState(() {}); // 刷新“已收下”角标
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('收下失败，请重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// “说一句改一点”→ adjust；understood:false 显示追问气泡
  Future<void> _adjust() async {
    final text = _adjustCtrl.text.trim();
    if (text.isEmpty || _adjustSending) return;
    if (!await ensureCredits(context, ref, kCreditAdjust, action: '微调')) {
      return;
    }
    setState(() {
      _adjustSending = true;
      _clarify = null;
    });
    try {
      final workId = await _ensureAdopted(_cur);
      final res = await _api.adjust(workId ?? _cur.id, text);
      if (!mounted) return;
      if (res['understood'] == true) {
        final jobId = '${res['job_id']}';
        ProgressPage.push(context, jobId, title: '微调中');
        _adjustCtrl.clear();
      } else {
        setState(() => _clarify = '${res['clarify'] ?? '能再说具体一点吗？'}');
      }
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('微调失败，请重试');
    } finally {
      if (mounted) setState(() => _adjustSending = false);
    }
  }

  @override
  void dispose() {
    _adjustCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final adopted = _adopted[_cur.id] != null;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.adjusted ? '微调揭晓' : '你的三首候选'),
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  Text('候选 ${_idx + 1}/${widget.candidates.length}',
                      style:
                          const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  // A/B 快切
                  if (widget.candidates.length >= 2)
                    Row(
                      children: [
                        _AbButton(
                            label: 'A',
                            active: _idx == 0,
                            onTap: () => _ab(0)),
                        const SizedBox(width: 6),
                        _AbButton(
                            label: 'B',
                            active: _idx == 1,
                            onTap: () => _ab(1)),
                      ],
                    ),
                ],
              ),
            ),
            // 翻转候选卡
            Expanded(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 420),
                    transitionBuilder: (child, anim) {
                      final t = Tween<double>(begin: math.pi / 2, end: 0)
                          .animate(CurvedAnimation(
                              parent: anim, curve: Curves.easeOutBack));
                      return AnimatedBuilder(
                        animation: anim,
                        child: child,
                        builder: (ctx, c) {
                          final m = Matrix4.identity()
                            ..setEntry(3, 2, 0.0015)
                            ..rotateY(1 - t.value);
                          return Transform(
                            alignment: Alignment.center,
                            transform: m,
                            child: c,
                          );
                        },
                      );
                    },
                    child: _CandidateCard(
                      key: ValueKey(_cur.id),
                      candidate: _cur,
                      adopted: adopted,
                      playing: ref
                              .watch(playerProvider)
                              .current
                              ?.id ==
                          _cur.id,
                      onPlay: () => ref
                          .read(playerProvider.notifier)
                          .playQueue([_candidateToWork(_cur)], 0),
                      onAdopt: _adopt,
                      busy: _busy,
                    ),
                  ),
                ),
              ),
            ),
            // 翻页点
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(widget.candidates.length, (i) {
                return GestureDetector(
                  onTap: () => _go(i),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    margin: const EdgeInsets.symmetric(
                        horizontal: 4, vertical: 8),
                    width: i == _idx ? 22 : 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: i == _idx
                          ? Theme.of(context).colorScheme.primary
                          : Colors.white24,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                );
              }),
            ),
            // 追问气泡
            if (_clarify != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Container(
                    constraints:
                        const BoxConstraints(maxWidth: 340),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 10),
                    decoration: BoxDecoration(
                      color: Theme.of(context)
                          .colorScheme
                          .surfaceContainerHighest,
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(14),
                        topRight: Radius.circular(14),
                        bottomRight: Radius.circular(14),
                      ),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.campaign_outlined,
                            size: 15, color: Colors.amberAccent),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text('AI 追问：$_clarify',
                              style: const TextStyle(fontSize: 13)),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            // 说一句改一点
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _adjustCtrl,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _adjust(),
                      decoration: InputDecoration(
                        hintText: '说一句改一点，如“副歌再燃一点”',
                        isDense: true,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _adjustSending ? null : _adjust,
                    icon: _adjustSending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.send_rounded),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AbButton extends StatelessWidget {
  const _AbButton(
      {required this.label, required this.active, required this.onTap});

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        width: 36,
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: active ? scheme.primary : Colors.white10,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(label,
            style: TextStyle(
                fontWeight: FontWeight.w700,
                color: active ? scheme.onPrimary : Colors.white70)),
      ),
    );
  }
}

class _CandidateCard extends StatelessWidget {
  const _CandidateCard({
    super.key,
    required this.candidate,
    required this.adopted,
    required this.playing,
    required this.onPlay,
    required this.onAdopt,
    required this.busy,
  });

  final Candidate candidate;
  final bool adopted;
  final bool playing;
  final VoidCallback onPlay;
  final VoidCallback onAdopt;
  final bool busy;

  String _fmt(double sec) {
    final s = sec.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(maxWidth: 420),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            scheme.surfaceContainerHigh,
            scheme.surfaceContainerLow,
          ],
        ),
        border: Border.all(color: Colors.white10),
      ),
      padding: const EdgeInsets.all(18),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 54,
                height: 54,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(colors: [
                    scheme.primary.withValues(alpha: .8),
                    scheme.tertiary.withValues(alpha: .6),
                  ]),
                ),
                child: const Center(child: Text('💿', style: TextStyle(fontSize: 24))),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      candidate.title.isEmpty ? '未命名作品' : candidate.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 18, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text('时长 ${_fmt(candidate.durationSec)} · MP3',
                        style: const TextStyle(
                            fontSize: 12, color: Colors.white54)),
                  ],
                ),
              ),
              const AiBadge(),
            ],
          ),
          const SizedBox(height: 14),
          // 波形（peaks 占位）
          WaveformCanvas(
            peaks: pseudoPeaks(candidate.id, n: 56),
            height: 56,
            progress: playing ? 0.5 : 0,
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onPlay,
                  icon: Icon(playing
                      ? Icons.pause_circle_filled
                      : Icons.play_circle_fill),
                  label: Text(playing ? '暂停试听' : '试听'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: PrimaryButton(
                  text: adopted ? '已收下 ✓' : '收下这首',
                  icon: adopted ? Icons.check_circle : Icons.favorite,
                  loading: busy && !adopted,
                  onPressed: adopted || busy ? null : onAdopt,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
