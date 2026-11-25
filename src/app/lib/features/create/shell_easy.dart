import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import 'creation_state.dart';
import 'credit_guard.dart';
import 'intent_flow_page.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'style_picker.dart';
import 'transcript_confirm_page.dart';
import 'voice_capture.dart';

/// 简约级「灵感拍立得」：大按钮按住说话(≤60s) / 拍一张 / 一句话 → intent 流
class ShellEasy extends ConsumerStatefulWidget {
  const ShellEasy({super.key, this.keyboardOpen});

  final bool? keyboardOpen;

  @override
  ConsumerState<ShellEasy> createState() => _ShellEasyState();
}

class _ShellEasyState extends ConsumerState<ShellEasy> {
  bool _busy = false;
  final TextEditingController _text = TextEditingController();

  @override
  void initState() {
    super.initState();
    _text.text = ref.read(creationProvider).prompt;
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  void _setText(String value) {
    _text.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    ref.read(creationProvider.notifier).setPrompt(value);
  }

  Future<void> _onVoice(VoiceCaptureResult cap) async {
    if (_busy) return;
    if (!cap.hasAnything) {
      _toast(cap.local?.error ?? '没听清，再说一遍');
      return;
    }
    setState(() => _busy = true);
    try {
      if (!mounted) return;
      final exit = await Navigator.of(context).push<ConfirmExit>(
        MaterialPageRoute(
            builder: (_) => TranscriptConfirmPage(capture: cap, easy: true)),
      );
      if (!mounted) return;
      if (exit?.kind == kConfirmTyped && exit!.text.isNotEmpty) {
        _setText(exit.text);
        _toast('已填进「一句话」，可以直接改');
      } else if (exit?.kind == kConfirmRedo) {
        _toast('好，再按住说一次');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _onPhoto() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final id = await capturePhotoAndIntent(context, ref);
      if (id != null && mounted) {
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => IntentFlowPage(intentId: id, easy: true),
        ));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _onText() async {
    if (_busy) return;
    final prompt = _text.text.trim();
    if (prompt.isEmpty) return;
    setState(() => _busy = true);
    try {
      if (!await ensureCredits(context, ref, kCreditGenerateEach * 3,
          action: '一键出歌')) {
        return;
      }
      final body = <String, dynamic>{
        'mode': 'simple',
        'prompt': prompt,
        'count': 3,
      };
      final model = ref.read(musicModelProvider);
      final r = await ref.read(apiClientProvider).generate(body, model: model);
      if (!mounted) return;
      _setText('');
      ProgressPage.push(
        context,
        '${r['job_id']}',
        brief: const TaskBrief(
                action: '生成', tierLabel: '简约', sourceLabel: '一句话', count: 3)
            .copyLike(prompt: prompt),
        plannedCount: 3,
        onRetry: () async {
          try {
            final rr =
                await ref.read(apiClientProvider).generate(body, model: model);
            return '${rr['job_id']}';
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
    ref.listen(creationProvider, (previous, next) {
      if (_text.text != next.prompt) _setText(next.prompt);
    });
    final scheme = Theme.of(context).colorScheme;
    final keyboardOpen =
        widget.keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    final shortScreen = MediaQuery.sizeOf(context).height < 640;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 20),
            children: [
              const SizedBox(height: 8),
              const Text('说出你的灵感，即刻成曲',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              const Text('按住说话 · 拍一张 · 打一句话，AI 帮你写成歌',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white38, fontSize: 13)),
              const SizedBox(height: 20),
              InspirationChips(
                samples: const ['雨夜咖啡馆的爵士', '公路旅行，City Pop', '治愈女声，木吉他'],
                onPick: (v) {
                  if (!_busy) _setText(v);
                },
              ),
            ],
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            border: Border(top: BorderSide(color: scheme.outlineVariant)),
          ),
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: _text,
                    minLines: 1,
                    maxLines: shortScreen ? 2 : 3,
                    textInputAction: TextInputAction.send,
                    onChanged: (v) =>
                        ref.read(creationProvider.notifier).setPrompt(v),
                    onSubmitted: (_) => _onText(),
                    decoration: InputDecoration(
                      hintText: shortScreen ? '或打一句话' : '或打一句话，如“雨天咖啡馆的爵士”',
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  if (!keyboardOpen) ...[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              HoldToTalkButton(
                                compact: true,
                                enabled: !_busy,
                                onResult: _onVoice,
                              ),
                              if (!shortScreen) ...[
                                const SizedBox(height: 6),
                                const Text('按住说话',
                                    style: TextStyle(
                                        fontSize: 12, color: Colors.white70)),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton(
                            onPressed: _busy ? null : _onPhoto,
                            style: OutlinedButton.styleFrom(
                              minimumSize: Size(0, shortScreen ? 64 : 72),
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 8),
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(16)),
                            ),
                            child: const Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.photo_camera_rounded),
                                SizedBox(height: 6),
                                Text('拍一张', textAlign: TextAlign.center),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                  ],
                  const SizedBox(height: 10),
                  PrimaryButton(
                    text: '生成 3 首 · 约 45 积分',
                    big: true,
                    icon: Icons.auto_awesome,
                    loading: _busy,
                    onPressed: _busy ? null : _onText,
                  ),
                  if (!keyboardOpen && !shortScreen)
                    const Padding(
                      padding: EdgeInsets.only(top: 6),
                      child: Text('失败自动返还积分',
                          style:
                              TextStyle(color: Colors.white38, fontSize: 11)),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
