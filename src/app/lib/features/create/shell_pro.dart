import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/primary_button.dart';
import 'credit_guard.dart';
import 'creation_state.dart';
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

  /// 选择项目录（远程优先，兜底本地）——initState 里先定一次，build 里再随远程刷新取
  StyleCatalog _cat = StyleCatalog.fallback;

  /// 目录内的规范词由选择器管，目录外的词由自由框管，两者合并存进 st.tags
  List<String> _freeOf(String raw) =>
      parseTagList(raw).where((t) => !_cat.isKnown(t)).toList();

  @override
  void initState() {
    super.initState();
    _cat = styleCatalogOfConfig(ref.read(remoteConfigProvider));
    final st = ref.read(creationProvider);
    _prompt.text = st.prompt;
    _lyrics.text = st.lyrics;
    // 自由框只回填"目录外的词"，目录内的由 chips 呈现，避免同一词两处显示
    _tags.text = joinTagList(_freeOf(st.tags));
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
    final st = ref.read(creationProvider);
    final prompt = _prompt.text.trim();
    final lyrics = _lyrics.text.trim();
    if (prompt.isEmpty && lyrics.isEmpty) {
      _toast('至少给个灵感描述或歌词');
      return;
    }
    if (!await ensureCredits(context, ref, kCreditGenerateEach * st.count,
        action: '深度生成 ${st.count} 首')) {
      return;
    }
    setState(() => _busy = true);
    try {
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
    final st = ref.watch(creationProvider);
    final notifier = ref.read(creationProvider.notifier);
    final personas = ref.watch(personasProvider);
    final cat = styleCatalogOf(ref);
    _cat = cat; // 与 initState 的回填口径保持一致（远程目录晚到时也对得上）
    final pickedTags = parseTagList(st.tags).where((t) => cat.isKnown(t)).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        const _H('灵感描述'),
        TextField(
          controller: _prompt,
          maxLines: 3,
          minLines: 2,
          onChanged: notifier.setPrompt,
          decoration: const InputDecoration(
            hintText: '想要的画面/情绪/乐器，如：雨夜公路、合成器贝斯、微微加速',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        const _H('歌词（可插入结构标记）'),
        TextField(
          controller: _lyrics,
          minLines: 5,
          maxLines: 12,
          onChanged: notifier.setLyrics,
          decoration: const InputDecoration(
            hintText: '留空则由 AI 自动填词',
            alignLabelWithHint: true,
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          children: kStructureTags
              .map((t) => ActionChip(
                    label: Text('${t.$2} ${t.$1}',
                        style: const TextStyle(fontSize: 12)),
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _insertTag(t.$1),
                  ))
              .toList(),
        ),
        const SizedBox(height: 16),
        // 「标签」原来是自由文本框 + 英文示例（city pop, retro, synth），
        // 没人知道它是曲风还是情绪。拆成两组中文选择项，自由补充降为逃生口。
        StylePicker(
          selected: parseTagList(st.tags),
          onChanged: (next) => notifier.setTags(joinTagList(next)),
        ),
        const SizedBox(height: 12),
        FreeTagField(
          controller: _tags,
          onChanged: (v) => notifier
              .setTags(joinTagList([...pickedTags, ...parseTagList(v)])),
        ),
        const SizedBox(height: 16),
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
          onChanged: (v) =>
              notifier.setInstrumental(v.isNotEmpty && v.first == '纯音乐'),
        ),
        const SizedBox(height: 16),
        _H('速度 BPM · ${st.bpm}'),
        Slider(
          value: st.bpm.toDouble().clamp(60, 180),
          min: 60,
          max: 180,
          divisions: 120,
          label: '${st.bpm}',
          onChanged: (v) => notifier.setBpm(v.round()),
        ),
        _H('时长 · ${st.sec} 秒'),
        Slider(
          value: st.sec.toDouble().clamp(15, 240),
          min: 15,
          max: 240,
          divisions: 45,
          label: '${st.sec}s',
          onChanged: (v) => notifier.setSec(v.round()),
        ),
        const SizedBox(height: 4),
        const _H('候选数量'),
        SegmentedButton<int>(
          segments: const [
            ButtonSegment(value: 1, label: Text('1 首')),
            ButtonSegment(value: 2, label: Text('2 首')),
            ButtonSegment(value: 3, label: Text('3 首')),
            ButtonSegment(value: 4, label: Text('4 首')),
          ],
          selected: {st.count},
          onSelectionChanged: (s) => notifier.setCount(s.first),
        ),
        const SizedBox(height: 16),
        const _H('声音人格（可选）'),
        DropdownButtonFormField<String?>(
          value: st.personaId,
          items: [
            const DropdownMenuItem(value: null, child: Text('默认音色')),
            ...personas
                .map((p) => DropdownMenuItem(
                    value: p.id,
                    child: Text(p.isPublic ? '${p.name} · 公开' : p.name)))
          ],
          onChanged: (v) => notifier.setPersona(v),
          decoration: const InputDecoration(border: OutlineInputBorder()),
        ),
        const SizedBox(height: 16),
        const _H('随机种子（可选）'),
        TextField(
          controller: _seed,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            isDense: true,
            hintText: '留空＝每次随机',
            helperText: '填同一个数字，可以复现同一首歌（比心后固定它）',
            helperMaxLines: 2,
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 8),
        Text('共约 ${kCreditGenerateEach * st.count} 积分 · 失败自动返还',
            style: const TextStyle(color: Colors.white38, fontSize: 12)),
        const SizedBox(height: 14),
        PrimaryButton(
          text: '生成 ${st.count} 首',
          big: true,
          icon: Icons.auto_awesome,
          loading: _busy,
          onPressed: _busy ? null : _generate,
        ),
      ],
    );
  }
}

class _H extends StatelessWidget {
  const _H(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text,
          style: const TextStyle(
              fontWeight: FontWeight.w700, fontSize: 13, color: Colors.white70)),
    );
  }
}
