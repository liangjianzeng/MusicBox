import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import '../create/credit_guard.dart';
import '../create/progress_page.dart';

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
      final jobId = await ref.read(apiClientProvider).dsp(widget.workId, _op, params);
      if (!mounted) return;
      ProgressPage.push(context, jobId, title: '音频处理中');
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
      appBar: AppBar(title: const Text('音频小手术（约 5 积分）')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
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
              )
            ,
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
              )
            ,
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
              )
            ,
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
