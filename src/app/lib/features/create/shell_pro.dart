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
        // 强度只有选了人格才有意义；不给则服务端按 config.persona 的默认值兜。
        if (st.personaId != null && st.coverStrength != null)
          'cover_strength': st.coverStrength,
        // 契约 generate 未定义 seed，透传由服务端兼容（可忽略）
        if (seedNum != null) 'seed': seedNum,
      };
      final model = ref.read(musicModelProvider);
      final r = await ref.read(apiClientProvider).generate(body, model: model);
      if (!mounted) return;
      // 揭晓页的「没有套上」横幅要报得出**是哪条声线**没套上；写死"已选人格"等于把最关键的
      // 那条信息又糊掉了（真机 2026-11-27：用户看到的是「已选人格」，不知道失败的是自己挑的哪条）。
      String? pickedPersonaName;
      if (st.personaId != null) {
        for (final p in ref.read(personasProvider)) {
          if (p.id == st.personaId) {
            pickedPersonaName = p.name;
            break;
          }
        }
      }
      ProgressPage.push(
        context,
        '${r['job_id']}',
        brief: TaskBrief.fromCreation(
          st,
          prompt: prompt,
          lyrics: lyrics,
          tags: st.instrumental ? [...tagList, '纯音乐'] : tagList,
          seed: seedNum,
          personaName: st.personaId == null ? null : (pickedPersonaName ?? '已选人格'),
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
                          // 以前这里写「留空则由 AI 自动填词」—— **那是谎话**：全仓没有任何写词实现，
                          // 留空 + 「人声演唱」实际出的是纯音乐（真机 2026-11-28，用户原话
                          // 「这不是纯音乐么？」）。界面只准说做得到的事（契约 v5.6.14）。
                          decoration: creationFieldDecoration(
                            hint: st.instrumental
                                ? '纯音乐可以留空'
                                : '要人声必须给歌词（留空只能出纯音乐）',
                            alignLabelWithHint: true,
                          ),
                        ),
                        const SizedBox(height: 10),
                        // 说了规则就要在违反时提醒：选了人声却没歌词 = 必然纯音乐，
                        // 当场讲清，比让用户生成完才发现强（这不是"解释控件不是什么"，是讲后果）。
                        if (!st.instrumental && st.lyrics.trim().isEmpty)
                          const Padding(
                            padding: EdgeInsets.only(bottom: 8),
                            child: Text(
                              '现在是「人声演唱」但歌词为空 → 出来的会是纯音乐（AI 写词还没实现）',
                              style: TextStyle(
                                fontSize: 11.5,
                                color: CreationPalette.amber,
                              ),
                            ),
                          ),
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
                          // 卡片叫「曲风与质感」，就只放编曲与制作质感的词。
                          // 「谁在唱/怎么唱」原来也在这里（我上一版塞进来的），把人声劈成
                          // 两半放在两个卡片里 —— 用户一眼就看出来了：歌声不是曲声。
                          groups: const ['genre', 'style'],
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
                    title: '谁在唱（人声）',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // 原来"要不要人声"在这一卡、"男声女声/微醺气声"在「曲风与质感」卡里，
                        // 同一个问题被拆到两个地方答。现在"谁在唱"一处说清：
                        // 有没有人 → 什么性别 → 用什么状态唱。
                        const _H('人声'),
                        MoodChips(
                          options: const ['人声演唱', '纯音乐'],
                          selected: [st.instrumental ? '纯音乐' : '人声演唱'],
                          single: true,
                          onChanged: (v) => notifier.setInstrumental(
                              v.isNotEmpty && v.first == '纯音乐'),
                        ),
                        const SizedBox(height: 10),
                        StylePicker(
                          groups: const ['gender', 'delivery'],
                          selected: _catalogTags,
                          onChanged: (next) {
                            setState(() => _catalogTags = next);
                            _syncTags();
                          },
                        ),
                        const SizedBox(height: 6),
                        // 界面不许撒谎：引擎（src/executor/lanes/music.js）唯一能锁音色的是
                        // 人格参考音频走 cover 变声；没选人格时，「女声」只是 prompt 里的一个词，
                        // 出男声是完全可能的（2026-11-27 真机就是这么翻车的）。
                        Text(
                          st.instrumental
                              ? '纯音乐：没有人声，上面的选择不会生效'
                              : '没选人格时，「女声」只是写给模型的描述词，锁不住音色（可能仍出男声）。'
                                  '要固定音色：去「人格」录一段 20-40 秒，'
                                  '或在曲库打开某首歌 → ⋮ →「从本作生成人格」；'
                                  '选上后把下面的「音色贴近程度」调高。',
                          style: const TextStyle(
                              fontSize: 11, color: CreationPalette.faint),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ProCard(
                    step: '05',
                    title: '心情与节奏',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const _H('心情（可多选）'),
                        MoodChips(
                            // 吃服务端下发的目录（style_options），别用编译期 kMoodOptions：
                            // 否则服务端加一档心情（如「微醺」）永远到不了这一档界面。
                            options: cat.moods.map((e) => e.zh).toList(growable: false),
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
                    step: '06',
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
                        // 选了人格就必须能调强度：它是**唯一**能锁住音色/性别的旋钮
                        // （引擎只吃 tags/lyrics/prompt/bpm，纯文本的「女声」锁不住）。
                        // 以前它被写死成 0.2 共三处，用户想锁也锁不住。
                        if (st.personaId != null)
                          Builder(builder: (context) {
                            // 默认强度只认**服务端下发的那一个数**（config.persona 是唯一真源）。
                            // 没取到就如实说"没取到"，绝不在端侧编个 0.6 冒充默认 ——
                            // 那是第二个真源：服务端一改，界面显示的档位和实际跑出来的就不是一回事。
                            final srvDefault = ref
                                .read(remoteConfigProvider)
                                ?.personaDefaultCoverStrength;
                            final shown = st.coverStrength ?? srvDefault;
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const SizedBox(height: 10),
                                const _H('音色贴近程度（选了人格才生效）'),
                                if (shown == null)
                                  const Text(
                                    '还没取到服务端默认强度（配置未就绪）。拖一格即可自己指定；不拖则由服务端按其默认执行。',
                                    style: TextStyle(
                                        fontSize: 11.5,
                                        color: Colors.white60),
                                  )
                                else ...[
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Slider(
                                          min: 0,
                                          max: 1,
                                          divisions: 5,
                                          value: shown.clamp(0.0, 1.0),
                                          label: '${(shown * 100).round()}%',
                                          onChanged: (v) =>
                                              notifier.setCoverStrength(v),
                                        ),
                                      ),
                                      SizedBox(
                                        width: 96,
                                        child: Text(
                                          st.coverStrength == null
                                              ? '${(shown * 100).round()}% · 服务端默认'
                                              : '${(shown * 100).round()}% · 你选的',
                                          style: const TextStyle(fontSize: 12),
                                        ),
                                      ),
                                    ],
                                  ),
                                  if (st.coverStrength != null)
                                    TextButton.icon(
                                      onPressed: () =>
                                          notifier.resetCoverStrength(),
                                      icon: const Icon(Icons.undo, size: 15),
                                      label: const Text('交回服务端默认'),
                                    ),
                                ],
                                const Text(
                                  '0＝只借编排，100%＝完全照这条声线唱。要固定性别/音色就调高；'
                                  '引擎变声失败时，揭晓页会直说「没有套上」。',
                                  style: TextStyle(
                                      fontSize: 11.5, color: Colors.white60),
                                ),
                              ],
                            );
                          }),
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
