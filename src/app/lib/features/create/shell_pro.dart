import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/primary_button.dart';
import 'credit_guard.dart';
import 'creation_state.dart';
import 'progress_page.dart';

const kStructureTags = ['[Verse]', '[Chorus]', '[Bridge]', '[Intro]', '[Outro]'];

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

  @override
  void initState() {
    super.initState();
    final st = ref.read(creationProvider);
    _prompt.text = st.prompt;
    _lyrics.text = st.lyrics;
    _tags.text = st.tags;
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
      final tagList = _tags.text
          .split(RegExp('[,，\\s]+'))
          .where((e) => e.trim().isNotEmpty)
          .map((e) => e.trim())
          .toList();
      final r = await ref.read(apiClientProvider).generate({
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
        if (_seed.text.trim().isNotEmpty) 'seed': int.tryParse(_seed.text.trim()),
      });
      if (!mounted) return;
      ProgressPage.push(context, '${r['job_id']}');
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
                    label: Text(t, style: const TextStyle(fontSize: 12)),
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _insertTag(t),
                  ))
              .toList(),
        ),
        const SizedBox(height: 16),
        const _H('标签（逗号分隔）'),
        TextField(
          controller: _tags,
          onChanged: notifier.setTags,
          decoration: const InputDecoration(
            hintText: '如：city pop, retro, synth',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        const _H('Mood'),
        MoodChips(
            options: kMoodOptions,
            selected: st.mood,
            onChanged: notifier.setMood),
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
        _H('BPM · ${st.bpm}'),
        Slider(
          value: st.bpm.toDouble().clamp(60, 180),
          min: 60,
          max: 180,
          divisions: 120,
          label: '${st.bpm}',
          onChanged: (v) => notifier.setBpm(v.round()),
        ),
        _H('时长 · ${st.sec}s'),
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
            ButtonSegment(value: 1, label: Text('1')),
            ButtonSegment(value: 2, label: Text('2')),
            ButtonSegment(value: 3, label: Text('3')),
            ButtonSegment(value: 4, label: Text('4')),
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
        const _H('Seed（可选，复现同一首）'),
        TextField(
          controller: _seed,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            hintText: '留空随机',
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
