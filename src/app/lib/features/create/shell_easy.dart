import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import 'creation_state.dart';
import 'creation_ui.dart';
import 'credit_guard.dart';
import 'intent_flow_page.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'style_picker.dart';
import 'transcript_confirm_page.dart';
import 'voice_capture.dart';

/// 简约级「灵感拍立得」：底部输入坞 + 语音/拍照/一句话 → intent 流
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
        _toast('已填进灵感框，可以直接改');
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
    final keyboardOpen =
        widget.keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    final shortScreen = MediaQuery.sizeOf(context).height < 640;
    return Column(
      children: [
        Expanded(
          child: CustomScrollView(
            key: const ValueKey('creation-easy-scroll'),
            slivers: [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Padding(
                  padding: EdgeInsets.fromLTRB(
                    24,
                    shortScreen ? 4 : 12,
                    24,
                    shortScreen ? 12 : 22,
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (!shortScreen) ...[
                        const Row(
                          children: [
                            Icon(Icons.auto_awesome_rounded,
                                size: 14, color: CreationPalette.amber),
                            SizedBox(width: 7),
                            Text(
                              'AI MUSIC STUDIO',
                              style: TextStyle(
                                color: CreationPalette.violetBright,
                                fontSize: 10,
                                height: 1,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 2,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                      ],
                      Text(
                        shortScreen ? '让灵感成歌' : '让灵感，\n即刻成歌',
                        textAlign:
                            shortScreen ? TextAlign.center : TextAlign.left,
                        style: TextStyle(
                          color: CreationPalette.text,
                          fontSize: shortScreen ? 26 : 34,
                          height: 1.12,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -1,
                        ),
                      ),
                      SizedBox(height: shortScreen ? 8 : 12),
                      if (!shortScreen)
                        const Text(
                          '说一句、拍一张，或写下你脑海里的画面。\n剩下的，交给 MusicBox。',
                          style: TextStyle(
                            color: CreationPalette.muted,
                            fontSize: 13,
                            height: 1.55,
                          ),
                        ),
                      SizedBox(height: shortScreen ? 14 : 30),
                      if (!shortScreen)
                        const Row(
                          children: [
                            Text(
                              '从这些灵感开始',
                              style: TextStyle(
                                color: CreationPalette.text,
                                fontSize: 13,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            Spacer(),
                            Text(
                              '点一下填入',
                              style: TextStyle(
                                color: CreationPalette.faint,
                                fontSize: 10,
                              ),
                            ),
                          ],
                        ),
                      if (!shortScreen) const SizedBox(height: 10),
                      if (!shortScreen)
                        InspirationChips(
                          samples: const [
                            '雨夜爵士',
                            '公路 City Pop',
                            '治愈木吉他',
                          ],
                          onPick: (v) {
                            if (!_busy) _setText(v);
                          },
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        CreationDock(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _text,
                minLines: 1,
                maxLines: shortScreen ? 2 : 3,
                textInputAction: TextInputAction.send,
                style: const TextStyle(
                  color: CreationPalette.text,
                  fontSize: 14,
                  height: 1.4,
                ),
                onChanged: (v) =>
                    ref.read(creationProvider.notifier).setPrompt(v),
                onSubmitted: (_) => _onText(),
                decoration: creationFieldDecoration(
                  hint: shortScreen ? '输入灵感' : '输入灵感，或直接按住说话',
                ),
              ),
              if (!keyboardOpen) ...[
                SizedBox(height: shortScreen ? 9 : 12),
                CreationInputActions(
                  compact: shortScreen,
                  voice: HoldToTalkButton(
                    compact: true,
                    enabled: !_busy,
                    onResult: _onVoice,
                  ),
                  onPhoto: _busy ? null : _onPhoto,
                ),
                SizedBox(height: shortScreen ? 9 : 12),
              ],
              PrimaryButton(
                text: '生成 3 首',
                big: true,
                gradient: true,
                icon: Icons.auto_awesome_rounded,
                loading: _busy,
                onPressed: _busy ? null : _onText,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
