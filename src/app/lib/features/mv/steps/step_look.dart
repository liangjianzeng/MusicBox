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
import '../widgets/mv_video_player.dart';

/// 步③定妆：3 候选定妆照 →（选定后）定妆视频 → 13 帧格勾选（facegate 分
/// 排序 + 过门帧预选）→ 拍板固化 viewRefs（身份真源）。
/// 数据全部来自 GET /v1/mv/projects/:id 的 character（cast_images / cast_video /
/// frames=cast_video 完成后机检回传）；未回传时如实等待态、整体禁用 ——
/// 不做假庆祝、不伪造定妆结果。帧格排序克制：只标「更像你的角度」分档，
/// 不评美丑（§5.1③ 纪律）。
class StepLook extends ConsumerStatefulWidget {
  const StepLook({super.key, required this.workId});
  final String? workId;

  static const int kFrameCells = 13;

  @override
  ConsumerState<StepLook> createState() => _StepLookState();
}

class _StepLookState extends ConsumerState<StepLook> {
  int? _pickedCast; // 选中的定妆照候选（0..2）
  Set<String>? _selectedFrames; // 勾选帧 url（首次以 pass 帧预选）
  String? _frameSignature; // 数据签名变化时重新预选，build 内无写副作用
  bool _busy = false;
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;
  String? _watchedProjectId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _watchProject(ref.read(mvWizardProvider(widget.workId)).project?.id);
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
    _poll = Timer.periodic(
      const Duration(seconds: 3),
      (_) {
        if (!mounted) return;
        ref
            .read(mvProjectDetailProvider(projectId).notifier)
            .refresh(quiet: true);
      },
    );
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

  @override
  Widget build(BuildContext context) {
    final wizard = ref.watch(mvWizardProvider(widget.workId));
    ref.listen(mvWizardProvider(widget.workId), (_, next) {
      _watchProject(next.project?.id);
    });
    final n = ref.read(mvWizardProvider(widget.workId).notifier);
    final project = wizard.project;
    if (project == null) {
      return Center(
          child:
              Text('请先在步②确认主演', style: TextStyle(color: context.mvTextMuted)));
    }
    final detailState = ref.watch(mvProjectDetailProvider(project.id));
    final detail = detailState.detail;
    final character = (detail?.characters.isNotEmpty ?? false)
        ? detail!.characters.first
        : null;

    final castImages = <String>[
      ...?character?.castImages,
      // 兼容：老数据只回填单张 cast_image_url
      if ((character?.castImageUrl ?? '').isNotEmpty &&
          !(character?.castImages ?? const [])
              .contains(character!.castImageUrl))
        character.castImageUrl!,
    ];
    final pickedUrl = _pickedCast != null && _pickedCast! < castImages.length
        ? castImages[_pickedCast!]
        : (character?.castImageUrl ?? '');
    final cands = character?.castCandidates ?? const <MvCastCandidate>[];
    // 身份门控的真相（呈现见下方 gateWarning，契约 v5.6.16）
    final gateRan = character?.castGateRan;
    final bestScore = character?.castBestScore;
    final castVideo = character?.castVideoUrl ?? '';
    // 帧格：机检回传帧按分排序（高分在前），上限 13 格；pass 帧默认勾选
    final frames = [...?character?.frames]
      ..sort((a, b) => (b.score ?? -1).compareTo(a.score ?? -1));
    final shownFrames = frames.take(StepLook.kFrameCells).toList();
    final frameReady = shownFrames.isNotEmpty;
    final signature = [
      character?.id ?? '',
      pickedUrl,
      castVideo,
      for (final f in shownFrames) '${f.url}:${f.pass}:${f.score}',
    ].join('|');
    final defaultSelected = <String>{
      for (final f in shownFrames)
        if (f.pass) f.url,
    };
    final selected = (_frameSignature == signature ? _selectedFrames : null)
            ?.where((u) => shownFrames.any((f) => f.url == u))
            .toSet() ??
        defaultSelected;
    final confirmed = character?.confirmed == true || wizard.lookConfirmed;
    final visibleError = mvUserVisibleText(detailState.error);
    // 门控没跑成时，这条横幅优先说这个（契约 v5.6.16）。过去 facegate 不可达只是执行侧
    // 一行日志 + 评分缺省，这里照样显示「定妆照已回传，点选一张」，让用户以为三张都是
    // 和主角脸对照过才发回来的 —— 把自己的失败藏进用户的损失里，正是这轮反复在猎的东西。
    // `gateRan == null`（老数据未标注）也不许读成"验过了"，同按未验呈现。
    final String? gateWarning = (castImages.isEmpty || confirmed)
        ? null
        : gateRan != true
            ? '身份门控没跑成（${character?.castGateReason ?? '未上报原因'}）：'
                '这 ${castImages.length} 张候选都没和主角脸对照过，挑之前请知悉。'
            : (bestScore != null && bestScore < kMvCastGateLine)
                ? '这 ${castImages.length} 张都没过身份门控：最像的一张相似度 ${(bestScore * 100).round()}%，'
                    '低于 ${(kMvCastGateLine * 100).round()}% 通过线。可以硬挑，但我们没验到像。'
                : null;
    final lookMessage = visibleError.trim().isNotEmpty
        ? visibleError
        : (gateWarning ??
            (confirmed
                ? '定妆已拍板固化，身份参考以服务端回执为准。'
                : frameReady
                    ? '定妆视频与角度帧已就绪，勾选后拍板固化。'
                    : castVideo.isNotEmpty
                        ? '定妆视频已回传，角度帧机检结果生成中。'
                        : castImages.isNotEmpty
                            ? '定妆照已回传，点选一张后拍摄定妆视频。'
                            : wizard.jobNote ??
                                '定妆照任务已提交，等待剧组出图（约 15 秒/张 ×3）。'));
    final lookBusy = detailState.error == null &&
        !confirmed &&
        (castImages.isEmpty || (castVideo.isNotEmpty && !frameReady));

    return MvLeaveGuard(
      busy: _busy,
      message: '定妆视频或角度帧拍板仍在提交中。离开不会取消后台任务，'
          '但可能看不到本次回执。确定离开吗？',
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        children: [
          // 诚实横幅
          _WaitBanner(text: lookMessage, busy: lookBusy),
          SizedBox(height: 12),
          const _Label('定妆照候选 · 3 张（点选一张做主演定妆）'),
          SizedBox(height: 8),
          Row(
            children: [
              for (var i = 0; i < 3; i++) ...[
                if (i > 0) SizedBox(width: 8),
                Expanded(
                  child: _CandidateTile(
                    index: i,
                    url: i < castImages.length ? castImages[i] : null,
                    score: i < cands.length ? cands[i].score : null,
                    selected: castImages.isNotEmpty &&
                        ((pickedUrl.isNotEmpty &&
                                i < castImages.length &&
                                castImages[i] == pickedUrl) ||
                            (pickedUrl.isEmpty &&
                                _pickedCast == null &&
                                i == 0)),
                    onTap: castImages.isEmpty || confirmed
                        ? null
                        : () => setState(() {
                              _pickedCast = i;
                              _selectedFrames = null; // 换定妆照后帧格重新预选
                              _frameSignature = null;
                            }),
                    onPreview: i < castImages.length
                        ? () => showMvImagePreview(context,
                            url: castImages[i], title: '定妆照候选 ${i + 1}')
                        : null,
                  ),
                ),
              ],
            ],
          ),
          SizedBox(height: 8),
          // 拍定妆视频（cast_video：约 5 秒多角度转头，~5 分钟）
          if (!confirmed && (castVideo.isEmpty || _pickedCast != null))
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: (_busy || pickedUrl.isEmpty || castVideo.isNotEmpty)
                    ? null
                    : () async {
                        setState(() => _busy = true);
                        try {
                          final err = await n.dispatchCastVideo(pickedUrl);
                          if (!mounted) return;
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                              content: Text(err ?? '定妆视频任务已提交，约需 5 分钟')));
                          ref
                              .read(
                                  mvProjectDetailProvider(project.id).notifier)
                              .refresh(quiet: true);
                        } finally {
                          if (mounted) setState(() => _busy = false);
                        }
                      },
                icon: _busy
                    ? SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(Icons.videocam, size: 16),
                label: Text(castVideo.isEmpty ? '用这张拍定妆视频' : '重新拍定妆视频',
                    style: TextStyle(fontSize: 12.5)),
              ),
            ),
          SizedBox(height: 12),
          const _Label('定妆视频（多角度转头 · 约 5 秒）'),
          SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: MvVideoPlayer(
              url: castVideo.isEmpty ? null : castVideo,
              coverUrl: pickedUrl.isEmpty ? null : pickedUrl,
              aspectRatio: 9 / 16,
              placeholderHint: '定妆视频待执行器出片后显示',
            ),
          ),
          SizedBox(height: 16),
          const _Label('满意角度帧格 · 13 帧（勾选后拍板固化）'),
          SizedBox(height: 4),
          Text(
              frameReady
                  ? '高分帧在前，过门帧已默认勾选；只按「更像你」排序，不评美丑。'
                  : '定妆视频产出后，逐帧评分自动填入帧格（机检回传，未回传前如实禁用）。',
              style: TextStyle(fontSize: 11, color: context.mvTextMuted)),
          SizedBox(height: 8),
          _FrameGrid(
            frames: shownFrames,
            enabled: frameReady && !confirmed,
            selected: selected,
            onToggle: (url) => setState(() {
              if (_frameSignature != signature) {
                _selectedFrames = {...selected};
                _frameSignature = signature;
              }
              if (selected.contains(url)) {
                _selectedFrames!.remove(url);
              } else {
                _selectedFrames!.add(url);
              }
            }),
          ),
          SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              // 拍板权在人：仅当候选 + 帧格勾选就绪才亮按钮
              onPressed: (frameReady &&
                      selected.isNotEmpty &&
                      !confirmed &&
                      !_busy)
                  ? () async {
                      setState(() => _busy = true);
                      try {
                        final sel = <Map<String, dynamic>>[
                          for (final f in shownFrames)
                            if (selected.contains(f.url))
                              {
                                'url': f.url,
                                if (f.score != null) 'score': f.score,
                                'sel': true
                              },
                        ];
                        final ok = await n.confirmCastFrames(
                            castImageUrl: pickedUrl, frameSel: sel);
                        if (!mounted) return;
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                            content: Text(ok
                                ? '已拍板固化 ${sel.length} 个角度帧，去下一步'
                                : '拍板未生效（帧数据或定妆照未就绪），稍后再试')));
                        if (ok) {
                          ref
                              .read(
                                  mvProjectDetailProvider(project.id).notifier)
                              .refresh(quiet: true);
                        }
                      } finally {
                        if (mounted) setState(() => _busy = false);
                      }
                    }
                  : null,
              icon: confirmed
                  ? Icon(Icons.verified_outlined, size: 18)
                  : Icon(Icons.lock_outline, size: 18),
              label: Text(confirmed
                  ? '已拍板固化（${selected.isEmpty ? '帧已固化' : '${selected.length} 帧'}）'
                  : frameReady
                      ? '拍板固化选定的角度'
                      : '拍板固化（待帧格就绪）'),
            ),
          ),
          SizedBox(height: 8),
          Text(
            '诚实提示：后台定妆链路未回传前，本页保持等待态；不会伪造定妆结果。',
            style: TextStyle(fontSize: 11, color: context.mvTextMuted),
          ),
        ],
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text,
        style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: context.mvTextSecondary));
  }
}

class _WaitBanner extends StatelessWidget {
  const _WaitBanner({required this.text, required this.busy});
  final String text;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final color = busy ? context.mvWarning : context.mvSuccess;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .07),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: .3)),
      ),
      child: Row(
        children: [
          if (busy)
            SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                    strokeWidth: 2, color: context.mvWarning))
          else
            Icon(Icons.check_circle_outline, size: 16, color: color),
          SizedBox(width: 10),
          Expanded(
              child: Text(mvHuman(text),
                  style: TextStyle(fontSize: 12, color: color, height: 1.4))),
        ],
      ),
    );
  }
}

/// 单个候选位：有 url 渲染图（可点选），否则等待占位
/// 定妆候选的身份相似度通过线（SP-MV-3 量化口径，与判词 V14-① 的 `≥0.6` 同源）。
/// 改这里必须同时改 `test/acceptance/v14_mv_instrumental.test.js` 的过门线 —— 否则界面说
/// "过门"而判词说"没过"，两边各说各话，等于没有这条线。
const double kMvCastGateLine = 0.6;

/// 候选格子上的相似度角标：过线绿、未过线黄、**没打分写「未验」**（灰）。
class _ScoreBadge extends StatelessWidget {
  const _ScoreBadge({this.score});
  final double? score;

  @override
  Widget build(BuildContext context) {
    final s = score;
    final passed = s != null && s >= kMvCastGateLine;
    final color = s == null
        ? context.mvTextMuted
        : (passed ? context.mvSuccess : context.mvWarning);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: .55),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        s == null ? '未验' : '${(s * 100).round()}',
        style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: color),
      ),
    );
  }
}

class _CandidateTile extends StatelessWidget {
  const _CandidateTile(
      {required this.index,
      required this.url,
      required this.selected,
      this.score,
      this.onTap,
      this.onPreview});
  final int index;
  final String? url;
  final bool selected;

  /// facegate 与主角脸对照出的相似度（0~1）；null = 本轮没打分（未验脸）
  final double? score;
  final VoidCallback? onTap;
  final VoidCallback? onPreview;

  @override
  Widget build(BuildContext context) {
    final has = (url ?? '').isNotEmpty;
    return Semantics(
      button: true,
      selected: selected,
      label: '定妆照候选 ${index + 1}'
      '${score == null ? '，未验脸' : '，相似度 ${(score! * 100).round()}%'}'
      '${selected ? '，已选中' : ''}',
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: AspectRatio(
          aspectRatio: 2 / 3,
          child: Container(
            decoration: BoxDecoration(
              color: context.mvSurfaceRaised.withValues(alpha: .04),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                  color: selected
                      ? Theme.of(context).colorScheme.primary
                      : context.mvBorder,
                  width: selected ? 2 : 1),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              fit: StackFit.expand,
              children: [
                has
                    ? MvNetworkImage(
                        url: url!,
                        cacheWidth: 260,
                        semanticLabel: '定妆照候选 ${index + 1}')
                    : _waiting(context, first: index == 0 && !has),
                if (has)
                  Positioned(
                    left: 4,
                    top: 4,
                    // 相似度角标：让用户挑「最像主角的那张」而不是凭眼缘猜。
                    // 没打分必须明写「未验」——留白会被读成 0 分或被无视，那还是藏信息。
                    child: _ScoreBadge(score: score),
                  ),
                if (selected)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Icon(Icons.check_circle_rounded,
                        size: 16, color: context.mvSuccess),
                  ),
                if (has && onPreview != null)
                  Positioned(
                    right: 3,
                    bottom: 3,
                    child: MvZoomButton(onPressed: onPreview!),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _waiting(BuildContext context, {required bool first}) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (first)
            SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2))
          else
            Icon(Icons.portrait_outlined, size: 18, color: context.mvTextMuted),
          SizedBox(height: 6),
          Text(first ? '生成中' : '待生成',
              style: TextStyle(fontSize: 10, color: context.mvTextMuted)),
        ],
      ),
    );
  }
}

/// 13 帧格：机检帧就绪后可勾选（过门帧默认选中）；未就绪整体禁用
class _FrameGrid extends StatelessWidget {
  const _FrameGrid({
    required this.frames,
    required this.enabled,
    required this.selected,
    required this.onToggle,
  });
  final List<MvFrame> frames;
  final bool enabled;
  final Set<String> selected;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, constraints) => GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: mvFrameColumns(constraints.maxWidth),
            childAspectRatio: 0.68,
            crossAxisSpacing: 8,
            mainAxisSpacing: 8,
          ),
          itemCount: StepLook.kFrameCells,
          itemBuilder: (ctx, i) {
            if (i >= frames.length) {
              return ExcludeSemantics(
                child: Opacity(
                  opacity: 0.45,
                  child: Container(
                    decoration: BoxDecoration(
                      color: context.mvSurfaceRaised.withValues(alpha: 0.04),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: context.mvBorder),
                    ),
                    child: Center(
                      child: Text('${i + 1}',
                          style: TextStyle(
                              fontSize: 11, color: context.mvTextMuted)),
                    ),
                  ),
                ),
              );
            }
            final f = frames[i];
            final sel = selected.contains(f.url);
            return Semantics(
              button: true,
              selected: sel,
              enabled: enabled,
              label: '第 ${i + 1} 个角度帧${sel ? '，已勾选' : ''}',
              hint: enabled ? '点击勾选，放大按钮查看大图' : '帧格已固化',
              child: Opacity(
                opacity: enabled ? 1 : 0.45,
                child: GestureDetector(
                  onTap: enabled ? () => onToggle(f.url) : null,
                  child: Container(
                    decoration: BoxDecoration(
                      color: context.mvSurfaceRaised.withValues(alpha: 0.04),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                          color:
                              sel ? context.mvColors.primary : context.mvBorder,
                          width: sel ? 2 : 1),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        MvNetworkImage(
                            url: f.url,
                            cacheWidth: 180,
                            semanticLabel: '第 ${i + 1} 个角度帧'),
                        Positioned(
                          left: 0,
                          right: 0,
                          bottom: 0,
                          child: Container(
                            color:
                                context.mvColors.scrim.withValues(alpha: 0.62),
                            padding: const EdgeInsets.symmetric(
                                horizontal: 4, vertical: 1),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text('${i + 1}',
                                    style: TextStyle(
                                        fontSize: 8.5,
                                        color: context.mvOnScrim)),
                                if (f.score != null)
                                  Text(f.score!.toStringAsFixed(2),
                                      style: TextStyle(
                                          fontSize: 8.5,
                                          color: context.mvOnScrim)),
                              ],
                            ),
                          ),
                        ),
                        if (sel)
                          Positioned(
                              top: 2,
                              left: 2,
                              child: Icon(Icons.check_circle,
                                  size: 12, color: context.mvSuccess)),
                        Positioned(
                          top: 1,
                          right: 1,
                          child: MvZoomButton(
                            label: '放大第 ${i + 1} 帧',
                            onPressed: () => showMvImagePreview(context,
                                url: f.url, title: '角度帧 ${i + 1}'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      );
}
