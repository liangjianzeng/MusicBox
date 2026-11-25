import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/state.dart';
import '../../../core/ws_client.dart';
import '../mv_models.dart';
import '../mv_progress_page.dart';
import '../mv_state.dart';
import '../widgets/mv_common.dart';
import '../widgets/mv_theme.dart';
import '../widgets/mv_video_player.dart';

/// 步⑤ 样片 → 报价 → 开机（S7 流程硬门禁：样片先行，「开机开拍」永远手动）。
/// 报价卡数据源 = GET detail 的 project.est / est_ver（mv_preview 完成时生成）；
/// boot{est_ver} 走报价 CAS：409 EST_STALE → 刷新报价卡并请你重新拍板；
/// 402 BUDGET_EXCEEDED / CREDITS_NOT_ENOUGH 给诚实对话（人工调预算 / 退未拍镜）。
class StepBoot extends ConsumerStatefulWidget {
  const StepBoot({super.key, required this.workId});
  final String? workId;

  @override
  ConsumerState<StepBoot> createState() => _StepBootState();
}

class _StepBootState extends ConsumerState<StepBoot> {
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;
  bool _booting = false;

  @override
  void initState() {
    super.initState();
    // 样片产出期间 5s 静默轮询，WSS 完成事件立即刷新。
    _poll = Timer.periodic(const Duration(seconds: 5), (_) async {
      if (!mounted) return;
      final p = _project();
      if (p == null) return;
      final detail = ref.read(mvProjectDetailProvider(p.id)).detail;
      final live = detail?.project ?? p;
      if ((live.previewUrl ?? '').isNotEmpty || !live.hasScript) return;
      await ref
          .read(mvProjectDetailProvider(p.id).notifier)
          .refresh(quiet: true);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final projectId = _project()?.id;
      if (projectId == null) return;
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
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _wsSub?.cancel();
    super.dispose();
  }

  MvProject? _project() {
    final st = ref.read(mvWizardProvider(widget.workId));
    return st.project;
  }

  void _toast(String t) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(mvUserVisibleText(t))));
  }

  Future<void> _makePreview(MvProjectDetailNotifier n) async {
    if (_booting) return;
    setState(() => _booting = true);
    try {
      final (ok, err, _) = await n.requestPreview();
      _toast(ok ? '样片任务已提交，约 1–2 分钟' : (err ?? '样片提交失败，请重试'));
    } finally {
      if (mounted) setState(() => _booting = false);
    }
  }

  Future<void> _bootFlow(
      BuildContext context, MvProjectDetailNotifier n, MvProject p) async {
    final est = p.est;
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('确认开机开拍'),
        content: Text(
          '开机后立即进入拍摄队列（分钟级异步工程，可离开 App）。\n'
          '本次拍摄 ${est?.shots ?? '--'} 镜 · 预计 ${est?.minutes ?? '--'} 分钟。',
          style: TextStyle(fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false), child: Text('再看看')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true), child: Text('拍板开机')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _booting = true);
    final r = await n.boot(p.estVer ?? '');
    if (!mounted) return;
    setState(() => _booting = false);
    if (!context.mounted) return;
    switch (r.code) {
      case 'OK':
        _toast(r.jobs > 0
            ? '已开机开拍，${r.jobs} 镜进队列'
            : '已确认开机，剧组将按计划制作');
      case 'EST_STALE':
        // 快照失配：刷新服务端状态，请用户核对新的拍摄计划后重新拍板。
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text('开机信息已更新'),
            content: Text(
              '剧本或镜数有变化，已为你刷新拍摄计划，'
              '请核对后再点「开机开拍」。',
              style: TextStyle(fontSize: 13, height: 1.5),
            ),
            actions: [
              FilledButton(
                  onPressed: () => Navigator.pop(ctx), child: Text('好的')),
            ],
          ),
        );
      case 'NOT_READY':
        _toast(r.message ?? '请先出样片，再开机');
      case 'BUDGET_EXCEEDED':
      case 'CREDITS_NOT_ENOUGH':
        _toast('暂时无法开机，请稍后重试');
      default:
        _toast(r.message ?? '开机失败，请稍后重试');
    }
  }

  @override
  Widget build(BuildContext context) {
    final wizard = ref.watch(mvWizardProvider(widget.workId));
    final p = wizard.project;
    if (p == null) {
      return Center(
          child:
              Text('请先完成前面的确认门', style: TextStyle(color: context.mvTextMuted)));
    }
    final detailState = ref.watch(mvProjectDetailProvider(p.id));
    final detail = detailState.detail;
    final n = ref.read(mvProjectDetailProvider(p.id).notifier);
    final live = detail?.project ?? p; // 以服务端最新状态为准
    final est = live.est;
    final previewUrl = live.previewUrl ?? '';
    final hasPreview = previewUrl.isNotEmpty;
    final canBoot = live.canBootGate &&
        (live.estVer ?? '').isNotEmpty &&
        !live.paused &&
        (detail?.shots.isNotEmpty ?? false);

    return MvLeaveGuard(
      busy: _booting,
      message: '样片或开机仍在提交中。离开不会取消后台任务，'
          '但可能看不到本次执行回执。确定离开吗？',
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          Text('先看样片，再开机',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
          SizedBox(height: 4),
          Text('预览样片 = 分镜关键帧 × 已制曲混音（非正式画面），看完再确认开机。',
              style: TextStyle(fontSize: 11.5, color: context.mvTextMuted)),
          SizedBox(height: 12),
          // ---- 样片播放器（非正式角标） ----
          Stack(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: MvVideoPlayer(
                  url: hasPreview ? previewUrl : null,
                  coverUrl: live.coverUrl,
                  aspectRatio: 9 / 16,
                  placeholderHint:
                      hasPreview ? '样片暂不可播（片源或服务异常）' : '还没有样片 —— 点下方按钮出片',
                ),
              ),
              if (hasPreview)
                Positioned(
                  top: 8,
                  left: 8,
                  child: _InformalBadge(),
                ),
            ],
          ),
          SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: live.hasScript && !live.ready
                      ? () => _makePreview(n)
                      : null,
                  icon: Icon(Icons.movie_outlined, size: 16),
                  label: Text(hasPreview ? '重出样片' : '出样片',
                      style: TextStyle(fontSize: 12)),
                ),
              ),
            ],
          ),
          if (!live.hasScript)
            Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('还没有剧本/分镜：回到上一步先「生成分镜」，样片需要先有镜头。',
                  style: TextStyle(fontSize: 11, color: context.mvTextMuted)),
            )
          else if (!hasPreview)
            Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text(
                  '还没有样片：点上方「出样片」派单；执行器合片约 1–2 分钟，'
                  '完成后本页自动出现样片与拍摄计划。',
                  style: TextStyle(fontSize: 11, color: context.mvTextMuted)),
            )
          else if (!live.canBootGate)
            const _WaitNote(text: '样片已出，拍摄计划生成中。'),
          SizedBox(height: 16),
          // ---- 拍摄计划 ----
          _EstCard(est: est),
          SizedBox(height: 16),
          // ---- 开机开拍（永远手动） ----
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: canBoot && !_booting
                  ? () => _bootFlow(context, n, live)
                  : null,
              icon: _booting
                  ? SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : Icon(Icons.rocket_launch_outlined, size: 18),
              label: Text(live.status == 'failed'
                  ? '重新开机恢复'
                  : live.statusRank >= 4
                      ? '剧组已进场（拍摄中）'
                      : '开机开拍'),
            ),
          ),
          if ((live.estVer ?? '').isEmpty && live.hasScript)
            Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('拍摄计划会在样片产出时生成 —— 没看样片之前不开机，这是产品纪律。',
                  style: TextStyle(fontSize: 11, color: context.mvTextMuted)),
            ),
          if (live.paused)
            Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('制作已暂停，请稍后重试。',
                  style: TextStyle(fontSize: 11, color: context.mvWarning)),
            ),
          SizedBox(height: 10),
          if (live.statusRank >= 4)
            OutlinedButton.icon(
              onPressed: () => MvProgressPage.push(context, projectId: p.id),
              icon: Icon(Icons.dashboard_outlined, size: 16),
              label: Text('去剧组通告板看进度'),
            ),
        ],
      ),
    );
  }
}

/// 「非正式画面」角标（样片水印的页侧提示；成片不挂）
class _InformalBadge extends StatelessWidget {
  const _InformalBadge();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: context.mvColors.scrim.withValues(alpha: .55),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: context.mvOnScrim.withValues(alpha: .6)),
      ),
      child: Text('预览样片 · 非正式画面',
          style:
              TextStyle(fontSize: 10, color: context.mvOnScrim, height: 1.2)),
    );
  }
}

class _WaitNote extends StatelessWidget {
  const _WaitNote({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: context.mvWarning.withValues(alpha: .06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.mvWarning.withValues(alpha: .25)),
      ),
      child: Row(
        children: [
          SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(
                  strokeWidth: 2, color: context.mvWarning)),
          SizedBox(width: 10),
          Expanded(
              child: Text(text,
                  style: TextStyle(
                      fontSize: 11.5, color: context.mvWarning, height: 1.4))),
        ],
      ),
    );
  }
}

/// 拍摄计划（预计分钟数与镜数；费用字段保留在模型中，但不在用户面呈现）。
class _EstCard extends StatelessWidget {
  const _EstCard({required this.est});
  final MvEst? est;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final e = est;
    final hasPlan = e != null && (e.shots > 0 || e.minutes > 0);
    // 旧数据可能只回传费用而没有拍摄计划；此时整卡直接隐藏。
    if (e != null && !hasPlan) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        color: scheme.primaryContainer.withValues(alpha: .07),
        border: Border.all(
            color: hasPlan
                ? scheme.primary.withValues(alpha: .4)
                : context.mvBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('拍摄计划',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
          SizedBox(height: 10),
          if (!hasPlan)
            Text(
              '拍摄计划生成中，样片完成后即可确认开机。',
              style: TextStyle(
                  fontSize: 12, color: context.mvTextMuted, height: 1.5),
            )
          else
            Text(
              '预计 ${e.minutes > 0 ? e.minutes : '--'} 分钟 · '
              '拍 ${e.shots} 镜'
              '${e.lipsync > 0 ? '（含 ${e.lipsync} 镜对口型）' : ''}',
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: scheme.primary),
            ),
        ],
      ),
    );
  }
}
