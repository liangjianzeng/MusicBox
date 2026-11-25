import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../mv_models.dart';
import '../mv_state.dart';
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
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final wizard = ref.watch(mvWizardProvider(widget.workId));
    final n = ref.read(mvWizardProvider(widget.workId).notifier);
    final project = wizard.project;
    if (project == null) {
      return const Center(
          child: Text('请先在步②确认主演',
              style: TextStyle(color: Colors.white38)));
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
          !(character?.castImages ?? const []).contains(character!.castImageUrl))
        character.castImageUrl!,
    ];
    final pickedUrl = _pickedCast != null && _pickedCast! < castImages.length
        ? castImages[_pickedCast!]
        : (character?.castImageUrl ?? '');
    final castVideo = character?.castVideoUrl ?? '';
    // 帧格：机检回传帧按分排序（高分在前），上限 13 格；pass 帧默认勾选
    final frames = [...?character?.frames]
      ..sort((a, b) =>
          (b.score ?? -1).compareTo(a.score ?? -1));
    final shownFrames = frames.take(StepLook.kFrameCells).toList();
    final frameReady = shownFrames.isNotEmpty;
    _selectedFrames ??= {
      for (final f in shownFrames)
        if (f.pass) f.url,
    };
    final selected = _selectedFrames!
        .where((u) => shownFrames.any((f) => f.url == u))
        .toSet();
    final confirmed = character?.confirmed == true || wizard.lookConfirmed;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      children: [
        // 诚实横幅
        _WaitBanner(
            text: detailState.error ??
                wizard.jobNote ??
                '定妆照任务已提交，等待剧组出图（约 15 秒/张 ×3）。'),
        const SizedBox(height: 12),
        const _Label('定妆照候选 · 3 张（点选一张做主演定妆）'),
        const SizedBox(height: 8),
        Row(
          children: [
            for (var i = 0; i < 3; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              Expanded(
                child: _CandidateTile(
                  index: i,
                  url: i < castImages.length ? castImages[i] : null,
                  selected: castImages.isNotEmpty &&
                      ((pickedUrl.isNotEmpty &&
                              i < castImages.length &&
                              castImages[i] == pickedUrl) ||
                          (pickedUrl.isEmpty && _pickedCast == null && i == 0)),
                  onTap: castImages.isEmpty || confirmed
                      ? null
                      : () => setState(() {
                            _pickedCast = i;
                            _selectedFrames = null; // 换定妆照后帧格重新预选
                          }),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 8),
        // 拍定妆视频（cast_video：约 5 秒多角度转头，~5 分钟）
        if (!confirmed && (castVideo.isEmpty || _pickedCast != null))
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: (_busy || pickedUrl.isEmpty || castVideo.isNotEmpty)
                  ? null
                  : () async {
                      setState(() => _busy = true);
                      final err = await n.dispatchCastVideo(pickedUrl);
                      if (!mounted) return;
                      setState(() => _busy = false);
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                          content: Text(err ?? '定妆视频任务已提交，约需 5 分钟')));
                      ref
                          .read(mvProjectDetailProvider(project.id).notifier)
                          .refresh(quiet: true);
                    },
              icon: _busy
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.videocam, size: 16),
              label: Text(castVideo.isEmpty ? '用这张拍定妆视频' : '重新拍定妆视频',
                  style: const TextStyle(fontSize: 12.5)),
            ),
          ),
        const SizedBox(height: 12),
        const _Label('定妆视频（多角度转头 · 约 5 秒）'),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: MvVideoPlayer(
            url: castVideo.isEmpty ? null : castVideo,
            coverUrl: pickedUrl.isEmpty ? null : pickedUrl,
            aspectRatio: 9 / 16,
            placeholderHint: '定妆视频待执行器出片后显示',
          ),
        ),
        const SizedBox(height: 16),
        const _Label('满意角度帧格 · 13 帧（勾选后拍板固化）'),
        const SizedBox(height: 4),
        Text(frameReady
            ? '高分帧在前，过门帧已默认勾选；只按「更像你」排序，不评美丑。'
            : '定妆视频产出后，逐帧评分自动填入帧格（机检回传，未回传前如实禁用）。',
            style: const TextStyle(fontSize: 11, color: Colors.white24)),
        const SizedBox(height: 8),
        _FrameGrid(
          frames: shownFrames,
          enabled: frameReady && !confirmed,
          selected: selected,
          onToggle: (url) => setState(() {
            if (selected.contains(url)) {
              _selectedFrames!.remove(url);
            } else {
              _selectedFrames!.add(url);
            }
          }),
        ),
        const SizedBox(height: 14),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            // 拍板权在人：仅当候选 + 帧格勾选就绪才亮按钮
            onPressed: (frameReady && selected.isNotEmpty && !confirmed && !_busy)
                ? () async {
                    setState(() => _busy = true);
                    final sel = <Map<String, dynamic>>[
                      for (final f in shownFrames)
                        if (selected.contains(f.url))
                          {'url': f.url, if (f.score != null) 'score': f.score, 'sel': true},
                    ];
                    final ok = await n.confirmCastFrames(
                        castImageUrl: pickedUrl, frameSel: sel);
                    if (!mounted) return;
                    setState(() => _busy = false);
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                        content: Text(ok
                            ? '已拍板固化 ${sel.length} 个角度帧，去下一步'
                            : '拍板未生效（帧数据或定妆照未就绪），稍后再试')));
                    if (ok) {
                      ref
                          .read(mvProjectDetailProvider(project.id).notifier)
                          .refresh(quiet: true);
                    }
                  }
                : null,
            icon: confirmed
                ? const Icon(Icons.verified_outlined, size: 18)
                : const Icon(Icons.lock_outline, size: 18),
            label: Text(confirmed
                ? '已拍板固化（${selected.isEmpty ? '帧已固化' : '${selected.length} 帧'}）'
                : frameReady
                    ? '拍板固化选定的角度'
                    : '拍板固化（待帧格就绪）'),
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          '诚实提示：后台定妆链路未回传前，本页保持等待态；不会伪造定妆结果。',
          style: TextStyle(fontSize: 11, color: Colors.white24),
        ),
      ],
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text,
        style: const TextStyle(
            fontSize: 13, fontWeight: FontWeight.w700, color: Colors.white70));
  }
}

class _WaitBanner extends StatelessWidget {
  const _WaitBanner({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: Colors.amber.withValues(alpha: .07),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.amber.withValues(alpha: .3)),
      ),
      child: Row(
        children: [
          const SizedBox(
              width: 14,
              height: 14,
              child:
                  CircularProgressIndicator(strokeWidth: 2, color: Colors.amber)),
          const SizedBox(width: 10),
          Expanded(
              child: Text(mvHuman(text),
                  style: const TextStyle(
                      fontSize: 12, color: Colors.amberAccent, height: 1.4))),
        ],
      ),
    );
  }
}

/// 单个候选位：有 url 渲染图（可点选），否则等待占位
class _CandidateTile extends StatelessWidget {
  const _CandidateTile(
      {required this.index, required this.url, required this.selected, this.onTap});
  final int index;
  final String? url;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final has = (url ?? '').isNotEmpty;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: AspectRatio(
        aspectRatio: 2 / 3,
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: .04),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
                color: selected
                    ? Theme.of(context).colorScheme.primary
                    : Colors.white10,
                width: selected ? 2 : 1),
          ),
          clipBehavior: Clip.antiAlias,
          child: Stack(
            fit: StackFit.expand,
            children: [
              has
                  ? Image.network(url!,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => _waiting(first: false))
                  : _waiting(first: index == 0 && !has),
              if (selected)
                const Positioned(
                  top: 4,
                  right: 4,
                  child: Icon(Icons.check_circle_rounded,
                      size: 16, color: Colors.greenAccent),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _waiting({required bool first}) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (first)
            const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2))
          else
            const Icon(Icons.portrait_outlined, size: 18, color: Colors.white24),
          const SizedBox(height: 6),
          Text(first ? '生成中' : '待生成',
              style: const TextStyle(fontSize: 10, color: Colors.white24)),
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
  Widget build(BuildContext context) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 4,
        childAspectRatio: 0.68,
        crossAxisSpacing: 8,
        mainAxisSpacing: 8,
      ),
      itemCount: StepLook.kFrameCells,
      itemBuilder: (ctx, i) {
        if (i >= frames.length) {
          // 未回传的格子：如实灰显编号
          return IgnorePointer(
            child: Opacity(
              opacity: 0.45,
              child: Container(
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: .04),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.white10),
                ),
                child: Center(
                  child: Text('${i + 1}',
                      style:
                          const TextStyle(fontSize: 11, color: Colors.white12)),
                ),
              ),
            ),
          );
        }
        final f = frames[i];
        final sel = selected.contains(f.url);
        return Opacity(
          opacity: enabled ? 1 : 0.45,
          child: GestureDetector(
            onTap: enabled ? () => onToggle(f.url) : null,
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: .04),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                    color: sel
                        ? Theme.of(context).colorScheme.primary
                        : Colors.white10,
                    width: sel ? 2 : 1),
              ),
              clipBehavior: Clip.antiAlias,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Image.network(f.url,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const ColoredBox(
                          color: Colors.black26,
                          child: Center(
                              child: Icon(Icons.broken_image_outlined,
                                  size: 14, color: Colors.white24)))),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: Container(
                      color: Colors.black.withValues(alpha: .55),
                      padding:
                          const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('${i + 1}',
                              style: const TextStyle(
                                  fontSize: 8.5, color: Colors.white38)),
                          if (f.score != null)
                            Text(f.score!.toStringAsFixed(2),
                                style: TextStyle(
                                    fontSize: 8.5,
                                    color: (f.score! >= 0.6)
                                        ? Colors.greenAccent
                                        : Colors.orangeAccent)),
                        ],
                      ),
                    ),
                  ),
                  if (sel)
                    const Positioned(
                        top: 2,
                        right: 2,
                        child: Icon(Icons.check_circle,
                            size: 12, color: Colors.greenAccent)),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
