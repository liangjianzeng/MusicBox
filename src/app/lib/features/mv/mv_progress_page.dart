import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../../core/ws_client.dart';
import 'assistant_sheet.dart';
import 'mv_detail_page.dart';
import 'mv_models.dart';
import 'mv_reveal_page.dart';
import 'mv_state.dart';
import 'widgets/mv_common.dart';
import 'widgets/mv_task_chip.dart';
import 'widgets/mv_theme.dart';
import 'widgets/mv_video_player.dart';

/// 步⑥剧组通告板：TaskChip×镜（排队/开拍/对口型/合成/完成 + 降级角标）
/// + 位次/ETA 人话 + 重拍/对口型 chips → 诊断卡 → 系统动作（付费过确认对话）
/// + 项目级取消（未拍镜全额退）。
/// 数据来源：GET /v1/mv/projects/:id（3s 轮询）+ WSS mv.progress 加速。
/// 诚实纪律：执行器未挂时镜头一律如实显示「排队中」并横幅说明；系统自动
/// 返工（不扣分）以横幅明示；绝不伪造推进百分比或庆祝。
class MvProgressPage extends ConsumerStatefulWidget {
  const MvProgressPage(
      {super.key, required this.projectId, this.autoPlay = false});

  final String projectId;
  final bool autoPlay;

  static void push(BuildContext context,
      {required String projectId, bool autoPlay = false}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MvProgressPage(projectId: projectId, autoPlay: autoPlay),
    ));
  }

  @override
  ConsumerState<MvProgressPage> createState() => _MvProgressPageState();
}

class _MvProgressPageState extends ConsumerState<MvProgressPage> {
  Timer? _poll;
  StreamSubscription<WsEvent>? _wsSub;
  bool _autoPlayed = false;
  String? _lastNote; // WSS note（人话，已过禁词过滤）
  bool _systemAuto = false; // 最近一次广播含「系统自动返工」（不扣分明示）
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(
        const Duration(seconds: 3),
        (_) => ref
            .read(mvProjectDetailProvider(widget.projectId).notifier)
            .refresh(quiet: true));
    _wsSub = ref
        .read(wsClientProvider)
        .events
        .where((e) => e is MvProgressEvent && e.projectId == widget.projectId)
        .listen((e) {
      if (e is MvProgressEvent) {
        final note = mvHuman(e.note ?? '').trim();
        if (note.isNotEmpty) {
          setState(() {
            _lastNote = note;
            _systemAuto = note.contains('自动返工') || note.contains('系统自动');
          });
        }
      }
      ref
          .read(mvProjectDetailProvider(widget.projectId).notifier)
          .refresh(quiet: true);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _wsSub?.cancel();
    super.dispose();
  }

  void _toast(String t) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));
  }

  // ---------- 取消项目（未拍镜全额退，账本核算如实呈现） ----------

  Future<void> _cancelProject(MvProjectDetailNotifier n) async {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('取消制作'),
        content: Text(
          '取消后制作停止；尚未开拍的镜头预留积分会全额退回（已开拍的不退，'
          '账本如实核算）。确定取消吗？',
          style: TextStyle(fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false), child: Text('继续制作')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              style: FilledButton.styleFrom(backgroundColor: context.mvError),
              child: Text('取消制作')),
        ],
      ),
    );
    if (go != true) return;
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      final (refunded, err) = await n.cancel();
      _toast(err ??
          (refunded != null && refunded > 0
              ? '已取消，退回 $refunded ⚡（未拍镜全额退）'
              : '已取消（无待退积分）'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---------- 重拍/对口型 chips → 诊断卡 → 系统动作 ----------

  Future<void> _openDiagnose(MvProjectDetail detail, MvShot shot,
      {String? preselect}) async {
    final pick = await showModalBottomSheet<_DiagPick>(
      context: context,
      backgroundColor: context.mvColors.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) =>
          _DiagnoseSheet(detail: detail, shot: shot, preselect: preselect),
    );
    if (pick == null || !mounted) return;
    switch (pick.kind) {
      case _DiagKind.paid:
        final quote = mvShotActionQuote(detail, pick.type);
        final costText = quote == null ? '以确认卡为准' : '$quote ⚡';
        final go = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(pick.type == 'reshoot' ? '重拍这一镜' : '重新对口型'),
            content: Text(
              '${pick.reason.isEmpty ? '（未填原因）' : '「${pick.reason}」'}\n'
              '将由剧组重新执行，预计扣 $costText（先扣后派单，失败自动全退）。\n'
              '系统若自动补拍（≤2 次）一律不扣分，并会在通告板明示。',
              style: TextStyle(fontSize: 13, height: 1.5),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: Text('先不动')),
              FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: Text(quote == null ? '确认提交' : '确认扣 $quote ⚡')),
            ],
          ),
        );
        if (go != true || !mounted) return;
        final n = ref.read(mvProjectDetailProvider(widget.projectId).notifier);
        setState(() => _busy = true);
        try {
          final (ok, err, charged) =
              await n.shotJob(shot.id, pick.type, pick.reason);
          _toast(ok
              ? (charged > 0
                  ? '${pick.type == 'reshoot' ? '重拍' : '口型重校'}已提交（扣 $charged ⚡）'
                  : '已提交（幂等命中，未重复扣分）')
              : (err ?? '提交失败，请重试'));
        } finally {
          if (mounted) setState(() => _busy = false);
        }
      case _DiagKind.free:
        _toast('节奏/时长是剧本层修改：回「剧本」步长按该镜调整时长，文本编辑免费。');
      case _DiagKind.expensive:
        if (!mounted) return;
        _cancelProject(
            ref.read(mvProjectDetailProvider(widget.projectId).notifier));
    }
  }

  // ---------- 确认票（助手签发的昂贵动作票，在通告板也可直接拍板） ----------

  Future<void> _resolveTicket(
      MvProjectDetailNotifier n, MvTicket t, bool approve) async {
    setState(() => _busy = true);
    try {
      final err =
          await n.resolveTicket(t.id, approve, ver: t.ver, hash: t.hash);
      _toast(err ?? (approve ? '票已批准，剧组开始执行' : '已拒绝这张票'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mvProjectDetailProvider(widget.projectId));
    final detail = st.detail;
    final project = detail?.project;

    // 成片就绪自动办首映礼（autoPlay：从「看成片」入口进 → 揭晓页拉幕→播放）
    if (widget.autoPlay &&
        !_autoPlayed &&
        project != null &&
        (project.videoUrl ?? '').isNotEmpty) {
      _autoPlayed = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        MvRevealPage.push(context, mvId: widget.projectId);
      });
    }

    final assistantOn =
        (detail?.assistantEnabled ?? false) || kMvAssistantEnabled;

    return MvLeaveGuard(
      busy: _busy,
      message: '取消、返工或确认票仍在提交中。离开不会取消后台任务，'
          '但可能看不到本次扣分与执行回执。确定离开吗？',
      child: Scaffold(
        appBar: AppBar(
          title: Text(
              project?.title.isNotEmpty == true ? project!.title : '剧组通告板'),
          actions: [
            if (project != null && project.ready)
              IconButton(
                tooltip: '看详情',
                onPressed: () =>
                    MvDetailPage.push(context, mvId: widget.projectId),
                icon: Icon(Icons.movie_filter_outlined),
              ),
            IconButton(
              tooltip: '刷新',
              onPressed: () => ref
                  .read(mvProjectDetailProvider(widget.projectId).notifier)
                  .refresh(),
              icon: Icon(Icons.refresh),
            ),
          ],
        ),
        floatingActionButton: assistantOn
            ? FloatingActionButton.small(
                heroTag: 'mv_assistant_fab',
                tooltip: '制片助手',
                onPressed: () => showMvAssistant(context,
                    projectId: widget.projectId,
                    projectTitle: project?.title ?? '',
                    chatEnabled: detail?.assistantChat ?? false,
                    modeHint: detail?.assistantModeHint),
                child: Icon(Icons.smart_toy_outlined, size: 20),
              )
            : null,
        body: st.detail == null && st.loading
            ? Center(child: CircularProgressIndicator())
            : st.detail == null
                ? MvErrorView(
                    text: st.error ?? '暂无数据',
                    onRetry: () => ref
                        .read(
                            mvProjectDetailProvider(widget.projectId).notifier)
                        .refresh(),
                  )
                : _Board(
                    detail: detail!,
                    lastNote: _lastNote,
                    systemAuto: _systemAuto,
                    onCancel: () => _cancelProject(ref.read(
                        mvProjectDetailProvider(widget.projectId).notifier)),
                    onDiagnose: (shot, preselect) =>
                        _openDiagnose(detail, shot, preselect: preselect),
                    onResolveTicket: (t, approve) => _resolveTicket(
                        ref.read(
                            mvProjectDetailProvider(widget.projectId).notifier),
                        t,
                        approve),
                  ),
      ),
    );
  }
}

class _Board extends ConsumerWidget {
  const _Board({
    required this.detail,
    required this.lastNote,
    required this.systemAuto,
    required this.onCancel,
    required this.onDiagnose,
    required this.onResolveTicket,
  });

  final MvProjectDetail detail;
  final String? lastNote;
  final bool systemAuto;
  final VoidCallback onCancel;
  final void Function(MvShot shot, String? preselect) onDiagnose;
  final void Function(MvTicket ticket, bool approve) onResolveTicket;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = detail.project;
    final shots = detail.shots;
    final inProgress = mvProjectInProgress(p.status);
    // 执行器未挂 = 无任何镜头推进信号：如实呈现，不伪造
    final noExecutor = inProgress &&
        shots.every((s) => s.status == 'draft' || s.status == 'queued');
    final doneCount = shots
        .where(
            (s) => const {'clipReady', 'synced', 'locked'}.contains(s.status))
        .length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        // 项目状态横幅
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            color: context.mvSurfaceRaised.withValues(alpha: .03),
            border: Border.all(color: context.mvBorder),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('《${p.title.isEmpty ? '未命名 MV' : p.title}》',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 15)),
                    SizedBox(height: 4),
                    Text(
                      [
                        mvKindLabel(p.kind),
                        if (shots.isNotEmpty) '成片 $doneCount/${shots.length} 镜',
                        '已用 ${p.creditsCost} ⚡',
                        if (p.paused) '预算护栏暂停（需人工恢复）',
                        if (p.queueMode == 'night') '夜间档',
                      ].join(' · '),
                      style:
                          TextStyle(fontSize: 11, color: context.mvTextMuted),
                    ),
                  ],
                ),
              ),
              MvProjectChip(status: p.status),
            ],
          ),
        ),
        if ((lastNote ?? '').isNotEmpty) ...[
          SizedBox(height: 8),
          MvNotice(icon: Icons.campaign_outlined, text: '剧组播报：$lastNote'),
        ],
        if (systemAuto) ...[
          SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: context.mvInfo.withValues(alpha: .08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: context.mvInfo.withValues(alpha: .4)),
            ),
            child: Row(
              children: [
                Icon(Icons.auto_fix_high, size: 16, color: context.mvInfo),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '不扣分的自动返工：质量门未过时系统会自动补拍（≤2 次，恒免费），'
                    '不重复计费，无需你操作。',
                    style: TextStyle(
                        fontSize: 12, color: context.mvInfo, height: 1.45),
                  ),
                ),
              ],
            ),
          ),
        ],
        if (noExecutor) ...[
          SizedBox(height: 8),
          const MvNotice(
            icon: Icons.hourglass_empty,
            text: '通告板等待中：镜头任务尚未开拍（执行器未挂单时如实显示排队中）。'
                '制作是分钟级异步工程，可离开本页与 App，完成后通知拉回。',
          ),
        ],
        if (p.paused) ...[
          SizedBox(height: 8),
          const MvNotice(
              icon: Icons.pause_circle_outline,
              text: '预算护栏已触发（超预算 120%）。可在「开机」页人工调高预算后恢复。'),
        ],
        if (p.status == 'failed') ...[
          SizedBox(height: 8),
          const MvNotice(
            icon: Icons.restart_alt_outlined,
            text: '本次制作未成功，但项目没有结束。可从具体镜头的「重拍」或'
                '「运动改写」恢复，也可按原报价重新开机；确认前不会扣分。',
          ),
        ],
        // 待确认票（昂贵动作拍板权在人）
        if (detail.tickets.isNotEmpty) ...[
          SizedBox(height: 12),
          Text('待你拍板的确认票',
              style: TextStyle(
                  fontWeight: FontWeight.w700, color: context.mvTextSecondary)),
          SizedBox(height: 6),
          ...detail.tickets.map((t) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _TicketCard(
                    ticket: t,
                    onResolve: (approve) => onResolveTicket(t, approve)),
              )),
        ],
        SizedBox(height: 16),
        Text('镜头通告（长按镜卡外的重拍/对口型 chips 打开诊断卡）',
            style: TextStyle(
                fontWeight: FontWeight.w700, color: context.mvTextSecondary)),
        SizedBox(height: 8),
        if (shots.isEmpty)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: context.mvSurfaceRaised.withValues(alpha: .03),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: context.mvBorder)),
            child: Text(
              '镜头清单待剧本/分镜步骤生成。未开机前本页如实保持「等待中」，不伪造进度。',
              style: TextStyle(
                  fontSize: 12, color: context.mvTextMuted, height: 1.5),
            ),
          )
        else
          ...shots.map((s) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Material(
                  color: context.mvSurfaceRaised.withValues(alpha: .03),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                    child: Row(
                      children: [
                        CircleAvatar(
                          radius: 13,
                          backgroundColor: context.mvBorder,
                          child: Text('${s.seq}',
                              style: TextStyle(
                                  fontSize: 11,
                                  color: context.mvTextSecondary)),
                        ),
                        SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                mvHuman((s.desc ?? '').isEmpty
                                    ? '第 ${s.seq} 镜'
                                    : s.desc!),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 13),
                              ),
                              SizedBox(height: 2),
                              Text(
                                [
                                  mvShotKindLabel(s.kind),
                                  if ((s.camera ?? '').isNotEmpty) s.camera!,
                                  if (s.sec > 0) '${s.sec.round()}s',
                                  if (s.rerolls > 0) '补拍 ${s.rerolls} 次',
                                ].join(' · '),
                                style: TextStyle(
                                    fontSize: 11, color: context.mvTextMuted),
                              ),
                              // 重拍 / 对口型 chips（诊断卡入口）；failed 允许重拍恢复
                              if (p.status != 'canceled')
                                Padding(
                                  padding: const EdgeInsets.only(top: 4),
                                  child: Row(
                                    children: [
                                      _MiniActionChip(
                                          icon: Icons.autorenew_outlined,
                                          label: '重拍',
                                          onTap: () => onDiagnose(s, null)),
                                      _MiniActionChip(
                                          icon: Icons.directions_run_outlined,
                                          label: '运动改写',
                                          onTap: () => onDiagnose(s, '动作不对')),
                                      if (p.isVocal && s.singing)
                                        _MiniActionChip(
                                            icon: Icons
                                                .record_voice_over_outlined,
                                            label: '对口型',
                                            onTap: () => onDiagnose(s, '不像在唱')),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        ),
                        MvTaskChip(status: s.status, badges: s.degraded),
                      ],
                    ),
                  ),
                ),
              )),
        if ((p.previewUrl ?? '').isNotEmpty) ...[
          SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: () => MvVideoPlayerPage.push(context,
                url: p.previewUrl,
                title: '预览样片（非正式画面）',
                coverUrl: p.coverUrl,
                placeholderHint: '样片暂不可播'),
            icon: Icon(Icons.movie_outlined, size: 18),
            label: Text('看预览样片（非正式画面）'),
          ),
        ],
        if ((p.videoUrl ?? '').isNotEmpty) ...[
          SizedBox(height: 8),
          FilledButton.icon(
            // 完成 → 首映礼揭晓页（拉幕动画 → 海报先行 → 内联自动播放）
            onPressed: () => MvRevealPage.push(context, mvId: p.id),
            icon: Icon(Icons.play_circle_outline, size: 18),
            label: Text('看成片'),
          ),
        ],
        if (inProgress) ...[
          SizedBox(height: 12),
          Divider(color: context.mvBorder),
          SizedBox(height: 4),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: onCancel,
              icon: Icon(Icons.cancel_presentation_outlined,
                  size: 16, color: context.mvError),
              label: Text('取消制作（未拍镜全额退）',
                  style: TextStyle(fontSize: 12, color: context.mvError)),
            ),
          ),
        ],
      ],
    );
  }
}

/// 镜级轻操作 chip（重拍/对口型 → 诊断卡）
class _MiniActionChip extends StatelessWidget {
  const _MiniActionChip(
      {required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: context.mvBorder),
            color: context.mvSurfaceRaised.withValues(alpha: .03),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 12, color: context.mvTextMuted),
              SizedBox(width: 3),
              Text(label,
                  style: TextStyle(
                      fontSize: 10.5, color: context.mvTextSecondary)),
            ],
          ),
        ),
      ),
    );
  }
}

/// 确认票卡（动作 + 报价 + 批准/拒绝；TTL/一票一次由服务端硬门）
class _TicketCard extends StatelessWidget {
  const _TicketCard({required this.ticket, required this.onResolve});
  final MvTicket ticket;
  final ValueChanged<bool> onResolve;

  @override
  Widget build(BuildContext context) {
    final pending = ticket.status == 'pending';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.mvWarning.withValues(alpha: .05),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.mvWarning.withValues(alpha: .3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.receipt_long_outlined,
                  size: 15, color: context.mvWarning),
              SizedBox(width: 6),
              Expanded(
                child: Text('确认票 · ${mvHuman(ticket.action)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style:
                        TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
              ),
              Text(pending ? '待拍板' : '已处理',
                  style: TextStyle(fontSize: 10.5, color: context.mvTextMuted)),
            ],
          ),
          SizedBox(height: 4),
          Text('约 ${ticket.estCredits} ⚡ · ${ticket.estMinutes} 分钟 · 60 秒内有效',
              style: TextStyle(fontSize: 11.5, color: context.mvTextSecondary)),
          if (pending) ...[
            SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                    onPressed: () => onResolve(false),
                    child: Text('拒绝',
                        style: TextStyle(
                            fontSize: 12, color: context.mvTextSecondary))),
                SizedBox(width: 8),
                FilledButton(
                    onPressed: () => onResolve(true),
                    style: FilledButton.styleFrom(
                        visualDensity: VisualDensity.compact),
                    child: Text('批准', style: TextStyle(fontSize: 12))),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

// ---------- 诊断卡（mv-plan §5.3：chips → 诊断 → 系统动作） ----------

enum _DiagKind { paid, free, expensive }

String _mvQuoteText(MvProjectDetail detail, String action) {
  final quote = mvShotActionQuote(detail, action);
  return quote == null ? '以确认卡为准' : '$quote ⚡';
}

class _DiagPick {
  const _DiagPick(this.kind, {this.type = 'reshoot', this.reason = ''});
  final _DiagKind kind;
  final String type; // reshoot|resync
  final String reason;
}

class _DiagItem {
  const _DiagItem(this.chip, this.hint, this.pick);
  final String chip;
  final String hint;
  final _DiagPick pick;
}

const _diagItems = [
  _DiagItem('不像本人', '系统会换高分角度帧重拍；自动补拍 ≤2 次不扣分',
      _DiagPick(_DiagKind.paid, type: 'reshoot', reason: '不像本人')),
  _DiagItem('不像在唱', '按已制曲唱段重新校对口型',
      _DiagPick(_DiagKind.paid, type: 'resync', reason: '不像在唱')),
  _DiagItem('动作不对', '按新导演阐述重拍本镜',
      _DiagPick(_DiagKind.paid, type: 'reshoot', reason: '动作不对')),
  _DiagItem('景别不对', '先在镜卡上改景别，再按新景别重拍',
      _DiagPick(_DiagKind.paid, type: 'reshoot', reason: '景别不对')),
  _DiagItem('节奏太慢', '回剧本步改本镜时长（文本编辑免费，不动已拍画面）', _DiagPick(_DiagKind.free)),
  _DiagItem('太贵了', '取消剩余未拍镜头（未拍全额退）或减镜', _DiagPick(_DiagKind.expensive)),
];

class _DiagnoseSheet extends StatelessWidget {
  const _DiagnoseSheet(
      {required this.detail, required this.shot, this.preselect});
  final MvProjectDetail detail;
  final MvShot shot;
  final String? preselect;

  @override
  Widget build(BuildContext context) {
    // 诊断数据全来自机检回传字段，不虚构当前分
    final info = [
      mvShotKindLabel(shot.kind),
      if ((shot.camera ?? '').isNotEmpty) shot.camera!,
      if (shot.sec > 0) '${shot.sec.round()}s',
      if (shot.rerolls > 0) '已补拍 ${shot.rerolls} 次',
    ].join(' · ');
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('诊断卡 · 第 ${shot.seq} 镜',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
            SizedBox(height: 2),
            Text(info,
                style: TextStyle(fontSize: 11.5, color: context.mvTextMuted)),
            SizedBox(height: 4),
            Text('你觉得哪里不对？（同镜同因自动补拍 ≤2 次且免费；再不过会转人工通道）',
                style: TextStyle(
                    fontSize: 11.5,
                    color: context.mvTextSecondary,
                    height: 1.4)),
            SizedBox(height: 8),
            ..._diagItems.map((d) => ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    d.pick.kind == _DiagKind.paid
                        ? Icons.build_outlined
                        : d.pick.kind == _DiagKind.free
                            ? Icons.edit_note_outlined
                            : Icons.savings_outlined,
                    size: 18,
                    color: context.mvTextMuted,
                  ),
                  title: Text(d.chip,
                      style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          color: context.mvTextPrimary)),
                  subtitle: Text(
                    d.hint,
                    style: TextStyle(
                        fontSize: 11, color: context.mvTextMuted, height: 1.35),
                  ),
                  trailing: d.pick.kind == _DiagKind.paid
                      ? Text(_mvQuoteText(detail, d.pick.type),
                          style: TextStyle(
                              fontSize: 11, color: context.mvTextMuted))
                      : null,
                  onTap: () => Navigator.pop(context, d.pick),
                )),
            if (preselect != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('已按「$preselect」预填原因',
                    style:
                        TextStyle(fontSize: 10.5, color: context.mvTextMuted)),
              ),
          ],
        ),
      ),
    );
  }
}
