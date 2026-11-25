import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../shared/widgets/ai_badge.dart';
import 'mv_api_client.dart';
import 'mv_detail_page.dart';
import 'mv_list_state.dart';
import 'mv_models.dart';
import 'mv_progress_page.dart';
import 'widgets/mv_common.dart';
import 'widgets/mv_network_image.dart';
import 'widgets/mv_task_chip.dart';
import 'widgets/mv_theme.dart';
import 'widgets/mv_video_player.dart';

/// MV 首映礼揭晓页（mv-plan §3 步⑥ / §2.3 宪法第 6 条「抽卡仪式感」）：
/// 拉幕入场动画（~1.2s，复用一期揭晓页的仪式化 AnimatedSwitcher 语言，
/// 这里化为片名+主演+海报的幕布拉开+淡入，轻点随时跳过）→ 9:16 海报先行
/// → 「看成片」内联自动播放（复用 MvVideoPlayer）→「去详情」。
/// 诚实纪律：项目未 ready / 片源缺失 / 服务端未上线（MV_NOT_READY）一律
/// 如实占位 + 人话说明，绝不伪造画面、绝不回退假数据。
class MvRevealPage extends ConsumerStatefulWidget {
  const MvRevealPage({super.key, required this.mvId});
  final String mvId;

  static void push(BuildContext context, {required String mvId}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MvRevealPage(mvId: mvId),
    ));
  }

  @override
  ConsumerState<MvRevealPage> createState() => _MvRevealPageState();
}

class _MvRevealPageState extends ConsumerState<MvRevealPage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  bool _loading = true;
  String? _error;
  Map? _raw;
  bool _showCurtain = false;
  bool _entranceDone = false;
  bool _playing = false; // 海报先行，点「看成片」后挂载播放器并自动开播

  MvApiClient get _api => ref.read(mvApiClientProvider);

  MvProject? get _project {
    final m = _raw?['mv'];
    return m is Map ? MvProject.fromMap(m) : null;
  }

  Work? get _parent {
    final p = _raw?['parent_work'];
    return p is Map ? Work.fromMap(p) : null;
  }

  List<Map> get _cast {
    final m = _raw?['mv'];
    if (m is! Map) return const [];
    return (m['cast'] as List? ?? const []).whereType<Map>().toList();
  }

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 1200));
    _ctrl.addStatusListener((s) {
      if (s == AnimationStatus.completed && !_entranceDone) {
        setState(() => _entranceDone = true);
      }
    });
    _load();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final m = await _api.mvDetail(widget.mvId);
      if (!mounted) return;
      final project = MvProject.fromMap((m['mv'] as Map?) ?? const {});
      // 只有真 ready 且有片源/海报可展示时才举办首映礼（拉幕）
      final playable = project.ready &&
          ((project.videoUrl ?? '').isNotEmpty ||
              (project.coverUrl ?? '').isNotEmpty);
      setState(() {
        _raw = m;
        _loading = false;
        if (playable) {
          _showCurtain = true;
          _entranceDone = false;
        }
      });
      if (playable) _ctrl.forward(from: 0);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = mvUserVisibleError(e); // MV_NOT_READY 等按域内诚实文案呈现
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载失败，请重试';
      });
    }
  }

  void _skipEntrance() {
    if (!_showCurtain || _entranceDone) return;
    _ctrl.animateTo(1, duration: const Duration(milliseconds: 160));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('MV 首映礼'),
        actions: [
          IconButton(
              onPressed: _load, icon: Icon(Icons.refresh), tooltip: '刷新'),
        ],
      ),
      body: _loading
          ? ListView(
              padding: const EdgeInsets.all(16),
              children: const [MvCardSkeleton(), MvCardSkeleton()],
            )
          : _error != null
              ? _offline(_error!)
              : _body(),
    );
  }

  Widget _body() {
    final p = _project;
    if (p == null) return _offline('MV 不存在，可能已被删除');
    final content = p.ready ? _readyBody(p) : _notReadyBody(p);
    if (!_showCurtain || _entranceDone) return content;
    // 拉幕入场：两侧幕布外撤 + 内容淡入（一期揭晓页仪式语言）
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, _) {
        final t = _ctrl.value;
        final open = Curves.easeInOutCubic.transform(t);
        final labelOp = (1 - t * 2.2).clamp(0.0, 1.0);
        final half = MediaQuery.of(context).size.width / 2 * (1 - open);
        final fadeIn =
            Curves.easeIn.transform(((t - 0.25) / 0.75).clamp(0.0, 1.0));
        return Stack(fit: StackFit.expand, children: [
          Opacity(opacity: fadeIn, child: content),
          Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              width: half,
              child: const _CurtainPanel(mirror: false)),
          Positioned(
              right: 0,
              top: 0,
              bottom: 0,
              width: half,
              child: const _CurtainPanel(mirror: true)),
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: _skipEntrance,
              child: IgnorePointer(
                child: Opacity(
                  opacity: labelOp,
                  child: Center(child: _curtainTitle(p)),
                ),
              ),
            ),
          ),
        ]);
      },
    );
  }

  Widget _curtainTitle(MvProject p) {
    final names = _cast
        .map((c) => mvHuman((c['name'] ?? '').toString()))
        .where((s) => s.isNotEmpty)
        .take(2)
        .join('、');
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('🎬', style: TextStyle(fontSize: 42)),
        SizedBox(height: 6),
        Text('首映礼',
            style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.w900,
                letterSpacing: 6,
                color: context.mvColors.onInverseSurface)),
        SizedBox(height: 10),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Text('《${p.title.isEmpty ? '未命名 MV' : p.title}》',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: context.mvColors.onInverseSurface)),
        ),
        if (names.isNotEmpty) ...[
          SizedBox(height: 4),
          Text('主演 $names',
              style: TextStyle(
                  fontSize: 12, color: context.mvColors.onInverseSurface)),
        ],
        SizedBox(height: 14),
        const AiBadge(),
        SizedBox(height: 26),
        Text('轻点屏幕跳过',
            style: TextStyle(
                fontSize: 11, color: context.mvColors.onInverseSurface)),
      ],
    );
  }

  // ---------- 就绪：海报先行 → 内联自动播放 ----------

  Widget _readyBody(MvProject p) {
    final video = (p.videoUrl ?? '').isEmpty ? null : p.videoUrl;
    final parent = _parent;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 320, maxHeight: 566),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: _stage(p, video),
            ),
          ),
        ),
        SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: Text(
                p.title.isEmpty ? '未命名 MV' : p.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
              ),
            ),
            const AiBadge(),
          ],
        ),
        SizedBox(height: 4),
        Text(
          [
            mvKindLabel(p.kind),
            if (p.durationSec > 0) mvFormatDuration(p.durationSec),
          ].join(' · '),
          style: TextStyle(fontSize: 11.5, color: context.mvTextMuted),
        ),
        SizedBox(height: 12),
        // 母 work 谱系卡（只呈现标题，诚实：不存在就说不存在）
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: context.mvSurfaceRaised.withValues(alpha: .03),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: context.mvBorder),
          ),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  gradient: LinearGradient(colors: [
                    Theme.of(context).colorScheme.primary.withValues(alpha: .5),
                    Theme.of(context)
                        .colorScheme
                        .tertiary
                        .withValues(alpha: .35),
                  ]),
                ),
                child: Center(
                    child: Icon(Icons.music_note,
                        size: 17, color: context.mvTextPrimary)),
              ),
              SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('母作品',
                        style: TextStyle(
                            fontSize: 10.5, color: context.mvTextMuted)),
                    SizedBox(height: 2),
                    Text(
                      parent == null
                          ? '母作品已不存在（成片不受影响）'
                          : (parent.title.isEmpty ? '未命名作品' : parent.title),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 13.5, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                // 看成片 = 内联放映：海报先行的舞台挂载 MvVideoPlayer 并自动开播
                onPressed: video == null
                    ? null
                    : () => setState(() => _playing = true),
                icon: Icon(Icons.play_circle_outline, size: 18),
                label: Text(_playing ? '正在放映' : '看成片',
                    style: TextStyle(fontSize: 13.5)),
              ),
            ),
            SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => MvDetailPage.push(context, mvId: widget.mvId),
                icon: Icon(Icons.movie_filter_outlined, size: 18),
                label: Text('去详情', style: TextStyle(fontSize: 13.5)),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// 9:16 舞台：海报先行（未点放映前不加载视频），点开后自动播放
  Widget _stage(MvProject p, String? video) {
    if (_playing) {
      return MvVideoPlayer(
        url: video,
        coverUrl: p.coverUrl,
        aspectRatio: 9 / 16,
        autoPlay: true,
        placeholderHint: '成片暂不可播（片源或服务异常，可去详情重试）',
      );
    }
    return Semantics(
      label: p.title.isEmpty ? 'MV 海报' : '${p.title} 海报',
      hint: video == null ? '片源暂不可用' : '点击播放成片',
      child: AspectRatio(
        aspectRatio: 9 / 16,
        child: GestureDetector(
          onTap: video == null ? null : () => setState(() => _playing = true),
          child: Stack(
            fit: StackFit.expand,
            children: [
              if ((p.coverUrl ?? '').isNotEmpty)
                MvNetworkImage(
                    url: p.coverUrl!,
                    cacheWidth: 720,
                    semanticLabel: p.title.isEmpty ? 'MV 海报' : '${p.title} 海报')
              else
                _posterFallback(),
              Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                        video == null
                            ? Icons.videocam_off_outlined
                            : Icons.play_circle_outline,
                        size: 46,
                        color: context.mvColors.onInverseSurface),
                    SizedBox(height: 8),
                    Text(
                      video == null ? '还没有可播的片源（可去详情或刷新重试）' : '点击放映 · 自动播放',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          fontSize: 12,
                          color: context.mvColors.onInverseSurface),
                    ),
                  ],
                ),
              ),
              Positioned(top: 8, right: 8, child: AiBadge(small: true)),
              if ((p.coverUrl ?? '').isNotEmpty)
                Positioned(
                  top: 6,
                  left: 6,
                  child: MvZoomButton(
                    label: '放大 MV 海报',
                    onPressed: () => showMvImagePreview(context,
                        url: p.coverUrl!,
                        title: p.title.isEmpty ? 'MV 海报' : p.title),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _posterFallback() {
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            context.mvColors.inverseSurface,
            context.mvColors.inverseSurface.withValues(alpha: 0.82),
          ],
        ),
      ),
      child: SizedBox.expand(),
    );
  }

  // ---------- 未就绪 / 离线：诚实占位，不办首映礼 ----------

  Widget _notReadyBody(MvProject p) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.local_movies_outlined,
                size: 40, color: context.mvTextMuted),
            SizedBox(height: 12),
            Text(
              '《${p.title.isEmpty ? '未命名 MV' : p.title}》还在制作中，'
              '成片就绪后才能举办首映礼。',
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 13, color: context.mvTextSecondary, height: 1.5),
            ),
            SizedBox(height: 10),
            MvProjectChip(status: p.status),
            SizedBox(height: 14),
            OutlinedButton.icon(
              onPressed: () => MvProgressPage.push(context, projectId: p.id),
              icon: Icon(Icons.local_activity_outlined, size: 18),
              label: Text('看进度'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _offline(String text) => MvErrorView(
      text: text, onRetry: _load, icon: Icons.movie_filter_outlined);
}

/// 幕布半幅（剧场红绒质感，缝边亮线；随拉幕动画由页面控制宽度外撤）
class _CurtainPanel extends StatelessWidget {
  const _CurtainPanel({required this.mirror});
  final bool mirror;

  @override
  Widget build(BuildContext context) {
    final colors = mirror
        ? [
            context.mvColors.inverseSurface,
            context.mvColors.inverseSurface.withValues(alpha: 0.72),
          ]
        : [
            context.mvColors.inverseSurface.withValues(alpha: 0.72),
            context.mvColors.inverseSurface,
          ];
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: colors),
        border: Border(
          right: mirror ? BorderSide.none : BorderSide(color: context.mvBorder),
          left: mirror ? BorderSide(color: context.mvBorder) : BorderSide.none,
        ),
      ),
      child: const SizedBox.expand(),
    );
  }
}
