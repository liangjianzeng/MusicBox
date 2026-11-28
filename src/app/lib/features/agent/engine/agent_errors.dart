/// 预算护栏异常（纯 Dart —— 方案 §3.6「TurnMeter 是读数不是闸门」的直接回应）。
///
/// 端侧必须有**硬闸门**：每回合 token/成本/步数/调用次数超限即断流并抛出
/// [AgentBudgetExceededException]。文案的诚实性由 [budgetMessageIsHonest] 锁死，
/// 单测与服务端验收共用同一条判据。
library;

import 'agent_transport.dart';

/// 撞的是哪一道闸。
enum AgentBudgetKind { steps, tokens, cost, toolCalls }

/// 回合预算超限。
///
/// ⚠️ 文案红线（方案 §0.3「施工期核实与更正」第 3 条）：额度是**账号级**累计，
/// 所以**不得**许诺「新开会话就能继续」—— 那等于把用户支使去撞第二道墙。
class AgentBudgetExceededException implements Exception {
  const AgentBudgetExceededException({
    required this.kind,
    required this.limit,
    required this.used,
    this.steps = 0,
    this.usage = AgentUsage.zero,
    this.partialText = '',
    this.toolName,
  });

  final AgentBudgetKind kind;

  /// 触发的上限值。
  final num limit;

  /// 触发时的实际读数。
  final num used;

  final int steps;
  final AgentUsage usage;

  /// 断流前已经拿到的部分回复（UI 该显示还是要显示，别吞）。
  final String partialText;

  /// 成本/调用次数类超限时相关的工具名（只供日志，不上屏）。
  final String? toolName;

  String get _detail => switch (kind) {
        AgentBudgetKind.steps => '本轮最多走 $limit 步，已经走满（实际 $steps 步）',
        AgentBudgetKind.tokens => '本轮最多用 $limit 个用量单位，已经用到 $used',
        AgentBudgetKind.cost => '本轮最多花 $limit 份用量，已经花到 $used',
        AgentBudgetKind.toolCalls => '本轮最多查 $limit 次，已经查到 $used',
      };

  /// 给用户看的说明。刻意不含引擎名/模型名/工具名（方案 §11.5）。
  String get message => '本轮已经到达助手用量护栏（$_detail），我就此停下——'
      '没做完的部分我不会说成做完了。'
      '这是护栏不是故障：它按账号算，新开一对话也不会绕过去。'
      '你可以把要求说得更具体些、让我少查几步，或者稍后再试。';

  @override
  String toString() => message;
}

/// 预算文案的**诚实性判据**（单测与服务端验收共用，对齐 V35-⑱e 的做法）。
///
/// 必须：说明是护栏 + 说明额度按账号累计；
/// 禁止：许诺「新开会话 / 新建会话 / 另开会话 → 就能继续」这类假出路。
bool budgetMessageIsHonest(String text) {
  if (!text.contains('护栏')) return false;
  if (!text.contains('按账号')) return false;
  // 「换个对话就能继续」是最常见的假承诺，说法五花八门，变体一律堵死。
  // 判据从「账号累计」改成「按账号」（2026-11-28 产品拍板：智能体里一个字都不提钱），
  // 诚实性没降：仍然如实说是护栏、仍然按账号算、仍然不许诺换对话能继续。
  final falsePromise =
      RegExp(r'(新开会话|新建会话|另开会话|重新开会话|新开一对话|开新对话|换个对话|换个会话|新对话)[^。；;！!？?]{0,10}(就能|即可|就会|可以|便可|能|会)(继续|恢复|接着|重新开始)');
  if (falsePromise.hasMatch(text)) return false;
  // 这类说法只允许出现在否定句里（"新开一对话也不会绕过去"）。
  for (final m in RegExp('新开会话|新开一对话|开新对话|换个对话|换个会话|新对话').allMatches(text)) {
    final tail = text.substring(
        m.end, m.end + 6 < text.length ? m.end + 6 : text.length);
    if (!tail.contains('不会') && !tail.contains('不能') && !tail.contains('无法')) {
      return false;
    }
  }
  return true;
}

/// 传输/引擎层的运行失败（连不上服务端等）。与「预算护栏」严格区分：
/// 护栏是**我们主动停**，故障是**做不了**。
class AgentEngineException implements Exception {
  const AgentEngineException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'AgentEngineException($code): $message';
}
