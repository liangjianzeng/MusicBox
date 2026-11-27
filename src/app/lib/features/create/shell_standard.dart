import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/primary_button.dart';
import '../../shared/widgets/tag_chip.dart';
import 'credit_guard.dart';
import 'style_options.dart';
import 'creation_state.dart';
import 'creation_ui.dart';
import 'intent_flow_page.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'transcript_confirm_page.dart';
import 'voice_capture.dart';

/// 标准级：意图卡 + 轻参数（心情/流派/人声/时长）+ 底部语音输入坞
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
    final localText = cap.local?.text.trim() ?? '';
    if (localText.isNotEmpty) _setPrompt(localText);
    setState(() => _busy = true);
    try {
      if (!mounted) return;
      final exit = await Navigator.of(context).push<ConfirmExit>(
        MaterialPageRoute(
            builder: (_) => TranscriptConfirmPage(
                  capture: cap,
                  easy: false,
                  autoOpenFlow: false,
                  onTranscript: _setPrompt,
                )),
      );
      if (!mounted) return;
      if (exit?.kind == kConfirmIntent && exit!.text.isNotEmpty) {
        ref.read(creationProvider.notifier).setIntent(exit.text);
      } else if (exit?.kind == kConfirmTyped && exit!.text.isNotEmpty) {
        _setPrompt(exit.text);
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
      final cat = styleCatalogOf(ref);
      final tags = <String>[
        // 人声词排在最前：服务端 tags 有 cap，先保住"谁来唱"，被挤掉的只能是装饰词。
        // （真机教训：勾了女声却出男声 —— 女声当年被当成风格点缀，配额被钢琴/黑胶吃光。）
        ...st.voice.map(cat.wireOf),
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
    // 三档同源：选择项一律吃服务端下发的 style_options（唯一真源），不再用编译期硬编表
    final cat = styleCatalogOf(ref);
    ref.listen(creationProvider, (previous, next) {
      if (_prompt.text != next.prompt) _setPrompt(next.prompt);
    });
    final st = ref.watch(creationProvider);
    final notifier = ref.read(creationProvider.notifier);
    final keyboardOpen =
        widget.keyboardOpen ?? MediaQuery.viewInsetsOf(context).bottom > 0;
    final shortScreen = MediaQuery.sizeOf(context).height < 640;
    return Column(
      children: [
        Expanded(
          child: ListView(
            key: const ValueKey('creation-standard-scroll'),
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
            children: [
              Container(
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
                decoration: BoxDecoration(
                  color: CreationPalette.surface,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: CreationPalette.border),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const CreationSectionLabel('灵感描述', trailing: '可选'),
                    TextField(
                      controller: _prompt,
                      maxLines: 3,
                      minLines: 1,
                      style: const TextStyle(
                        color: CreationPalette.text,
                        fontSize: 14,
                        height: 1.45,
                      ),
                      onChanged: notifier.setPrompt,
                      decoration: creationFieldDecoration(
                        hint: '比如：雨夜公路、复古合成器、温柔女声…',
                      ),
                    ),
                  ],
                ),
              ),
              if (st.intentId != null) ...[
                const SizedBox(height: 16),
                IntentFlowPanel(
                  intentId: st.intentId!,
                  easy: false,
                  onGenerated: (jobId, brief, retry) => ProgressPage.push(
                      context, jobId,
                      brief: brief, plannedCount: 3, onRetry: retry),
                ),
              ],
              const SizedBox(height: 22),
              // 以前这两组吃的是编译期硬编的 kMoodOptions/kGenreOptions：运营在服务端
              // 词典加了词（比如「微醺」），标准档永远看不见 —— 三档必须吃同一份下发目录。
              const CreationSectionLabel('心情', trailing: '可多选'),
              MoodChips(
                options: cat.moods.map((e) => e.zh).toList(growable: false),
                selected: st.mood,
                onChanged: notifier.setMood,
              ),
              const SizedBox(height: 22),
              const CreationSectionLabel('谁来唱', trailing: '单选 · 这是"人"不是风格'),
              MoodChips(
                options: cat.genders.map((e) => e.zh).toList(growable: false),
                selected: st.voice
                    .where((z) => cat.genders.any((e) => e.zh == z))
                    .toList(growable: false),
                single: true,
                onChanged: (v) => notifier.setVoice([
                  ...st.voice.where((z) => !cat.genders.any((e) => e.zh == z)),
                  ...v,
                ]),
              ),
              const SizedBox(height: 14),
              const CreationSectionLabel('怎么唱', trailing: '可多选 · 唱法≠情绪'),
              MoodChips(
                options: cat.deliveries.map((e) => e.zh).toList(growable: false),
                selected: st.voice
                    .where((z) => cat.deliveries.any((e) => e.zh == z))
                    .toList(growable: false),
                onChanged: notifier.setVoice,
              ),
              const SizedBox(height: 22),
              const CreationSectionLabel('曲风', trailing: '单选'),
              MoodChips(
                options: cat.genres.map((e) => e.zh).toList(growable: false),
                selected: st.genre == null ? const [] : [st.genre!],
                single: true,
                onChanged: (v) => notifier.setGenre(v.isEmpty ? null : v.first),
              ),
              const SizedBox(height: 22),
              const CreationSectionLabel('人声'),
              MoodChips(
                options: const ['人声演唱', '纯音乐'],
                selected: [st.instrumental ? '纯音乐' : '人声演唱'],
                single: true,
                onChanged: (v) =>
                    notifier.setInstrumental(v.isNotEmpty && v.first == '纯音乐'),
              ),
              const SizedBox(height: 22),
              Container(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: BoxDecoration(
                  color: CreationPalette.surface,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: CreationPalette.border),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Text(
                          '时长',
                          style: TextStyle(
                            color: CreationPalette.text,
                            fontSize: 14,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const Spacer(),
                        Text(
                          '${st.sec}s',
                          style: const TextStyle(
                            color: CreationPalette.violetBright,
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                    SliderTheme(
                      data: SliderTheme.of(context).copyWith(
                        activeTrackColor: CreationPalette.violet,
                        inactiveTrackColor: Colors.white.withValues(alpha: .08),
                        thumbColor: CreationPalette.violetBright,
                        overlayColor:
                            CreationPalette.violet.withValues(alpha: .12),
                        trackHeight: 3,
                      ),
                      child: Slider(
                        value: st.sec.toDouble().clamp(15, 240),
                        min: 15,
                        max: 240,
                        divisions: 45,
                        label: '${st.sec}s',
                        onChanged: (v) => notifier.setSec(v.round()),
                      ),
                    ),
                    Wrap(
                      spacing: 7,
                      runSpacing: 7,
                      children: [30, 45, 60, 90, 120].map((s) {
                        final selected = st.sec == s;
                        return TagChip(
                          label: Text('${s}s'),
                          selected: selected,
                          onTap: () => notifier.setSec(s),
                        );
                      }).toList(),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        CreationDock(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!keyboardOpen) ...[
                CreationInputActions(
                  compact: shortScreen,
                  voice: HoldToTalkButton(
                    compact: true,
                    enabled: !_busy,
                    onResult: _onVoice,
                    onPartial: _setPrompt,
                  ),
                  onPhoto: _busy ? null : _onPhoto,
                ),
                const SizedBox(height: 12),
              ],
              if (st.intentId == null)
                PrimaryButton(
                  text: '生成 3 首',
                  big: true,
                  gradient: true,
                  icon: Icons.auto_awesome_rounded,
                  loading: _busy,
                  onPressed: _busy ? null : _generateFromParams,
                )
              else
                Text(
                  shortScreen ? '在上方灵感卡确认参数' : '在上方灵感卡确认参数后生成',
                  style: const TextStyle(
                    color: CreationPalette.faint,
                    fontSize: 12,
                    height: 1.35,
                  ),
                  textAlign: TextAlign.center,
                ),
            ],
          ),
        ),
      ],
    );
  }
}
