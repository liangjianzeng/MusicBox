import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/share_channel.dart';
import '../../core/state.dart';
import '../../shared/widgets/ai_badge.dart';
import '../../shared/widgets/waveform_canvas.dart';
import '../assistant/assistant_models.dart';
import '../assistant/assistant_state.dart';
import '../assistant/assistant_surface.dart';
import '../create/credit_guard.dart';
import '../create/music_assistant_sheet.dart';
import '../create/progress_page.dart';
import '../create/shelf_store.dart';
import '../mv/mv_wizard_page.dart';
import '../player/player_provider.dart';
import 'dsp_page.dart';

/// 作品详情：播放+peaks 波形 / 星级 / 元数据编辑 / 谱系父链+children /
/// seed-pack 分享 / dsp 入口 / 导出下载 / 谱系动作
class WorkDetailPage extends ConsumerStatefulWidget {
  const WorkDetailPage({super.key, required this.workId});

  final String workId;

  @override
  ConsumerState<WorkDetailPage> createState() => _WorkDetailPageState();
}

class _WorkDetailPageState extends ConsumerState<WorkDetailPage> {
  WorkDetail? _detail;
  Work? _cached;
  String? _error;
  List<double>? _peaks;
  bool _loading = true;

  ApiClient get _api => ref.read(apiClientProvider);
  AssistantContext? _previousAssistantContext;

  @override
  void initState() {
    super.initState();
    _previousAssistantContext = ref.read(assistantContextProvider);
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _syncAssistantContext();
    });
  }

  bool get _ownsAssistantContext {
    final current = ref.read(assistantContextProvider);
    return current.surface == 'library' &&
        current.refs.length == 1 &&
        current.refs.single.type == 'work' &&
        current.refs.single.id == widget.workId;
  }

  void _syncAssistantContext() {
    if (!mounted) return;
    ref.read(assistantContextProvider.notifier).state = AssistantContext(
      surface: 'library',
      refs: [AssistantRef('work', widget.workId)],
      title: _work?.title ?? '',
    );
  }

  @override
  void dispose() {
    if (_ownsAssistantContext) {
      ref.read(assistantContextProvider.notifier).state =
          _previousAssistantContext ??
              const AssistantContext(surface: 'library');
    }
    super.dispose();
  }

  Future<void> _load() async {
    // 先读缓存，网络失败不白屏
    try {
      final c = await ref.read(localDbProvider).cachedWork(widget.workId);
      if (mounted && _detail == null) {
        setState(() => _cached = c);
        if (_ownsAssistantContext) _syncAssistantContext();
      }
    } catch (_) {}
    try {
      final d = await _api.work(widget.workId);
      if (!mounted) return;
      setState(() {
        _detail = d;
        _error = null;
      });
      if (_ownsAssistantContext) _syncAssistantContext();
      await ref.read(localDbProvider).cacheWork(d.work);
      if (d.work.waveformUrl != null) {
        final p = await _api.fetchPeaks(d.work.waveformUrl!);
        if (mounted && p != null && p.isNotEmpty) {
          setState(() => _peaks = p);
        }
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _error = e.zh);
        if (_cached == null && _detail == null) _loading = false;
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Work? get _work => _detail?.work ?? _cached;

  String _fmt(double sec) {
    final s = sec.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  // ---------- 星级 ----------

  Future<void> _rate(int stars) async {
    try {
      final w = await _api.patchWork(widget.workId, {'rating': stars});
      await ref.read(localDbProvider).cacheWork(w);
      if (!mounted) return;
      setState(() {
        _detail = WorkDetail(
            work: w,
            parents: _detail?.parents ?? const [],
            childrenCount: _detail?.childrenCount ?? 0);
      });
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  // ---------- 元数据编辑 ----------

  Future<void> _editMeta() async {
    final w = _work;
    if (w == null) return;
    final titleC = TextEditingController(text: w.title);
    final moodC = TextEditingController(text: w.mood ?? '');
    final genresC = TextEditingController(text: w.genres.join(','));
    String visibility = w.visibility;
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDlg) => AlertDialog(
          title: const Text('编辑信息'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                    controller: titleC,
                    decoration: const InputDecoration(labelText: '标题')),
                const SizedBox(height: 10),
                TextField(
                    controller: moodC,
                    decoration: const InputDecoration(labelText: '心情（逗号分隔）')),
                const SizedBox(height: 10),
                TextField(
                    controller: genresC,
                    decoration: const InputDecoration(labelText: '流派（逗号分隔）')),
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Text('公开广场：'),
                    Switch(
                      value: visibility == 'public',
                      onChanged: (v) =>
                          setDlg(() => visibility = v ? 'public' : 'private'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('取消')),
            FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('保存')),
          ],
        ),
      ),
    );
    if (saved != true) return;
    try {
      final nw = await _api.patchWork(widget.workId, {
        'title': titleC.text.trim(),
        'mood': moodC.text.trim(),
        'genres': genresC.text
            .split(RegExp('[,，]'))
            .where((e) => e.trim().isNotEmpty)
            .toList(),
        'visibility': visibility,
      });
      await ref.read(localDbProvider).cacheWork(nw);
      _load();
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  // ---------- seed-pack 分享 ----------

  Future<void> _shareSeedPack() async {
    try {
      final sp = await _api.seedPack(widget.workId);
      if (!mounted) return;
      final text = sp.toShareText(title: _work?.title);
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Seed Pack · 复刻配方'),
          content: SingleChildScrollView(
            child: SelectableText(text),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: text));
                if (ctx.mounted) Navigator.pop(ctx);
                _toast('已复制配方');
              },
              child: const Text('复制'),
            ),
            FilledButton.icon(
              onPressed: () async {
                final ok = await SystemShare.shareText(text);
                if (ctx.mounted) Navigator.pop(ctx);
                if (!ok) _toast('分享不可用，已可手动复制');
              },
              icon: const Icon(Icons.ios_share, size: 18),
              label: const Text('系统分享'),
            ),
          ],
        ),
      );
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  // ---------- 谱系动作 ----------

  Future<void> _moreActions() async {
    final w = _work;
    if (w == null) return;
    final picked = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
                leading: const Icon(Icons.expand_rounded),
                title: const Text('延长'),
                onTap: () => Navigator.pop(ctx, 'extend')),
            ListTile(
                leading: const Icon(Icons.graphic_eq_rounded),
                title: const Text('用人格翻唱'),
                onTap: () => Navigator.pop(ctx, 'cover')),
            ListTile(
                leading: const Icon(Icons.science_outlined),
                title: const Text('实验台 variation'),
                onTap: () => Navigator.pop(ctx, 'variation')),
            ListTile(
                leading: const Icon(Icons.cut_rounded),
                title: const Text('DSP：裁剪/淡化/变调/变速'),
                onTap: () => Navigator.pop(ctx, 'dsp')),
            ListTile(
                leading: const Icon(Icons.download_rounded),
                title: const Text('导出下载'),
                onTap: () => Navigator.pop(ctx, 'download')),
            ListTile(
                leading: const Icon(Icons.mic_external_on_outlined),
                title: const Text('从本作生成人格'),
                onTap: () => Navigator.pop(ctx, 'to-persona')),
            ListTile(
                leading: const Icon(Icons.flag_outlined),
                title: const Text('举报'),
                onTap: () => Navigator.pop(ctx, 'report')),
            ListTile(
                leading: const Icon(Icons.movie_creation_outlined),
                title: const Text('用这首拍 MV'),
                onTap: () => Navigator.pop(ctx, 'mv')),
          ],
        ),
      ),
    );
    if (!mounted) return;
    switch (picked) {
      case 'mv':
        if (!mounted) break;
        MvWizardPage.push(context, workId: widget.workId, initialStep: 1);
        break;
      case 'extend':
        _extend();
        break;
      case 'cover':
        _cover();
        break;
      case 'variation':
        _variation();
        break;
      case 'dsp':
        final route = ModalRoute.of(context);
        Navigator.of(context)
            .push(MaterialPageRoute(
                builder: (_) => DspPage(workId: widget.workId)))
            .then((_) {
          if (mounted && route?.isCurrent == true) _syncAssistantContext();
        });
        break;
      case 'download':
        _download();
        break;
      case 'to-persona':
        _toPersona();
        break;
      case 'report':
        _report();
        break;
    }
  }

  Future<void> _extend() async {
    if (!await ensureCredits(context, ref, kCreditExtendCover, action: '延长')) {
      return;
    }
    if (!mounted) return;
    final c = TextEditingController(text: '30');
    final sec = await showDialog<int>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('延长几秒？'),
        content: TextField(
            controller: c,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(suffixText: '秒')),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
              onPressed: () =>
                  Navigator.pop(ctx, int.tryParse(c.text.trim()) ?? 30),
              child: const Text('开始')),
        ],
      ),
    );
    if (sec == null) return;
    try {
      final jobId = await _api.extend(widget.workId, sec);
      if (!mounted) return;
      ProgressPage.push(
        context,
        jobId,
        title: '延长中',
        brief: TaskBrief(action: '延长', sourceLabel: '曲库作品', sec: sec, count: 1),
        plannedCount: 1,
        onRetry: () async {
          try {
            return await _api.extend(widget.workId, sec);
          } catch (_) {
            return null;
          }
        },
      );
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  Future<void> _cover() async {
    if (!await ensureCredits(context, ref, kCreditExtendCover, action: '翻唱')) {
      return;
    }
    await ref.read(personasProvider.notifier).load();
    if (!mounted) return;
    final personas = ref.read(personasProvider);
    if (personas.isEmpty) {
      _toast('还没有可用的人格，先去人格页登记一个');
      return;
    }
    final pid = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('选择人格'),
        children: personas
            .map((p) => SimpleDialogOption(
                  onPressed: () => Navigator.pop(ctx, p.id),
                  child: Text('${p.name}${p.isPublic ? ' · 公开' : ''}'),
                ))
            .toList(),
      ),
    );
    if (pid == null || !mounted) return;
    final persona = personas.firstWhere((p) => p.id == pid);
    final workTitle = _work?.title ?? '';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('确认翻唱'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('作品名：${workTitle.isEmpty ? '未命名作品' : workTitle}',
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              Text('人格名：${persona.name}',
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              const Text('生成数量：1 首'),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('确认翻唱')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      final jobId = await _api.cover(widget.workId, pid);
      if (!mounted) return;
      ProgressPage.push(
        context,
        jobId,
        title: '翻唱中',
        brief: TaskBrief(
            action: '翻唱',
            sourceLabel: '曲库作品',
            personaName: persona.name,
            count: 1),
        plannedCount: 1,
        onRetry: () async {
          try {
            return await _api.cover(widget.workId, pid);
          } catch (_) {
            return null;
          }
        },
      );
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  Future<void> _variation() async {
    if (!await ensureCredits(context, ref, kCreditAdjust, action: '实验台')) {
      return;
    }
    if (!mounted) return;
    final bpmC = TextEditingController();
    final tagsC = TextEditingController();
    final delta = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('控制变量实验台'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                  controller: bpmC,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'BPM（留空不改）')),
              const SizedBox(height: 10),
              TextField(
                  controller: tagsC,
                  decoration: const InputDecoration(labelText: '标签（留空不改）')),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final d = <String, dynamic>{};
              final b = int.tryParse(bpmC.text.trim());
              if (b != null) d['bpm'] = b;
              if (tagsC.text.trim().isNotEmpty) {
                d['tags'] = tagsC.text
                    .split(RegExp('[,，]'))
                    .where((e) => e.trim().isNotEmpty)
                    .toList();
              }
              Navigator.pop(ctx, d);
            },
            child: const Text('开跑'),
          ),
        ],
      ),
    );
    if (delta == null || delta.isEmpty) return;
    try {
      final jobId = await _api.variation(widget.workId, delta);
      if (!mounted) return;
      ProgressPage.push(
        context,
        jobId,
        title: '实验中',
        brief: TaskBrief(
            action: '实验',
            sourceLabel: '曲库作品',
            bpm: delta['bpm'] is int
                ? delta['bpm'] as int
                : int.tryParse('${delta['bpm']}'),
            tags: delta['tags'] is List
                ? (delta['tags'] as List).map((e) => '$e').toList()
                : const [],
            count: 1),
        plannedCount: 1,
        onRetry: () async {
          try {
            return await _api.variation(widget.workId, delta);
          } catch (_) {
            return null;
          }
        },
      );
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  Future<void> _download() async {
    final w = _work;
    if (w?.audioUrl == null) {
      _toast('没有可下载的音频');
      return;
    }
    try {
      final dir = await getApplicationDocumentsDirectory();
      final name =
          '${(w!.title.isEmpty ? 'work' : w.title).replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')}.${w.audioUrl!.endsWith('.wav') ? 'wav' : 'mp3'}';
      final path = await _api.download(w.audioUrl!, '${dir.path}/$name');
      _toast('已导出到 $path');
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  Future<void> _toPersona() async {
    final c = TextEditingController(text: '${_work?.title ?? '作品'}声线');
    final total = (_work?.durationSec ?? 0).round();
    // 服务端只接受 20-40 秒样本（契约 §8）。可选窗口：不超过总长，也不超过 40。
    final options = <int>[20, 28, 40].where((x) => total == 0 || x <= total).toList();
    var seconds = options.isEmpty ? 20 : (options.contains(28) ? 28 : options.first);
    var start = 0;
    final picked = await showDialog<({String name, int start, int seconds})>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          final maxStart = total > seconds ? total - seconds : 0;
          if (start > maxStart) start = 0;
          return AlertDialog(
            title: const Text('从本作生成人格'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                    controller: c,
                    decoration: const InputDecoration(labelText: '人格名称')),
                const SizedBox(height: 12),
                Text('取样时长 $seconds 秒',
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                Wrap(
                  spacing: 6,
                  children: [
                    for (final o in options)
                      ChoiceChip(
                        label: Text('$o 秒'),
                        selected: o == seconds,
                        onSelected: (_) => setDialogState(() => seconds = o),
                      ),
                  ],
                ),
                const SizedBox(height: 10),
                Text('起点 ${start}s${total > 0 ? '（可取 0–$maxStart s）' : ''}',
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                Slider(
                  value: start.toDouble().clamp(0, maxStart == 0 ? 1.0 : maxStart.toDouble()),
                  max: maxStart == 0 ? 1 : maxStart.toDouble(),
                  divisions: maxStart == 0 ? 1 : maxStart,
                  label: '$start s',
                  onChanged: (v) => setDialogState(() => start = v.round()),
                ),
                const SizedBox(height: 4),
                // 界面不许让用户拿一段没有人声的素材去当声纹：那样 cover 变声会"看起来成功"
                // 却锁不住音色，用户只会以为功能坏了（2026-11-27 真机的整条 240s 事故）。
                const Text('提示：前奏和尾奏多半只有乐器。先试听，把起点放在人声最实的段落（通常是副歌）。',
                    style: TextStyle(fontSize: 11)),
              ],
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
              FilledButton(
                  onPressed: () => Navigator.pop(
                      ctx, (name: c.text.trim(), start: start, seconds: seconds)),
                  child: const Text('生成')),
            ],
          );
        },
      ),
    );
    if (picked == null || picked.name.isEmpty) return;
    try {
      await _api.workToPersona(widget.workId, picked.name,
          startSec: picked.start, seconds: picked.seconds);
      await ref.read(personasProvider.notifier).load(force: true);
      _toast('人格已生成（取样 ${picked.start}s 起 ${picked.seconds}s），去人格页查看');
    } on ApiException catch (e) {
      // 服务端拒绝时必须把真实原因说出来（含"这台服务器没有裁剪工具，请改走录音登记"）
      _toast(e.zh);
    }
  }

  Future<void> _report() async {
    final c = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('举报'),
        content: TextField(
            controller: c,
            maxLines: 3,
            decoration: const InputDecoration(labelText: '原因')),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, c.text.trim()),
              child: const Text('提交')),
        ],
      ),
    );
    if (reason == null || reason.isEmpty) return;
    try {
      await _api.report(widget.workId, reason);
      _toast('已提交举报，感谢帮助维护社区');
    } on ApiException catch (e) {
      _toast(e.zh);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = _work;
    final rc = ref.watch(remoteConfigProvider);
    final assistantOn = (rc?.musicAssistant ?? false) || kMusicAssistantForce;
    return Scaffold(
      appBar: AppBar(
        title: const Text('作品详情'),
        actions: [
          IconButton(
              onPressed: _editMeta,
              icon: const Icon(Icons.edit_outlined),
              tooltip: '编辑'),
          IconButton(
              onPressed: _moreActions,
              icon: const Icon(Icons.more_horiz),
              tooltip: '更多'),
        ],
      ),
      floatingActionButton: assistantOn
          ? FloatingActionButton.small(
              heroTag: 'music_assistant_fab_work',
              tooltip: '音乐助手',
              onPressed: () => showMusicAssistant(context,
                  subjectType: 'work',
                  subjectId: widget.workId,
                  subjectLabel: w?.title ?? '',
                  chatEnabled: rc?.assistantChatMusic ?? false),
              child: const Icon(Icons.smart_toy_outlined, size: 20),
            )
          : null,
      body: _loading && w == null
          ? const Center(child: CircularProgressIndicator())
          : w == null
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error ?? '加载失败',
                          style: const TextStyle(color: Colors.white54)),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                          onPressed: _load,
                          icon: const Icon(Icons.refresh),
                          label: const Text('重试')),
                    ],
                  ),
                )
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // 标题 + AI 角标
                      Row(
                        children: [
                          Expanded(
                            child: Text(w.title.isEmpty ? '未命名作品' : w.title,
                                style: const TextStyle(
                                    fontSize: 22, fontWeight: FontWeight.w800)),
                          ),
                          if (w.aiLabel) const AiBadge(),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        [
                          ...w.genres,
                          if (w.mood != null) w.mood!,
                          if (w.bpm != null) 'BPM ${w.bpm}',
                          (_fmt(w.durationSec)),
                          if (w.seed != null) 'Seed ${w.seed}',
                          if (w.visibility == 'public') '公开' else '仅自己',
                        ].join(' · '),
                        style: const TextStyle(color: Colors.white54),
                      ),
                      const SizedBox(height: 18),
                      // 大波形 + 播放
                      WaveformCanvas(
                        peaks: _peaks ?? pseudoPeaks(w.id, n: 96),
                        height: 72,
                        barWidth: 3,
                        gap: 3,
                      ),
                      Wrap(
                        spacing: 10,
                        runSpacing: 10,
                        children: [
                          FilledButton.icon(
                            onPressed: () => ref
                                .read(playerProvider.notifier)
                                .playQueue([w], 0),
                            icon: const Icon(Icons.play_arrow_rounded),
                            label: const Text('播放'),
                          ),
                          OutlinedButton.icon(
                            onPressed: _shareSeedPack,
                            icon: const Icon(Icons.ios_share, size: 18),
                            label: const Text('Seed Pack 分享'),
                          ),
                          OutlinedButton.icon(
                            onPressed: () => MvWizardPage.push(context,
                                workId: widget.workId, initialStep: 1),
                            icon: const Icon(Icons.movie_creation_outlined,
                                size: 18),
                            label: const Text('用这首拍 MV'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      const AssistantSuggestionCard(
                        title: '解释这首作品',
                        prompt: '请基于当前作品上下文，解释这首作品的创作思路、情绪和音乐特点',
                        icon: Icons.lightbulb_outline,
                      ),
                      const AssistantSuggestionCard(
                        title: '帮我微调',
                        prompt: '请基于当前作品上下文，给我一些微调建议；涉及修改时先给我确认票',
                        icon: Icons.tune_outlined,
                      ),
                      // 星级
                      Wrap(
                        spacing: 4,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          const Text('我的评分：',
                              style: TextStyle(color: Colors.white70)),
                          ...List.generate(5, (i) {
                            final v = (w.rating ?? 0) > i;
                            return SizedBox(
                              width: 48,
                              height: 48,
                              child: InkWell(
                                onTap: () => _rate(i + 1),
                                customBorder: const CircleBorder(),
                                child: Center(
                                  child: Icon(
                                    v
                                        ? Icons.star_rounded
                                        : Icons.star_outline_rounded,
                                    color: Colors.amber,
                                    size: 26,
                                  ),
                                ),
                              ),
                            );
                          }),
                        ],
                      ),
                      const Divider(height: 32),
                      // 谱系
                      const Text('谱系',
                          style: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: Colors.white70)),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          ...(_detail?.parents ?? const <Work>[])
                              .map((p) => Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Chip(
                                        label: Text(
                                            '${p.title.isEmpty ? '源作品' : p.title} · ${p.lineageKind}',
                                            style:
                                                const TextStyle(fontSize: 12)),
                                        visualDensity: VisualDensity.compact,
                                      ),
                                      const Icon(Icons.chevron_right,
                                          size: 16, color: Colors.white30),
                                    ],
                                  )),
                          Chip(
                            label: Text('本作（深度 ${w.depth} · ${w.lineageKind}）',
                                style: const TextStyle(
                                    fontSize: 12, fontWeight: FontWeight.w600)),
                            visualDensity: VisualDensity.compact,
                          ),
                          if ((_detail?.childrenCount ?? 0) > 0)
                            Text('衍生 ${_detail!.childrenCount} 首',
                                style: const TextStyle(
                                    fontSize: 12, color: Colors.white38)),
                        ],
                      ),
                      const Divider(height: 32),
                      if (w.lyrics != null && w.lyrics!.isNotEmpty) ...[
                        const Text('歌词',
                            style: TextStyle(
                                fontWeight: FontWeight.w700,
                                color: Colors.white70)),
                        const SizedBox(height: 8),
                        SelectableText(w.lyrics!,
                            style: const TextStyle(height: 1.5)),
                      ],
                    ],
                  ),
                ),
    );
  }
}
