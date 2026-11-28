import 'package:flutter/material.dart';

import '../../create/creation_ui.dart';
import '../../../shared/widgets/primary_button.dart';
import 'agent_view_model.dart';

/// 任务简报卡 = 出曲前的**唯一一次总确认**（方案 §6.6 / D-2）。
///
/// 三条硬要求：
/// 1. 摊开"将要生效的全部参数"（含被跳过的题——用推荐值也要看得见）；
/// 2. **不呈现计费**：不报单价/合计/余额，也不写"何时扣费"（2026-11-28 产品拍板：
///    没产出任何东西之前不给用户看账本）。钱只由服务端裁决，不够时它的原话如实上屏；
/// 3. 拍板权在人：按钮永远站在"待你确认"这一侧，界面不出现"已生成/已完成"。
///
/// 确认走票后落在卡内的票面（§11.4：不用弹框审批），与 v5.0「先票后办」同源。
class AgentBriefCard extends StatelessWidget {
  const AgentBriefCard({
    super.key,
    required this.state,
    required this.controller,
    this.title = '开始做之前，先看一眼这份简报',
  });

  final AgentUiState state;
  final AgentUiController controller;
  final String title;

  @override
  Widget build(BuildContext context) {
    final gate = state.confirmGate;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: CreationPalette.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: CreationPalette.border),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.assignment_outlined,
                  size: 15, color: CreationPalette.violet),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                    color: CreationPalette.text,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _StatusChip(state: state),
            ],
          ),
          if (state.briefHeadline.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                state.briefHeadline,
                style: const TextStyle(
                  color: CreationPalette.faint,
                  fontSize: 11.5,
                ),
              ),
            ),
          const SizedBox(height: 8),
          if (state.briefRows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 6),
              child: Text(
                '还没定下什么。先把上面的问题选完，或者直接在下面说一句。',
                style: TextStyle(
                  color: CreationPalette.faint,
                  fontSize: 12.5,
                  height: 1.4,
                ),
              ),
            )
          else
            for (final row in state.briefRows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 74,
                      child: Text(
                        row.label,
                        style: const TextStyle(
                          color: CreationPalette.faint,
                          fontSize: 12,
                        ),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        row.value,
                        style: const TextStyle(
                          color: CreationPalette.text,
                          fontSize: 12.5,
                          height: 1.35,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          if (state.ticket != null && state.ticket!.pending) ...[
            const SizedBox(height: 10),
            AgentTicketFace(ticket: state.ticket!, controller: controller),
          ],
          const SizedBox(height: 12),
          Semantics(
            button: true,
            enabled: gate.enabled,
            hint: gate.enabled ? null : gate.reason,
            label: '就用这些，开始做（待你确认）',
            child: PrimaryButton(
              text: state.confirmed
                  ? '已交给你确认过'
                  : (state.confirming ? '正在提交你的确认…' : '就用这些，开始做'),
              big: true,
              gradient: true,
              icon: Icons.auto_awesome_rounded,
              loading: state.confirming,
              onPressed: gate.enabled ? () => controller.confirmBrief() : null,
            ),
          ),
          if (!gate.enabled && gate.reason.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child: Text(
                gate.reason,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: CreationPalette.faint,
                  fontSize: 11.5,
                  height: 1.35,
                ),
              ),
            ),
          const SizedBox(height: 4),
          const Text(
            '你点一下我才动手。',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: CreationPalette.faint,
              fontSize: 11,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.state});
  final AgentUiState state;

  @override
  Widget build(BuildContext context) {
    final (text, color) = state.confirmed
        ? ('已提交确认', CreationPalette.green)
        : (state.confirming
            ? ('提交中', CreationPalette.cyan)
            : ('待你确认', CreationPalette.amber));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: .35)),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 10.5,
          color: color,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

/// 票面（§11.4：工具审批不用弹框，走既有票面形态）。
class AgentTicketFace extends StatelessWidget {
  const AgentTicketFace({
    super.key,
    required this.ticket,
    required this.controller,
  });

  final AgentTicketInfo ticket;
  final AgentUiController controller;

  @override
  Widget build(BuildContext context) {
    final busy = ticket.busy;
    return Container(
      decoration: BoxDecoration(
        color: CreationPalette.raised,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: CreationPalette.amber.withValues(alpha: .3)),
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.fact_check_outlined,
                  size: 14, color: CreationPalette.amber),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  ticket.actionLabel.isEmpty ? '要办的一步' : ticket.actionLabel,
                  style: const TextStyle(
                    color: CreationPalette.text,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const Text(
                '待你确认',
                style: TextStyle(
                  color: CreationPalette.amber,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          if ((ticket.diff ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text(
                ticket.diff!,
                style: const TextStyle(
                  color: CreationPalette.muted,
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 5),
            child: Text(
              // 票面只说"要办什么、大约多久"，不印价目（2026-11-28 产品拍板）。
              ticket.minutes == null ? '' : '大约 ${ticket.minutes} 分钟',
              style: const TextStyle(
                color: CreationPalette.faint,
                fontSize: 11,
              ),
            ),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Semantics(
                button: true,
                enabled: !busy,
                hint: busy ? '正在处理这张票' : null,
                label: '不要这一步',
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(10),
                    onTap: busy ? null : () => controller.denyTicket(ticket.id),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      child: Text(
                        '不要这一步',
                        style: TextStyle(
                          color: CreationPalette.muted,
                          fontSize: 12.5,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Flexible 是必需的，不是排版偏好：Row 给非 flex 子件的是**无界宽度**，
              // 而 PrimaryButton 内部那行用了 Flexible 文案 —— 无界 + flex 直接炸断言
              // （'RenderFlex children have non-zero flex but incoming width constraints
              // are unbounded'）。这张票面此前从没被渲染过一次（服务端压根没发过票），
              // 所以这颗钮第一次真的出现在屏幕上时，是把布局炸掉的 —— 崩在这里等于
              // 又一条"票在屏幕上却点不动"的断头路。
              Flexible(
                child: Semantics(
                  button: true,
                  enabled: !busy,
                  hint: busy ? '正在处理这张票' : null,
                  label: '就按这张票办',
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: PrimaryButton(
                      text: '就按这张票办',
                      expand: false,
                      onPressed: busy ? null : () => controller.confirmTicket(ticket.id),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
