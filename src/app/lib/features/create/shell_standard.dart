import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/primary_button.dart';
import 'credit_guard.dart';
import 'creation_state.dart';
import 'intent_flow_page.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'transcript_confirm_page.dart';
import 'voice_capture.dart';

/// 标准级：意图卡 + 全部澄清题（选项 chips，推荐高亮，可跳过）
/// + mood/流派/人声/时长 轻参数
class ShellStandard extends ConsumerStatefulWidget {
  const ShellStandard({super.key, this.keyboardOpen});

  final bool? keyboardOpen;

  @override
  ConsumerState<ShellStandard> createState() => _ShellStandardState();
}

class _ShellStandardState extends ConsumerState<ShellStandard> {
  bool _busy = false;
  final TextEditingController _prompt = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prompt.text = ref.read(creationProvider).prompt;
  }

  @override
  void dispose() {
    _prompt.dispose();
    super.dispose();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  void _setPrompt(String value) {
    _prompt.value = TextEditingValue(
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
            builder: (_) => TranscriptConfirmPage(
                capture: cap, easy: false, autoOpenFlow: false)),
      );
      if (!mounted) return;
      if (exit?.kind == kConfirmIntent && exit!.text.isNotEmpty) {
        ref.read(creationProvider.notifier).setIntent(exit.text);
      } else if (exit?.kind == kConfirmTyped && exit!.text.isNotEmpty) {
        _setPrompt(exit.text);
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
      await capturePhotoAndIntent(context, ref);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _generateFromParams() async {
    if (_busy) return;
    final st = ref.read(creationProvider);
    if (_prompt.text.trim().isEmpty && st.mood.isEmpty && st.genre == null) {
      _toast('给点灵感吧：说句话或选个心情');
      return;
    }
    setState(() => _busy = true);
    try {
      if (!await ensureCredits(context, ref, kCreditGenerateEach * 3,
          action: '标准生成')) {
        return;
      }
      final tags = <String>[
        if (st.genre != null) st.genre!,
        if (st.instrumental) '纯音乐',
      ];
      final body = <String, dynamic>{
        'mode': 'simple',
        'prompt': _prompt.text.trim(),
        'mood': st.mood.join(','),
        'tags': tags.join(','),
        'sec': st.sec,
        'count': 3,
        if (st.personaId != null) 'persona_id': st.personaId,
      };
      final model = ref.read(musicModelProvider);
      final r = await ref.read(apiClientProvider).generate(body, model: model);
      if (!mounted) return;
      ProgressPage.push(
        context,
        '${r['job_id']}',
        brief: TaskBrief.fromCreation(
          st,
          prompt: _prompt.text.trim(),
          tags: tags,
          count: 3,
          personaName: st.personaId == null ? null : '已选人格',
        ).copyLike(sourceLabel: '轻参数直接生成'),
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
      if (_prompt.text != next.prompt) _setPrompt(next.prompt);
    });
    final st = ref.watch(creationProvider);
    final notifier = ref.read(creationProvider.notifier);
    final scheme = Theme.of(context).colorScheme;
    final keyboardOpen =
        widget.keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
            children: [
              TextField(
                controller: _prompt,
                maxLines: 2,
                minLines: 1,
                onChanged: notifier.setPrompt,
                decoration: const InputDecoration(
                  hintText: '一句话描述想要的歌（可选，意图卡会自动预填）',
                  alignLabelWithHint: true,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 14),
              if (st.intentId != null) ...[
                IntentFlowPanel(
                  intentId: st.intentId!,
                  easy: false,
                  onGenerated: (jobId, brief, retry) => ProgressPage.push(
                      context, jobId,
                      brief: brief, plannedCount: 3, onRetry: retry),
                ),
                const Divider(height: 32),
              ],
              const _Label('心情'),
              MoodChips(
                options: kMoodOptions,
                selected: st.mood,
                onChanged: notifier.setMood,
              ),
              const SizedBox(height: 14),
              const _Label('流派'),
              MoodChips(
                options: kGenreOptions,
                selected: st.genre == null ? const [] : [st.genre!],
                single: true,
                onChanged: (v) => notifier.setGenre(v.isEmpty ? null : v.first),
              ),
              const SizedBox(height: 14),
              const _Label('人声'),
              MoodChips(
                options: const ['人声演唱', '纯音乐'],
                selected: [st.instrumental ? '纯音乐' : '人声演唱'],
                single: true,
                onChanged: (v) =>
                    notifier.setInstrumental(v.isNotEmpty && v.first == '纯音乐'),
              ),
              const SizedBox(height: 14),
              const _Label('时长（秒）'),
              Wrap(
                spacing: 6,
                children: [30, 45, 60, 90, 120]
                    .map((s) => ChoiceChip(
                          label: Text('${s}s'),
                          selected: st.sec == s,
                          onSelected: (_) => notifier.setSec(s),
                        ))
                    .toList(),
              ),
              Slider(
                value: st.sec.toDouble().clamp(15, 240),
                min: 15,
                max: 240,
                divisions: 45,
                label: '${st.sec}s',
                onChanged: (v) => notifier.setSec(v.round()),
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
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (!keyboardOpen) ...[
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _busy ? null : _onPhoto,
                            icon: const Icon(Icons.photo_camera_rounded,
                                size: 18),
                            label: const Text('拍一张'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              HoldToTalkButton(
                                compact: true,
                                enabled: !_busy,
                                onResult: _onVoice,
                              ),
                              const SizedBox(width: 6),
                              const Flexible(
                                child: Text('按住说话',
                                    style: TextStyle(
                                        fontSize: 12, color: Colors.white70)),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                  ],
                  if (st.intentId == null)
                    PrimaryButton(
                      text: '生成 3 首候选 · 约 45 积分',
                      big: true,
                      icon: Icons.auto_awesome,
                      loading: _busy,
                      onPressed: _busy ? null : _generateFromParams,
                    )
                  else
                    const Text('在上方灵感卡确认参数后生成',
                        style: TextStyle(color: Colors.white38, fontSize: 12)),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text,
          style: const TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: 13,
              color: Colors.white70)),
    );
  }
}
