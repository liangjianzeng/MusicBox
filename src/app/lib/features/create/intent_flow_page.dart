import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart' as mdl;
import '../../core/state.dart';
import '../../core/ws_client.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/primary_button.dart';
import '../assistant/assistant_models.dart';
import '../assistant/assistant_state.dart';
import '../assistant/assistant_surface.dart';
import 'intent_card_view.dart';
import 'intent_sync.dart';
import 'music_assistant_sheet.dart';
import 'progress_page.dart';
import 'shelf_store.dart';

/// 意图流面板：轮询 + WSS 加速刷新 + 澄清答题 + 卡面点改落库 + 生成
/// 简约级 easy=true：只显示第 1 题 + 大号"直接生成"
class IntentFlowPanel extends ConsumerStatefulWidget {
  const IntentFlowPanel({
    super.key,
    required this.intentId,
    required this.easy,
    this.stickyActions = false,
    this.onGenerated,
  });

  final String intentId;
  final bool easy;
  final bool stickyActions;

  /// 生成成功回调（跳进度页）。默认行为：push Replacement 进度页。
  /// 一并交出本次任务要素与「原参数重交」闭包，供进度页显示与重试。
  final void Function(
          String jobId, TaskBrief brief, Future<String?> Function() retry)?
      onGenerated;

  @override
  ConsumerState<IntentFlowPanel> createState() => _IntentFlowPanelState();
}

class _IntentFlowPanelState extends ConsumerState<IntentFlowPanel> {
  mdl.Intent? _intent; // 展示值（含乐观改动）
  mdl.Intent? _server; // 最后一次服务端确认值（回滚基准 / 状态判定源）
  String? _error;
  bool _sending = false;
  IntentPatchStatus _patchStatus = IntentPatchStatus.idle;
  Set<String>? _pickedGenres; // 流派假设里用户选中的（null=全部）
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;
  final Map<int, int> _answers = {};
  late final IntentPatchQueue _q;

  ApiClient get _api => ref.read(apiClientProvider);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _setAssistantContext();
    });
    _q = intentQueueFor(ref, widget.intentId);
    _q.owner = this;
    _q.onStatus = (s) {
      if (mounted) setState(() => _patchStatus = s);
    };
    _q.onApplied = (i) {
      if (!mounted) return;
      setState(() {
        _server = i;
        // 期间用户又点了新的 → 保留乐观值，等下一次 PATCH 收口
        if (!_q.hasPending) _intent = i;
        _syncPickedGenres(i);
      });
    };
    _fetch();
    _poll = Timer.periodic(const Duration(milliseconds: 2500), (_) {
      final i = _intent;
      if (i == null || i.processing) _fetch();
    });
    _wsSub = ref
        .read(wsClientProvider)
        .events
        .where((e) => e is IntentCardEvent && e.intentId == widget.intentId)
        .listen((_) => _fetch());
  }

  void _setAssistantContext() {
    ref.read(assistantContextProvider.notifier).state = AssistantContext(
      surface: 'create',
      refs: [AssistantRef('intent', widget.intentId)],
      title: _intent?.sceneDesc ?? '灵感卡',
    );
  }

  bool get _ownsAssistantContext {
    final current = ref.read(assistantContextProvider);
    return current.surface == 'create' &&
        current.refs.length == 1 &&
        current.refs.single.type == 'intent' &&
        current.refs.single.id == widget.intentId;
  }

  @override
  void didUpdateWidget(covariant IntentFlowPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.intentId != widget.intentId) {
      final current = ref.read(assistantContextProvider);
      if (current.surface == 'create' &&
          current.refs.length == 1 &&
          current.refs.single.type == 'intent' &&
          current.refs.single.id == oldWidget.intentId) {
        ref.read(assistantContextProvider.notifier).state =
            const AssistantContext(surface: 'create');
      }
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _setAssistantContext();
      });
    }
  }

  @override
  void dispose() {
    if (_ownsAssistantContext) {
      ref.read(assistantContextProvider.notifier).state =
          const AssistantContext(surface: 'create');
    }
    _poll?.cancel();
    _wsSub?.cancel();
    if (_q.owner == this) {
      _q.owner = null;
      _q.onStatus = null;
      _q.onApplied = null;
    }
    // 离开面板前把没发出去的点改补发，不装丢
    unawaited(_q.flush());
    super.dispose();
  }

  void _syncPickedGenres(mdl.Intent i) {
    final all = i.genreHypotheses.toSet();
    final cur = _pickedGenres;
    if (cur == null ||
        !cur.toSet().every(all.contains) ||
        cur.length != all.length) {
      _pickedGenres = all;
    }
  }

  Future<void> _fetch() async {
    try {
      final i = await _api.intent(widget.intentId);
      if (!mounted) return;
      setState(() {
        _server = i;
        final editing = _patchStatus == IntentPatchStatus.saving ||
            _q.hasPending ||
            _q.busy;
        if (!editing) _intent = i;
        _error = null;
        _syncPickedGenres(i);
      });
      if (_ownsAssistantContext) _setAssistantContext();
      if (i.ready || i.consumed) _poll?.cancel();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.zh);
    } catch (_) {
      if (mounted) setState(() => _error = '加载失败，请检查网络');
    }
  }

  void _toast(String msg, {bool withRetry = false}) {
    if (!mounted) return;
    final m = ScaffoldMessenger.of(context);
    m.removeCurrentSnackBar();
    m.showSnackBar(SnackBar(
      content: Text(msg),
      duration: const Duration(seconds: 4),
      action: withRetry
          ? SnackBarAction(
              label: '重试',
              onPressed: () async {
                final r = await _q.retry();
                if (r != null && mounted) _toast('已保存你的修改');
              },
            )
          : null,
    ));
  }

  bool get _editing {
    final i = _intent;
    return i != null && !i.consumed && !_sending;
  }

  /// 卡面点改：乐观更新 + 落库（契约 v2.19）
  void _edit(Map<String, dynamic> patch, mdl.Intent optimistic) {
    if (!_editing) {
      _toast('这张卡已经用过啦，回到创建页再来一次');
      return;
    }
    setState(() => _intent = optimistic);
    _q.submit(patch);
  }

  Future<void> _editSceneDesc(mdl.Intent i) async {
    if (!_editing) return;
    final ctrl = TextEditingController(text: i.sceneDesc ?? '');
    final v = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('改一改灵感描述'),
        content: SizedBox(
          width: 420,
          child: TextField(
            controller: ctrl,
            autofocus: true,
            maxLines: 4,
            minLines: 2,
            maxLength: 300,
            decoration: const InputDecoration(
              hintText: '想要的画面/情绪/乐器',
              border: OutlineInputBorder(),
            ),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: const Text('保存')),
        ],
      ),
    );
    if (v == null || v == (i.sceneDesc ?? '')) return;
    _edit({'scene_desc': v}, i.copyWith(sceneDesc: v));
  }

  /// 生成：简约级/直接生成用推荐答案补齐澄清题（≤2 轮），再调 intent generate
  Future<void> _generate({bool direct = false}) async {
    if (_sending) return;
    setState(() => _sending = true);
    try {
      // 点改必须先落库，否则"最后一下改动"会被 generate 静默忽略（契约 v2.19）
      final flushed = await _q.flush();
      if (flushed == null && _q.hasPending) {
        if (!mounted) return;
        _toast('你的修改还没保存上，先点「重试」再生成', withRetry: true);
        return;
      }
      var cur = _intent;
      int rounds = 0;
      while (cur != null && !cur.ready && rounds < 3) {
        final pending = <mdl.IntentAnswer>[];
        for (final q in cur.questions) {
          final sel = _answers[q.qIdx];
          if (sel != null) {
            pending.add(mdl.IntentAnswer(qIdx: q.qIdx, optionIdx: sel));
          } else if (widget.easy || direct) {
            if (q.recommendedIdx != null) {
              pending.add(
                  mdl.IntentAnswer(qIdx: q.qIdx, optionIdx: q.recommendedIdx!));
            }
          }
        }
        if (pending.isEmpty) break;
        cur = await _api.intentAnswer(widget.intentId, pending);
        if (!mounted) return;
        setState(() {
          _intent = cur;
          _server = cur;
        });
        rounds++;
      }
      final ready = (_server ?? cur)?.ready ?? false;
      if (ready) {
        final jobId = await _api.intentGenerate(widget.intentId);
        if (!mounted) return;
        final it = _server ?? cur;
        final genres = _pickedGenres != null && _pickedGenres!.isNotEmpty
            ? _pickedGenres!.join(' / ')
            : ((it?.genreHypotheses.isNotEmpty ?? false)
                ? it!.genreHypotheses.join(' / ')
                : null);
        final brief = TaskBrief(
          action: '生成',
          tierLabel: widget.easy ? '简约' : '标准',
          sourceLabel: switch (it?.sourceKind ?? 'text') {
            'voice' => '按住说话',
            'image' => '拍一张',
            _ => '一句话',
          },
          mood: it?.mood ?? const [],
          vocal: it?.vocal == 'instrumental' ? '纯音乐' : '人声演唱',
          genre: genres,
          count: 3,
          intentId: widget.intentId,
        );
        Future<String?> retry() async {
          try {
            return await _api.intentGenerate(widget.intentId);
          } catch (_) {
            return null;
          }
        }

        if (widget.onGenerated != null) {
          widget.onGenerated!(jobId, brief, retry);
        } else {
          ProgressPage.pushReplacement(context, jobId,
              brief: brief, plannedCount: 3, onRetry: retry);
        }
      } else {
        _toast('再答一题就更准；也可以直接生成，我们用推荐答案');
      }
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('操作失败，请重试');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Widget get _saveBadge {
    switch (_patchStatus) {
      case IntentPatchStatus.saving:
        return const _CardBadge(
            icon: Icons.sync, text: '保存中…', color: Colors.white38);
      case IntentPatchStatus.saved:
        return const _CardBadge(
            icon: Icons.check_circle_outline,
            text: '已按你的修改',
            color: Colors.tealAccent);
      case IntentPatchStatus.failed:
        return InkWell(
          onTap: () async {
            final r = await _q.retry();
            if (r != null && mounted) _toast('已保存你的修改');
          },
          child: const _CardBadge(
              icon: Icons.error_outline,
              text: '保存失败·点重试',
              color: Colors.amberAccent),
        );
      case IntentPatchStatus.idle:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    final i = _intent;
    if (_error != null && i == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded, size: 40),
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.white54)),
            const SizedBox(height: 12),
            OutlinedButton.icon(
                onPressed: _fetch,
                icon: const Icon(Icons.refresh),
                label: const Text('重试')),
          ],
        ),
      );
    }
    if (i == null || i.processing) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
                width: 30,
                height: 30,
                child: CircularProgressIndicator(strokeWidth: 2.5)),
            SizedBox(height: 14),
            Text('正在理解你的灵感…', style: TextStyle(color: Colors.white70)),
            SizedBox(height: 4),
            Text('AI 会听声音/看画面，猜出你想听的歌',
                style: TextStyle(color: Colors.white38, fontSize: 12)),
          ],
        ),
      );
    }
    final card = IntentCardView(
      intent: i,
      maxQuestions: widget.easy ? 1 : null,
      answers: _answers,
      onAnswer:
          _sending ? null : (qIdx, opt) => setState(() => _answers[qIdx] = opt),
      onSkipQuestion: widget.easy || _sending
          ? null
          : (qIdx) {
              final q = i.questions.firstWhere((e) => e.qIdx == qIdx);
              setState(() => _answers[qIdx] = q.recommendedIdx ?? 0);
            },
      onMoodChanged:
          _editing ? (m) => _edit({'mood': m}, i.copyWith(mood: m)) : null,
      moodSuggestions: kMoodOptions,
      onSceneDescEdited: _editing ? () => _editSceneDesc(i) : null,
      selectedGenres: _pickedGenres?.toList() ?? i.genreHypotheses,
      onGenreToggled: _editing
          ? (g, sel) {
              final next = {...?_pickedGenres};
              if (sel) {
                next.add(g);
              } else {
                next.remove(g);
              }
              _pickedGenres = next;
              _edit({'genre_hypotheses': next.toList()},
                  i.copyWith(genreHypotheses: next.toList()));
            }
          : null,
      onVocalToggled: _editing
          ? () {
              final next = i.vocal == 'instrumental' ? 'song' : 'instrumental';
              _edit({'vocal': next}, i.copyWith(vocal: next));
            }
          : null,
      headerTrailing: _saveBadge,
    );
    final actions = widget.easy
        ? PrimaryButton(
            text: '直接生成',
            big: true,
            icon: Icons.auto_awesome,
            loading: _sending,
            onPressed: i.consumed ? null : () => _generate(direct: true),
          )
        : Row(
            children: [
              Expanded(
                child: PrimaryButton(
                  text: '生成',
                  icon: Icons.auto_awesome,
                  loading: _sending,
                  onPressed: i.consumed ? null : () => _generate(),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton(
                  onPressed: i.consumed || _sending
                      ? null
                      : () => _generate(direct: true),
                  child: const Text('按推荐直接生成'),
                ),
              ),
            ],
          );
    final hint = widget.easy && i.clarifying && i.questions.isNotEmpty
        ? const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('不想答？点下方「直接生成」就好',
                style: TextStyle(color: Colors.white38, fontSize: 12)),
          )
        : null;
    const assistantSuggestion = AssistantSuggestionCard(
      title: '帮我改意图卡',
      prompt: '请基于当前灵感卡上下文，给我一些修改建议；我想先确认调整内容，再走现有的保存和生成流程',
      icon: Icons.edit_note_outlined,
    );
    if (!widget.stickyActions) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          card,
          assistantSuggestion,
          const SizedBox(height: 16),
          actions,
          if (hint != null) hint,
        ],
      );
    }
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [card, assistantSuggestion, if (hint != null) hint],
            ),
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
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
              child: actions,
            ),
          ),
        ),
      ],
    );
  }
}

/// 卡头保存态徽标
class _CardBadge extends StatelessWidget {
  const _CardBadge(
      {required this.icon, required this.text, required this.color});

  final IconData icon;
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: color),
        const SizedBox(width: 3),
        Text(text, style: TextStyle(fontSize: 11, color: color)),
      ],
    );
  }
}

/// 简约级全屏意图流
class IntentFlowPage extends ConsumerWidget {
  const IntentFlowPage({super.key, required this.intentId, this.easy = true});

  final String intentId;
  final bool easy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rc = ref.watch(remoteConfigProvider);
    final assistantOn = (rc?.musicAssistant ?? false) || kMusicAssistantForce;
    return Scaffold(
      appBar: AppBar(title: const Text('灵感理解')),
      floatingActionButtonLocation: FloatingActionButtonLocation.endTop,
      floatingActionButton: assistantOn
          ? FloatingActionButton.small(
              heroTag: 'music_assistant_fab_intent',
              tooltip: '音乐助手',
              onPressed: () => showMusicAssistant(context,
                  subjectType: 'intent',
                  subjectId: intentId,
                  chatEnabled: rc?.assistantChatMusic ?? false),
              child: const Icon(Icons.smart_toy_outlined, size: 20),
            )
          : null,
      body: SafeArea(
        child: IntentFlowPanel(
          intentId: intentId,
          easy: easy,
          stickyActions: true,
        ),
      ),
    );
  }
}
