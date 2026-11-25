import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import '../assistant/assistant_models.dart';
import '../assistant/assistant_state.dart';
import '../assistant/assistant_surface.dart';
import '../create/credit_guard.dart';
import '../create/progress_page.dart';
import '../create/shelf_store.dart';

/// 过程页要素用的人话标签（不把 start_sec/semitones 这种键名甩给用户）
const kDspOpZh = {'trim': '裁剪', 'fade': '淡入淡出', 'pitch': '变调', 'tempo': '变速'};
const kDspParamZh = {
  'start_sec': '开始（秒）',
  'end_sec': '结束（秒）',
  'in_sec': '淡入（秒）',
  'out_sec': '淡出（秒）',
  'semitones': '变调（半音）',
  'factor': '倍速',
};

/// DSP 入口：裁剪 / 淡化 / 变调 / 变速 → job → 进度
class DspPage extends ConsumerStatefulWidget {
  const DspPage({super.key, required this.workId});

  final String workId;

  @override
  ConsumerState<DspPage> createState() => _DspPageState();
}

class _DspPageState extends ConsumerState<DspPage> {
  String _op = 'trim'; // trim/fade/pitch/tempo
  double _startSec = 0;
  double _endSec = 30;
  double _fadeIn = 2;
  double _fadeOut = 2;
  double _semitones = 0;
  double _tempoFactor = 1.0;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _setAssistantContext();
    });
  }

  void _setAssistantContext() {
    ref.read(assistantContextProvider.notifier).state = AssistantContext(
      surface: 'library',
      refs: [AssistantRef('work', widget.workId)],
    );
  }

  bool get _ownsAssistantContext {
    final current = ref.read(assistantContextProvider);
    return current.surface == 'library' &&
        current.refs.length == 1 &&
        current.refs.single.type == 'work' &&
        current.refs.single.id == widget.workId;
  }

  @override
  void dispose() {
    if (_ownsAssistantContext) {
      ref.read(assistantContextProvider.notifier).state =
          const AssistantContext(surface: 'library');
    }
    super.dispose();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _submit() async {
    if (!await ensureCredits(context, ref, kCreditDsp, action: 'DSP 处理')) {
      return;
    }
    setState(() => _busy = true);
    try {
      final params = <String, dynamic>{};
      switch (_op) {
        case 'trim':
          if (_endSec <= _startSec) {
            _toast('裁剪结束需大于开始');
            return;
          }
          params['start_sec'] = _startSec.round();
          params['end_sec'] = _endSec.round();
          break;
        case 'fade':
          params['in_sec'] = _fadeIn.round();
          params['out_sec'] = _fadeOut.round();
          break;
        case 'pitch':
          params['semitones'] = _semitones.round();
          break;
        case 'tempo':
          params['factor'] = _tempoFactor;
          break;
      }
      final jobId =
          await ref.read(apiClientProvider).dsp(widget.workId, _op, params);
      if (!mounted) return;
      final api = ref.read(apiClientProvider);
      ProgressPage.push(
        context,
        jobId,
        title: '音频处理中',
        brief: TaskBrief(
          action: '音频处理',
          sourceLabel: '曲库作品',
          count: 1,
          extra: {
            '操作': kDspOpZh[_op] ?? _op,
            for (final e in params.entries)
              (kDspParamZh[e.key] ?? e.key): '${e.value}',
          },
        ),
        plannedCount: 1,
        onRetry: () async {
          try {
            return await api.dsp(widget.workId, _op, params);
          } catch (_) {
            return null;
          }
        },
      );
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('提交失败，请重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('音频小手术')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const AssistantSuggestionCard(
            title: '解释这个音频处理',
            prompt: '请基于当前作品上下文，解释裁剪、淡化、变调和变速对音频的影响，并给出适合这首作品的处理建议',
            icon: Icons.hearing_outlined,
          ),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'trim', label: Text('裁剪')),
              ButtonSegment(value: 'fade', label: Text('淡化')),
              ButtonSegment(value: 'pitch', label: Text('变调')),
              ButtonSegment(value: 'tempo', label: Text('变速')),
            ],
            selected: {_op},
            onSelectionChanged: (s) => setState(() => _op = s.first),
          ),
          const SizedBox(height: 24),
          switch (_op) {
            'trim' => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('起点 ${_startSec.round()}s'),
                  Slider(
                      value: _startSec,
                      min: 0,
                      max: 240,
                      divisions: 240,
                      onChanged: (v) => setState(() {
                            _startSec = v;
                            if (_endSec < v + 1) _endSec = v + 1;
                          })),
                  Text('终点 ${_endSec.round()}s'),
                  Slider(
                      value: _endSec,
                      min: 0,
                      max: 240,
                      divisions: 240,
                      onChanged: (v) => setState(() => _endSec = v)),
                ],
              ),
            'fade' => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('淡入 ${_fadeIn.round()}s'),
                  Slider(
                      value: _fadeIn,
                      min: 0,
                      max: 10,
                      divisions: 10,
                      onChanged: (v) => setState(() => _fadeIn = v)),
                  Text('淡出 ${_fadeOut.round()}s'),
                  Slider(
                      value: _fadeOut,
                      min: 0,
                      max: 10,
                      divisions: 10,
                      onChanged: (v) => setState(() => _fadeOut = v)),
                ],
              ),
            'pitch' => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('变调 ${_semitones.round()} 半音（±12）'),
                  Slider(
                      value: _semitones,
                      min: -12,
                      max: 12,
                      divisions: 24,
                      label: '${_semitones.round()}',
                      onChanged: (v) => setState(() => _semitones = v)),
                ],
              ),
            _ => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('速度 ×${_tempoFactor.toStringAsFixed(2)}（变速不变调）'),
                  Slider(
                      value: _tempoFactor,
                      min: 0.5,
                      max: 2.0,
                      divisions: 30,
                      label: '×${_tempoFactor.toStringAsFixed(2)}',
                      onChanged: (v) => setState(() => _tempoFactor = v)),
                ],
              ),
          },
          const SizedBox(height: 28),
          PrimaryButton(
            text: '开始处理',
            big: true,
            icon: Icons.tune,
            loading: _busy,
            onPressed: _busy ? null : _submit,
          ),
        ],
      ),
    );
  }
}
