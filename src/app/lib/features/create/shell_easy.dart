import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import 'creation_state.dart';
import 'creation_ui.dart';
import 'credit_guard.dart';
import 'intent_flow_page.dart';
import '../../shared/widgets/mood_chips.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'style_options.dart';
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
  /// 简约档也要能回答「谁来唱」：性别是这首歌最贵的选择，不该只有标准/深度档才配决定。
  /// 三档一致是产品底线（同一个用户在三档之间来回，不该发现某档锁不住性别）。
  String? _voice;
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
    final localText = cap.local?.text.trim() ?? '';
    if (localText.isNotEmpty) _setText(localText);
    setState(() => _busy = true);
    try {
      if (!mounted) return;
      final exit = await Navigator.of(context).push<ConfirmExit>(
        MaterialPageRoute(
            builder: (_) => TranscriptConfirmPage(
                  capture: cap,
                  easy: true,
                  onTranscript: _setText,
                )),
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
      final cat = styleCatalogOf(ref);
      final body = <String, dynamic>{
        'mode': 'simple',
        'prompt': prompt,
        'count': 3,
        // 谁来唱：简约档也必须能锁性别。走 tags 的规范词（中文标签→服务端词典的 wire 词），
        // 与标准/深度档同一真源，绝不在端侧另立一套词表。
        if (_voice != null) 'tags': [cat.wireOf(_voice!)],
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
                // 谁来唱：三档一致。以前只有标准/深度档能选性别，于是"最省事的那一档"
                // 恰恰是锁不住音色的那一档。必须放在 sticky dock 里 —— hero 区不滚动，
                // 放上去会被输入卡片整个盖住（2026-11-27 真机第一次就踩了这个）。
                const SizedBox(height: 10),
                const Row(
                  children: [
                    Text(
                      '谁来唱',
                      style: TextStyle(
                        color: CreationPalette.text,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '单选 · 这是"人"，不是风格',
                        style: TextStyle(
                            fontSize: 10.5, color: CreationPalette.faint),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                MoodChips(
                  options: styleCatalogOf(ref)
                      .genders
                      .map((e) => e.zh)
                      .toList(growable: false),
                  selected: _voice == null ? const [] : [_voice!],
                  single: true,
                  onChanged: (v) =>
                      setState(() => _voice = v.isEmpty ? null : v.first),
                ),
                SizedBox(height: shortScreen ? 9 : 12),
                CreationInputActions(
                  compact: shortScreen,
                  voice: HoldToTalkButton(
                    compact: true,
                    enabled: !_busy,
                    onResult: _onVoice,
                    onPartial: _setText,
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
