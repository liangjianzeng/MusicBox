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
import 'widgets/mv_task_chip.dart';
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
      builder: (_) =>
          MvProgressPage(projectId: projectId, autoPlay: autoPlay),
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
            _systemAuto =
                note.contains('自动返工') || note.contains('系统自动');
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
        title: const Text('取消制作'),
        content: const Text(
          '取消后制作停止；尚未开拍的镜头预留积分会全额退回（已开拍的不退，'
          '账本如实核算）。确定取消吗？',
          style: TextStyle(fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('继续制作')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              style: FilledButton.styleFrom(backgroundColor: Colors.redAccent),
              child: const Text('取消制作')),
        ],
      ),
    );
    if (go != true) return;
    final (refunded, err) = await n.cancel();
    _toast(err ??
        (refunded != null && refunded > 0
            ? '已取消，退回 $refunded ⚡（未拍镜全额退）'
            : '已取消（无待退积分）'));
  }

  // ---------- 重拍/对口型 chips → 诊断卡 → 系统动作 ----------

  Future<void> _openDiagnose(MvProjectDetail detail, MvShot shot,
      {String? preselect}) async {
    final pick = await showModalBottomSheet<_DiagPick>(
      context: context,
      backgroundColor: const Color(0xFF17181F),
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _DiagnoseSheet(detail: detail, shot: shot, preselect: preselect),
    );
    if (pick == null || !mounted) return;
    switch (pick.kind) {
      case _DiagKind.paid:
        final cost = pick.type == 'reshoot' ? 40 : 20;
        final go = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(pick.type == 'reshoot' ? '重拍这一镜' : '重新对口型'),
            content: Text(
              '${pick.reason.isEmpty ? '（未填原因）' : '「${pick.reason}」'}\n'
              '将由剧组重新执行，预计扣 $cost ⚡（先扣后派单，失败自动全退）。\n'
              '系统若自动补拍（≤2 次）一律不扣分，并会在通告板明示。',
              style: const TextStyle(fontSize: 13, height: 1.5),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('先不动')),
              FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: Text('确认扣 $cost ⚡')),
            ],
          ),
        );
        if (go != true) return;
        final n = ref.read(mvProjectDetailProvider(widget.projectId).notifier);
        final (ok, err, charged) =
            await n.shotJob(shot.id, pick.type, pick.reason);
        _toast(ok
            ? (charged > 0
                ? '${pick.type == 'reshoot' ? '重拍' : '口型重校'}已提交（扣 $charged ⚡）'
                : '已提交（幂等命中，未重复扣分）')
            : (err ?? '提交失败，请重试'));
      case _DiagKind.free:
        _toast('节奏/时长是剧本层修改：回「剧本」步长按该镜调整时长，文本编辑免费。');
      case _DiagKind.expensive:
        if (!mounted) return;
        _cancelProject(ref.read(mvProjectDetailProvider(widget.projectId).notifier));
    }
  }

  // ---------- 确认票（助手签发的昂贵动作票，在通告板也可直接拍板） ----------

  Future<void> _resolveTicket(MvProjectDetailNotifier n, MvTicket t,
      bool approve) async {
    final err =
        await n.resolveTicket(t.id, approve, ver: t.ver, hash: t.hash);
    _toast(err ?? (approve ? '票已批准，剧组开始执行' : '已拒绝这张票'));
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

    final assistantOn = (detail?.assistantEnabled ?? false) || kMvAssistantEnabled;

    return Scaffold(
      appBar: AppBar(
        title: Text(project?.title.isNotEmpty == true
            ? project!.title
            : '剧组通告板'),
        actions: [
          if (project != null && project.ready)
            IconButton(
              tooltip: '看详情',
              onPressed: () =>
                  MvDetailPage.push(context, mvId: widget.projectId),
              icon: const Icon(Icons.movie_filter_outlined),
            ),
          IconButton(
            tooltip: '刷新',
            onPressed: () => ref
                .read(mvProjectDetailProvider(widget.projectId).notifier)
                .refresh(),
            icon: const Icon(Icons.refresh),
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
              child: const Icon(Icons.smart_toy_outlined, size: 20),
            )
          : null,
      body: st.detail == null && st.loading
          ? const Center(child: CircularProgressIndicator())
          : st.detail == null
              ? _ErrorView(
                  text: st.error ?? '暂无数据',
                  onRetry: () => ref
                      .read(mvProjectDetailProvider(widget.projectId).notifier)
                      .refresh(),
                )
              : _Board(
                  detail: detail!,
                  lastNote: _lastNote,
                  systemAuto: _systemAuto,
                  onCancel: () => _cancelProject(
                      ref.read(mvProjectDetailProvider(widget.projectId).notifier)),
                  onDiagnose: (shot, preselect) =>
                      _openDiagnose(detail, shot, preselect: preselect),
                  onResolveTicket: (t, approve) => _resolveTicket(
                      ref.read(mvProjectDetailProvider(widget.projectId).notifier),
                      t,
                      approve),
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
    final noExecutor =
        inProgress && shots.every((s) => s.status == 'draft' || s.status == 'queued');
    final doneCount = shots
        .where((s) => const {'clipReady', 'synced', 'locked'}.contains(s.status))
        .length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        // 项目状态横幅
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            color: Colors.white.withValues(alpha: .03),
            border: Border.all(color: Colors.white10),
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
                        style: const TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 15)),
                    const SizedBox(height: 4),
                    Text(
                      [
                        mvKindLabel(p.kind),
                        if (shots.isNotEmpty) '成片 $doneCount/${shots.length} 镜',
                        '已用 ${p.creditsCost} ⚡',
                        if (p.paused) '预算护栏暂停（需人工恢复）',
                        if (p.queueMode == 'night') '夜间档',
                      ].join(' · '),
                      style:
                          const TextStyle(fontSize: 11, color: Colors.white38),
                    ),
                  ],
                ),
              ),
              MvProjectChip(status: p.status),
            ],
          ),
        ),
        if ((lastNote ?? '').isNotEmpty) ...[
          const SizedBox(height: 8),
          _Notice(
              icon: Icons.campaign_outlined,
              text: '剧组播报：$lastNote'),
        ],
        if (systemAuto) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: Colors.teal.withValues(alpha: .08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.teal.withValues(alpha: .4)),
            ),
            child: const Row(
              children: [
                Icon(Icons.auto_fix_high, size: 16, color: Colors.tealAccent),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '不扣分的自动返工：质量门未过时系统会自动补拍（≤2 次，恒免费），'
                    '不重复计费，无需你操作。',
                    style: TextStyle(
                        fontSize: 12, color: Colors.tealAccent, height: 1.45),
                  ),
                ),
              ],
            ),
          ),
        ],
        if (noExecutor) ...[
          const SizedBox(height: 8),
          const _Notice(
            icon: Icons.hourglass_empty,
            text: '通告板等待中：镜头任务尚未开拍（执行器未挂单时如实显示排队中）。'
                '制作是分钟级异步工程，可离开本页与 App，完成后通知拉回。',
          ),
        ],
        if (p.paused) ...[
          const SizedBox(height: 8),
          const _Notice(
              icon: Icons.pause_circle_outline,
              text: '预算护栏已触发（超预算 120%）。可在「开机」页人工调高预算后恢复。'),
        ],
        // 待确认票（昂贵动作拍板权在人）
        if (detail.tickets.isNotEmpty) ...[
          const SizedBox(height: 12),
          const Text('待你拍板的确认票',
              style:
                  TextStyle(fontWeight: FontWeight.w700, color: Colors.white70)),
          const SizedBox(height: 6),
          ...detail.tickets.map((t) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _TicketCard(
                    ticket: t, onResolve: (approve) => onResolveTicket(t, approve)),
              )),
        ],
        const SizedBox(height: 16),
        const Text('镜头通告（长按镜卡外的重拍/对口型 chips 打开诊断卡）',
            style:
                TextStyle(fontWeight: FontWeight.w700, color: Colors.white70)),
        const SizedBox(height: 8),
        if (shots.isEmpty)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: .03),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.white10)),
            child: const Text(
              '镜头清单待剧本/分镜步骤生成。未开机前本页如实保持「等待中」，不伪造进度。',
              style: TextStyle(fontSize: 12, color: Colors.white38, height: 1.5),
            ),
          )
        else
          ...shots.map((s) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Material(
                  color: Colors.white.withValues(alpha: .03),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                    child: Row(
                      children: [
                        CircleAvatar(
                          radius: 13,
                          backgroundColor: Colors.white10,
                          child: Text('${s.seq}',
                              style: const TextStyle(
                                  fontSize: 11, color: Colors.white70)),
                        ),
                        const SizedBox(width: 10),
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
                                style: const TextStyle(fontSize: 13),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                [
                                  mvShotKindLabel(s.kind),
                                  if ((s.camera ?? '').isNotEmpty) s.camera!,
                                  if (s.sec > 0) '${s.sec.round()}s',
                                  if (s.rerolls > 0) '补拍 ${s.rerolls} 次',
                                ].join(' · '),
                                style: const TextStyle(
                                    fontSize: 11, color: Colors.white38),
                              ),
                              // 重拍 / 对口型 chips（诊断卡入口）
                              if (!['canceled', 'failed'].contains(p.status))
                                Padding(
                                  padding: const EdgeInsets.only(top: 4),
                                  child: Row(
                                    children: [
                                      _MiniActionChip(
                                          icon: Icons.autorenew_outlined,
                                          label: '重拍',
                                          onTap: () => onDiagnose(s, null)),
                                      _MiniActionChip(
                                          icon:
                                              Icons.directions_run_outlined,
                                          label: '运动改写',
                                          onTap: () =>
                                              onDiagnose(s, '动作不对')),
                                      if (p.isVocal && s.singing)
                        _MiniActionChip(
                                          icon: Icons.record_voice_over_outlined,
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
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: () => MvVideoPlayerPage.push(context,
                url: p.previewUrl,
                title: '预览样片（非正式画面）',
                coverUrl: p.coverUrl,
                placeholderHint: '样片暂不可播'),
            icon: const Icon(Icons.movie_outlined, size: 18),
            label: const Text('看预览样片（非正式画面）'),
          ),
        ],
        if ((p.videoUrl ?? '').isNotEmpty) ...[
          const SizedBox(height: 8),
          FilledButton.icon(
            // 完成 → 首映礼揭晓页（拉幕动画 → 海报先行 → 内联自动播放）
            onPressed: () => MvRevealPage.push(context, mvId: p.id),
            icon: const Icon(Icons.play_circle_outline, size: 18),
            label: const Text('看成片'),
          ),
        ],
        if (inProgress) ...[
          const SizedBox(height: 12),
          const Divider(color: Colors.white10),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: onCancel,
              icon: const Icon(Icons.cancel_presentation_outlined,
                  size: 16, color: Colors.redAccent),
              label: const Text('取消制作（未拍镜全额退）',
                  style: TextStyle(fontSize: 12, color: Colors.redAccent)),
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
            border: Border.all(color: Colors.white12),
            color: Colors.white.withValues(alpha: .03),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 12, color: Colors.white38),
              const SizedBox(width: 3),
              Text(label,
                  style: const TextStyle(fontSize: 10.5, color: Colors.white54)),
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
        color: Colors.amber.withValues(alpha: .05),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.amber.withValues(alpha: .3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.receipt_long_outlined,
                  size: 15, color: Colors.amberAccent),
              const SizedBox(width: 6),
              Expanded(
                child: Text('确认票 · ${mvHuman(ticket.action)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12.5, fontWeight: FontWeight.w700)),
              ),
              Text(pending ? '待拍板' : '已处理',
                  style: const TextStyle(fontSize: 10.5, color: Colors.white38)),
            ],
          ),
          const SizedBox(height: 4),
          Text('约 ${ticket.estCredits} ⚡ · ${ticket.estMinutes} 分钟 · 60 秒内有效',
              style: const TextStyle(fontSize: 11.5, color: Colors.white54)),
          if (pending) ...[
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                    onPressed: () => onResolve(false),
                    child: const Text('拒绝',
                        style: TextStyle(fontSize: 12, color: Colors.white54))),
                const SizedBox(width: 8),
                FilledButton(
                    onPressed: () => onResolve(true),
                    style: FilledButton.styleFrom(
                        visualDensity: VisualDensity.compact),
                    child: const Text('批准', style: TextStyle(fontSize: 12))),
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
  _DiagItem('节奏太慢', '回剧本步改本镜时长（文本编辑免费，不动已拍画面）',
      _DiagPick(_DiagKind.free)),
  _DiagItem('太贵了', '取消剩余未拍镜头（未拍全额退）或减镜',
      _DiagPick(_DiagKind.expensive)),
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
                style: const TextStyle(
                    fontWeight: FontWeight.w800, fontSize: 14)),
            const SizedBox(height: 2),
            Text(info,
                style: const TextStyle(fontSize: 11.5, color: Colors.white38)),
            const SizedBox(height: 4),
            const Text('你觉得哪里不对？（同镜同因自动补拍 ≤2 次且免费；再不过会转人工通道）',
                style: TextStyle(fontSize: 11.5, color: Colors.white54, height: 1.4)),
            const SizedBox(height: 8),
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
                    color: Colors.white38,
                  ),
                  title: Text(d.chip,
                      style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          color: Colors.white)),
                  subtitle: Text(
                    d.hint,
                    style: const TextStyle(
                        fontSize: 11, color: Colors.white38, height: 1.35),
                  ),
                  trailing: d.pick.kind == _DiagKind.paid
                      ? Text(
                          d.pick.type == 'reshoot' ? '40 ⚡' : '20 ⚡',
                          style: const TextStyle(
                              fontSize: 11, color: Colors.white38))
                      : null,
                  onTap: () => Navigator.pop(context, d.pick),
                )),
            if (preselect != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('已按「$preselect」预填原因',
                    style: const TextStyle(fontSize: 10.5, color: Colors.white24)),
              ),
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: .04),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: Colors.white38),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text,
                  style:
                      const TextStyle(fontSize: 12, color: Colors.white54, height: 1.45))),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.text, required this.onRetry});
  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.snooze_rounded, size: 38, color: Colors.white24),
            const SizedBox(height: 10),
            Text(text,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white54, fontSize: 13)),
            const SizedBox(height: 12),
            OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
