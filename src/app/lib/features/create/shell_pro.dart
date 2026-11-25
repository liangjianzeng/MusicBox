import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/primary_button.dart';
import '../../shared/widgets/tag_chip.dart';
import 'credit_guard.dart';
import 'creation_state.dart';
import 'creation_ui.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'style_options.dart';
import 'style_picker.dart';

/// 歌词结构标记：插进歌词的必须是英文标记（模型只认 [Verse] 这类），
/// 界面显示中文——以前只有一排 [Verse]/[Chorus] 方括号，普通用户不知道那是干什么的
const kStructureTags = [
  ('[Verse]', '主歌'),
  ('[Chorus]', '副歌'),
  ('[Bridge]', '桥段'),
  ('[Intro]', '前奏'),
  ('[Outro]', '尾奏'),
];

/// 深度级工作台：prompt/歌词+结构标记/tags/mood/人声/bpm/时长/数量/persona/seed
class ShellPro extends ConsumerStatefulWidget {
  const ShellPro({super.key});

  @override
  ConsumerState<ShellPro> createState() => _ShellProState();
}

class _ShellProState extends ConsumerState<ShellPro> {
  bool _busy = false;
  final _prompt = TextEditingController();
  final _lyrics = TextEditingController();
  final _tags = TextEditingController();
  final _seed = TextEditingController();
  late List<String> _catalogTags;
  late List<String> _freeTags;

  /// 选择项目录（远程优先，兜底本地）——initState 里先定一次，build 里再随远程刷新取
  StyleCatalog _cat = StyleCatalog.fallback;

  @override
  void initState() {
    super.initState();
    _cat = styleCatalogOfConfig(ref.read(remoteConfigProvider));
    final st = ref.read(creationProvider);
    _prompt.text = st.prompt;
    _lyrics.text = st.lyrics;
    _seed.text = st.seed?.toString() ?? '';
    final tags = parseTagList(st.tags);
    _catalogTags = tags.where(_cat.isKnown).toList();
    _freeTags = tags.where((t) => !_cat.isKnown(t)).toList();
    _tags.text = joinTagList(_freeTags);
  }

  @override
  void dispose() {
    _prompt.dispose();
    _lyrics.dispose();
    _tags.dispose();
    _seed.dispose();
    super.dispose();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  void _syncTags() {
    ref
        .read(creationProvider.notifier)
        .setTags(joinTagList([..._catalogTags, ..._freeTags]));
  }

  void _setPrompt(String value) {
    _prompt.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    ref.read(creationProvider.notifier).setPrompt(value);
  }

  void _setLyrics(String value) {
    _lyrics.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    ref.read(creationProvider.notifier).setLyrics(value);
  }

  /// 在光标处插入结构标记
  void _insertTag(String tag) {
    final sel = _lyrics.selection;
    final text = _lyrics.text;
    final start = sel.isValid ? sel.start : text.length;
    final end = sel.isValid ? sel.end : text.length;
    final next = text.replaceRange(start, end, '\n$tag\n');
    _lyrics.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: start + tag.length + 2),
    );
    ref.read(creationProvider.notifier).setLyrics(next);
  }

  Future<void> _generate() async {
    if (_busy) return;
    final st = ref.read(creationProvider);
    final prompt = _prompt.text.trim();
    final lyrics = _lyrics.text.trim();
    if (prompt.isEmpty && lyrics.isEmpty) {
      _toast('至少给个灵感描述或歌词');
      return;
    }
    setState(() => _busy = true);
    try {
      if (!await ensureCredits(context, ref, kCreditGenerateEach * st.count,
          action: '深度生成 ${st.count} 首')) {
        return;
      }
      // 标签 = 选择器选中的规范词 + 自由补充（统一存于 st.tags，切档位不丢）
      final tagList = parseTagList(st.tags);
      final seedNum = int.tryParse(_seed.text.trim());
      final body = <String, dynamic>{
        'mode': 'custom',
        if (prompt.isNotEmpty) 'prompt': prompt,
        if (lyrics.isNotEmpty) 'lyrics': lyrics,
        if (tagList.isNotEmpty) 'tags': tagList,
        if (st.mood.isNotEmpty) 'mood': st.mood.join(','),
        'bpm': st.bpm,
        'sec': st.sec,
        'count': st.count,
        if (!st.instrumental) 'instrumental': false,
        if (st.instrumental) 'tags': [...tagList, '纯音乐'],
        if (st.personaId != null) 'persona_id': st.personaId,
        // 契约 generate 未定义 seed，透传由服务端兼容（可忽略）
        if (seedNum != null) 'seed': seedNum,
      };
      final model = ref.read(musicModelProvider);
      final r = await ref.read(apiClientProvider).generate(body, model: model);
      if (!mounted) return;
      ProgressPage.push(
        context,
        '${r['job_id']}',
        brief: TaskBrief.fromCreation(
          st,
          prompt: prompt,
          lyrics: lyrics,
          tags: st.instrumental ? [...tagList, '纯音乐'] : tagList,
          seed: seedNum,
          personaName: st.personaId == null ? null : '已选人格',
        ).copyLike(sourceLabel: '全参数工作台'),
        plannedCount: st.count,
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
      if (_lyrics.text != next.lyrics) _setLyrics(next.lyrics);
      final seed = next.seed?.toString() ?? '';
      if (_seed.text != seed) {
        _seed.value = TextEditingValue(
          text: seed,
          selection: TextSelection.collapsed(offset: seed.length),
        );
      }
    });
    final st = ref.watch(creationProvider);
    final notifier = ref.read(creationProvider.notifier);
    final personas = ref.watch(personasProvider);
    final cat = styleCatalogOf(ref);
    _cat = cat; // 与 initState 的回填口径保持一致（远程目录晚到时也对得上）
    return Column(
      children: [
        Expanded(
          child: Stack(
            children: [
              ListView(
                key: const ValueKey('creation-pro-scroll'),
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
                children: [
                  _ProCard(
                    step: '01',
                    title: '灵感描述',
                    child: TextField(
                      controller: _prompt,
                      maxLines: 3,
                      minLines: 2,
                      style: const TextStyle(
                        color: CreationPalette.text,
                        height: 1.45,
                      ),
                      onChanged: notifier.setPrompt,
                      decoration: creationFieldDecoration(
                        hint: '想要的画面/情绪/乐器，如：雨夜公路、合成器贝斯、微微加速',
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ProCard(
                    step: '02',
                    title: '歌词',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        TextField(
                          controller: _lyrics,
                          minLines: 5,
                          maxLines: 12,
                          style: const TextStyle(
                            color: CreationPalette.text,
                            height: 1.45,
                          ),
                          onChanged: notifier.setLyrics,
                          decoration: creationFieldDecoration(
                            hint: '留空则由 AI 自动填词',
                            alignLabelWithHint: true,
                          ),
                        ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 7,
                          runSpacing: 7,
                          children: kStructureTags
                              .map((t) => TagChip(
                                    label: Text('${t.$2} ${t.$1}'),
                                    selected: false,
                                    onTap: () => _insertTag(t.$1),
                                  ))
                              .toList(),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ProCard(
                    step: '03',
                    title: '曲风与质感',
                    child: Column(
                      children: [
                        // 「标签」原来是自由文本框 + 英文示例（city pop, retro, synth），
                        // 没人知道它是曲风还是情绪。拆成两组中文选择项，自由补充降为逃生口。
                        StylePicker(
                          selected: _catalogTags,
                          onChanged: (next) {
                            setState(() => _catalogTags = next);
                            _syncTags();
                          },
                        ),
                        const SizedBox(height: 12),
                        FreeTagField(
                          controller: _tags,
                          onChanged: (v) {
                            _freeTags = parseTagList(v);
                            _syncTags();
                          },
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ProCard(
                    step: '04',
                    title: '心情、人声与节奏',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const _H('心情（可多选）'),
                        MoodChips(
                            options: kMoodOptions,
                            selected: st.mood,
                            onChanged: (v) {
                              notifier.setMood(v);
                              // 第一次选心情时，按词典里的典型速度给 BPM 一个合理起点；
                              // 只在"从空开始选"时给，之后一律尊重用户手调的值，不偷偷改
                              if (st.mood.isEmpty && v.isNotEmpty) {
                                final bpm = cat.bpmFor(v.first);
                                if (bpm != null) notifier.setBpm(bpm);
                              }
                            }),
                        const SizedBox(height: 16),
                        const _H('人声'),
                        MoodChips(
                          options: const ['人声演唱', '纯音乐'],
                          selected: [st.instrumental ? '纯音乐' : '人声演唱'],
                          single: true,
                          onChanged: (v) => notifier.setInstrumental(
                              v.isNotEmpty && v.first == '纯音乐'),
                        ),
                        const SizedBox(height: 8),
                        _H('速度 BPM · ${st.bpm}'),
                        SliderTheme(
                          data: SliderTheme.of(context).copyWith(
                            activeTrackColor: CreationPalette.violet,
                            inactiveTrackColor:
                                Colors.white.withValues(alpha: .08),
                            thumbColor: CreationPalette.violetBright,
                            overlayColor:
                                CreationPalette.violet.withValues(alpha: .12),
                            trackHeight: 3,
                          ),
                          child: Slider(
                            value: st.bpm.toDouble().clamp(60, 180),
                            min: 60,
                            max: 180,
                            divisions: 120,
                            label: '${st.bpm}',
                            onChanged: (v) => notifier.setBpm(v.round()),
                          ),
                        ),
                        _H('时长 · ${st.sec} 秒'),
                        SliderTheme(
                          data: SliderTheme.of(context).copyWith(
                            activeTrackColor: CreationPalette.violet,
                            inactiveTrackColor:
                                Colors.white.withValues(alpha: .08),
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
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ProCard(
                    step: '05',
                    title: '输出控制',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const _H('候选数量'),
                        Wrap(
                          spacing: 7,
                          runSpacing: 7,
                          children: [1, 2, 3, 4]
                              .map((n) => TagChip(
                                    label: Text('$n 首'),
                                    selected: st.count == n,
                                    onTap: () => notifier.setCount(n),
                                  ))
                              .toList(),
                        ),
                        const SizedBox(height: 16),
                        const _H('声音人格（可选）'),
                        DropdownButtonFormField<String?>(
                          value: st.personaId,
                          items: [
                            const DropdownMenuItem(
                                value: null, child: Text('默认音色')),
                            ...personas.map((p) => DropdownMenuItem(
                                value: p.id,
                                child: Text(
                                    p.isPublic ? '${p.name} · 公开' : p.name)))
                          ],
                          onChanged: (v) => notifier.setPersona(v),
                          decoration: creationFieldDecoration(),
                        ),
                        const SizedBox(height: 14),
                        const _H('随机种子（可选）'),
                        TextField(
                          controller: _seed,
                          keyboardType: TextInputType.number,
                          onChanged: (v) =>
                              notifier.setSeed(int.tryParse(v.trim())),
                          decoration: creationFieldDecoration(
                            hint: '留空＝每次随机',
                            helper: '填同一个数字，可以复现同一首歌（收下作品后可固定它）',
                            dense: true,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: 36,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          CreationPalette.background.withValues(alpha: 0),
                          CreationPalette.background.withValues(alpha: .96),
                        ],
                      ),
                    ),
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
              PrimaryButton(
                text: '生成 ${st.count} 首',
                big: true,
                gradient: true,
                icon: Icons.auto_awesome_rounded,
                loading: _busy,
                onPressed: _busy ? null : _generate,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ProCard extends StatelessWidget {
  const _ProCard({
    required this.step,
    required this.title,
    required this.child,
  });

  final String step;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 16),
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
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: CreationPalette.violet.withValues(alpha: .1),
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(
                    color: CreationPalette.violet.withValues(alpha: .24),
                  ),
                ),
                child: Text(
                  step,
                  style: const TextStyle(
                    color: CreationPalette.violetBright,
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .5,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  color: CreationPalette.text,
                  fontWeight: FontWeight.w800,
                  fontSize: 15,
                  letterSpacing: -.1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

class _H extends StatelessWidget {
  const _H(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Text(
        text,
        style: const TextStyle(
          fontWeight: FontWeight.w700,
          fontSize: 12.5,
          color: CreationPalette.muted,
        ),
      ),
    );
  }
}
