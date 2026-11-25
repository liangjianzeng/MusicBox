import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../mv_models.dart';
import '../mv_progress_page.dart';
import '../mv_state.dart';
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
  bool _booting = false;

  @override
  void initState() {
    super.initState();
    // 样片产出期间 5s 静默轮询（出片后自动停）
    _poll = Timer.periodic(const Duration(seconds: 5), (_) async {
      final p = _project();
      if (p == null) return;
      if ((p.previewUrl ?? '').isNotEmpty || !p.hasScript) return;
      if (!mounted) return;
      await ref
          .read(mvProjectDetailProvider(p.id).notifier)
          .refresh(quiet: true);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  MvProject? _project() {
    final st = ref.read(mvWizardProvider(widget.workId));
    return st.project;
  }

  void _toast(String t) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));
  }

  Future<void> _makePreview(MvProjectDetailNotifier n) async {
    final (ok, err, charged) = await n.requestPreview();
    _toast(ok
        ? (charged > 0
            ? '样片重出任务已提交（扣 $charged ⚡，首个免费已用掉）'
            : '样片任务已提交（本次免费），约 1–2 分钟')
        : (err ?? '样片提交失败，请重试'));
  }

  Future<void> _bootFlow(
      BuildContext context, MvProjectDetailNotifier n, MvProject p) async {
    final est = p.est;
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('确认开机开拍'),
        content: Text(
          '开机后立即进入拍摄队列（分钟级异步工程，可离开 App）。\n'
          '本次按报价卡执行：拍 ${est?.shots ?? '--'} 镜 · '
          '约 ${est?.credits ?? '--'} ⚡ · 预计 ${est?.minutes ?? '--'} 分钟。\n'
          '未拍镜取消可全额退。',
          style: const TextStyle(fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('再看看')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('拍板开机')),
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
        _toast(r.charged > 0
            ? '已开机开拍（扣 ${r.charged} ⚡，${r.jobs} 镜进队列）'
            : '已确认开机（幂等命中，未重复扣分）');
      case 'EST_STALE':
        // 报价 CAS 失配：刷新报价卡，请用户看新报价后重新拍板
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('报价已更新'),
            content: const Text(
              '剧本或镜数有变化，这份报价已过期。已为你刷新报价卡，'
              '请核对新报价后再点「开机开拍」。',
              style: TextStyle(fontSize: 13, height: 1.5),
            ),
            actions: [
              FilledButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('好的')),
            ],
          ),
        );
      case 'NOT_READY':
        _toast(r.message ?? '请先出样片与报价，再开机');
      case 'BUDGET_EXCEEDED':
        await _budgetDialog(context, n, p);
      case 'CREDITS_NOT_ENOUGH':
        await _creditsDialog(context, n, p);
      default:
        _toast(r.message ?? '开机失败，请稍后重试');
    }
  }

  /// 预算护栏（v2.11）：paused 后唯一恢复通道 = 人工调高预算（PATCH ver CAS）
  Future<void> _budgetDialog(
      BuildContext context, MvProjectDetailNotifier n, MvProject p) async {
    final need = ((p.est?.credits ?? p.creditsCost) * 1.25).ceil();
    final ctrl =
        TextEditingController(text: (need ~/ 50 * 50).clamp(50, 999999).toString());
    final newBudget = await showDialog<int>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('预算护栏已触发'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '本次开机将超出项目预算（${p.budgetCredits} ⚡）的 120%，'
              '已自动暂停计费派单。仅可人工调高预算恢复（不自动恢复）。',
              style: const TextStyle(fontSize: 12.5, height: 1.5),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: ctrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                  labelText: '新预算（⚡）', isDense: true),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('先不拍')),
          FilledButton(
              onPressed: () =>
                  Navigator.pop(ctx, int.tryParse(ctrl.text.trim())),
              child: const Text('调高预算')),
        ],
      ),
    );
    if (newBudget == null || newBudget <= 0) return;
    final err = await n.raiseBudget(newBudget);
    _toast(err ?? '预算已调高到 $newBudget ⚡，护栏解除，可重新开机');
  }

  /// 余额不足：诚实对话 + 退未拍镜通道
  Future<void> _creditsDialog(
      BuildContext context, MvProjectDetailNotifier n, MvProject p) async {
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('积分不足'),
        content: const Text(
          '开机需要约一整笔拍摄积分，当前余额不够。\n'
          '· 每日登录可领免费积分，攒够再来开机；\n'
          '· 也可以取消这个项目，未拍镜的预留积分会全额退回。',
          style: TextStyle(fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('知道了')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, 'cancel'),
              child: const Text('取消并退未拍镜',
                  style: TextStyle(color: Colors.orangeAccent))),
        ],
      ),
    );
    if (choice != 'cancel') return;
    final (refunded, err) = await n.cancel();
    _toast(err ??
        (refunded != null && refunded > 0
            ? '已取消，退回 $refunded ⚡（未拍镜全额退）'
            : '已取消（无待退积分）'));
  }

  @override
  Widget build(BuildContext context) {
    final wizard = ref.watch(mvWizardProvider(widget.workId));
    final p = wizard.project;
    if (p == null) {
      return const Center(
          child: Text('请先完成前面的确认门', style: TextStyle(color: Colors.white38)));
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

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        const Text('先看片，再掏分',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        const Text('免费预览样片 = 分镜关键帧 × 已制曲混音（非正式画面），看完再按报价拍板开机。',
            style: TextStyle(fontSize: 11.5, color: Colors.white38)),
        const SizedBox(height: 12),
        // ---- 样片播放器（非正式角标） ----
        Stack(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: MvVideoPlayer(
                url: hasPreview ? previewUrl : null,
                coverUrl: live.coverUrl,
                aspectRatio: 9 / 16,
                placeholderHint: hasPreview
                    ? '样片暂不可播（片源或服务异常）'
                    : '还没有样片 —— 点下方按钮免费出片',
              ),
            ),
            if (hasPreview)
              const Positioned(
                top: 8,
                left: 8,
                child: _InformalBadge(),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: live.hasScript && !live.ready
                    ? () => _makePreview(n)
                    : null,
                icon: const Icon(Icons.movie_outlined, size: 16),
                label: Text(hasPreview ? '重出样片（5 ⚡）' : '免费出样片',
                    style: const TextStyle(fontSize: 12)),
              ),
            ),
          ],
        ),
        if (!live.hasScript)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('还没有剧本/分镜：回到上一步先「生成分镜」，样片需要先有镜头。',
                style: TextStyle(fontSize: 11, color: Colors.white24)),
          )
        else if (!hasPreview)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('还没有样片：点上方「免费出样片」派单；执行器合片约 1–2 分钟，'
                '完成后本页自动出现样片与报价卡。',
                style: TextStyle(fontSize: 11, color: Colors.white24)),
          )
        else if (!live.canBootGate)
          const _WaitNote(
              text: '样片已出，报价卡生成中（服务端在样片完成时产出报价快照）。'),
        const SizedBox(height: 16),
        // ---- 报价卡 ----
        _EstCard(
            est: est,
            estVer: live.estVer,
            paused: live.paused,
            budget: live.budgetCredits),
        const SizedBox(height: 16),
        // ---- 开机开拍（计费门，永远手动） ----
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: canBoot && !_booting
                ? () => _bootFlow(context, n, live)
                : null,
            icon: _booting
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.rocket_launch_outlined, size: 18),
            label: Text(live.statusRank >= 4
                ? '剧组已进场（拍摄中）'
                : '开机开拍'),
          ),
        ),
        if ((live.estVer ?? '').isEmpty && live.hasScript)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('报价卡会在样片产出时生成 —— 没看样片之前不开机，这是产品纪律。',
                style: TextStyle(fontSize: 11, color: Colors.white24)),
          ),
        if (live.paused)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('预算护栏已触发：本页可在人工确认后调高预算恢复。',
                style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ),
        const SizedBox(height: 10),
        if (live.statusRank >= 4)
          OutlinedButton.icon(
            onPressed: () => MvProgressPage.push(context, projectId: p.id),
            icon: const Icon(Icons.dashboard_outlined, size: 16),
            label: const Text('去剧组通告板看进度'),
          ),
      ],
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
        color: Colors.black.withValues(alpha: .55),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: Colors.amberAccent.withValues(alpha: .6)),
      ),
      child: const Text('预览样片 · 非正式画面',
          style: TextStyle(
              fontSize: 10, color: Colors.amberAccent, height: 1.2)),
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
        color: Colors.amber.withValues(alpha: .06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.amber.withValues(alpha: .25)),
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
              child: Text(text,
                  style: const TextStyle(
                      fontSize: 11.5, color: Colors.amberAccent, height: 1.4))),
        ],
      ),
    );
  }
}

/// 报价卡（预计 X 分钟 · 约 Y ⚡ · 拍 N 镜 + 明细行 + est_ver 版本角标）
class _EstCard extends StatelessWidget {
  const _EstCard(
      {required this.est,
      required this.estVer,
      required this.paused,
      required this.budget});
  final MvEst? est;
  final String? estVer;
  final bool paused;
  final int budget;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final e = est;
    final empty = e == null || e.isEmpty;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        color: scheme.primaryContainer.withValues(alpha: .07),
        border: Border.all(
            color: (empty ? Colors.white10 : scheme.primary.withValues(alpha: .4))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('报价卡',
                  style:
                      TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
              const Spacer(),
              if ((estVer ?? '').isNotEmpty)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: .06),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text('报价版 ${estVer!.length > 8 ? estVer!.substring(0, 8) : estVer}',
                      style: const TextStyle(
                          fontSize: 10, color: Colors.white38)),
                ),
            ],
          ),
          const SizedBox(height: 10),
          if (empty)
            const Text(
              '报价还没生成 —— 它随样片一起产出（预计耗时按队列深度 + 实测均值动态计算）。',
              style: TextStyle(fontSize: 12, color: Colors.white38, height: 1.5),
            )
          else ...[
            Text(
              '预计 ${e.minutes > 0 ? e.minutes : '--'} 分钟 · '
              '约 ${e.credits} ⚡ · 拍 ${e.shots} 镜'
              '${e.lipsync > 0 ? '（含 ${e.lipsync} 镜对口型）' : ''}',
              style: TextStyle(
                  fontSize: 15, fontWeight: FontWeight.w800, color: scheme.primary),
            ),
            const SizedBox(height: 8),
            ...e.breakdown.map((r) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    children: [
                      Expanded(
                          child: Text('${mvHuman(r.item)}（${mvHuman(r.unit)}）',
                              style: const TextStyle(
                                  fontSize: 12, color: Colors.white54))),
                      Text('${r.count} × ${r.credits} ⚡',
                          style: const TextStyle(
                              fontSize: 12, color: Colors.white70)),
                    ],
                  ),
                )),
            const Divider(color: Colors.white10, height: 18),
            Text('预算护栏 $budget ⚡${paused ? ' · 已暂停（需人工调高）' : ''}',
                style: const TextStyle(fontSize: 11, color: Colors.white38)),
          ],
        ],
      ),
    );
  }
}
