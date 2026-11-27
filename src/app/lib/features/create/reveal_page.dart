import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../shared/widgets/ai_badge.dart';
import '../../shared/widgets/primary_button.dart';
import '../../shared/widgets/waveform_canvas.dart';
import '../library/library_page.dart';
import '../player/player_provider.dart';
import 'credit_guard.dart';
import 'progress_page.dart';
import 'shelf_page.dart';
import 'shelf_store.dart';
import 'task_brief_card.dart';

/// 「说一句改一点」的快捷改法（点一下填进输入框，不用打字）
const kAdjustHints = [
  '副歌更燃一点',
  '整体慢一点',
  '前奏短一些',
  '人声再靠前',
  '鼓点再重一点',
  '留白多一点',
];

/// 收下按钮的判定（纯函数，被 test/reveal_degraded_test.dart 钉住）。
/// 存在的理由是一条真机教训：降级态里按钮曾拿着本地快照的「已收下 ✓」把 onPressed 置 null ——
/// 用户看到一颗像正常按钮的东西，点了什么也不发生，也没地方删这条失效暂存
/// （2026-11-27 反馈「暂存的歌曲没法收下」）。规矩：**能点必须有反应，不能点必须说清为什么**。
AdoptButton adoptButton({
  required bool degraded,
  required bool adopted,
  required bool busy,
}) {
  if (degraded) {
    return const AdoptButton(
      text: '收不下 · 任务已失效',
      icon: Icons.error_outline,
      enabled: true, // 必须可点：点开是给原因和「删除这条暂存」的出路，不是静默吞掉
      loading: false,
      reason: '这条任务的产物在服务端已经取不到（可能已清理），收不进曲库。',
    );
  }
  return AdoptButton(
    text: adopted ? '已收下 ✓' : '收下这首',
    icon: adopted ? Icons.check_circle : Icons.favorite,
    enabled: !adopted && !busy,
    loading: busy && !adopted,
    reason: adopted
        ? '这首已经收进曲库了，去「曲库 · 我的」听它。'
        : (busy ? '正在等上一个请求完成，稍一下就好。' : null),
  );
}

/// [adoptButton] 的返回值
class AdoptButton {
  const AdoptButton(
      {required this.text,
      required this.icon,
      required this.enabled,
      required this.loading,
      this.reason});
  final String text;
  final IconData icon;
  final bool enabled;
  final bool loading;
  final String? reason;
}

/// 揭晓页：候选卡带翻转、A/B/C/D 快切（整队连续试听）、真波形+真播放进度+点按 seek、
/// 收下、说一句改一点（隐式收下母本会明说）、追问快捷
class RevealPage extends ConsumerStatefulWidget {
  const RevealPage({
    this.lyrics,
    super.key,
    required this.jobId,
    required this.candidates,
    this.resultWorkId,
    this.adjusted = false,
    this.onRegenerate,
    this.brief,
    this.adopted = const {},
    this.degraded = false,
  });

  final String jobId;
  final List<Candidate> candidates;

  /// 当初提交的歌词（来自 GET /v1/jobs/:id 的 gen，契约 v3.3）。
  /// 「歌词不能用完就丢」：以前候选造出来的 Work 没有 lyrics，播放器歌词区只能说
  /// "歌词没取到 · 离线或这首已不在"，用户刚填完 38 行词却在下一次试听时看不到自己写的东西。
  final String? lyrics;

  /// generate 任务关联的 draft work id（adopt 用）
  final String? resultWorkId;

  /// 是否由 adjust 产生（微调谱系）
  final bool adjusted;

  /// 「再来一批」重交通道（返回新 job_id）。
  /// 由提交侧持有原始参数才能真重交；拿不到时按钮不显示——不假装能再来。
  final Future<String?> Function()? onRegenerate;

  /// 本次任务要素（进度页/暂存架带过来）：显示「按什么生成」+ 暂存架摘要
  final TaskBrief? brief;

  /// 已收下状态（从「曲库 · 暂存」回来时恢复角标，不用重新收下）
  final Map<String, String> adopted;

  /// 离线快照态：服务端这条任务已经取不到（被清理/换库/离线），页面吃的是本地留存的候选。
  /// 必须让页面自己知道 —— 否则收下按钮会拿着本地记的「已收下 ✓」变成一颗没解释的死按钮
  /// （2026-11-27 真机反馈：「暂存的歌曲没法收下」，点了没反应、也没地方删这条暂存）。
  final bool degraded;

  @override
  ConsumerState<RevealPage> createState() => _RevealPageState();
}

class _RevealPageState extends ConsumerState<RevealPage> {
  int _idx = 0;
  late final Map<String, String> _adopted = Map.of(widget.adopted);
  late final ShelfNotifier _shelf = ref.read(shelfProvider.notifier);
  /// 必须在 initState 里抓，不能 `late` 惰性求值：`ScaffoldMessenger.of(context)` 会被拖到
  /// 第一次用到的时候才执行，而第一次用到恰好是 dispose() 里弹「已存暂存架」—— 那时 context 已卸载，
  /// 内部空断言直接抛异常；崩在卸载中途会把之后打开的页面污染成 ErrorWidget
  /// （2026-11-27 真机：曲库卡片标题变红字+黄下划线、底部导航整条消失，logcat 见 ScaffoldMessenger.of 栈）。
  ScaffoldMessengerState? _messenger;
  bool _quietExit = false; // 内部跳转（再来一批/去曲库）不弹「已存暂存架」
  final Map<String, List<double>> _peaks = {}; // candidateId -> 真 peaks
  bool _busy = false;
  bool _adjustSending = false;
  bool _adjustHintShown = false; // 首次微调前明说"会先收下这一版"
  String? _clarify; // understood:false 的追问
  final TextEditingController _adjustCtrl = TextEditingController();
  StreamSubscription<Duration>? _posSub;
  StreamSubscription<Duration?>? _durSub;
  Duration _pos = Duration.zero;
  Duration _dur = Duration.zero;

  Candidate get _cur => widget.candidates[_idx];

  ApiClient get _api => ref.read(apiClientProvider);
  AudioPlayer get _player => ref.read(playerProvider.notifier).audio;

  @override
  void initState() {
    super.initState();
    _messenger = ScaffoldMessenger.of(context); // 趁 context 还活着抓走；dispose 里只用这个缓存
    _loadPeaks(_cur);
    // 真·播放进度：订阅全局播放器位置/时长，绝不用写死的 0.5 假装在播
    _posSub = _player.positionStream.listen((v) {
      if (mounted) setState(() => _pos = v);
    });
    _durSub = _player.durationStream.listen((v) {
      if (mounted) setState(() => _dur = v ?? Duration.zero);
    });
    // 一进来就挂上暂存架：哪怕立刻被电话打断/杀进程，这几首也找得回来
    scheduleMicrotask(_saveShelf);
  }

  @override
  void dispose() {
    _posSub?.cancel();
    _durSub?.cancel();
    _adjustCtrl.dispose();
    // 任何退出路径（✕ / 返回手势 / popUntil）都先把现场落到「曲库 · 暂存」——
    // 这是「很容易点出去就不见了」的根治点
    _saveShelf();
    if (!_quietExit) {
      _messenger?.showSnackBar(
          const SnackBar(content: Text('这几首已存进「曲库 · 暂存」，回来点它就能接着听')));
    }
    super.dispose();
  }

  /// 写暂存架（fire-and-forget；provider 是 app 级，dispose 后仍可安全调用）
  void _saveShelf() {
    final brief = widget.brief ??
        TaskBrief(
            action: widget.adjusted ? '微调' : '生成',
            prompt: _cur.title.isEmpty ? null : _cur.title,
            count: widget.candidates.length);
    final title = (brief.prompt ?? '').trim();
    unawaited(() async {
      try {
        await _shelf.save(
          jobId: widget.jobId,
          title: title.isEmpty
              ? (_cur.title.isEmpty ? '灵感候选' : _cur.title)
              : (title.length > 14 ? '${title.substring(0, 14)}…' : title),
          brief: brief,
          candidates: widget.candidates,
          adopted: _adopted,
        );
      } catch (_) {}
    }());
  }

  Work _candidateToWork(Candidate c) => Work(
        id: c.id,
        title: c.title.isEmpty ? '候选 ${c.seq}' : c.title,
        status: 'draft',
        durationSec: c.durationSec,
        createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
        audioUrl: c.audioUrl,
        waveformUrl: c.waveformUrl,
        // 候选行本身不带歌词（服务端 candidates 表只有 meta），所以由任务详情的 gen 传进来
        lyrics: (widget.lyrics ?? '').trim().isEmpty ? null : widget.lyrics,
      );

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  void _go(int i) {
    if (i < 0 || i >= widget.candidates.length) return;
    setState(() {
      _idx = i;
      _clarify = null;
    });
    _loadPeaks(widget.candidates[i]);
  }

  double _swipeDx = 0.0;

  /// 左右滑动切换候选：左滑 → 下一首，右滑 → 上一首。
  /// 波形 seek（内层手势）会先赢得手势仲裁，不受影响。
  void _onSwipeStart(DragStartDetails _) {
    _swipeDx = 0.0;
  }

  void _onSwipeUpdate(DragUpdateDetails d) {
    _swipeDx += d.delta.dx;
  }

  void _onSwipeEnd(DragEndDetails d) {
    final v = d.primaryVelocity ?? 0.0;
    final dx = _swipeDx;
    _swipeDx = 0.0;
    if (v < -300 || dx < -90) {
      _go(_idx + 1);
    } else if (v > 300 || dx > 90) {
      _go(_idx - 1);
    }
  }

  void _onSwipeCancel() {
    _swipeDx = 0.0;
  }

  /// 拉真 peaks（/f/* 公共读）；拉不到留 pseudoPeaks 占位并由 UI 标注预览
  Future<void> _loadPeaks(Candidate c) async {
    if (_peaks.containsKey(c.id)) return;
    final url = c.waveformUrl;
    if (url == null || url.isEmpty) return;
    final p = await _api.fetchPeaks(url);
    if (p != null && p.isNotEmpty && mounted) {
      setState(() => _peaks[c.id] = p);
    }
  }

  /// A/B/C/D 快切：切过去并整队播放，可连续试听而不用来回点
  void _ab(int which) {
    final i = math.min(which, widget.candidates.length - 1);
    _go(i);
    ref
        .read(playerProvider.notifier)
        .playQueue(widget.candidates.map(_candidateToWork).toList(), i);
  }

  bool _isCurrent(Candidate c) => ref.read(playerProvider).current?.id == c.id;

  Duration _totalOf(Candidate c) => _isCurrent(c) && _dur.inMilliseconds > 0
      ? _dur
      : Duration(milliseconds: (c.durationSec * 1000).round());

  Future<String?> _ensureAdopted(Candidate c) async {
    final existing = _adopted[c.id];
    if (existing != null) return existing;
    // adopt 需要 work id：优先 job 的 result_work_id，退回 job id
    final workId = widget.resultWorkId ?? widget.jobId;
    final work = await _api.adopt(workId, c.id);
    _adopted[c.id] = work.id;
    await ref.read(localDbProvider).cacheWork(work);
    try {
      await _shelf.markAdopted(widget.jobId, c.id, work.id);
    } catch (_) {}
    return work.id;
  }

  /// 降级态里点收不下：不能只把按钮置灰了事 —— 必须说清为什么，并给一条出路
  /// （删掉这条已失效的暂存），否则用户只能对着死按钮反复点。
  void _adoptBlocked() {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: const Text('这条任务的产物在服务端已经取不到（可能已清理），收不进曲库。'),
      action: SnackBarAction(
        label: '删除这条暂存',
        onPressed: () async {
          await _shelf.remove(widget.jobId);
          if (!mounted) return;
          _quietExit = true;
          Navigator.of(context).pop();
        },
      ),
    ));
  }

    Future<void> _adopt() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await _ensureAdopted(_cur);
      if (!mounted) return;
      setState(() {}); // 刷新"已收下"角标
      final allKept =
          widget.candidates.every((c) => _adopted.containsKey(c.id));
      if (allKept) {
        try {
          await _shelf.pruneFullyAdopted();
        } catch (_) {}
        if (!mounted) return;
        _toast('全部收下了，已进曲库（草稿），暂存架里这条已清掉');
      } else {
        _toast('已收下《${_cur.title.isEmpty ? '未命名作品' : _cur.title}》，'
            '可在曲库查看；其余仍在「曲库 · 暂存」等你');
      }
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('收下失败，请重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// "说一句改一点"→ adjust；understood:false 显示追问气泡 + 快捷改法
  Future<void> _adjust() async {
    final text = _adjustCtrl.text.trim();
    if (text.isEmpty || _busy || _adjustSending) return;
    setState(() {
      _busy = true;
      _adjustSending = true;
      _clarify = null;
    });
    try {
      if (!await ensureCredits(context, ref, kCreditAdjust, action: '微调')) {
        return;
      }
      // 微调必须有母本 → 隐式 adopt。这是"替你收下一首"的副作用，必须说清楚，
      // 不能让用户事后在曲库里发现凭空多出一首。
      final firstAdopt = _adopted[_cur.id] == null;
      final workId = await _ensureAdopted(_cur);
      if (firstAdopt && mounted) {
        setState(() => _adjustHintShown = true);
        _toast('先收下这一版作母本（已进曲库），再基于它微调');
      }
      final res = await _api.adjust(workId ?? _cur.id, text);
      if (!mounted) return;
      if (res['understood'] == true) {
        final jobId = '${res['job_id']}';
        ProgressPage.push(
          context,
          jobId,
          title: '微调中',
          brief: (widget.brief ?? const TaskBrief(action: '微调'))
              .copyLike(action: '微调', prompt: text, count: 1),
          plannedCount: 1,
          onRetry: () async {
            try {
              final r = await _api.adjust(workId ?? _cur.id, text);
              return r['understood'] == true ? '${r['job_id']}' : null;
            } catch (_) {
              return null;
            }
          },
        );
        _adjustCtrl.clear();
      } else {
        setState(() => _clarify = '${res['clarify'] ?? '能再说具体一点吗？'}');
      }
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('微调失败，请重试');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _adjustSending = false;
        });
      }
    }
  }

  Future<void> _regenerate() async {
    final f = widget.onRegenerate;
    if (f == null || _busy) return;
    setState(() => _busy = true);
    try {
      final id = await f();
      if (!mounted) return;
      if (id == null || id.isEmpty) {
        _toast('没能在服务端重交，稍后再试');
        return;
      }
      if (id == widget.jobId) {
        _toast('服务端仍在原任务幂等窗口内，请稍后再试');
        return;
      }
      _quietExit = true; // 内部跳转，不弹「已存暂存架」
      ProgressPage.pushReplacement(
        context,
        id,
        brief: widget.brief,
        plannedCount: widget.brief?.count,
        onRetry: widget.onRegenerate,
      );
    } catch (_) {
      _toast('重交失败，请重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 「这次是按什么生成的」：把提交时的要素摊开（灵感/歌词/情绪/参数/Seed…）
  void _openFacts() {
    final brief = widget.brief;
    if (brief == null || brief.isEmpty) return;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('这次是按这些要素生成的',
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                const SizedBox(height: 10),
                TaskBriefCard(brief: brief, initiallyExpanded: true),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final playerState = ref.watch(playerProvider);
    final adopted = _adopted[_cur.id] != null;
    final adoptedCount = _adopted.length;
    final isCurrent = playerState.current?.id == _cur.id;
    final total = _totalOf(_cur);
    final progress = isCurrent && total.inMilliseconds > 0
        ? (_pos.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0)
        : 0.0;
    return Scaffold(
      appBar: AppBar(
        title:
            Text(widget.adjusted ? '微调揭晓' : '你的${widget.candidates.length}首候选'),
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          tooltip: '收起（自动存进暂存架）',
          onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
        ),
        actions: [
          if (widget.brief != null && !widget.brief!.isEmpty)
            IconButton(
              icon: const Icon(Icons.assignment_outlined, size: 20),
              tooltip: '本次是按什么生成的',
              onPressed: _openFacts,
            ),
          IconButton(
            icon: const Icon(Icons.bookmark_border, size: 20),
            tooltip: '灵感暂存架',
            onPressed: () => Navigator.of(context)
                .push(MaterialPageRoute(builder: (_) => const ShelfPage())),
          ),
          if (widget.onRegenerate != null)
            TextButton.icon(
              onPressed: _busy ? null : _regenerate,
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('再来一批'),
            ),
          if (adoptedCount > 0)
            TextButton.icon(
              onPressed: () => Navigator.of(context)
                  .push(MaterialPageRoute(builder: (_) => const LibraryPage())),
              icon: const Icon(Icons.library_music, size: 16),
              label: Text('曲库($adoptedCount)'),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            // 人格没套上必须**当场**说：stage②（cover 变声）是唯一能锁音色/性别的阶段，
            // 它失败时用户拿到的是默认音色 —— 不说就等于让用户把别人的声音当成自己的声线。
            if (_cur.personaFailed)
              Container(
                width: double.infinity,
                color: Theme.of(context).colorScheme.errorContainer,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Text(
                  '「${widget.brief?.personaName ?? '所选人格'}」没有套上：'
                  '${_cur.personaFailReason}。这首是默认音色，不是你选的声线。',
                  style: TextStyle(
                      fontSize: 12.5,
                      color: Theme.of(context).colorScheme.onErrorContainer),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  Text('候选 ${_idx + 1}/${widget.candidates.length}',
                      style: const TextStyle(
                          fontSize: 15, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  // A/B/C/D 快切（按候选数给够，3~4 首也能一键对比）
                  if (widget.candidates.length >= 2)
                    Row(
                      children: [
                        for (var i = 0; i < widget.candidates.length; i++) ...[
                          _AbButton(
                              label: String.fromCharCode(65 + i),
                              active: _idx == i,
                              onTap: () => _ab(i)),
                          if (i != widget.candidates.length - 1)
                            const SizedBox(width: 6),
                        ],
                      ],
                    ),
                ],
              ),
            ),
            if (widget.degraded)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: Theme.of(context)
                        .colorScheme
                        .errorContainer
                        .withValues(alpha: 0.28),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: Theme.of(context)
                          .colorScheme
                          .error
                          .withValues(alpha: 0.5),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.wifi_off,
                          size: 16, color: Theme.of(context).colorScheme.error),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Text('离线快照：服务端已取不到这条任务，可以试听已存的文件，'
                            '但收下与微调不可用。',
                            style: TextStyle(fontSize: 12, height: 1.35)),
                      ),
                      TextButton(
                        onPressed: _adoptBlocked,
                        child: const Text('清理这条', style: TextStyle(fontSize: 12)),
                      ),
                    ],
                  ),
                ),
              ),
            // 翻转候选卡（左右滑动切换候选；波形区由内层手势 seek，优先级更高）
            Expanded(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onHorizontalDragStart: _onSwipeStart,
                onHorizontalDragUpdate: _onSwipeUpdate,
                onHorizontalDragEnd: _onSwipeEnd,
                onHorizontalDragCancel: _onSwipeCancel,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 420),
                      transitionBuilder: (child, anim) {
                        final t = Tween<double>(begin: math.pi / 2, end: 0)
                            .animate(CurvedAnimation(
                                parent: anim, curve: Curves.easeOutBack));
                        return AnimatedBuilder(
                          animation: anim,
                          child: child,
                          builder: (ctx, c) {
                            final m = Matrix4.identity()
                              ..setEntry(3, 2, 0.0015)
                              ..rotateY(t.value);
                            return Transform(
                              alignment: Alignment.center,
                              transform: m,
                              child: c,
                            );
                          },
                        );
                      },
                      child: _CandidateCard(
                        key: ValueKey(_cur.id),
                        candidate: _cur,
                        adopted: adopted,
                        playing: isCurrent && playerState.playing,
                        peaks: _peaks[_cur.id],
                        progress: progress,
                        onPlay: () => ref
                            .read(playerProvider.notifier)
                            .playQueue(
                                widget.candidates
                                    .map(_candidateToWork)
                                    .toList(),
                                _idx),
                        onTogglePlay: isCurrent
                            ? () => ref.read(playerProvider.notifier).toggle()
                            : null,
                        onSeek: isCurrent && total.inMilliseconds > 0
                            ? (v) => ref.read(playerProvider.notifier).seek(
                                Duration(
                                    milliseconds:
                                        (v * total.inMilliseconds).round()))
                            : null,
                        onAdopt: _adopt,
                        busy: _busy,
                        degraded: widget.degraded,
                        onAdoptBlocked: _adoptBlocked,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            // 翻页点 → 带序号/时长/收下角标的标签（看得出「有三首、怎么切」）
            Padding(
              padding: const EdgeInsets.only(top: 2, bottom: 6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(widget.candidates.length, (i) {
                  final c = widget.candidates[i];
                  final sel = i == _idx;
                  final secs = c.durationSec.round();
                  return GestureDetector(
                    onTap: () => _go(i),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 200),
                      margin: const EdgeInsets.symmetric(horizontal: 4),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 7),
                      decoration: BoxDecoration(
                        color: sel
                            ? Theme.of(context)
                                .colorScheme
                                .primary
                                .withValues(alpha: 0.18)
                            : Colors.white.withValues(alpha: 0.05),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                            color: sel
                                ? Theme.of(context).colorScheme.primary
                                : Colors.white12),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text('第 ${i + 1} 首',
                              style: TextStyle(
                                  fontSize: 12,
                                  fontWeight:
                                      sel ? FontWeight.w700 : FontWeight.w500,
                                  color: sel ? Colors.white : Colors.white54)),
                          const SizedBox(width: 4),
                          Text(
                              '${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')}',
                              style: const TextStyle(
                                  fontSize: 11, color: Colors.white38)),
                          if (_adopted.containsKey(c.id)) ...[
                            const SizedBox(width: 3),
                            Icon(Icons.check_circle,
                                size: 13,
                                color: Theme.of(context).colorScheme.primary),
                          ],
                        ],
                      ),
                    ),
                  );
                }),
              ),
            ),
            // 追问气泡 + 快捷改法
            if (_clarify != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Container(
                        constraints: const BoxConstraints(maxWidth: 340),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 10),
                        decoration: BoxDecoration(
                          color: Theme.of(context)
                              .colorScheme
                              .surfaceContainerHighest,
                          borderRadius: const BorderRadius.only(
                            topLeft: Radius.circular(14),
                            topRight: Radius.circular(14),
                            bottomRight: Radius.circular(14),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.campaign_outlined,
                                size: 15, color: Colors.amberAccent),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text('AI 追问：$_clarify',
                                  style: const TextStyle(fontSize: 13)),
                            ),
                          ],
                        ),
                      ),
                    ),
                    // 追问别只给一句话：给几个能直接点的改法
                    Padding(
                      padding: const EdgeInsets.only(left: 4, top: 2),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        children: kAdjustHints
                            .take(4)
                            .map((h) => ActionChip(
                                  label: Text(h,
                                      style: const TextStyle(fontSize: 12)),
                                  visualDensity: VisualDensity.compact,
                                  onPressed: () {
                                    _adjustCtrl.text = h;
                                    _adjustCtrl.selection =
                                        TextSelection.collapsed(
                                            offset: h.length);
                                  },
                                ))
                            .toList(),
                      ),
                    ),
                  ],
                ),
              ),
            // 微调会先收下母本——说在前面，别事后让用户在曲库里猜
            if (!adopted)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 2),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline,
                        size: 13, color: Colors.white24),
                    const SizedBox(width: 5),
                    Expanded(
                      child: Text(
                        _adjustHintShown
                            ? '这一版已收下作母本（在曲库），继续说改哪里'
                            : '说一句改一点：会先收下这一版作母本（进曲库）',
                        style: const TextStyle(
                            fontSize: 11, color: Colors.white24),
                      ),
                    ),
                  ],
                ),
              ),
            // 说一句改一点
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _adjustCtrl,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _adjust(),
                      decoration: InputDecoration(
                        hintText: '说一句改一点，如"副歌再燃一点"',
                        isDense: true,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _busy ? null : _adjust,
                    icon: _adjustSending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.send_rounded),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AbButton extends StatelessWidget {
  const _AbButton(
      {required this.label, required this.active, required this.onTap});

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        width: 36,
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: active ? scheme.primary : Colors.white10,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(label,
            style: TextStyle(
                fontWeight: FontWeight.w700,
                color: active ? scheme.onPrimary : Colors.white70)),
      ),
    );
  }
}

class _CandidateCard extends StatelessWidget {
  const _CandidateCard({
    super.key,
    required this.candidate,
    required this.adopted,
    required this.playing,
    required this.peaks,
    required this.progress,
    required this.onPlay,
    required this.onTogglePlay,
    required this.onSeek,
    required this.onAdopt,
    required this.busy,
    this.degraded = false,
    this.onAdoptBlocked,
  });

  final Candidate candidate;
  final bool adopted;
  final bool degraded;
  final VoidCallback? onAdoptBlocked;
  final bool playing;
  final List<double>? peaks;
  final double progress;
  final VoidCallback onPlay;
  final VoidCallback? onTogglePlay;
  final ValueChanged<double>? onSeek;
  final VoidCallback onAdopt;
  final bool busy;

  String _fmt(double sec) {
    final s = sec.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final realPeaks = peaks;
    return Container(
      constraints: const BoxConstraints(maxWidth: 420),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            scheme.surfaceContainerHigh,
            scheme.surfaceContainerLow,
          ],
        ),
        border: Border.all(color: Colors.white10),
      ),
      padding: const EdgeInsets.all(18),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 54,
                height: 54,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(colors: [
                    scheme.primary.withValues(alpha: .8),
                    scheme.tertiary.withValues(alpha: .6),
                  ]),
                ),
                child: const Center(
                    child: Text('💿', style: TextStyle(fontSize: 24))),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      candidate.title.isEmpty ? '未命名作品' : candidate.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 18, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text(
                        '时长 ${_fmt(candidate.durationSec)} · ${candidate.format.toUpperCase()}',
                        style: const TextStyle(
                            fontSize: 12, color: Colors.white54)),
                  ],
                ),
              ),
              const AiBadge(),
            ],
          ),
          const SizedBox(height: 14),
          // 波形：有真 peaks 用真的（可点按 seek），拉不到才用确定性占位并说明
          WaveformCanvas(
            peaks: realPeaks ?? pseudoPeaks(candidate.id, n: 56),
            height: 56,
            progress: progress,
            onSeek: onSeek,
          ),
          if (realPeaks == null)
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: Text('波形预览（精确波形稍后就绪）',
                  style: TextStyle(fontSize: 10, color: Colors.white24)),
            ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: playing ? onTogglePlay : onPlay,
                  icon: Icon(playing
                      ? Icons.pause_circle_filled
                      : Icons.play_circle_fill),
                  label: Text(playing ? '暂停试听' : '试听'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: () {
                  final b = adoptButton(
                      degraded: degraded, adopted: adopted, busy: busy);
                  return PrimaryButton(
                    text: b.text,
                    icon: b.icon,
                    loading: b.loading,
                    // 降级态点它 = 说清原因 + 给出路；正常态已收下则保持禁用（但文案自证状态）
                    onPressed: !b.enabled
                        ? null
                        : (degraded ? onAdoptBlocked : onAdopt),
                  );
                }(),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
