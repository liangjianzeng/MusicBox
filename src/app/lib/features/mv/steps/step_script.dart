import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/state.dart';
import '../../../core/ws_client.dart';
import '../mv_models.dart';
import '../mv_state.dart';
import '../widgets/mv_common.dart';
import '../widgets/mv_network_image.dart';
import '../widgets/mv_theme.dart';

/// 步④剧本/分镜：镜卡竖列（分镜图缩略 or 待生成占位 / 类型徽标 / 时长 /
/// 画面描述 / 景别），长按弹卡编辑（改词·删镜·上移下移·景别 chips）——
/// 全部经 PATCH script_json（ver CAS，409 STALE → refetch+重试一次，
/// 二次失败诚实 toast）。「让它改改」→ 建议挂草稿 → diff 预览 → 采纳才生效
///（suggest 与拍板解耦：LLM 离线 409 NOT_READY，退回手动编辑，绝不装忙）。
class StepScript extends ConsumerStatefulWidget {
  const StepScript({super.key, required this.workId});
  final String? workId;

  @override
  ConsumerState<StepScript> createState() => _StepScriptState();
}

class _StepScriptState extends ConsumerState<StepScript> {
  bool _busy = false;
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;
  String? _watchedProjectId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _watchProject(ref.read(mvWizardProvider(widget.workId)).project?.id);
      }
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _wsSub?.cancel();
    super.dispose();
  }

  void _watchProject(String? projectId) {
    if (_watchedProjectId == projectId) return;
    _poll?.cancel();
    _wsSub?.cancel();
    _watchedProjectId = projectId;
    if (projectId == null) return;
    _poll = Timer.periodic(const Duration(seconds: 3), (_) {
      if (!mounted) return;
      ref
          .read(mvProjectDetailProvider(projectId).notifier)
          .refresh(quiet: true);
    });
    _wsSub = ref
        .read(wsClientProvider)
        .events
        .where((e) => e is MvProgressEvent && e.projectId == projectId)
        .listen((_) {
      if (!mounted) return;
      ref
          .read(mvProjectDetailProvider(projectId).notifier)
          .refresh(quiet: true);
    });
  }

  MvProjectDetailNotifier _n(WidgetRef ref, String projectId) =>
      ref.read(mvProjectDetailProvider(projectId).notifier);

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(mvUserVisibleText(text))));
  }

  Future<void> _guard(Future<void> Function() f) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await f();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _compileStoryboard(String projectId) async {
    await _guard(() async {
      final (ok, err, _) = await _n(ref, projectId).dispatchJob('storyboard');
      if (ok) {
        _toast('分镜任务已提交，关键帧逐镜产出');
      } else {
        _toast(err ?? '分镜提交失败，请重试');
      }
    });
  }

  /// 应用一版镜卡编辑并保存（PATCH script_json + ver CAS）
  Future<void> _saveShots(String projectId, List<MvShot> next) async {
    await _guard(() async {
      final err = await _n(ref, projectId).editScript(next);
      _toast(err ?? '已保存，剧组按新剧本执行');
    });
  }

  /// 「让它改改」：note → suggest → diff 预览卡 → 采纳/放弃
  Future<void> _suggest(String projectId, MvProjectDetail detail) async {
    final note = await _askNote();
    if (note == null || note.trim().isEmpty) return;
    await _guard(() async {
      final (suggest, err, notReady) =
          await _n(ref, projectId).suggestScript(note.trim());
      if (notReady) {
        _toast('AI 编剧暂不可用（后台未就绪），已退回手动编辑——不装忙');
        return;
      }
      if (suggest == null) {
        _toast(err ?? '编剧没给出可用建议，请换个说法再试');
        return;
      }
      if (!mounted) return;
      await _showSuggestCard(projectId, detail, suggest);
    });
  }

  Future<String?> _askNote() {
    final ctrl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('让它改改'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('告诉编剧你想怎么改（建议只挂草稿，你采纳才生效）',
                style:
                    TextStyle(fontSize: 12.5, color: context.mvTextSecondary)),
            SizedBox(height: 10),
            TextField(
              controller: ctrl,
              maxLines: 3,
              maxLength: 200,
              autofocus: true,
              decoration: const InputDecoration(
                  hintText: '比如：副歌前多一段城市空镜，结尾给主演特写',
                  isDense: true,
                  border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('算了')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text),
              child: Text('请编剧改一版')),
        ],
      ),
    );
  }

  Future<void> _showSuggestCard(
      String projectId, MvProjectDetail detail, MvSuggest s) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.mvColors.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.auto_awesome, size: 16, color: context.mvInfo),
                  SizedBox(width: 6),
                  Expanded(
                      child: Text('编剧的新版剧本（草稿 · 未生效）',
                          style: TextStyle(
                              fontWeight: FontWeight.w700, fontSize: 14))),
                  Text('AI 编剧 · ${mvHuman(s.mode)}',
                      style:
                          TextStyle(fontSize: 11, color: context.mvTextMuted)),
                ],
              ),
              SizedBox(height: 6),
              Text(mvHuman(s.summary ?? ''),
                  style: TextStyle(
                      fontSize: 12.5,
                      color: context.mvTextSecondary,
                      height: 1.4)),
              SizedBox(height: 4),
              Text(
                  '现在 ${detail.shots.length} 镜 → 新版 ${s.shots.length} 镜'
                  '（采纳后未成片镜头按新剧本刷新，已成片不动）',
                  style: TextStyle(fontSize: 11.5, color: context.mvTextMuted)),
              SizedBox(height: 8),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (var i = 0; i < s.shots.length && i < 16; i++)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              width: 22,
                              child: Text('${i + 1}',
                                  style: TextStyle(
                                      fontSize: 11,
                                      color: context.mvTextMuted)),
                            ),
                            Expanded(
                              child: Text(
                                '${mvShotKindLabel('${s.shots[i]['kind'] ?? 'story'}')}'
                                ' · ${mvHuman('${s.shots[i]['desc'] ?? ''}')}',
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    fontSize: 12,
                                    color: context.mvTextSecondary),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                        onPressed: () => Navigator.pop(ctx),
                        child: Text('先不要')),
                  ),
                  SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () async {
                        Navigator.pop(ctx);
                        await _guard(() async {
                          final err = await _n(ref, projectId).applySuggest(s);
                          _toast(err ?? '已采纳这版剧本（版本号已推进，重新送审）');
                        });
                      },
                      icon: Icon(Icons.check, size: 16),
                      label: Text('采纳这版'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 长按镜卡 → 编辑弹层（改词/删镜/上移下移/景别）
  Future<void> _editSheet(MvProjectDetail detail, MvShot shot) async {
    final action = await showModalBottomSheet<_ShotEditResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.mvColors.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _ShotEditSheet(shot: detail.shots, target: shot),
    );
    if (action == null) return;
    final list = [...detail.shots];
    final i = list.indexWhere((s) => s.id == shot.id);
    if (i < 0) return;
    switch (action.kind) {
      case _ShotEditKind.save:
        list[i] = list[i].copyWith(desc: action.desc, camera: action.camera);
        await _saveShots(detail.project.id, _reseq(list));
      case _ShotEditKind.delete:
        if (list.length <= 1) {
          _toast('至少保留一个镜头');
          return;
        }
        list.removeAt(i);
        await _saveShots(detail.project.id, _reseq(list));
      case _ShotEditKind.up:
        if (i == 0) return;
        final t = list[i - 1];
        list[i - 1] = list[i];
        list[i] = t;
        await _saveShots(detail.project.id, _reseq(list));
      case _ShotEditKind.down:
        if (i == list.length - 1) return;
        final t = list[i + 1];
        list[i + 1] = list[i];
        list[i] = t;
        await _saveShots(detail.project.id, _reseq(list));
    }
  }

  /// 调序/删镜后按新顺序重排 seq（服务端按 seq 出片序）
  List<MvShot> _reseq(List<MvShot> list) => [
        for (var i = 0; i < list.length; i++) list[i].copyWith(seq: i + 1),
      ];

  @override
  Widget build(BuildContext context) {
    final wizard = ref.watch(mvWizardProvider(widget.workId));
    ref.listen(mvWizardProvider(widget.workId), (_, next) {
      _watchProject(next.project?.id);
    });
    final project = wizard.project;
    if (project == null) {
      return Center(
          child:
              Text('请先在步②确认主演', style: TextStyle(color: context.mvTextMuted)));
    }
    final detailState = ref.watch(mvProjectDetailProvider(project.id));
    final detail = detailState.detail;
    if (detailState.detail == null && detailState.loading) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: const [MvListSkeleton(count: 4)],
      );
    }
    if (detail == null) {
      return MvErrorView(
        text: mvUserVisibleText(detailState.error).trim().isEmpty
            ? '剧本数据暂不可用'
            : mvUserVisibleText(detailState.error),
        onRetry: () => _n(ref, project.id).refresh(),
      );
    }
    final shots = detail.shots;
    final scheme = Theme.of(context).colorScheme;

    return MvLeaveGuard(
      busy: _busy,
      message: '剧本、分镜图或 AI 建议仍在提交中。离开不会取消后台任务，'
          '但可能看不到本次保存回执。确定离开吗？',
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          Row(
            children: [
              Expanded(
                child: Text('剧本 / 分镜 · ${shots.length} 镜',
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
              ),
              OutlinedButton.icon(
                onPressed: _busy ? null : () => _suggest(project.id, detail),
                icon: Icon(Icons.auto_awesome, size: 15),
                label: Text('让它改改', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
          SizedBox(height: 4),
          Text('长按镜卡或编辑手柄可改词、删镜、调序、换景别；调序请使用上移/下移，不拖动。',
              style: TextStyle(fontSize: 11.5, color: context.mvTextMuted)),
          SizedBox(height: 12),
          if (detail.aiReview != null && detail.aiReview!.present) ...[
            _AiReviewCard(review: detail.aiReview!),
            SizedBox(height: 12),
          ],
          if (shots.isEmpty)
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: context.mvSurfaceRaised.withValues(alpha: .03),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: context.mvBorder),
              ),
              child: Column(
                children: [
                  Icon(Icons.movie_filter_outlined,
                      size: 34, color: context.mvTextMuted),
                  SizedBox(height: 8),
                  Text(
                      '还没有分镜。先由编剧按这首歌编译剧本，'
                      '再逐镜产出关键帧。',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          fontSize: 12.5,
                          color: context.mvTextSecondary,
                          height: 1.5)),
                  SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed:
                        _busy ? null : () => _compileStoryboard(project.id),
                    icon: _busy
                        ? SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : Icon(Icons.burst_mode_outlined, size: 18),
                    label: Text('生成分镜'),
                  ),
                ],
              ),
            )
          else ...[
            ...shots.map((s) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _ShotCard(
                      shot: s,
                      isVocal: detail.project.isVocal,
                      onLongPress: _busy ? null : () => _editSheet(detail, s)),
                )),
            SizedBox(height: 2),
            OutlinedButton.icon(
              onPressed: _busy ? null : () => _compileStoryboard(project.id),
              icon: Icon(Icons.image_outlined, size: 16),
              label: Text('补拍/重出分镜图', style: TextStyle(fontSize: 12)),
            ),
            if (shots.every((s) => (s.storyboardUrl ?? '').isEmpty))
              Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text('分镜图尚未产出：等待执行器出图后显示缩略图，本页不伪造画面。',
                    style: TextStyle(fontSize: 11, color: context.mvTextMuted)),
              ),
          ],
          SizedBox(height: 14),
          // 步入门禁提示：出样片前不进⑤
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: scheme.primaryContainer.withValues(alpha: .08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: context.mvBorder),
            ),
            child: Text(
              '下一步：先看样片 → 确认拍摄计划 →「开机开拍」。剧本没改好之前不必急着看片。',
              style: TextStyle(
                  fontSize: 11.5, color: context.mvTextMuted, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- 长按编辑弹层 ----------

enum _ShotEditKind { save, delete, up, down }

class _ShotEditResult {
  _ShotEditResult(this.kind, {this.desc, this.camera});
  final _ShotEditKind kind;
  final String? desc;
  final String? camera;
}

class _ShotEditSheet extends StatefulWidget {
  const _ShotEditSheet({required this.shot, required this.target});
  final List<MvShot> shot;
  final MvShot target;

  @override
  State<_ShotEditSheet> createState() => _ShotEditSheetState();
}

class _ShotEditSheetState extends State<_ShotEditSheet> {
  late final TextEditingController _desc =
      TextEditingController(text: widget.target.desc ?? '');
  late String? _camera = kMvCameraChips.contains(widget.target.camera)
      ? widget.target.camera
      : null;

  @override
  void dispose() {
    _desc.dispose();
    super.dispose();
  }

  void _pop(_ShotEditResult r) => Navigator.pop(context, r);

  @override
  Widget build(BuildContext context) {
    final i = widget.shot.indexWhere((s) => s.id == widget.target.id);
    final last = widget.shot.length - 1;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                '第 ${widget.target.seq} 镜 · '
                '${mvShotKindLabel(widget.target.kind)}',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
            SizedBox(height: 10),
            Text('改画面描述（改词）',
                style: TextStyle(fontSize: 12, color: context.mvTextSecondary)),
            SizedBox(height: 4),
            TextField(
              controller: _desc,
              maxLines: 3,
              maxLength: 200,
              decoration: const InputDecoration(
                  isDense: true, counterText: '', border: OutlineInputBorder()),
            ),
            SizedBox(height: 6),
            Text('景别',
                style: TextStyle(fontSize: 12, color: context.mvTextSecondary)),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                for (final c in kMvCameraChips)
                  ChoiceChip(
                    label: Text(c, style: TextStyle(fontSize: 12)),
                    selected: _camera == c,
                    visualDensity: VisualDensity.compact,
                    onSelected: (_) =>
                        setState(() => _camera = _camera == c ? null : c),
                  ),
              ],
            ),
            SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => _pop(_ShotEditResult(_ShotEditKind.save,
                        desc: _desc.text.trim(), camera: _camera ?? '')),
                    icon: Icon(Icons.check, size: 16),
                    label: Text('保存修改'),
                  ),
                ),
              ],
            ),
            SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: i > 0
                        ? () => _pop(_ShotEditResult(_ShotEditKind.up))
                        : null,
                    icon: Icon(Icons.arrow_upward, size: 15),
                    label: Text('上移', style: TextStyle(fontSize: 12)),
                  ),
                ),
                SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: i < last
                        ? () => _pop(_ShotEditResult(_ShotEditKind.down))
                        : null,
                    icon: Icon(Icons.arrow_downward, size: 15),
                    label: Text('下移', style: TextStyle(fontSize: 12)),
                  ),
                ),
                SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () =>
                        _pop(_ShotEditResult(_ShotEditKind.delete)),
                    icon: Icon(Icons.delete_outline,
                        size: 15, color: context.mvError),
                    label: Text('删镜',
                        style: TextStyle(fontSize: 12, color: context.mvError)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- 镜卡 ----------

class _ShotCard extends StatelessWidget {
  const _ShotCard(
      {required this.shot, required this.isVocal, required this.onLongPress});
  final MvShot shot;
  final bool isVocal;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final board = shot.storyboardUrl ?? '';
    return Semantics(
      button: true,
      label:
          '第 ${shot.seq} 镜，${mvShotKindLabel(shot.kind)}，${shot.sec.round()} 秒',
      hint: onLongPress == null ? '正在保存' : '长按编辑，使用上移或下移调序',
      child: Material(
        color: context.mvSurfaceRaised.withValues(alpha: 0.03),
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onLongPress: onLongPress,
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: context.mvBorder),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: SizedBox(
                    width: 54,
                    height: 76,
                    child: board.isNotEmpty
                        ? Stack(
                            fit: StackFit.expand,
                            children: [
                              MvNetworkImage(
                                  url: board,
                                  cacheWidth: 160,
                                  semanticLabel: '第 ${shot.seq} 镜分镜图'),
                              Positioned(
                                top: 1,
                                right: 1,
                                child: MvZoomButton(
                                  label: '放大第 ${shot.seq} 镜分镜图',
                                  onPressed: () => showMvImagePreview(context,
                                      url: board, title: '第 ${shot.seq} 镜分镜图'),
                                ),
                              ),
                            ],
                          )
                        : _boardPlaceholder(context),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text('#${shot.seq}',
                              style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w800,
                                  color: context.mvTextMuted)),
                          const SizedBox(width: 6),
                          _KindBadge(kind: shot.kind),
                          const Spacer(),
                          if (shot.sec > 0)
                            Text('${shot.sec.round()}s',
                                style: TextStyle(
                                    fontSize: 11, color: context.mvTextMuted)),
                        ],
                      ),
                      const SizedBox(height: 5),
                      Text(
                          mvHuman((shot.desc ?? '').isEmpty
                              ? '（暂无描述）'
                              : shot.desc!),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 12.5,
                              color: context.mvTextSecondary,
                              height: 1.35)),
                      const SizedBox(height: 4),
                      Text(
                        [
                          if ((shot.camera ?? '').isNotEmpty) shot.camera!,
                          if (isVocal && shot.singing && shot.lyricFrom != null)
                            '唱段 · 第 ${shot.lyricFrom! + 1}'
                                '${shot.lyricTo != null && shot.lyricTo! > shot.lyricFrom! + 1 ? '–${shot.lyricTo}' : ''} 句',
                          if (shot.rerolls > 0) '补拍 ${shot.rerolls} 次',
                        ].where((e) => e.isNotEmpty).join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            TextStyle(fontSize: 11, color: context.mvTextMuted),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 2),
                Tooltip(
                  message: '长按编辑；上移/下移调序',
                  child: Semantics(
                    label: '编辑手柄',
                    child: Icon(Icons.drag_handle,
                        size: 20, color: context.mvTextMuted),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _boardPlaceholder(BuildContext context) {
    return Container(
      color: context.mvSurfaceRaised.withValues(alpha: 0.05),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.image_outlined, size: 16, color: context.mvTextMuted),
            const SizedBox(height: 3),
            Text('待生成',
                style: TextStyle(fontSize: 9, color: context.mvTextMuted)),
          ],
        ),
      ),
    );
  }
}

class _KindBadge extends StatelessWidget {
  const _KindBadge({required this.kind});
  final String kind;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (kind) {
      'singing' => ('演唱', context.mvInfo),
      'broll' => ('空镜', context.mvTextMuted),
      _ => ('剧情', context.mvColors.primary),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .15),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: .45)),
      ),
      child: Text(label,
          style: TextStyle(fontSize: 10, color: color, height: 1.2)),
    );
  }
}

/// 只读 AI 卡审结论卡（契约 v2.21 detail.ai_review）：如实呈现机检/LLM findings，
/// 不阻断拍板（warn/high 仅提醒），无风险时明示「机检通过」。
class _AiReviewCard extends StatelessWidget {
  const _AiReviewCard({required this.review});
  final MvAiReview review;

  @override
  Widget build(BuildContext context) {
    if (!review.hasScript) return const SizedBox.shrink();
    final all = <MvAiFinding>[...review.findings, ...review.llmFindings];
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.mvSurfaceRaised.withValues(alpha: .03),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.mvBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.verified_user_outlined,
                  size: 15, color: context.mvInfo),
              SizedBox(width: 6),
              Text('AI 卡审',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
              SizedBox(width: 8),
              Flexible(
                child: Text(review.engine ?? '规则机检',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style:
                        TextStyle(fontSize: 10.5, color: context.mvTextMuted)),
              ),
              if (review.llmUsed) ...[
                SizedBox(width: 6),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(
                    color: context.mvInfo.withValues(alpha: .15),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text('LLM 增补',
                      style: TextStyle(fontSize: 9, color: context.mvInfo)),
                ),
              ],
            ],
          ),
          SizedBox(height: 8),
          if (all.isEmpty)
            Text('机检通过：暂无需要提醒你的风险项。',
                style: TextStyle(
                    fontSize: 12, color: context.mvTextSecondary, height: 1.4))
          else
            for (final f in all)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(f.isHigh ? Icons.error_outline : Icons.info_outline,
                        size: 14,
                        color: f.isHigh ? context.mvError : context.mvWarning),
                    SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        '${f.shotSeq != null ? '第${f.shotSeq}镜 · ' : ''}${mvHuman(f.message)}',
                        style: TextStyle(
                            fontSize: 12,
                            color: context.mvTextSecondary,
                            height: 1.4),
                      ),
                    ),
                    if (f.source == 'llm')
                      Padding(
                        padding: EdgeInsets.only(left: 4),
                        child: Text('AI',
                            style:
                                TextStyle(fontSize: 9, color: context.mvInfo)),
                      ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}
