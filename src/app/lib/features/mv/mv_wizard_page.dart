import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'assistant_sheet.dart';
import 'mv_state.dart';
import 'mv_progress_page.dart';
import 'steps/step_boot.dart';
import 'steps/step_cast.dart';
import 'steps/step_look.dart';
import 'steps/step_script.dart';
import 'steps/step_work.dart';
import 'widgets/mv_common.dart';
import 'widgets/mv_theme.dart';

/// 六步向导壳：进度芯片 ①②③④⑤⑥ + 回退 + 步进。
/// 状态持久化：MvWizardNotifier（本地 StateNotifier，family 按 workId 缓存）——
/// 页面随路由 pop 销毁、再 push 时从 provider 恢复草稿，即「路由级
/// dispose-and-resume」；不写假存档、不谎称已保存到服务端。
/// 确认门（S7 流程）：② 主演确认 → ③ 帧格拍板 → ④ 已有分镜 →
/// ⑤ 先看样片再开机（status≥previewed，服务端 boot 硬门 + 本页门禁双保险）。
class MvWizardPage extends ConsumerStatefulWidget {
  const MvWizardPage({super.key, this.workId, this.initialStep = 0});

  final String? workId;
  final int initialStep;

  static void push(BuildContext context,
      {String? workId, int initialStep = 0}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MvWizardPage(workId: workId, initialStep: initialStep),
    ));
  }

  @override
  ConsumerState<MvWizardPage> createState() => _MvWizardPageState();
}

const _stepNames = ['选曲', '选角', '定妆', '剧本', '开机', '成片'];

class _MvWizardPageState extends ConsumerState<MvWizardPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final n = ref.read(mvWizardProvider(widget.workId).notifier);
      // 从曲库候选进入：落在步①并预选该曲；MV tab 进入步①不预选
      n.goTo(widget.initialStep);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(mvWizardProvider(widget.workId));
    final n = ref.read(mvWizardProvider(widget.workId).notifier);
    final step = state.step;

    // 服务端实况（门禁数据源）
    final project = state.project;
    final detail = project == null
        ? null
        : ref.watch(mvProjectDetailProvider(project.id)).detail;
    final lookConfirmed = state.lookConfirmed ||
        (detail?.characters.isNotEmpty == true &&
            detail!.characters.first.confirmed);

    // 步进门禁（②③④⑤确认门，未过不进下一步；服务端硬门 + 本页双保险）
    String? nextBlocked;
    switch (step) {
      case 0:
        if (!state.hasWork) nextBlocked = '先选一首已完成的歌';
        break;
      case 1:
        if (state.project == null) nextBlocked = '请先确认主演（定妆确认门）';
        break;
      case 2:
        if (!lookConfirmed) nextBlocked = '帧格未拍板：挑角度帧后点「拍板固化」';
        break;
      case 3:
        if (detail == null) {
          nextBlocked = '剧本数据加载中…';
        } else if (detail.shots.isEmpty) {
          nextBlocked = '先点「生成分镜」：编剧免费编译剧本，再逐镜出关键帧';
        }
        break;
      case 4:
        if (detail == null || !detail.project.canBootGate) {
          nextBlocked = '先看免费样片并按报价卡拍板「开机开拍」（计费门）';
        } else if (detail.project.statusRank < 4) {
          nextBlocked = '尚未开机：开机后进入异步制作';
        }
        break;
      case 5:
        nextBlocked = null;
        break;
    }

    final assistantOn =
        (detail?.assistantEnabled ?? false) || kMvAssistantEnabled;

    return MvLeaveGuard(
      busy: state.submitting,
      message: '主演资料仍在提交中。离开不会取消已创建的项目或后台任务，'
          '但可能看不到本次回执；草稿会保留在本机。确定离开吗？',
      child: Scaffold(
        appBar: AppBar(title: const Text('新 MV')),
        floatingActionButton: (assistantOn && project != null)
            ? FloatingActionButton.small(
                heroTag: 'mv_wizard_assistant',
                tooltip: '制片助手',
                onPressed: () => showMvAssistant(context,
                    projectId: project.id,
                    projectTitle:
                        project.title.isEmpty ? '新 MV' : project.title,
                    chatEnabled: detail?.assistantChat ?? false,
                    modeHint: detail?.assistantModeHint),
                child: const Icon(Icons.smart_toy_outlined, size: 20),
              )
            : null,
        body: Column(
          children: [
            _StepBar(
                step: step,
                onTap: (i) {
                  // 允许回退任意已到达步骤；前进仅当门禁通过
                  if (state.submitting) return;
                  if (i < step) {
                    n.goTo(i);
                  } else if (i == step + 1 && nextBlocked == null) {
                    n.goTo(i);
                  }
                }),
            Expanded(
              child: switch (step) {
                0 => StepWork(workId: widget.workId),
                1 => StepCast(workId: widget.workId),
                2 => StepLook(workId: widget.workId),
                3 => StepScript(workId: widget.workId),
                4 => StepBoot(workId: widget.workId),
                5 => _FinalStep(workId: widget.workId),
                _ => const SizedBox.shrink(),
              },
            ),
            // 底栏：回退 + 前进
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                child: Row(
                  children: [
                    if (step > 0)
                      OutlinedButton.icon(
                        onPressed:
                            state.submitting ? null : () => n.goTo(step - 1),
                        icon: const Icon(Icons.chevron_left, size: 18),
                        label: const Text('上一步'),
                      ),
                    const Spacer(),
                    if (step < 5)
                      FilledButton.icon(
                        onPressed: nextBlocked != null || state.submitting
                            ? null
                            : () => n.goTo(step + 1),
                        icon: state.submitting
                            ? const SizedBox(
                                width: 14,
                                height: 14,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.chevron_right, size: 18),
                        label: Text(state.submitting ? '提交中' : '下一步'),
                      )
                    else if (state.project != null)
                      FilledButton.icon(
                        onPressed: () => MvProgressPage.push(context,
                            projectId: state.project!.id),
                        icon: const Icon(Icons.local_movies_outlined, size: 18),
                        label: const Text('查看进度'),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 进度芯片条：①②③④⑤⑥
class _StepBar extends StatelessWidget {
  const _StepBar({required this.step, required this.onTap});
  final int step;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 52,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        itemCount: 6,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (ctx, i) {
          final done = i < step;
          final cur = i == step;
          final color = done
              ? scheme.primary
              : cur
                  ? scheme.primaryContainer
                  : context.mvSurfaceRaised;
          final fg = done
              ? scheme.onPrimary
              : cur
                  ? scheme.onPrimaryContainer
                  : context.mvTextSecondary;
          return InkWell(
            borderRadius: BorderRadius.circular(999),
            onTap: () => onTap(i),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(999),
                border:
                    cur ? Border.all(color: scheme.primary, width: 1.5) : null,
              ),
              child: Row(
                children: [
                  Text('${i + 1}',
                      style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: fg)),
                  const SizedBox(width: 5),
                  Text(_stepNames[i],
                      style: TextStyle(fontSize: 12, color: fg)),
                  if (done) const SizedBox(width: 3),
                  if (done)
                    Icon(Icons.check, size: 12, color: scheme.onPrimary),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// 步⑥成片入口：有项目则给通告板入口，否则给诚实等待
class _FinalStep extends ConsumerWidget {
  const _FinalStep({required this.workId});
  final String? workId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(mvWizardProvider(workId));
    final p = state.project;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.movie_filter_outlined,
                size: 42, color: context.mvTextMuted),
            const SizedBox(height: 12),
            Text(
              p == null ? '先完成前面的确认门' : '开机后进入异步制作',
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: context.mvTextSecondary),
            ),
            const SizedBox(height: 8),
            Text(
              p == null
                  ? '定妆拍板 → 剧本 → 报价开机，每一步都需你在卡片上拍板。'
                  : '拍摄 / 对口型 / 合成为分钟级异步工程，可离开 App，'
                      '完成后由通知拉回验收（一期通知栈复用）。',
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 12.5, color: context.mvTextMuted, height: 1.5),
            ),
            const SizedBox(height: 14),
            if (p != null)
              FilledButton.icon(
                onPressed: () => MvProgressPage.push(context, projectId: p.id),
                icon: const Icon(Icons.dashboard_outlined, size: 18),
                label: const Text('剧组通告板（进度）'),
              ),
          ],
        ),
      ),
    );
  }
}
