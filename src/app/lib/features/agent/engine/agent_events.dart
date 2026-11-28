/// 智能体事件流（纯 Dart，禁止 import material —— 方案 §11.1）。
///
/// 两条投影分家（方案 §3.4 第 4 条）：
/// * [AgentEvent.userLabel] 是**唯一允许上屏**的文案 —— 不含引擎名/模型名/
///   工具名/协议名（方案 §11.5 黑话纪律）；
/// * 其余机器字段（`toolName` 等）只供日志与诊断，UI 直接渲染即违规。
///
/// 三分类与 `ignorable`（方案 §3.4 第 1 条）：structural 与 log-only 事件
/// `ignorable = true`（不进模型历史、只作审计）；surface 事件（正文）为 false。
/// 新增事件类型必须显式登记 kind，未登记的按 log-only 处理。
///
/// UI 侧配色请用 `CreationPalette` 令牌（方案 §11.2）：
/// 完成=green、进行=cyan、待确认=amber、跳过=faint。
library;

/// 回合收尾原因。
enum AgentStopReason {
  /// 模型给出正文，正常收口。
  completed,

  /// 撞到预算护栏（步数/token/成本/工具次数）。
  budget,

  /// 所有可用能力都被熔断，无以为继。
  toolsExhausted,

  /// 传输层失败（连不上服务端 / 代理 4xx-5xx）。
  transport,

  /// 灰度未开放（服务端按 404 处理）：这条路此刻不存在，UI 要给「切回标准流程」的出路。
  unavailable,

  /// 模型既没给正文也没给工具调用。
  empty,

  /// 澄清题已交给界面，本轮就地收口等用户点选（方案 §6.1）。
  ///
  /// 为什么要单列一种、而不是复用 `completed`：这一轮**没说完**，只是停在「等用户点一下」。
  /// 界面据此把注意力留在提问卡上（不去催模型再补一句），审计据此知道后面的沉默是应该的；
  /// 宿主也据此不要把「工具结果发回模型再跑一轮」当成正常收口 —— 那样模型只会替用户选。
  awaitingUser,
}

/// 智能体过程事件。UI 按 [kind] 分派渲染，按 [userLabel] 出文案。
sealed class AgentEvent {
  const AgentEvent({this.userLabel = '', this.ignorable = true});

  /// 机器可读的事件类型（对齐服务端 assistant_events 的三分类）。
  String get kind;

  /// 上屏文案 —— 人话，无技术黑话。
  final String userLabel;

  /// 是否「不进模型历史、只作审计留痕」。
  final bool ignorable;

  @override
  String toString() => '$kind: $userLabel';
}

/// 一次用户回合开始。
final class AgentTurnStarted extends AgentEvent {
  const AgentTurnStarted({required this.turnIndex, required this.preview})
      : super(userLabel: '我在想这件事');

  @override
  String get kind => 'turn/start';

  final int turnIndex;
  final String preview;
}

/// 一个模型步开始。
final class AgentStepStarted extends AgentEvent {
  const AgentStepStarted({required this.step, required this.totalCap})
      : super(userLabel: '正在整理下一步');

  @override
  String get kind => 'step/start';

  final int step;
  final int totalCap;
}

/// 模型思考留痕。⚠️ 只能折叠展示，**永远不是回复内容**（方案附录 A）。
final class AgentReasoningRecorded extends AgentEvent {
  const AgentReasoningRecorded({required this.step, required this.preview})
      : super(userLabel: '助手想了一下');

  @override
  String get kind => 'agent/thinking';

  final int step;

  /// 截断后的摘要，供「展开看过程」用。
  final String preview;
}

/// 模型的正文回复。
final class AgentAssistantText extends AgentEvent {
  const AgentAssistantText({required this.step, required this.text})
      : super(userLabel: '', ignorable: false);

  @override
  String get kind => 'assistant';

  final int step;
  final String text;
}

/// 一次能力调用开始。`toolName` 只供日志，上屏用 [AgentEvent.userLabel]。
final class AgentToolStarted extends AgentEvent {
  const AgentToolStarted({
    required this.toolName,
    required this.callId,
    required super.userLabel,
  });

  @override
  String get kind => 'tool/call';

  final String toolName;
  final String callId;
}

/// 一次能力调用结束。
final class AgentToolFinished extends AgentEvent {
  const AgentToolFinished({
    required this.toolName,
    required this.callId,
    required this.ok,
    required this.preview,
    required super.userLabel,
  });

  @override
  String get kind => 'tool/result';

  final String toolName;
  final String callId;
  final bool ok;
  final String preview;
}

/// 同一工具连续失败到达阈值 → 本回合起不再调用它（方案 §3.6 工具级熔断）。
final class AgentToolCircuitBroken extends AgentEvent {
  const AgentToolCircuitBroken({
    required this.toolName,
    required this.consecutiveFailures,
    required super.userLabel,
  });

  @override
  String get kind => 'tool/circuit_open';

  final String toolName;
  final int consecutiveFailures;
}

/// 模型喊了一个不存在的工具名 → 弃用并留痕，不执行、不猜（方案 §3.6 自建护栏）。
final class AgentToolDeprecated extends AgentEvent {
  const AgentToolDeprecated({
    required this.toolName,
    required this.firstTime,
    required super.userLabel,
  });

  @override
  String get kind => 'tool/deprecated';

  final String toolName;

  /// 首次出现才播报一次，重复幻觉只留痕。
  final bool firstTime;
}

/// 上下文压缩发生（追加遮蔽，不改写原文）。
final class AgentContextCompacted extends AgentEvent {
  const AgentContextCompacted({
    required this.tokensBefore,
    required this.tokensAfter,
    required this.droppedItems,
  }) : super(userLabel: '我把前面聊过的内容压缩了一下');

  @override
  String get kind => 'context/compact';

  final int tokensBefore;
  final int tokensAfter;
  final int droppedItems;
}

/// 预算护栏拦下了一次动作（断流前的最后一枚事件）。
final class AgentBudgetBlocked extends AgentEvent {
  const AgentBudgetBlocked({required this.detail, required super.userLabel});

  @override
  String get kind => 'agent/budget_blocked';

  final String detail;
}

/// 一次工具调用被跳过（熔断中 / 次数已到顶）。
final class AgentToolSkipped extends AgentEvent {
  const AgentToolSkipped({
    required this.toolName,
    required this.reason,
    required super.userLabel,
  });

  @override
  String get kind => 'tool/skipped';

  final String toolName;
  final String reason;
}

/// 撞步数上限后注入收敛指令（不死停，逼模型用已有信息收口 —— 方案 §3.1）。
final class AgentConvergenceInjected extends AgentEvent {
  const AgentConvergenceInjected({required this.wrapup})
      : super(userLabel: '我把这一段收个尾');

  @override
  String get kind => 'agent/converge';

  final int wrapup;
}

/// 技能装载结果（首次装载 / 同会话去重命中）。
final class AgentSkillLoaded extends AgentEvent {
  const AgentSkillLoaded({required this.skillName, required this.deduped})
      : super(userLabel: '这套做法我已经记着了');

  @override
  String get kind => 'skill/loaded';

  final String skillName;
  final bool deduped;
}

/// 回合结束。
final class AgentTurnFinished extends AgentEvent {
  const AgentTurnFinished({
    required this.stopReason,
    required this.steps,
    required this.text,
  }) : super(userLabel: '');

  @override
  String get kind => 'turn/end';

  final AgentStopReason stopReason;
  final int steps;
  final String text;
}
