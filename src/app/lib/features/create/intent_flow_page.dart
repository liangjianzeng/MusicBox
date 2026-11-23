import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart' as mdl;
import '../../core/state.dart';
import '../../core/ws_client.dart';
import '../../shared/widgets/primary_button.dart';
import 'intent_card_view.dart';
import 'progress_page.dart';

/// 意图流面板：轮询 + WSS 加速刷新 + 澄清答题 + 生成
/// 傻瓜级 easy=true：只显示第 1 题 + 大号“直接生成”
class IntentFlowPanel extends ConsumerStatefulWidget {
  const IntentFlowPanel({
    super.key,
    required this.intentId,
    required this.easy,
    this.onGenerated,
  });

  final String intentId;
  final bool easy;

  /// 生成成功回调（跳进度页）。默认行为：push Replacement 进度页
  final void Function(String jobId)? onGenerated;

  @override
  ConsumerState<IntentFlowPanel> createState() => _IntentFlowPanelState();
}

class _IntentFlowPanelState extends ConsumerState<IntentFlowPanel> {
  mdl.Intent? _intent;
  String? _error;
  bool _sending = false;
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;
  final Map<int, int> _answers = {};

  ApiClient get _api => ref.read(apiClientProvider);

  @override
  void initState() {
    super.initState();
    _fetch();
    _poll = Timer.periodic(const Duration(milliseconds: 2500), (_) {
      final i = _intent;
      if (i == null || i.processing) _fetch();
    });
    _wsSub = ref
        .read(wsClientProvider)
        .events
        .where((e) => e is IntentCardEvent && e.intentId == widget.intentId)
        .listen((_) => _fetch());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _wsSub?.cancel();
    super.dispose();
  }

  Future<void> _fetch() async {
    try {
      final i = await _api.intent(widget.intentId);
      if (!mounted) return;
      setState(() {
        _intent = i;
        _error = null;
      });
      if (i.ready || i.consumed) _poll?.cancel();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.zh);
    } catch (_) {
      if (mounted) setState(() => _error = '加载失败，请检查网络');
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// 生成：傻瓜级/直接生成用推荐答案补齐澄清题（≤2 轮），再调 intent generate
  Future<void> _generate({bool direct = false}) async {
    if (_sending) return;
    setState(() => _sending = true);
    try {
      var cur = _intent;
      int rounds = 0;
      while (cur != null && !cur.ready && rounds < 3) {
        final pending = <mdl.IntentAnswer>[];
        for (final q in cur.questions) {
          final sel = _answers[q.qIdx];
          if (sel != null) {
            pending.add(mdl.IntentAnswer(qIdx: q.qIdx, optionIdx: sel));
          } else if (widget.easy || direct) {
            if (q.recommendedIdx != null) {
              pending.add(
                  mdl.IntentAnswer(qIdx: q.qIdx, optionIdx: q.recommendedIdx!));
            }
          }
        }
        if (pending.isEmpty) break;
        cur = await _api.intentAnswer(widget.intentId, pending);
        if (!mounted) return;
        setState(() => _intent = cur);
        rounds++;
      }
      cur = _intent;
      if (cur != null && cur.ready) {
        final jobId = await _api.intentGenerate(widget.intentId);
        if (!mounted) return;
        if (widget.onGenerated != null) {
          widget.onGenerated!(jobId);
        } else {
          ProgressPage.pushReplacement(context, jobId);
        }
      } else {
        _toast('再答一题就更准；也可以直接生成，我们用推荐答案');
      }
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('操作失败，请重试');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final i = _intent;
    if (_error != null && i == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded, size: 40),
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.white54)),
            const SizedBox(height: 12),
            OutlinedButton.icon(
                onPressed: _fetch,
                icon: const Icon(Icons.refresh),
                label: const Text('重试')),
          ],
        ),
      );
    }
    if (i == null || i.processing) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
                width: 30,
                height: 30,
                child: CircularProgressIndicator(strokeWidth: 2.5)),
            SizedBox(height: 14),
            Text('正在理解你的灵感…', style: TextStyle(color: Colors.white70)),
            SizedBox(height: 4),
            Text('AI 会听声音/看画面，猜出你想听的歌',
                style: TextStyle(color: Colors.white38, fontSize: 12)),
          ],
        ),
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        IntentCardView(
          intent: i,
          maxQuestions: widget.easy ? 1 : null,
          answers: _answers,
          onAnswer: (qIdx, opt) => setState(() => _answers[qIdx] = opt),
          onSkipQuestion: widget.easy
              ? null
              : (qIdx) {
                  // 跳过=采用该题推荐项
                  final q = i.questions.firstWhere((e) => e.qIdx == qIdx);
                  setState(() =>
                      _answers[qIdx] = q.recommendedIdx ?? 0);
                },
          onMoodChanged: (m) => setState(() => _intent = i.copyWith(mood: m)),
          onVocalToggled: () => setState(() => _intent = i.copyWith(
              vocal: i.vocal == 'instrumental' ? 'song' : 'instrumental')),
        ),
        const SizedBox(height: 16),
        if (widget.easy)
          PrimaryButton(
            text: '直接生成',
            big: true,
            icon: Icons.auto_awesome,
            loading: _sending,
            onPressed: i.consumed ? null : () => _generate(direct: true),
          )
        else
          Row(
            children: [
              Expanded(
                child: PrimaryButton(
                  text: '生成',
                  icon: Icons.auto_awesome,
                  loading: _sending,
                  onPressed: i.consumed ? null : () => _generate(),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton(
                  onPressed:
                      i.consumed || _sending ? null : () => _generate(direct: true),
                  child: const Text('按推荐直接生成'),
                ),
              ),
            ],
          ),
        if (widget.easy && i.clarifying && i.questions.isNotEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('不想答？点上面「直接生成」就好',
                style: TextStyle(color: Colors.white38, fontSize: 12)),
          ),
      ],
    );
  }
}

/// 傻瓜级全屏意图流
class IntentFlowPage extends ConsumerWidget {
  const IntentFlowPage({super.key, required this.intentId, this.easy = true});

  final String intentId;
  final bool easy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('灵感理解')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: IntentFlowPanel(
          intentId: intentId,
          easy: easy,
          onGenerated: (jobId) =>
              ProgressPage.pushReplacement(context, jobId),
        ),
      ),
    );
  }
}
