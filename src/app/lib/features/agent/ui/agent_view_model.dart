import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/state.dart';
import '../../create/style_options.dart';

// ═══════════════════════════════════════════════════════════════════════════
// 第 0 段 · 引擎对接面（集成时**只改这一段**）
// ═══════════════════════════════════════════════════════════════════════════
//
// 引擎由 `features/agent/engine/`（另一位同事并行实现，方案 §3）提供，契约签名
// 由 lead 定死：AgentTurnDraft / AgentToolCall / sealed AgentEvent（子类
// TurnStarted·AssistantTextDelta·ToolCallRequested·ToolResultReceived·
// TurnFinished·NeedsUserAnswer·BudgetExceeded）/ AgentSession。
//
// 下面这段是 **UI 侧的契约占位声明**，让界面能先落地、先跑测试。集成时做一件事：
//   删掉第 0 段全部声明，改成 `import '../engine/agent_engine.dart';`
// 若引擎的类名/字段与这里有出入，同样只改本文件——`ui/` 下其余文件一律只认
// [AgentUiState] 与 [AgentUiController]，不 import 任何引擎类型。
//
// ⚠️ 2026-11-27 20:12 核实：`engine/agent_events.dart` 已落地，但它的事件 taxonomy
// 与本契约**不同名**（`AgentTurnStarted / AgentStepStarted / AgentReasoningRecorded /
// AgentAssistantText / AgentToolStarted / AgentToolFinished / AgentToolSkipped /
// AgentToolCircuitBroken / AgentToolDeprecated / AgentContextCompacted /
// AgentConvergenceInjected / AgentBudgetBlocked / AgentSkillLoaded / AgentTurnFinished`，
// 每条自带 `kind` + **人话 `userLabel`**），且 `engine/` 里**没有** `AgentSession`。
// 引擎还在改，所以 UI 不在这里 import 它，
// 否则引擎同事改一个类名就把界面测试带崩。集成时在本文件写一层薄适配（约 20 行）：
//
//   AgentTurnStarted        → TurnStarted(turnId: e.turnIndex)
//   AgentAssistantText      → AssistantTextDelta(e.text)           // 正文才可上屏
//   AgentReasoningRecorded  → 只更新 draft.reasoning，**永不上屏**
//   AgentToolStarted        → ToolCallRequested(AgentToolCall(id: e.callId, name: e.toolName))
//                             （步骤文案用 e.userLabel，**不要用 e.toolName**）
//   AgentToolFinished       → ToolResultReceived(toolCallId: e.callId, ok: e.ok, summary: e.userLabel)
//   AgentToolSkipped        → ToolResultReceived(..., skipped: true)
//   AgentBudgetBlocked      → BudgetExceeded(reason: e.userLabel, wayOut: …)
//   AgentTurnFinished       → TurnFinished(ok: e.stopReason == completed || awaitingUser,
//                             reply: e.text, usedTool: e.steps > 0, mode: …)
//   澄清题（三题）：模型调 `tools/ask_tools.dart` 的 `agent.ask_user` 出题，由**会话层**
//   （`agent_bootstrap.dart`）调正式入口 [AgentUiController.applyQuestions] 发
//   `NeedsUserAnswer(questions)`；用户点选后同样由会话层攒成**一条用户消息**送回 `send`。
//   P3 的意图卡答题通道（`answerIntentInternal`）仍然并存，走 [AgentSession.answer] 的
//   非提问卡分支。
//
// 纪律：引擎事件里的 `reasoning` 只用于"助手在想"占位，**永不作为回复上屏**
// （方案 §1.2 / V35-㉟：reasoning 永不当回复）。

/// 一次工具调用（引擎原样透传；界面上只出现 [agentHumanToolLabel] 换算后的人话）。
class AgentToolCall {
  const AgentToolCall({
    required this.id,
    required this.name,
    this.arguments = const <String, dynamic>{},
    this.label,
  });

  final String id;
  final String name;
  final Map<String, dynamic> arguments;

  /// 引擎带来的**人话**步骤名（工具的 `activityLabel`）。
  /// 有它就用它：那条文案与工具本体写在同一处，改工具的人只会改那一处；
  /// 界面上这张对照表只剩兜底作用（真机上「我把这次要做的事列成清单了」就是在这儿
  /// 被换成一句含糊的「助手正在办一件事」，用户看不出这颗卡到底办了什么）。
  final String? label;
}

/// 本回合的草稿（流式累积）。`reasoning` 不上屏，只用来判断"助手还在想"。
class AgentTurnDraft {
  const AgentTurnDraft({
    this.content,
    this.reasoning,
    this.toolCalls = const <AgentToolCall>[],
  });

  final String? content;
  final String? reasoning;
  final List<AgentToolCall> toolCalls;

  bool get thinking => (content == null || content!.isEmpty) && toolCalls.isEmpty;

  AgentTurnDraft withDelta(String delta) => AgentTurnDraft(
        content: '${content ?? ''}$delta',
        reasoning: reasoning,
        toolCalls: toolCalls,
      );

  AgentTurnDraft withTool(AgentToolCall call) => AgentTurnDraft(
        content: content,
        reasoning: reasoning,
        toolCalls: <AgentToolCall>[...toolCalls, call],
      );
}

/// 引擎事件流（子类与 lead 定的清单一致，勿增删）。
sealed class AgentEvent {
  const AgentEvent();
}

class TurnStarted extends AgentEvent {
  const TurnStarted({this.turnId = 0});
  final int turnId;
}

class AssistantTextDelta extends AgentEvent {
  const AssistantTextDelta(this.text);
  final String text;
}

class ToolCallRequested extends AgentEvent {
  const ToolCallRequested(this.call);
  final AgentToolCall call;
}

class ToolResultReceived extends AgentEvent {
  const ToolResultReceived({
    required this.toolCallId,
    this.ok = true,
    this.summary,
    this.skipped = false,
    this.label,
  });

  final String toolCallId;
  final bool ok;

  /// 服务端给的**人话**摘要（已过 lex.sanitize）；为空则界面上不追加内容。
  final String? summary;

  /// 该步没做（例如越界被拒），界面上标"跳过"而不是失败堆栈。
  final bool skipped;

  /// 这一步的人话名字。**必须有**：入参不合格、被跳过、模型喊了一个不存在的capability
  /// 这几类结果**不会**先来一条 [ToolCallRequested]，界面若只认"已存在的步骤"就会整条丢掉 ——
  /// 真机上"模型明明试过了，屏幕上连一张卡都没出现过"就是这么来的。
  final String? label;
}

class TurnFinished extends AgentEvent {
  const TurnFinished({
    this.ok = true,
    this.reply,
    this.usedTool = false,
    this.gated = false,
    this.mode,
    this.notice,
  });

  final bool ok;

  /// 本回合终稿（与流式增量二选一：给了就以它为准）。
  final String? reply;

  /// 本回合是否真的动过工具（板块小助手据此判断"它答不上来"）。
  final bool usedTool;

  /// 命中付费/能力闸门被挡（方案 §2.3 的上交触发条件之一）。
  final bool gated;

  /// 'llm+rule' / 'rule'（界面只翻成「AI 对话」/「基础模式」，不外泄实现名）。
  final String? mode;

  final String? notice;
}

class NeedsUserAnswer extends AgentEvent {
  const NeedsUserAnswer(this.questions, {this.lead});

  /// 服务端形状的澄清题：
  /// `{q_idx, q, options:[{idx,label,set:{…}}], recommended_idx}`（契约 v5.5.9）。
  final List<dynamic> questions;

  /// 助手在题目上方想说的一句话。
  final String? lead;
}

class BudgetExceeded extends AgentEvent {
  const BudgetExceeded({this.reason, this.wayOut});

  final String? reason;

  /// 必须给出路（§11.5：空态与失败态必须给下一步，不许只报错）。
  final String? wayOut;
}

/// 服务端已把这条建议落成一张**确认票**挂在界面上（简报卡里会长出「就按这张票办」）。
///
/// 真机上断掉的就是这一条：`music.propose_generate` 回了一句"等服务端出确认票"，
/// 而这张票从来没有人去要 —— 于是界面既没有票、也没有任务，用户点完了所有能点的。
class TicketIssued extends AgentEvent {
  const TicketIssued(this.ticket, {this.startedWork = false});

  final AgentTicketInfo ticket;

  /// 用户在主 CTA 上已经拍过板、服务端已验票开工（此时不再要他点第二遍）。
  final bool startedWork;
}

/// 一张票被消费掉了（服务端验过票、也真的动过手）。
///
/// [jobId] 非空 = **服务端建出了任务**，这是界面上那句「已经开始做了」的唯一凭据：
/// 它不许由模型的措言、也不许由"用户点过钮了"这一步推导出来 —— 真机上坏就坏在
/// 拿"用户点过了"当"活开始了"。[jobId] 为空表示这张票只是改了一张单子。
class TicketSettled extends AgentEvent {
  const TicketSettled({
    required this.ticketId,
    this.jobId,
    this.intentId,
    this.count,
    this.sec,
    this.reply,
  });

  final String ticketId;
  final String? jobId;
  final String? intentId;
  final int? count;
  final int? sec;

  /// 服务端替助手说的那句人话（已过禁词表）；为空则用界面自己那句。
  final String? reply;
}

/// 端侧引擎的会话接口（唯一依赖面）。
abstract class AgentSession {
  Stream<AgentEvent> get events;
  Future<void> send(String text);

  /// 选择某题的某个选项（optionIdx 为 null 表示"这题不选"）。
  Future<void> answer(int qIdx, int? optionIdx);

  /// 跳过某题（服务端按 recommended_idx 填，方案 §1.4）。
  Future<void> skipQuestion(int qIdx);

}

/// 「用户亲自在主 CTA 上拍过板」这件事的出口（由宿主实现的可选能力）。
///
/// 为什么需要它：方案 D-2 把"出曲前"的总确认定成**一次**（简报卡），而方案 §6.5 又要求
/// "派单永远走票"。两者不冲突 —— 人只拍一次板，票照发：这一句就是告诉宿主
/// 「这一轮用户已经按过那颗钮了，草稿可以直接开工，不必再让他点第二遍」。
///
/// 它是**一次性**的（宿主用完即销），而且模型没有任何途径把它写成 true：
/// 它是界面 → 宿主的一条方法调用，不在模型能填的任何入参里。
abstract class AgentBriefApproval {
  void grantBriefApproval();
}

/// 确认票通道（拍板权在人）。引擎契约里没有票的确认方法，所以界面对接的是
/// 这个由集成方注入的窄接口（现网 `AssistantApiClient.confirmTicket/denyTicket`
/// 可直接适配），不在 [AgentSession] 上私自发明方法。
abstract class AgentTicketGateway {
  Future<void> confirm(String ticketId);
  Future<void> deny(String ticketId);
}

/// 「会话自己带得出票面通道」这件事（宿主接上了出票通道时才实现它）。
///
/// 为什么要有它：`agentTicketGatewayProvider` 以前恒为 null，而没人 override 过它 ——
/// 于是 `_runTicket` 拿到 null 就 `return`，**用户点「就按这张票办」时屏幕上连一句
/// "我做不到"都没有**。现在默认从会话身上取，接线方漏 override 也不会再出现死钮。
abstract class AgentTicketCapableSession {
  AgentTicketGateway get ticketGateway;
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 段 · 文案净化（§11.5 黑话纪律）
// ═══════════════════════════════════════════════════════════════════════════

final List<RegExp> _agentBannedAscii = [
  RegExp(r'\btool[\s_-]?calls?\b', caseSensitive: false),
  RegExp(r'\bfunction[\s_-]?calls?\b', caseSensitive: false),
  RegExp(r'\breasoning[\s_-]?tokens?\b', caseSensitive: false),
  RegExp(r'\btokens?\b', caseSensitive: false),
  RegExp(r'\bskills?\b', caseSensitive: false),
  RegExp(r'\bmodels?\b', caseSensitive: false),
  RegExp(r'\bllms?\b', caseSensitive: false),
  RegExp(r'\blanes?\b', caseSensitive: false),
  RegExp(r'\bapis?\b', caseSensitive: false),
  RegExp(r'\bprompts?\b', caseSensitive: false),
  RegExp(r'(searxng|vllm|llama|gguf|nvfp4|int8|qwen[\w.-]*|deepseek|gpt[\s-]?[\d.]*|ace[\s_-]?step|comfyui|whisper|sherpa)', caseSensitive: false),
];
const List<String> _agentBannedAsciiRepl = [
  '要办的事',
  '要办的事',
  '思考用量',
  '字数',
  '配方',
  '后台',
  '后台',
  '路线',
  '服务',
  '说明',
  '后台',
];

/// 只作用于「助手/服务端回传的字符串」的幂等禁词过滤（与 mvHuman 同思路）。
/// **不要**用在语音控件自己的文案上（那句"到「我的 · 语音能力」下载模型"是成品话术）。
String agentHuman(String? raw) {
  var s = (raw ?? '').trim();
  if (s.isEmpty) return s;
  for (var i = 0; i < _agentBannedAscii.length; i++) {
    s = s.replaceAll(_agentBannedAscii[i], _agentBannedAsciiRepl[i]);
  }
  // 内部能力名（`music.propose_generate` 这种 `命名段.名字` 形状）不许上屏：引擎把工具自报的
  // 降级拼成「能力名：那句话」直接进告警，念出来就是把内部名念给了用户（§11.5 黑话纪律）。
  // 只认**已知的命名段**（工具名都出自这几个命名空间），刻意不写宽的 `[a-z]+\.[a-z]+` ——
  // 宽版会把用户/助手句子里的「wikipedia.com」「1.5 分钟」这类一起咬掉，那是另一种难读。
  s = s.replaceAllMapped(
    RegExp(r'\b(?:music|agent|mv|job|jobs|catalog|knowledge|memory|intent|library|skill|skills|works)\.[a-z][a-z0-9_.]*\b'),
    (_) => '这一步',
  );
  // 拍板权在人：智能体不得宣布"办成了"（CONTRACTS.md:828）。
  s = s
      .replaceAll('已完成', '已提交确认')
      .replaceAll('已生成', '已提交确认')
      .replaceAll('已出歌', '已提交确认')
      .replaceAll('大模型', '助手')
      .replaceAll('引擎', '后台')
      .replaceAll('意图卡', '灵感卡')
      .replaceAll('意图', '想法');
  return s;
}

/// 工具名 → 人话。界面**绝不**把引擎内部名（`music.set_card` 之类）显示给用户。
String agentHumanToolLabel(String name) {
  const map = <String, String>{
    'library.search': '我去曲库里找了一下',
    'knowledge.web_search': '我去查了一下外面的说法',
    'music.set_card': '我把你的想法记进卡里',
    'music.set_title': '我改好了标题',
    'music.adjust_params': '我调了要用的说法',
    'music.memory': '我看了看你平时的偏好',
    'memory_set': '我记下了你的偏好',
    'memory_get': '我看了看你的偏好',
    'memory_delete': '我删掉了那条偏好',
    'load_skill': '我翻出常用的做法',
    // 提问卡这一步必须有一句自己的人话：落到兜底那句「助手正在办一件事」，
    // 用户会不知道屏幕上突然出现的三张卡片是谁在问什么（§11.5：步骤要说人话）。
    'agent.ask_user': '我把要问你的事列成了选项',
    'music.generate': '我准备把这首歌做出来',
    'music.propose_card_patch': '我把这张任务单整理好了',
    'music.propose_generate': '我把这次要做的事列成清单了',
    'mv.propose_shot_rework': '我把这个镜头要改的地方写好了',
    'catalog.lookup': '我核对了能用的说法',
    'job.status': '我看了一眼进度',
    'intent.read': '我又看了一眼那张任务单',
    'memory.write': '我记下了你的偏好',
    'memory.forget': '我把那条偏好撤掉了',
  };
  for (final e in map.entries) {
    if (e.key == name) return e.value;
  }
  // 未知工具一律收敛成一句人话：宁可含糊，也不外泄内部名（§11.5）。
  return '助手正在办一件事';
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 2 段 · UI 视图模型（界面只认这一段）
// ═══════════════════════════════════════════════════════════════════════════

/// 澄清题的选项：`{idx, label, set:{…}}`。
/// 选项自带生效参数（契约 v5.5.9），界面**不靠**猜 label 字面。
class AgentAskOption {
  const AgentAskOption({
    required this.idx,
    required this.label,
    this.set = const <String, dynamic>{},
  });

  final int idx;
  final String label;

  /// 生效载荷（`tags_add/genre_add/mood_add/vocal/bpm/sec/count`）。
  /// 只用于算简报，键名永不上屏。
  final Map<String, dynamic> set;

  factory AgentAskOption.fromMap(Map m) {
    final s = m['set'];
    return AgentAskOption(
      idx: m['idx'] is num ? (m['idx'] as num).toInt() : int.tryParse('${m['idx']}') ?? 0,
      label: '${m['label'] ?? ''}'.trim(),
      set: s is Map
          ? s.map((k, v) => MapEntry('$k', v))
          : const <String, dynamic>{},
    );
  }
}

class AgentAskQuestion {
  const AgentAskQuestion({
    required this.qIdx,
    required this.title,
    required this.options,
    this.recommendedIdx,
    this.hint,
  });

  final int qIdx;
  final String title;
  final List<AgentAskOption> options;
  final int? recommendedIdx;

  /// 题目下的一行补充（可选，说人话）。
  final String? hint;

  factory AgentAskQuestion.fromMap(Map m, {int fallbackIdx = 0}) {
    final opts = (m['options'] as List? ?? const [])
        .whereType<Map>()
        .map(AgentAskOption.fromMap)
        .toList(growable: false);
    final rec = m['recommended_idx'] ?? m['recommendedIdx'];
    return AgentAskQuestion(
      qIdx: m['q_idx'] is num
          ? (m['q_idx'] as num).toInt()
          : int.tryParse('${m['q_idx']}') ?? fallbackIdx,
      title: agentHuman('${m['q'] ?? m['title'] ?? ''}'),
      options: opts,
      recommendedIdx: rec == null
          ? null
          : (rec is num ? rec.toInt() : int.tryParse('$rec')),
      hint: m['note'] == null ? null : agentHuman('${m['note']}'),
    );
  }

  AgentAskOption? get recommended {
    final r = recommendedIdx;
    if (r == null) return null;
    for (final o in options) {
      if (o.idx == r) return o;
    }
    return null;
  }

  AgentAskOption? optionAt(int idx) {
    for (final o in options) {
      if (o.idx == idx) return o;
    }
    return null;
  }
}

enum AgentEntryRole { user, assistant, notice }

class AgentChatEntry {
  const AgentChatEntry({
    required this.id,
    required this.role,
    required this.text,
  });

  final String id;
  final AgentEntryRole role;
  final String text;
}

enum AgentStepState { running, done, awaiting, skipped }

class AgentStep {
  const AgentStep({
    required this.id,
    required this.label,
    required this.state,
    this.detail,
  });

  final String id;
  final String label;
  final AgentStepState state;
  final String? detail;
}

/// 简报里的一行「将要生效」的参数。value 必须是人话，键名不外泄。
class AgentBriefRow {
  const AgentBriefRow(this.label, this.value);
  final String label;
  final String value;
}

class AgentTicketInfo {
  const AgentTicketInfo({
    required this.id,
    required this.actionLabel,
    this.credits,
    this.diff,
    this.minutes,
    this.status = 'pending',
    this.busy = false,
    this.count,
    this.sec,
    this.jobId,
  });

  final String id;
  final String actionLabel;
  final String? diff;
  final int? credits;
  final int? minutes;

  /// pending / confirmed / denied / succeeded …
  final String status;
  final bool busy;

  /// 服务端定下来的**权威**条数与时长（随票回带）。界面念的数、模型念的数、真正派单的数
  /// 必须由它出：三方各报一个数就是真机上「简报说 3 首、模型草稿说 1 条」那个自相矛盾。
  final int? count;
  final int? sec;

  /// 票消费后服务端建出的任务编号（有它才可以说「已经开始做了」）。
  final String? jobId;

  bool get pending => status == 'pending';
  bool get settled => status == 'succeeded' || status == 'confirmed';
}

enum AgentPhase { idle, thinking, awaitingAnswer, awaitingConfirm }

/// 界面唯一读取的状态。
class AgentUiState {
  const AgentUiState({
    this.entries = const [],
    this.draft,
    this.steps = const [],
    this.questions = const [],
    this.answers = const {},
    this.skipped = const {},
    this.askLead,
    this.askLocked = false,
    this.briefRows = const [],
    this.briefHeadline = '',
    this.ticket,
    this.phase = AgentPhase.idle,
    this.sending = false,
    this.confirming = false,
    this.confirmed = false,
    this.error,
    this.mode,
  });

  final List<AgentChatEntry> entries;

  /// 正在流出的本回合草稿（`reasoning` 永不上屏）。
  final AgentTurnDraft? draft;
  final List<AgentStep> steps;

  /// 主动提问卡片区（至多 3 题，与聊天同屏）。
  final List<AgentAskQuestion> questions;
  final Map<int, int> answers;
  final Set<int> skipped;
  final String? askLead;
  final bool askLocked;

  final List<AgentBriefRow> briefRows;
  final String briefHeadline;
  final AgentTicketInfo? ticket;
  final AgentPhase phase;
  final bool sending;
  final bool confirming;
  final bool confirmed;
  final String? error;
  final String? mode;

  bool get busy => sending || confirming;
  bool get hasDraftText => (draft?.content?.trim().isNotEmpty ?? false);
  /// 简报卡出现条件**不含价格**：没定下参数之前，不该为了念账本而把卡撑出来。
  bool get showBrief => briefRows.isNotEmpty || ticket != null;

  int get unansweredCount {
    var n = 0;
    for (final q in questions) {
      if (!answers.containsKey(q.qIdx) && !skipped.contains(q.qIdx)) n++;
    }
    return n;
  }

  bool get questionsAnswered => questions.isNotEmpty && unansweredCount == 0;

  /// 主 CTA 是否可点 + 不可点的原因（§11.6：不可点的件必须说清为什么）。
  ({bool enabled, String reason}) get confirmGate {
    if (confirming) return (enabled: false, reason: '正在提交你的确认');
    if (confirmed) return (enabled: false, reason: '已经交给你拍板过了');
    if (sending) return (enabled: false, reason: '助手还在说，稍等一下');
    if (questions.isNotEmpty && !questionsAnswered) {
      return (enabled: false, reason: '还有 $unansweredCount 题没答，可以点「跳过这题」');
    }
    // 这里**不看价格**（2026-11-28 产品拍板）：还没产出任何东西之前，主 CTA 不许被
    // "价格没取到 / 还在读 / 余额不够"扣住 —— 那是把计费台当成了产品。
    // 钱只由服务端裁决：真不够时它拒绝，失败原话经 _fail 如实上屏，不在此预演。
    return (enabled: true, reason: '');
  }

  AgentUiState copyWith({
    List<AgentChatEntry>? entries,
    AgentTurnDraft? draft,
    bool clearDraft = false,
    List<AgentStep>? steps,
    List<AgentAskQuestion>? questions,
    Map<int, int>? answers,
    Set<int>? skipped,
    String? askLead,
    bool clearAskLead = false,
    bool? askLocked,
    List<AgentBriefRow>? briefRows,
    String? briefHeadline,
    AgentTicketInfo? ticket,
    bool clearTicket = false,
    AgentPhase? phase,
    bool? sending,
    bool? confirming,
    bool? confirmed,
    String? error,
    bool clearError = false,
    String? mode,
  }) {
    return AgentUiState(
      entries: entries ?? this.entries,
      draft: clearDraft ? null : (draft ?? this.draft),
      steps: steps ?? this.steps,
      questions: questions ?? this.questions,
      answers: answers ?? this.answers,
      skipped: skipped ?? this.skipped,
      askLead: clearAskLead ? null : (askLead ?? this.askLead),
      askLocked: askLocked ?? this.askLocked,
      briefRows: briefRows ?? this.briefRows,
      briefHeadline: briefHeadline ?? this.briefHeadline,
      ticket: clearTicket ? null : (ticket ?? this.ticket),
      phase: phase ?? this.phase,
      sending: sending ?? this.sending,
      confirming: confirming ?? this.confirming,
      confirmed: confirmed ?? this.confirmed,
      error: clearError ? null : (error ?? this.error),
      mode: mode ?? this.mode,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 3 段 · 控制器（吃引擎事件，吐 AgentUiState）
// ═══════════════════════════════════════════════════════════════════════════

/// 出曲前确认时发给引擎的那句话（引擎据此走确认票 → 派单，永远先票后扣费）。
const String kAgentConfirmUtterance = '就用这些，开始做';

/// 伴创一次问齐的题数（方案 §6.1：伴创卡 ask_budget=3；板块小助手 0 题=单轮）。
const int kAgentAskBudget = 3;

class AgentUiController extends StateNotifier<AgentUiState> {
  AgentUiController({
    required AgentSession session,
    int askBudget = kAgentAskBudget,
    AgentTicketGateway? tickets,
    StyleCatalog? styleCatalog,
  })  : _session = session,
        _askBudget = askBudget,
        _tickets = tickets,
        _catalog = styleCatalog ?? StyleCatalog.fallback,
        super(const AgentUiState()) {
    _sub = _session.events.listen(_onEvent, onError: (Object e) {
      state = state.copyWith(
        error: '助手这边断了一下，再说一遍就行',
        sending: false,
        phase: AgentPhase.idle,
        clearDraft: true,
      );
    });
  }

  final AgentSession _session;
  final int _askBudget;
  final AgentTicketGateway? _tickets;
  final StyleCatalog _catalog;

  /// 界面读状态的唯一入口（`state` 是 StateNotifier 的 protected 成员，
  /// 只允许子类与测试访问；widget 一律走这个只读快照）。
  AgentUiState get snapshot => state;

  /// widget 侧的重建句柄。`state_notifier` 自带一套 addListener，**不是** Flutter 的
  /// [Listenable]，所以 `ListenableBuilder` 要拿这个包一层再用。
  /// 缓存同一个实例：每次 build 新建会让 ListenableBuilder 反复摘挂监听。
  late final Listenable listenable = _ControllerListenable(this);

  StreamSubscription<AgentEvent>? _sub;
  int _entrySeq = 0;

  /// 「服务端真的建出了任务」的凭据，只由 [TicketSettled] 置位。
  /// 拍板之后界面上那句话必须看它说话：真机上坏就坏在拿"用户点过了"当"活开始了"。
  bool _workStarted = false;
  int? _workCount;
  bool _ticketPending = false;

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  // ── 用户动作 ────────────────────────────────────────────────────────────

  Future<void> send(String text) async {
    final t = text.trim();
    if (t.isEmpty || state.busy) return;
    _workStarted = false;
    _workCount = null;
    _ticketPending = false;
    _push(AgentEntryRole.user, t);
    state = state.copyWith(
      entries: state.entries,
      sending: true,
      phase: AgentPhase.thinking,
      clearError: true,
      clearDraft: true,
    );
    try {
      await _session.send(t);
    } catch (_) {
      _fail('没发出去，检查一下网络再试一次');
    } finally {
      if (state.sending) {
        state = state.copyWith(sending: false, phase: AgentPhase.idle);
      }
    }
  }

  /// 选项作答：本地立刻回显（不等网络），再落服务端。
  Future<void> selectOption(int qIdx, int optionIdx, {bool silent = false}) async {
    if (state.askLocked) return;
    state = state.copyWith(
      answers: <int, int>{...state.answers, qIdx: optionIdx},
      skipped: state.skipped.difference({qIdx}),
      phase: AgentPhase.awaitingAnswer,
    );
    _rebuildBrief();
    try {
      await _session.answer(qIdx, optionIdx);
    } catch (_) {
      _fail('这一题没记上，再点一次就好');
    }
  }

  /// 跳过 = 按推荐答案填（方案 §1.4 标准档同款语义），界面上要说清"用推荐的"。
  Future<void> skipQuestion(int qIdx) async {
    if (state.askLocked) return;
    state = state.copyWith(
      skipped: <int>{...state.skipped, qIdx},
      phase: AgentPhase.awaitingAnswer,
    );
    _rebuildBrief();
    try {
      await _session.skipQuestion(qIdx);
    } catch (_) {
      _fail('跳过没生效，再点一次就好');
    }
  }

  /// 简报卡上唯一一次总确认（拍板权在人：按钮文案永远是"待你确认"这一侧）。
  ///
  /// 方案 D-2 把"出曲前"的总确认定成**一次**，方案 §6.5 又要求"派单永远走票"：这里就是
  /// 那"一次"。按下它 = 人已经拍板，宿主于是拿到一次性授权，草稿直接换票开工，
  /// 不再要用户点第二遍（真机上用户点完这颗钮之后，屏幕上就再没有任何可点的东西了）。
  ///
  /// 收尾那句话**必须对得上服务端真做了什么**，三种可能各说各的实话：
  ///  · 服务端建出了任务 → 说「已排队」；
  ///  · 只换出一张待点的票 → 说「还差你点一下」，并把那颗钮留在屏幕上；
  ///  · 什么都没换出来 → 说「这次没真的开工」，**并且这颗钮还得能再按**。
  ///    旧代码在这里一律写 `confirmed: true`，于是"活没开始"和"已经办完"在屏幕上长得一样，
  ///    用户连重试的入口都没有 —— 那条断头路的最后一米就是这一步。
  Future<void> confirmBrief() async {
    final gate = state.confirmGate;
    if (!gate.enabled || state.busy) return;
    // 「会话」与「拍板授权」是两件事：宿主实现了才认，没实现就当没这个能力
    // （测试里的假会话、以及灰度没接线的会话都走这条 —— 缺能力必须退化成"再点一次"，
    //   而不是把用户困在一张点了没反应的卡上）。
    final session = _session;
    if (session is AgentBriefApproval) {
      (session as AgentBriefApproval).grantBriefApproval();
    }
    _workStarted = false;
    _workCount = null;
    _ticketPending = false;
    state = state.copyWith(
      confirming: true,
      phase: AgentPhase.awaitingConfirm,
      clearError: true,
    );
    _push(AgentEntryRole.user, kAgentConfirmUtterance);
    try {
      await _session.send(kAgentConfirmUtterance);
      final started = _workStarted;
      final ticketed = _ticketPending || (state.ticket?.pending ?? false);
      state = state.copyWith(
        confirming: false,
        confirmed: started || ticketed,
        phase: AgentPhase.idle,
        askLocked: started,
      );
      _push(
        AgentEntryRole.notice,
        // 这句是"人拍过板 + 服务端真建出了任务"才配说的；条数用服务端回带的那个，
        // 不用模型草稿里的（简报卡念 3 首、模型念 1 条那种自相矛盾就是这么来的）。
        started
            ? (_workCount == null
                ? '已按你确认的这份交给后台排队，做好我会在这里放出来'
                : '已按你确认的这份交给后台排队，出 $_workCount 条候选，做好我会在这里放出来')
            : (ticketed
                ? '还差你一下：按上面那张票点「就按这张票办」，我立刻开工。'
                : '这次没真的开工：我这边没拿到可以做活的清单。你再点一次上面那颗钮，或直接说一句「照刚才那版开始做」。'),
      );
    } catch (_) {
      state = state.copyWith(confirming: false, phase: AgentPhase.idle);
      _fail('这份没交上去，检查网络后点「重新提交」');
    }
  }

  Future<void> confirmTicket(String id) => _runTicket(id, true);
  Future<void> denyTicket(String id) => _runTicket(id, false);

  Future<void> _runTicket(String id, bool yes) async {
    final g = _tickets;
    if (g == null) {
      // 票面通道没接上 = 这颗钮按下去**什么都不发生**。那正是"用户点完了所有能点的、
      // 活却没开始"的另一半成因：宁可明说这条路没接上并给出去向，也绝不静默吞掉用户的点选。
      _fail('确认的通道没接上，这颗钮我这边点不动；回标准创作流程点「开始做」可以照常出歌。');
      _push(AgentEntryRole.notice, '确认的通道没接上，这一步我这边点不动。');
      return;
    }
    final t = state.ticket;
    state = state.copyWith(
      ticket: t == null
          ? null
          : AgentTicketInfo(
              id: t.id,
              actionLabel: t.actionLabel,
              diff: t.diff,
              credits: t.credits,
              minutes: t.minutes,
              status: t.status,
              busy: true,
            ),
    );
    try {
      if (yes) {
        _workStarted = false;
        _workCount = null;
        await g.confirm(id);
        // 「真开工」的凭据是宿主在网关里发回来的 [TicketSettled] 事件；
        // 这里不替服务端宣布开工，也不许因为"用户点了"就写"已经开始做"。
        _push(AgentEntryRole.notice, _workStarted
            ? '已按你的确认交给后台去做：${_workCount == null ? '正在排队' : '$_workCount 条候选正在排队'}，好了我会放在这里等你听。'
            : '这张票我已经交给后台，这一步按你说的办了。');
        if (!_workStarted) {
          state = state.copyWith(
            ticket: AgentTicketInfo(id: id, actionLabel: '', status: 'confirmed'),
          );
        }
      } else {
        await g.deny(id);
        _push(AgentEntryRole.notice, '已按你的意思撤掉这一步');
        state = state.copyWith(
          ticket: AgentTicketInfo(id: id, actionLabel: '', status: 'denied'),
        );
      }
    } catch (_) {
      _fail('这一步没处理成，可以重试');
    }
  }

  /// 集成方告诉界面当前是对话模式还是本地兜底模式（不外泄实现名）。
  void setMode(String? mode) {
    state = state.copyWith(mode: mode);
  }

  // ── 引擎事件 → 状态 ─────────────────────────────────────────────────────

  /// 集成热点：引擎事件形状若有出入，只改这个函数。
  void _onEvent(AgentEvent e) {
    switch (e) {
      case TurnStarted():
        state = state.copyWith(
          phase: AgentPhase.thinking,
          sending: true,
          clearDraft: true,
          clearError: true,
          steps: <AgentStep>[
            ...state.steps.map((s) =>
                s.state == AgentStepState.running
                    ? AgentStep(id: s.id, label: s.label, state: AgentStepState.done, detail: s.detail)
                    : s),
          ],
        );

      case AssistantTextDelta(:final text):
        final d = (state.draft ?? const AgentTurnDraft()).withDelta(text);
        state = state.copyWith(draft: d, phase: AgentPhase.thinking);

      case ToolCallRequested(:final call):
        final step = AgentStep(
          id: call.id.isEmpty ? 'step_${state.steps.length}' : call.id,
          // 引擎带来的 activityLabel 优先（它与工具本体写在一起，改工具只会改那一处）；
          // 界面这张对照表只兜"会话自己造出来的步骤"与测试里的假会话。
          label: (call.label?.trim().isNotEmpty ?? false)
              ? agentHuman(call.label!)
              : agentHumanToolLabel(call.name),
          state: AgentStepState.running,
        );
        state = state.copyWith(
          steps: <AgentStep>[...state.steps, step],
          draft: (state.draft ?? const AgentTurnDraft()).withTool(call),
          phase: AgentPhase.thinking,
        );

      case ToolResultReceived(:final toolCallId, :final ok, :final summary, :final skipped, :final label):
        final stepState =
            skipped || !ok ? AgentStepState.skipped : AgentStepState.done;
        final known = state.steps.any((s) => s.id == toolCallId);
        state = state.copyWith(
          steps: <AgentStep>[
            ...state.steps.map((s) => s.id == toolCallId
                ? AgentStep(
                    id: s.id,
                    label: s.label,
                    state: stepState,
                    detail: summary == null ? null : agentHuman(summary),
                  )
                : s),
            // 没有开头却有结果 = 引擎确实试过了这一步，界面必须留痕，不许整条吞掉。
            if (!known)
              AgentStep(
                id: toolCallId,
                label: (label?.trim().isNotEmpty ?? false)
                    ? agentHuman(label!)
                    : '助手试了一步，没走通',
                state: stepState,
                detail: summary == null ? null : agentHuman(summary),
              ),
          ],
        );
        if (skipped && ok) {
          _push(AgentEntryRole.notice, '有一步先放着没做，不影响继续往下');
        } else if (!ok) {
          _push(AgentEntryRole.notice, '有一步没办成，我换个说法再试');
        }

      case NeedsUserAnswer(:final questions, :final lead):
        applyQuestions(questions, lead: lead);

      case TurnFinished(:final reply, :final mode, :final notice):
        final text = (reply ?? state.draft?.content ?? '').trim();
        if (text.isNotEmpty) {
          _push(AgentEntryRole.assistant, agentHuman(text));
        }
        if (notice != null && notice.trim().isNotEmpty) {
          _push(AgentEntryRole.notice, agentHuman(notice));
        }
        state = state.copyWith(
          sending: false,
          clearDraft: true,
          phase: state.questions.isNotEmpty && !state.questionsAnswered
              ? AgentPhase.awaitingAnswer
              : AgentPhase.idle,
          mode: mode == null
              ? null
              : (mode == 'rule' ? '基础模式' : 'AI 对话'),
        );
      case TicketIssued(:final ticket, :final startedWork):
        // 票挂上界面：简报卡里会长出「就按这张票办」那颗钮（AgentBriefCard → AgentTicketFace）。
        _ticketPending = ticket.pending && !startedWork;
        state = state.copyWith(
          ticket: ticket,
          phase: ticket.pending && !startedWork
              ? AgentPhase.awaitingConfirm
              : state.phase,
        );
        if (ticket.pending && !startedWork && !state.confirming) {
          _push(AgentEntryRole.notice,
              '这条我先写成了一张票，按上面那颗「就按这张票办」点下去我才开工。');
        }

      case TicketSettled(:final ticketId, :final jobId, :final count, :final sec, :final reply):
        _ticketPending = false;
        if (jobId != null && jobId.isNotEmpty) {
          _workStarted = true;
          _workCount = count;
        }
        if (!state.confirming) {
          _push(
            AgentEntryRole.notice,
            jobId != null && jobId.isNotEmpty
                ? '已经开始做了：${count == null ? '正在排队' : '$count 条候选正在排队'}，好了我会放在这里等你听。'
                : ((reply?.trim().isNotEmpty ?? false)
                    ? agentHuman(reply!)
                    : '这一步已经按你确认的办好了。'),
          );
        }
        // 票收成"已办成"并留下任务编号 —— 刻意**不带** clearTicket：
        // copyWith 里 `clearTicket ? null : …` 会把手上这份覆盖掉（票面一闪就没的那种 bug）。
        state = state.copyWith(
          ticket: AgentTicketInfo(
            id: ticketId,
            actionLabel: '',
            status: 'succeeded',
            jobId: jobId,
            count: count,
            sec: sec,
          ),
          phase: AgentPhase.idle,
        );

      case BudgetExceeded(:final reason, :final wayOut):
        final r = agentHuman(reason ?? '这一轮想得有点多了');
        final w = agentHuman(wayOut ?? '你可以把要求说短一点，或者让我分两步做');
        _push(AgentEntryRole.notice, '$r · $w');
        state = state.copyWith(
          error: '$r · $w',
          sending: false,
          phase: AgentPhase.idle,
          clearDraft: true,
        );
    }
  }

  /// 会话层把澄清题推给界面（**正式入口**）：三题与聊天同屏，
  /// 题量夹到 askBudget（伴创 3、板块小助手 0 —— 封顶形态不问）。
  void applyQuestions(List<dynamic> raw, {String? lead}) {
    if (_askBudget <= 0) {
      state = state.copyWith(
        questions: const [],
        answers: const {},
        skipped: const <int>{},
        clearAskLead: true,
      );
      return;
    }
    final list = <AgentAskQuestion>[];
    for (var i = 0; i < raw.length && list.length < _askBudget; i++) {
      final m = raw[i];
      if (m is! Map) continue;
      final q = AgentAskQuestion.fromMap(m, fallbackIdx: i);
      if (q.options.isEmpty || q.options.length > 4) continue; // 契约 v1：每题 2–4 项
      list.add(q);
    }
    if (list.isEmpty) return;
    state = state.copyWith(
      questions: list,
      askLead: lead == null ? null : agentHuman(lead),
      phase: AgentPhase.awaitingAnswer,
      askLocked: false,
    );
    _rebuildBrief();
  }

  /// 简报 = 选项自带的 set 载荷 + 默认值（不问 BPM/时长/候选数，方案 §6.1）。
  void _rebuildBrief() {
    final mood = <String>{};
    final genre = <String>{};
    final craft = <String>{};
    final who = <String>{};
    int? bpm;
    int? sec;
    int? count;
    String? vocal;

    for (final q in state.questions) {
      final idx = state.answers[q.qIdx];
      if (idx == null) continue;
      final opt = q.optionAt(idx);
      if (opt == null) continue;
      final set = opt.set;
      void addAll(Object? v, void Function(String) to) {
        if (v is List) {
          for (final e in v) {
            final s = '$e'.trim();
            if (s.isNotEmpty) to(s);
          }
        } else if (v is String && v.trim().isNotEmpty) {
          to(v.trim());
        }
      }

      addAll(set['mood_add'] ?? set['mood'], (s) {
        final zh = _zhTag(s);
        if (zh != null) mood.add(zh);
      });
      addAll(set['genre_add'], (s) {
        final zh = _zhTag(s);
        if (zh != null) genre.add(zh);
      });
      addAll(set['tags_add'], (s) {
        final zh = _zhTag(s);
        if (zh == null) return;
        // 性别/唱法类词不进"曲风"，钉死 IA review #1「勾女声出男声」那条路径
        // （cap=3 + a 优先导致的静默丢词，UI 侧也绝不把「女声」当流派显示）。
        final wire = (_catalog.wireFor(s) ?? s).toLowerCase();
        if (wire.contains('vocal') ||
            wire.contains('choir') ||
            wire.contains('child')) {
          who.add(zh);
        } else {
          craft.add(zh);
        }
      });
      final v = set['vocal'];
      if (v is String && v.isNotEmpty) vocal = v;
      bpm = _asInt(set['bpm']) ?? bpm;
      sec = _asInt(set['sec']) ?? sec;
      count = _asInt(set['count']) ?? count;
    }

    // 跳过（用推荐答案）的题也要进简报——"待你确认"的东西必须看得见。
    for (final q in state.questions) {
      if (!state.skipped.contains(q.qIdx)) continue;
      final rec = q.recommended;
      if (rec == null) continue;
      for (final e in <String>['mood_add', 'mood']) {
        final raw = rec.set[e];
        if (raw is List) {
          _addTag(raw, mood.add);
        }
      }
      final g = rec.set['genre_add'];
      if (g is List) {
        _addTag(g, genre.add);
      }
      final t = rec.set['tags_add'];
      if (t is List) {
        _addTag(t, (zh) {
          final wire = (_catalog.wireFor(zh) ?? zh).toLowerCase();
          if (wire.contains('vocal') ||
              wire.contains('choir') ||
              wire.contains('child')) {
            who.add(zh);
          } else {
            craft.add(zh);
          }
        });
      }
      final rv = rec.set['vocal'];
      if (rv is String && rv.isNotEmpty) vocal = rv;
      bpm = _asInt(rec.set['bpm']) ?? bpm;
      sec = _asInt(rec.set['sec']) ?? sec;
      count = _asInt(rec.set['count']) ?? count;
    }

    // 条数以**服务端回带的权威值**为准；没出过票才回落平台默认 3
    // （= 服务端 config.gen.count_default，两边同一个真源）。真机上这里显示 3、
    // 模型草稿说「候选条数：1 条」，就是因为两边各自取了自己的默认值。
    final n = state.ticket?.count ?? count ?? 3;
    final rows = <AgentBriefRow>[
      if (mood.isNotEmpty) AgentBriefRow('情绪基调', mood.join(' / ')),
      if (who.isNotEmpty)
        AgentBriefRow('谁来唱', who.join(' / ')),
      if (vocal != null)
        AgentBriefRow('要不要人声', vocal == 'instrumental' ? '纯音乐，不唱' : '有人唱'),
      if (genre.isNotEmpty) AgentBriefRow('曲风', genre.join(' / ')),
      if (craft.isNotEmpty) AgentBriefRow('质感说法', craft.join(' / ')),
      if (bpm != null) AgentBriefRow('快慢', '$bpm'),
      if (sec != null) AgentBriefRow('时长', '$sec 秒左右'),
      AgentBriefRow('出几首', '$n 首挑着听'),
      ...state.briefRows.where((r) => r.label == '助手补充'),
    ];
    final head = <String>[
      if (mood.isNotEmpty) mood.first,
      if (genre.isNotEmpty) genre.first,
      if (sec != null) '${sec}s',
      '$n 首',
    ].join(' · ');
    state = state.copyWith(
      briefRows: rows,
      briefHeadline: head,
    );
  }

  /// 助手补充说明（例如检索后写回的说明）——集成方可注入，界面上单独一行。
  void setSupplement(String? text) {
    final t = agentHuman(text);
    state = state.copyWith(
      briefRows: <AgentBriefRow>[
        ...state.briefRows.where((r) => r.label != '助手补充'),
        if (t.isNotEmpty) AgentBriefRow('助手补充', t),
      ],
    );
  }

  int? _asInt(Object? v) {
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v.trim());
    return null;
  }

  /// 词 → 中文。**没翻成中文的 tag 一律不上屏**（§6.4「别给英文 tag 裸串」）：
  /// 本地兜底目录只有几百个词，真线上用 `GET /v1/app/config` 的 `style_options`
  /// 全量目录，正常不会丢词。
  String? _zhTag(Object? raw) {
    final s = '${raw ?? ''}'.trim();
    if (s.isEmpty) return null;
    final zh = _catalog.zhFor(s).trim();
    if (zh.isEmpty || RegExp('[A-Za-z]').hasMatch(zh)) return null;
    return zh;
  }

  void _addTag(Iterable<Object?> raw, void Function(String) to) {
    for (final e in raw) {
      final zh = _zhTag(e);
      if (zh != null) to(zh);
    }
  }

  void _push(AgentEntryRole role, String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    state = state.copyWith(
      entries: <AgentChatEntry>[
        ...state.entries,
        AgentChatEntry(id: 'e${_entrySeq++}', role: role, text: t),
      ],
    );
  }

  void _fail(String msg) {
    state = state.copyWith(
      error: msg,
      sending: false,
      confirming: false,
      phase: AgentPhase.idle,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 4 段 · 接线点（lead 在 root_shell / 创建页第四档里 override 这三个）
// ═══════════════════════════════════════════════════════════════════════════

/// 伴创会话（引擎的 AgentSession 实例）。默认不提供——必须由接线方
/// `agentSessionProvider.overrideWithValue(session)`，这样"关档"和"没接线"
/// 在 UI 上是同一种表现（整页给出路，而不是崩）。
final agentSessionProvider = Provider<AgentSession>((ref) {
  throw UnimplementedError('智能体未接线：请在 root_shell 里 overrideWithValue(AgentSession)');
});

/// 确认票通道（复用统一助手的票面通道即可）。
///
/// 默认从会话自己身上要：宿主装配时若把出票通道接上了，会话就把配套的票面通道一并交出来
/// （`AgentBridgeSession` 实现了 [AgentTicketCapableSession]）。接线方不必再单独 override；
/// 灰度没接上时会话给不出，这里回 null —— 此时那颗钮按下去会**明说**通道没接上，
/// 不会静默什么都不发生（真机上"点完了所有能点的、活却没开始"的另一半成因）。
final agentTicketGatewayProvider = Provider<AgentTicketGateway?>((ref) {
  try {
    final s = ref.watch(agentSessionProvider);
    if (s is AgentTicketCapableSession) return (s as AgentTicketCapableSession).ticketGateway;
  } catch (_) {
    // 智能体整条没接线：与"没有票面通道"是同一种表现（整页给出路，而不是崩）。
  }
  return null;
});
final agentUiProvider =
    StateNotifierProvider<AgentUiController, AgentUiState>((ref) {
  return AgentUiController(
    session: ref.watch(agentSessionProvider),
    tickets: ref.watch(agentTicketGatewayProvider),
    styleCatalog: styleCatalogOfConfig(ref.watch(remoteConfigProvider)),
  );
});


/// 把 [StateNotifier] 的监听口适配成 Flutter 的 [Listenable]（只此一处，UI 不感知）。
/// `state_notifier` 的 addListener 收的是 `Listener<T>` 并**返回**反注册函数，
/// 所以这里自己记住每个 VoidCallback 对应的反注册句柄。
class _ControllerListenable implements Listenable {
  _ControllerListenable(this._notifier);
  final AgentUiController _notifier;
  final _removers = <VoidCallback, void Function()>{};

  @override
  void addListener(VoidCallback listener) {
    if (_removers.containsKey(listener)) return;
    _removers[listener] =
        _notifier.addListener((_) => listener(), fireImmediately: false);
  }

  @override
  void removeListener(VoidCallback listener) {
    _removers.remove(listener)?.call();
  }
}
