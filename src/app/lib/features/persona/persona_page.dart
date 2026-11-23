import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/consent.dart';
import '../../shared/widgets/primary_button.dart';

/// 声音人格：列表 / 录音登记（20-40s）/ 默认选用
class PersonaPage extends ConsumerStatefulWidget {
  const PersonaPage({super.key});

  @override
  ConsumerState<PersonaPage> createState() => _PersonaPageState();
}

class _PersonaPageState extends ConsumerState<PersonaPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback(
        (_) => ref.read(personasProvider.notifier).load(force: true));
  }

  @override
  Widget build(BuildContext context) {
    final personas = ref.watch(personasProvider);
    final defaultId = ref.watch(defaultPersonaProvider);
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 10, 16, 8),
            child: Row(
              children: [
                Text('声音人格',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                Spacer(),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: PrimaryButton(
              text: '录一个新音色（20-40 秒）',
              icon: Icons.mic_rounded,
              expand: true,
              onPressed: () => _recordDialog(),
            ),
          ),
          Expanded(
            child: personas.isEmpty
                ? const Center(
                    child: Text('还没有人格，录一段 20-40 秒的干净人声试试',
                        style: TextStyle(color: Colors.white38)),
                  )
                : RefreshIndicator(
                    onRefresh: () =>
                        ref.read(personasProvider.notifier).load(force: true),
                    child: ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: personas.length,
                      itemBuilder: (ctx, i) {
                        final p = personas[i];
                        final isDefault = defaultId == p.id;
                        return Card(
                          margin: const EdgeInsets.only(bottom: 10),
                          child: ListTile(
                            leading: CircleAvatar(
                              backgroundColor:
                                  Theme.of(context).colorScheme.primaryContainer,
                              child: Text(p.name.characters.first,
                                  style: TextStyle(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onPrimaryContainer)),
                            ),
                            title: Text(p.name),
                            subtitle: Text(
                                '${p.isPublic ? '公开 · ' : ''}被使用 ${p.useCount} 次'),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (isDefault)
                                  const Chip(
                                    label: Text('默认',
                                        style: TextStyle(fontSize: 11)),
                                    visualDensity: VisualDensity.compact,
                                  )
                                else
                                  TextButton(
                                    onPressed: () async {
                                      await ref
                                          .read(prefsProvider)
                                          .setDefaultPersonaId(p.id);
                                      ref
                                          .read(defaultPersonaProvider
                                              .notifier)
                                          .state = p.id;
                                    },
                                    child: const Text('设为默认'),
                                  ),
                                IconButton(
                                  icon: const Icon(Icons.play_arrow_rounded),
                                  tooltip: '创作时使用',
                                  onPressed: () async {
                                    await ref
                                        .read(prefsProvider)
                                        .setDefaultPersonaId(p.id);
                                    ref
                                        .read(defaultPersonaProvider.notifier)
                                        .state = p.id;
                                    ScaffoldMessenger.of(context).showSnackBar(
                                        SnackBar(content: Text('已选「${p.name}」为默认音色')));
                                  },
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  /// 录音登记对话框：20-40s 校验 + multipart 上传
  Future<void> _recordDialog() async {
    if (!await ensureBiometricConsent(context, ref)) return;
    if (!mounted) return;
    final result = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => const _RecordDialog(),
    );
    if (result == null || !mounted) return;
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final c = TextEditingController();
        return AlertDialog(
          title: const Text('给音色起个名字'),
          content: TextField(
              controller: c,
              autofocus: true,
              maxLength: 20,
              decoration: const InputDecoration(hintText: '如：小空的清亮女声')),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('取消')),
            FilledButton(
                onPressed: () => Navigator.pop(ctx, c.text.trim()),
                child: const Text('登记')),
          ],
        );
      },
    );
    if (name == null || name.isEmpty) return;
    try {
      await ref.read(apiClientProvider).createPersona(name, result);
      await ref.read(personasProvider.notifier).load(force: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('「$name」登记成功')));
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.zh)));
    }
  }
}

class _RecordDialog extends ConsumerStatefulWidget {
  const _RecordDialog();

  @override
  ConsumerState<_RecordDialog> createState() => _RecordDialogState();
}

class _RecordDialogState extends ConsumerState<_RecordDialog> {
  final AudioRecorder _rec = AudioRecorder();
  Timer? _tick;
  bool _recording = false;
  bool _done = false;
  int _elapsed = 0;
  String? _path;

  @override
  void dispose() {
    _tick?.cancel();
    _rec.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    if (!await _rec.hasPermission()) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('没有麦克风权限')));
      return;
    }
    final dir = await getTemporaryDirectory();
    _path = '${dir.path}/persona_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _rec.start(
      const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 128000,
          sampleRate: 44100,
          numChannels: 1),
      path: _path!,
    );
    setState(() {
      _recording = true;
      _done = false;
      _elapsed = 0;
    });
    _tick = Timer.periodic(const Duration(seconds: 1), (t) {
      setState(() => _elapsed++);
      if (_elapsed >= 45) _stop(); // 上限保护，建议 20-40s
    });
  }

  Future<void> _stop() async {
    _tick?.cancel();
    final p = await _rec.stop();
    setState(() {
      _recording = false;
      _done = true;
      _path = p ?? _path;
    });
  }

  String get _hint {
    if (!_recording && !_done) return '点击下方按钮开始，唱或读 20-40 秒';
    if (_recording) {
      if (_elapsed < 20) return '继续录… 至少 20 秒（当前 ${_elapsed}s）';
      if (_elapsed <= 40) return '很好！可以停止啦（当前 ${_elapsed}s）';
      return '有点长了，尽快停止（当前 ${_elapsed}s）';
    }
    if (_elapsed < 20) return '太短了（${_elapsed}s），请重录至少 20 秒';
    if (_elapsed > 40) return '超过 40 秒（${_elapsed}s），请重录';
    return '时长合格（${_elapsed}s），可以登记了';
  }

  bool get _valid => _done && _elapsed >= 20 && _elapsed <= 40;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('录制音色样本'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('在安静环境清唱或朗读 20-40 秒，仅用于音色复刻',
              style: TextStyle(fontSize: 13, color: Colors.white70)),
          const SizedBox(height: 16),
          Text('${_elapsed}s',
              style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(_hint,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: Colors.white54)),
          const SizedBox(height: 16),
          IconButton.filled(
            iconSize: 40,
            onPressed: _recording ? _stop : _start,
            icon: Icon(_recording ? Icons.stop_rounded : Icons.fiber_manual_record_rounded),
          ),
        ],
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消')),
        FilledButton(
          onPressed: _valid ? () => Navigator.pop(context, _path) : null,
          child: const Text('下一步'),
        ),
      ],
    );
  }
}
