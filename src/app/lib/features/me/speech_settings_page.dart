import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:record/record.dart';

import '../../core/speech/asr_engine.dart';
import '../../core/speech/sherpa_asr.dart';
import '../../core/speech/speech_model_manager.dart';
import '../../core/speech/speech_service.dart';
import '../../core/speech/speech_settings.dart';
import '../../core/speech/tts_engine.dart';
import '../../core/state.dart';

/// 语音能力页：档位可配置切换 + 模型按需下载/删除 + 朗读设置 + 自检。
///
/// 文案纪律：全程不出现任何模型/引擎型号名，只说「即时 / 精听 / 服务端」这类能力话；
/// 自检结论一律来自实测（文件在不在、加载成没成、服务端探活回什么），不写死「正常」。
class SpeechSettingsPage extends ConsumerStatefulWidget {
  const SpeechSettingsPage({super.key});

  @override
  ConsumerState<SpeechSettingsPage> createState() => _SpeechSettingsPageState();
}

class _SpeechSettingsPageState extends ConsumerState<SpeechSettingsPage> {
  StreamSubscription<SpeechProgressEvent>? _sub;
  final Map<SpeechModel, _ModelUi> _ui = {
    for (final m in SpeechModel.values) m: _ModelUi(),
  };
  final AudioRecorder _rec = AudioRecorder();
  bool _checking = false;
  Map<String, dynamic>? _serverHealth;
  String? _healthNote;
  bool _speaking = false;

  @override
  void initState() {
    super.initState();
    _sub = SpeechModelManager.updates.listen(_onProgress);
    _refresh();
    _probeServer();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _rec.dispose();
    super.dispose();
  }

  void _onProgress(SpeechProgressEvent e) {
    if (!mounted) return;
    setState(() {
      final m = e.model;
      if (m == null) return;
      final ui = _ui[m]!;
      switch (e.phase) {
        case 'begin':
          ui.busy = true;
          ui.fraction = 0;
          ui.stage = '准备中';
        case 'file':
          ui.stage = e.file;
          ui.fraction = 0;
        case 'progress':
          ui.stage = e.file;
          ui.fraction = e.fileFraction;
          ui.received += 0; // 明细只在阶段行展示
        case 'done':
          ui.busy = false;
          ui.fraction = 1;
          ui.stage = '已就位';
        default:
          break;
      }
    });
  }

  Future<void> _refresh() async {
    for (final m in SpeechModel.values) {
      final ready = await SpeechModelManager.isReady(m);
      final bytes = await SpeechModelManager.sizeOnDisk(m);
      if (!mounted) return;
      setState(() {
        _ui[m]!.ready = ready;
        _ui[m]!.bytes = bytes;
        if (ready) _ui[m]!.stage = '已就位';
      });
    }
  }

  Future<void> _download(SpeechModel m) async {
    setState(() => _ui[m]!.error = null);
    try {
      await SpeechModelManager.ensure(m);
      await _refresh();
      // 刚下完就把引擎加载好，用户下次用不再干等
      if (m == SpeechModel.ttsZh) {
        await SherpaTtsEngine.prewarm(await SpeechModelManager.dirOf(m));
      } else {
        await SherpaAsrSession.warmup(
          useStreaming: await SpeechModelManager.isReady(SpeechModel.asrStreaming),
          useSenseVoice:
              await SpeechModelManager.isReady(SpeechModel.asrSenseVoice),
          streamingDir: await SpeechModelManager.dirOf(SpeechModel.asrStreaming),
          senseVoiceDir:
              await SpeechModelManager.dirOf(SpeechModel.asrSenseVoice),
        );
      }
    } on SpeechModelException catch (e) {
      if (!mounted) return;
      setState(() => _ui[m]!.error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _ui[m]!.error = '下载失败：$e');
    }
  }

  Future<void> _delete(SpeechModel m) async {
    if (m == SpeechModel.ttsZh) await SherpaTtsEngine.release();
    await SpeechModelManager.delete(m);
    await _refresh();
    if (!mounted) return;
    setState(() => _ui[m]!.busy = false);
  }

  Future<void> _probeServer() async {
    try {
      final d = await ref.read(apiClientProvider).speechHealth();
      if (!mounted) return;
      setState(() {
        _serverHealth = d;
        final asr = d['asr'];
        _healthNote = asr is Map
            ? (asr['ok'] == true
                ? '服务端识别：${asr['reason']}'
                : '服务端识别：${asr['reason']}')
            : '服务端没给出识别服务状态';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _healthNote = '问不到服务端状态（$e）');
    }
  }

  Future<void> _selfCheck() async {
    setState(() => _checking = true);
    final results = <String, String>{};
    try {
      results['麦克风'] = await _rec.hasPermission() ? '已授权' : '未授权（去系统设置里允许）';
    } catch (e) {
      results['麦克风'] = '查不到（$e）';
    }
    for (final m in SpeechModel.values) {
      final spec = SpeechModelManager.specOf(m);
      results[spec.capability] = _ui[m]!.ready ? '已就位（${_mb(_ui[m]!.bytes)}）' : '未下载';
    }
    if (_ui[SpeechModel.asrStreaming]!.ready ||
        _ui[SpeechModel.asrSenseVoice]!.ready) {
      final t0 = DateTime.now();
      await SherpaAsrSession.warmup(
        useStreaming: _ui[SpeechModel.asrStreaming]!.ready,
        useSenseVoice: _ui[SpeechModel.asrSenseVoice]!.ready,
        streamingDir: await SpeechModelManager.dirOf(SpeechModel.asrStreaming),
        senseVoiceDir:
            await SpeechModelManager.dirOf(SpeechModel.asrSenseVoice),
      );
      final ms = DateTime.now().difference(t0).inMilliseconds;
      results['本机识别加载'] = ms == 0 ? '已在内存里（秒开）' : '加载耗时 ${ms}ms';
    }
    final ttsDir = await SpeechModelManager.dirOf(SpeechModel.ttsZh);
    results['本机朗读'] = SherpaTtsEngine.layoutOk(ttsDir) ? '声库完整' : '声库不完整（缺 model/tokens/lexicon/dict）';
    if (!mounted) return;
    setState(() {
      _checking = false;
      _checkResults = results;
    });
    _probeServer();
  }

  Map<String, String>? _checkResults;

  Future<void> _trySpeak() async {
    if (_speaking) return;
    setState(() => _speaking = true);
    final s = ref.read(speechSettingsProvider);
    final err = await ref.read(speechServiceProvider).speak(
        '好，我用这台机器上的声音念给你听，语速 ${s.speakRate.toStringAsFixed(1)} 倍。');
    if (!mounted) return;
    setState(() => _speaking = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(speechSettingsProvider);
    final n = ref.read(speechSettingsProvider.notifier);
    return Scaffold(
      appBar: AppBar(title: const Text('语音能力')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          _sectionTitle('我说话时怎么听'),
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                for (final k in AsrEngineKind.values)
                  RadioListTile<AsrEngineKind>(
                    value: k,
                    groupValue: s.asrEngine,
                    title: Text(_engineTitle(k)),
                    subtitle: Text(_engineHint(k),
                        style: const TextStyle(fontSize: 12)),
                    onChanged: (v) {
                      if (v != null) n.setEngine(v);
                    },
                  ),
                const Divider(height: 1),
                SwitchListTile(
                  value: s.fallbackToServer,
                  title: const Text('本机不行时改用服务端'),
                  subtitle: const Text('关掉后，本机模型没就位就只提示、不偷偷上传',
                      style: TextStyle(fontSize: 12)),
                  onChanged: n.setFallbackToServer,
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          _sectionTitle('本机语音模型（不下载不占空间）'),
          for (final m in SpeechModel.values) _modelCard(m),
          const SizedBox(height: 18),
          _sectionTitle('念给我听'),
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                SwitchListTile(
                  value: s.autoSpeak,
                  title: const Text('助手回复自动朗读'),
                  subtitle: const Text('念的时候会暂停正在放的歌，念完接上',
                      style: TextStyle(fontSize: 12)),
                  onChanged: n.setAutoSpeak,
                ),
                const Divider(height: 1),
                ListTile(
                  title: const Text('语速'),
                  subtitle: Slider(
                    value: s.speakRate.clamp(0.6, 1.6),
                    min: 0.6,
                    max: 1.6,
                    divisions: 10,
                    label: '${s.speakRate.toStringAsFixed(1)} 倍',
                    onChanged: n.setSpeakRate,
                  ),
                  trailing: OutlinedButton(
                    onPressed: _speaking ? null : _trySpeak,
                    child: Text(_speaking ? '念着…' : '试听'),
                  ),
                ),
                ListTile(
                  title: const Text('说话人'),
                  subtitle: Slider(
                    value: s.speakerId.toDouble().clamp(0, 9),
                    min: 0,
                    max: 9,
                    divisions: 9,
                    label: '${s.speakerId + 1} 号',
                    onChanged: (v) => n.setSpeakerId(v.round()),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          _sectionTitle('自检'),
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.build_circle_outlined),
                  title: const Text('跑一遍自检'),
                  subtitle: const Text('麦克风授权、模型完整性、本机加载耗时、服务端识别服务',
                      style: TextStyle(fontSize: 12)),
                  trailing: _checking
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.chevron_right),
                  onTap: _checking ? null : _selfCheck,
                ),
                if (_healthNote != null)
                  ListTile(
                    leading: const Icon(Icons.cloud_outlined),
                    title: Text(_healthNote!, style: const TextStyle(fontSize: 13)),
                    subtitle: _serverHealth == null
                        ? null
                        : Text('探测时间 ${_serverHealth!['checked_at'] ?? '—'}（服务端 15 秒内复用上次探测）',
                            style: const TextStyle(
                                fontSize: 11, color: Colors.white30)),
                    trailing: IconButton(
                        icon: const Icon(Icons.refresh_rounded, size: 18),
                        onPressed: _probeServer),
                  ),
                if (_checkResults != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final e in _checkResults!.entries)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Icon(Icons.circle,
                                    size: 6, color: Colors.white24),
                                const SizedBox(width: 8),
                                Expanded(
                                    child: Text('${e.key}：${e.value}',
                                        style: const TextStyle(
                                            fontSize: 12.5, height: 1.4))),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          const Text('说明：识别用的模型与朗读声库都只存在这台机器上，删除即刻生效；'
              '上传给服务端复核的录音 72 小时后自动清理，不用于训练。',
              style: TextStyle(fontSize: 11.5, color: Colors.white38, height: 1.5)),
        ],
      ),
    );
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 2),
        child: Text(t,
            style: const TextStyle(
                fontSize: 13, fontWeight: FontWeight.w700, color: Colors.white70)),
      );

  Widget _modelCard(SpeechModel m) {
    final spec = SpeechModelManager.specOf(m);
    final ui = _ui[m]!;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(ui.ready ? Icons.verified_outlined : Icons.download_outlined,
                    size: 18, color: ui.ready ? Colors.greenAccent : Colors.white38),
                const SizedBox(width: 8),
                Expanded(
                    child: Text(spec.capability,
                        style: const TextStyle(fontSize: 14))),
                Text(ui.ready ? _mb(ui.bytes) : _mb(spec.totalBytes),
                    style: const TextStyle(fontSize: 12, color: Colors.white38)),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              ui.stage ?? (ui.ready ? '已就位' : '未下载（用到时才下，约 ${_mb(spec.totalBytes)}）'),
              style: const TextStyle(fontSize: 11.5, color: Colors.white38),
            ),
            if (ui.busy) ...[
              const SizedBox(height: 8),
              LinearProgressIndicator(value: ui.fraction > 0 ? ui.fraction : null),
            ],
            if (ui.error != null) ...[
              const SizedBox(height: 6),
              Text(ui.error!,
                  style: const TextStyle(fontSize: 11.5, color: Colors.orangeAccent)),
            ],
            Align(
              alignment: Alignment.centerRight,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (ui.ready)
                    TextButton(onPressed: () => _delete(m), child: const Text('删除')),
                  FilledButton.tonal(
                    onPressed: ui.busy || (ui.ready && m != SpeechModel.ttsZh)
                        ? null
                        : () => _download(m),
                    child: Text(ui.ready ? '重新校验' : (ui.busy ? '下载中…' : '下载')),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _engineTitle(AsrEngineKind k) => switch (k) {
        AsrEngineKind.streamingZipformer => '即时（边说边出字）',
        AsrEngineKind.senseVoiceOffline => '精听（整段听，带情绪与背景音）',
        AsrEngineKind.server => '服务端识别（不装本机模型）',
      };

  static String _engineHint(AsrEngineKind k) => switch (k) {
        AsrEngineKind.streamingZipformer =>
          '手感最好；最终逐字仍由服务端复核，情绪标签看服务端结果。',
        AsrEngineKind.senseVoiceOffline =>
          '松手后整段再听一遍，当场给情绪与背景音；模型较大。',
        AsrEngineKind.server => '什么都不用下载，但没网就听不了；说话时没有实时回显。',
      };

  static String _mb(int bytes) => bytes <= 0
      ? '0 MB'
      : '${(bytes / 1048576).toStringAsFixed(bytes > 10485760 ? 0 : 1)} MB';
}

class _ModelUi {
  bool ready = false;
  bool busy = false;
  int bytes = 0;
  double fraction = 0;
  int received = 0;
  String? stage;
  String? error;
}
