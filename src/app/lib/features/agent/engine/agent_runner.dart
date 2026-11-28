/// 端侧智能体主循环（纯 Dart，禁止 import material —— 方案 §3.1 / §3.6）。
///
/// 形态：多回合「模型 → 工具 → 回填 → 再问模型」，直到模型自己收口或撞护栏。
///
/// 四条**必须自建**的闸门（TongYi-Lite 一条都没有，方案 §3.6）：
/// 1. 每回合 token / 成本硬闸门（它的 `TurnMeter` 只是读数，我们这里是闸门）；
/// 2. 步数上限 + 撞上限不死停的收敛注入（wrap-up），仍不收口则抛预算异常；
/// 3. **工具级连续失败熔断**：同一工具连续失败 ≥ [AgentEngineConfig.consecutiveFailureLimit]
///    次 → 本回合起对该工具直接停止调用（回填「已停用」而不是真去调）；
/// 4. 单回合工具调用总次数 / 单工具调用次数上限（联网类尤其要封）。
///
/// ⚠️ 思考模型的回复纪律（方案附录 A，本项目实测确认）：
/// 回复**只**取 `message.content`；`reasoning` 只发 [AgentReasoningRecorded] 事件，
/// 永不进回复、永不回填模型。`content ?? reasoning` 那种兜底是错的。
library;

import 'dart:async';

import '../agent_config.dart';
import '../skills/skill_provider.dart';
import 'agent_errors.dart';
import 'agent_events.dart';
import 'agent_guardrails.dart';
import 'agent_messages.dart';
import 'agent_registry.dart';
import 'agent_tool.dart';
import 'agent_transport.dart';

/// 事件出口（UI 侧订阅后按 [AgentEvent.userLabel] 渲染，配色走 CreationPalette）。
typedef AgentEventSink = void Function(AgentEvent event);

/// 一次回合的结果。
class AgentRunResult {
  const AgentRunResult({
    required this.text,
    required this.stopReason,
    required this.usage,
    required this.steps,
    required this.newMessages,
    this.loadedSkills = const [],
    this.deprecatedTools = const [],
    this.trippedTools = const [],
    this.budget,
    this.transportError,
    this.sessionId,
    this.warnings = const [],
  });

  /// 本回合的**可归因降级**清单（工具少做了什么、为什么）。界面可提示，审计可追责。
  final List<String> warnings;

  /// 服务端创建/复用的智能体会话 id（宿主该存下来，下一回合带回来）。
  final String? sessionId;

  /// 给用户看的正文。**永不含 reasoning**。
  final String text;

  final AgentStopReason stopReason;
  final AgentUsage usage;
  final int steps;

  /// 本次回合新增的消息（含 user / assistant / tool），供服务端事件镜像（§3.4）。
  final List<AgentChatMessage> newMessages;

  final List<String> loadedSkills;
  final List<String> deprecatedTools;
  final List<String> trippedTools;

  /// [stopReason] == budget 时携带（runGuarded 用）。
  final AgentBudgetExceededException? budget;

  /// 传输失败时的可读原因。
  final String? transportError;

  /// 本回合正常问完（正文给了用户）或被澄清题就地收口 —— 两种都算办成了。
  ///
  /// `awaitingUser` 不是失败：题已经挂到用户眼前了，剩下的沉默是在等人，不是在等模型。
  bool get ok =>
      stopReason == AgentStopReason.completed ||
      stopReason == AgentStopReason.awaitingUser;
}

/// 主循环。
class AgentRunner {
  AgentRunner({
    required AgentTransport transport,
    required AgentToolRegistry registry,
    AgentEngineConfig config = const AgentEngineConfig(),
    AgentGuardrails? guardrails,
    AgentEventSink? onEvent,
    this.modelKey,
    this.systemPrompt,
    this.skillsCatalogText,
    this.memoryText,
    this.personaText,
    this.skillLedger,
  })  : _transport = transport,
        _registry = registry,
        _config = config,
        _guardrails = guardrails ?? config.buildGuardrails(),
        _onEvent = onEvent;

  final AgentTransport _transport;
  final AgentToolRegistry _registry;
  final AgentEngineConfig _config;
  final AgentGuardrails _guardrails;
  final AgentEventSink? _onEvent;

  /// 模型档位 key（注册表按模型层过滤用；null = 不分档）。
  final String? modelKey;

  /// 基础 system 段（不含人格/技能目录/记忆）。
  final String? systemPrompt;

  /// 技能目录（每回合常驻的一行短句集，方案 §4.1）。
  final String? skillsCatalogText;

  /// `music.memory` 注入段（方案 §4.7 缺口 B：置于纪律之前，且不得覆盖纪律）。
  final String? memoryText;

  /// 智能体人格（追加段，置于工具/审批纪律之前，方案 §2.4）。
  final String? personaText;

  /// 技能装载台账（用于「本回合装了哪些技能」与去重播报）。
  final SkillLoadLedger? skillLedger;

  /// `load_skill` 的注册名（引擎不 import tools/，按名字识别）。
  static const String loadSkillToolName = 'load_skill';

  /// `agent.ask_user` 的注册名（同上：按名字识别，不 import tools/）。
  ///
  /// 主循环认这个名字是为了「问完就地收口」：把工具结果再发回模型，它只会自问自答
  /// 替用户选一个（真机 K90 上就是这个现象）。这个名字与 `tools/ask_tools.dart` 里的
  /// `kAskUserToolName` 逐字一致 —— 引擎刻意不 import tools/，所以这份重复是有意的，
  /// 改一处必须改两处。
  static const String askUserToolName = 'agent.ask_user';

  void _emit(AgentEvent e) => _onEvent?.call(e);

  /// 跑一个用户回合。撞预算护栏**抛出** [AgentBudgetExceededException]。
  Future<AgentRunResult> run({
    /// 服务端返回过的会话 id；首次可为 null —— 服务端会创建并回传，后续步骤自动带上。
    String? sessionId,
    required String userText,
    List<AgentChatMessage> history = const [],
    String? systemPrompt,
    int? turnIndex,
    String? memoryTextOverride,
  }) async {
    final cfg = _config;
    var currentSessionId = sessionId;
    var forcedCompactions = 0;
    final turn = turnIndex ?? _historyTurn(history);
    final newMessages = <AgentChatMessage>[];
    if (userText.trim().isNotEmpty) newMessages.add(AgentChatMessage.user(userText));

    _emit(AgentTurnStarted(turnIndex: turn, preview: _clip(userText, 60)));

    final budget = _TurnBudget(cfg);
    final breaker = _ToolCircuitBreaker(cfg.consecutiveFailureLimit);
    final perToolCalls = <String, int>{};
    final loadedSkills = <String>[];
    final runWarnings = <String>[];
    var trippedOnlyRounds = 0; // 连续「只会调已停用能力」的轮数（连续两轮才收口）
    var step = 0;
    var wrapups = 0;
    var cap = cfg.maxStepsPerTurn; // 收敛轮会往上加（撞上限不死停）
    var partialText = '';

    AgentRunResult mk({
      required String text,
      required AgentStopReason reason,
      String? error,
      AgentBudgetExceededException? budgetError,
    }) =>
        AgentRunResult(
          text: text,
          stopReason: reason,
          usage: budget.usage,
          steps: step,
          newMessages: newMessages,
          loadedSkills: loadedSkills,
          deprecatedTools: _guardrails.unknownToolNames.toList(),
          trippedTools: breaker.tripped,
          budget: budgetError,
          transportError: error,
          sessionId: currentSessionId,
          warnings: List.unmodifiable(runWarnings),
        );

    String composedSystem() => composeAgentSystemPrompt(
          base: systemPrompt ?? this.systemPrompt,
          persona: personaText,
          memory: memoryTextOverride ?? memoryText,
          skillsCatalog: skillsCatalogText,
          extra: cfg.systemNotes,
        );

    while (true) {
      // ① 派发前硬闸门：上一轮读数超限就不许再发一次请求。
      _enforce(budget, partial: partialText);

      if (step >= cap) {
        if (wrapups >= cfg.maxWrapups) {
          throw _budgetStop(AgentBudgetKind.steps, cfg.hardStepCap, step, budget,
              partialText);
        }
        // 撞上限不死停：加一段收敛预算 + 注入收敛指令，逼模型用已有信息收口（方案 §3.1）。
        wrapups++;
        cap += cfg.wrapupSteps;
        newMessages.add(AgentChatMessage.user(
            '已达到本轮的步骤上限，请不要再调用任何能力，'
            '直接用你已经拿到的信息给出结论与下一步建议。'));
        _emit(AgentConvergenceInjected(wrapup: wrapups));
      }

      step++;
      _emit(AgentStepStarted(step: step, totalCap: cap));

      final rails = forcedCompactions > 0
          ? AgentGuardrails(
              contextTokenBudget:
                  (cfg.contextTokenBudget ~/ (2 * forcedCompactions)).clamp(1200, 1000000),
              toolResultMaxChars: cfg.toolResultMaxChars ~/ 2,
              keepRecentMessages: cfg.keepRecentMessages,
              maxArgumentRetries: cfg.maxArgumentRetries,
            )
          : _guardrails;
      final projection = rails.compact(
        messages: [...history, ...newMessages],
        systemPrompt: composedSystem(),
      );
      if (projection.compacted) {
        _emit(AgentContextCompacted(
          tokensBefore: projection.tokensBefore,
          tokensAfter: projection.tokensAfter,
          droppedItems: projection.droppedItems,
        ));
      }

      final request = AgentLlmRequest(
        sessionId: currentSessionId,
        turnIndex: turn,
        messages: projection.messages,
        tools: _registry.schemas(modelKey: modelKey),
        toolChoice: 'auto',
        maxTokens: cfg.maxTokensPerStep,
        thinkingEnabled: cfg.thinkingEnabled,
      );

      AgentLlmReply reply;
      try {
        reply = await _transport.complete(request);
      } on AgentBudgetExceededException {
        rethrow;
      } catch (e) {
        final te = e is AgentTransportException
            ? e
            : const AgentTransportException('NETWORK', '连不上服务，请稍后再试');
        // —— 分码处置（服务端 api/agent.js 的语义，一律不许「原样重试」蒙混）——
        if (te.sessionBroken) {
          // 409 SESSION_BROKEN：这是**预算护栏**，不是故障。文案必须诚实。
          final ex = AgentBudgetExceededException(
            kind: AgentBudgetKind.cost,
            limit: 0,
            used: budget.cost,
            steps: step,
            usage: budget.usage,
            partialText: partialText,
          );
          _emit(const AgentBudgetBlocked(detail: 'session_broken', userLabel: '这一轮到此为止了'));
          _emit(AgentTurnFinished(
              stopReason: AgentStopReason.budget, steps: step, text: ex.message));
          return mk(
              text: partialText.trim().isEmpty
                  ? ex.message
                  : '${partialText.trim()}\n\n${ex.message}',
              reason: AgentStopReason.budget,
              budgetError: ex);
        }
        if (te.grayedOff) {
          // 403/404：灰度没开 = 这条路此刻不存在 → 给出路，别让用户以为坏了。
          const text = '这条路现在没开放，我这边先不硬撑。'
              '你可以回到标准创作流程继续做，那边不受影响。';
          _emit(AgentTurnFinished(
              stopReason: AgentStopReason.unavailable, steps: step, text: text));
          return mk(text: text, reason: AgentStopReason.unavailable, error: te.message);
        }
        if (te.tooLarge && forcedCompactions < 2) {
          // 413：单回合过大 → 该压缩上下文再来一次，而不是原样重发（重试也白重试）。
          forcedCompactions++;
          step--;
          _emit(AgentContextCompacted(
            tokensBefore: projection.tokensAfter,
            tokensAfter: 0,
            droppedItems: 1,
          ));
          continue;
        }
        final why = te.message;
        _emit(AgentTurnFinished(
            stopReason: AgentStopReason.transport, steps: step, text: ''));
        final prefix = te.serviceUnavailable
            ? '理解服务这会儿没就绪，你的话我留着了 —— 稍等一下再发一次就行。'
            : '我没连上后台，这次没能答上来。';
        return mk(
            text: '$prefix$why',
            reason: AgentStopReason.transport,
            error: why);
      }
      // 服务端可能新建了会话：带回来，后续步骤与下一回合都复用它
      if (reply.sessionId != null && reply.sessionId!.isNotEmpty) {
        currentSessionId = reply.sessionId;
      }

      budget.addUsage(reply.usage);
      if (reply.hasReasoning) {
        // 只留痕，不进回复（方案附录 A 的陷阱就在这里处理）。
        _emit(AgentReasoningRecorded(step: step, preview: _clip(reply.reasoning, 240)));
      }
      if (reply.hasContent) partialText = reply.content.trim();
      if (reply.truncated) {
        partialText = partialText.isEmpty ? '（这次的内容被截断了）' : partialText;
      }

      // ② 读数落地后硬闸门：这一轮的 token/成本已超 → 立刻断流，不再回填续跑。
      _enforce(budget, partial: partialText);

      if (!reply.wantsTools) {
        final text = reply.content.trim();
        if (text.isEmpty) {
          // 诚实收口：宁可说「没能给出答复」，也**绝不**拿 reasoning 冒充回复。
          const fallback = '这次我没能给出可用的答复。'
              '你把要求再说具体一点，我重新来一次。';
          newMessages.add(AgentChatMessage.assistant(fallback));
          _emit(AgentAssistantText(step: step, text: fallback));
          _emit(AgentTurnFinished(
              stopReason: AgentStopReason.empty, steps: step, text: fallback));
          return mk(text: fallback, reason: AgentStopReason.empty);
        }
        newMessages.add(AgentChatMessage.assistant(text));
        _emit(AgentAssistantText(step: step, text: text));
        _emit(AgentTurnFinished(
            stopReason: AgentStopReason.completed, steps: step, text: text));
        return mk(text: text, reason: AgentStopReason.completed);
      }

      // 有工具调用：先落 assistant(带 tool_calls)，再逐段执行并回填。
      newMessages.add(AgentChatMessage.assistant(reply.content,
          toolCalls: reply.toolCalls));
      budget.stepsWithTools++;

      final calls = reply.toolCalls;
      var didRealWork = false; // 本轮是否真的执行过至少一条能力
      var askedUser = false; // 本步是否把澄清题交给了界面（见 askUserToolName）
      var i = 0;
      while (i < calls.length) {
        final end = _safeBatchEnd(calls, i);
        final batch = calls.sublist(i, end);
        // 并行安全的一起跑，不安全的单独跑（方案 §3.1 的 isConcurrencySafe 分批）。
        final produced = await Future.wait(
            batch.map((c) => _runToolCall(
                  call: c,
                  sessionId: sessionId,
                  turnIndex: turn,
                  step: step,
                  budget: budget,
                  breaker: breaker,
                  perToolCalls: perToolCalls,
                  loadedSkills: loadedSkills,
                  warnings: runWarnings,
                )));
        for (final o in produced) {
          if (o.message != null) newMessages.add(o.message!);
          if (o.executed) didRealWork = true;
          if (o.asked) askedUser = true;
        }
        i = end;
      }

      // 问完就地收口：题已经挂到用户眼前，接下来该发生的事是「等他点一下」，不是再问模型。
      // 走的是本文件已有的收口形状（`return mk(...)` + [AgentTurnFinished]），
      // 不另发明第二套停止逻辑 —— 多一套收口就多一处「谁也没想到它还会在这里结束」。
      //
      // 代价（明写）：同一条响应里排在 ask_user 之后的其它工具调用这一轮已经跑了，收不回；
      // 它们的结果仍留在 newMessages 里，下一回合模型看得见，所以不丢信息，只是白跑一步。
      // 题面与工具回填也都留在 newMessages 里：用户答完是**下一条用户消息**，
      // 模型需要看得到自己刚才问了什么，否则会对着一句「我选：…」猜题。
      if (askedUser) {
        final text = partialText.trim();
        _emit(AgentTurnFinished(
            stopReason: AgentStopReason.awaitingUser, steps: step, text: text));
        return mk(text: text, reason: AgentStopReason.awaitingUser);
      }

      // 熔断处置：本轮所有调用都撞在已停用的能力上 → 先给模型一次「用已有信息作答」的机会；
      // 连续两轮还是只会调已停用的能力，才如实收口（不硬撑到烧完预算）。
      final visibleNames = _registry.visible(modelKey: modelKey).map((t) => t.name).toSet();
      final allTripped =
          visibleNames.isNotEmpty && visibleNames.every(breaker.isTripped);
      // 只有「整轮一次真活都没干」（全被熔断挡回）才计数；
      // 首次触发熔断那一轮是干了活的，不算 —— 否则会把该给的收口机会吃掉。
      if (allTripped && !didRealWork) {
        trippedOnlyRounds++;
      } else if (!allTripped || didRealWork) {
        trippedOnlyRounds = 0;
      }
      if (allTripped && trippedOnlyRounds >= 2) {
        const text = '我把能用的几条路子都试过了，都没走通，就不继续试了。'
            '你换一个说法，或者稍后再让我试一次。';
        newMessages.add(AgentChatMessage.assistant(text));
        _emit(AgentAssistantText(step: step, text: text));
        _emit(AgentTurnFinished(
            stopReason: AgentStopReason.toolsExhausted, steps: step, text: text));
        return mk(text: text, reason: AgentStopReason.toolsExhausted);
      }
    }
  }

  /// 与 [run] 同义，但预算超限**不抛**，折成 [AgentRunResult]（stopReason=budget）。
  /// UI 的常规路径用它：断流了也要把已经拿到的东西显示出来。
  Future<AgentRunResult> runGuarded({
    String? sessionId,
    required String userText,
    List<AgentChatMessage> history = const [],
    String? systemPrompt,
    int? turnIndex,
    String? memoryText,
  }) async {
    try {
      return await run(
        sessionId: sessionId,
        userText: userText,
        history: history,
        systemPrompt: systemPrompt,
        turnIndex: turnIndex,
        memoryTextOverride: memoryText,
      );
    } on AgentBudgetExceededException catch (e) {
      final text = e.partialText.trim().isEmpty ? e.message : '${e.partialText}\n\n${e.message}';
      _emit(AgentTurnFinished(
          stopReason: AgentStopReason.budget, steps: e.steps, text: text));
      return AgentRunResult(
        text: text,
        stopReason: AgentStopReason.budget,
        usage: e.usage,
        steps: e.steps,
        newMessages: const [],
        deprecatedTools: _guardrails.unknownToolNames.toList(),
        budget: e,
        sessionId: sessionId,
      );
    }
  }

  // ------------------------------------------------------------- 工具执行

  Future<_CallOutcome> _runToolCall({
    required AgentToolCallDto call,
    required String? sessionId,
    required int turnIndex,
    required int step,
    required _TurnBudget budget,
    required _ToolCircuitBreaker breaker,
    required Map<String, int> perToolCalls,
    required List<String> loadedSkills,
    required List<String> warnings,
  }) async {
    final name = call.name.trim();
    AgentTool? tool;
    if (name.isEmpty) {
      return _CallOutcome(
          _backfill(call, name, '这次调用没写要用的能力名，我按未执行处理。'));
    }
    tool = _registry.lookup(name, modelKey: modelKey);

    // 护栏③：模型喊了不存在/被限制掉的能力 → 弃用并留痕，绝不执行、绝不猜。
    if (tool == null) {
      final firstTime = _guardrails.noteUnknownToolName(name);
      _registry.retire(name);
      _emit(AgentToolDeprecated(
        toolName: name,
        firstTime: firstTime,
        userLabel: firstTime ? '有个我用不上的路子，我跳过了' : '我跳过了一个用不上的路子',
      ));
      breaker.recordFailure(name);
      budget.toolCalls++;
      return _CallOutcome(_backfill(
        call,
        name,
        _guardrails.unknownToolHint(
            name, _registry.visible(modelKey: modelKey).map((t) => t.name).toSet()),
      ));
    }

    // 闸门③：同工具连续失败到达阈值 → 不再调用它（回填「已停用」）。
    if (breaker.isTripped(tool.name)) {
      _emit(AgentToolSkipped(
        toolName: tool.name,
        reason: '本回合连续失败已达 ${breaker.failuresOf(tool.name)} 次',
        userLabel: '有条路子刚才没走通，这轮我不再试它了',
      ));
      return _CallOutcome(_backfill(
          call,
          tool.name,
          '该能力本轮已停用（连续失败 ${breaker.failuresOf(tool.name)} 次）。'
          '请基于已有信息作答，或换一条路子。'));
    }

    // 闸门④：调用次数上限（总量 + 单工具）。
    if (budget.toolCalls + 1 > _config.maxToolCallsPerTurn) {
      throw _budgetStop(AgentBudgetKind.toolCalls, _config.maxToolCallsPerTurn,
          budget.toolCalls, budget, '');
    }
    final used = perToolCalls[tool.name] ?? 0;
    if (used >= _config.maxToolCallsPerToolPerTurn) {
      _emit(AgentToolSkipped(
        toolName: tool.name,
        reason: '本轮已查 $used 次',
        userLabel: '这件事我查得够多了，先按已有信息说',
      ));
      return _CallOutcome(_backfill(call, tool.name,
          '这个能力本轮已经用了 $used 次，请基于已有信息作答，别再重复查同一件事。'));
    }

    // 护栏②：入参 JSON 校验。不合格 → 回填**可执行**的改正提示，
    // 由下一步模型重发（真重试），同时按一次失败计入熔断，防止无限畸形参数。
    final decoded = AgentGuardrails.decodeArguments(call);
    var violations = <String>[];
    if (decoded.ok) {
      violations = validateToolArguments(decoded.args!, tool.parameters);
    }
    budget.toolCalls++;
    if (!decoded.ok || violations.isNotEmpty) {
      final tripped = breaker.recordFailure(tool.name);
      final hint = AgentGuardrails.argumentRetryHint(
          tool, call.argumentsJson, violations.isEmpty ? const [] : violations);
      _emit(AgentToolFinished(
        toolName: tool.name,
        callId: call.id,
        ok: false,
        preview: _clip(hint, 120),
        userLabel: '我刚才要到的信息不太对，我重新要一次',
      ));
      if (tripped) {
        _emit(AgentToolCircuitBroken(
          toolName: tool.name,
          consecutiveFailures: breaker.failuresOf(tool.name),
          userLabel: '有条路子连着没走通，这轮我先不用它了',
        ));
      }
      return _CallOutcome(_backfill(call, tool.name, hint));
    }

    final ctx = AgentToolCallContext(
      sessionId: sessionId,
      turnIndex: turnIndex,
      callId: call.id,
      step: step,
      args: decoded.args ?? const {},
    );
    perToolCalls[tool.name] = used + 1;
    _emit(AgentToolStarted(toolName: tool.name, callId: call.id, userLabel: tool.activityLabel));

    final scopeKey = AgentToolCallContext.scopeKeyOf(sessionId);
    final skillsBefore = skillLedger?.loadedIn(scopeKey).length ?? 0;
    AgentToolResult result;
    try {
      result = await tool
          .execute(ctx)
          .timeout(tool.timeout ?? _config.toolTimeout);
    } on TimeoutException {
      result = AgentToolResult.error('这条路子超时没回话（${(tool.timeout ?? _config.toolTimeout).inSeconds} 秒）');
    } catch (e) {
      result = AgentToolResult.error('这条路子没走通：$e');
    }

    final bool tripped;
    if (result.isError) {
      tripped = breaker.recordFailure(tool.name);
    } else {
      breaker.recordSuccess(tool.name);
      tripped = false;
    }

    _emit(AgentToolFinished(
      toolName: tool.name,
      callId: call.id,
      ok: !result.isError,
      preview: _clip(result.content, 120),
      userLabel: result.isError ? '${tool.activityLabel}，没走通' : '${tool.activityLabel}，有结果了',
    ));
    if (tripped) {
      _emit(AgentToolCircuitBroken(
        toolName: tool.name,
        consecutiveFailures: breaker.failuresOf(tool.name),
        userLabel: '有条路子连着没走通，这轮我先不用它了',
      ));
    }

    // 工具自报的降级（少做了某件事）→ 汇总成可归因告警，界面与审计都要看得见。
    final note = result.degradation?.trim() ?? '';
    if (note.isNotEmpty) warnings.add('${tool.name}：$note');

    // 技能装载留痕：台账变了 = 首次装载；没变 = 同会话去重命中。
    if (!result.isError && tool.name == loadSkillToolName) {
      final ledger = skillLedger;
      if (ledger != null) {
        final now = ledger.loadedIn(scopeKey);
        final deduped = now.length == skillsBefore;
        final skillName = decoded.args?['name']?.toString() ?? '';
        if (skillName.isNotEmpty && !loadedSkills.contains(skillName)) {
          loadedSkills.add(skillName);
        }
        _emit(AgentSkillLoaded(
            skillName: skillName.isEmpty ? tool.name : skillName, deduped: deduped));
      }
    }

    final content =
        result.isError ? '未成功：${result.content}' : result.content;
    return _CallOutcome(
      _backfill(call, tool.name, _guardrails.pruneToolResult(content)),
      executed: true,
      // 只有**真的把题挂出去了**才算问完：参数写歪时 result.isError=true，
      // 那种情况要继续让模型照着提示改一遍，而不是把这一轮就地结束（用户会看到一个空屏）。
      asked: !result.isError && tool.name == askUserToolName,
    );
  }

  AgentChatMessage _backfill(AgentToolCallDto call, String toolName, String content) =>
      AgentChatMessage.tool(toolCallId: call.id, toolName: toolName, content: content);

  /// 连续「并行安全」的调用合成一批；不安全的一条一批。
  int _safeBatchEnd(List<AgentToolCallDto> calls, int start) {
    final first = _registry.lookup(calls[start].name, modelKey: modelKey);
    final firstSafe = first?.concurrencySafeFor(const {}) ?? true;
    if (!firstSafe) return start + 1;
    var end = start + 1;
    while (end < calls.length) {
      final t = _registry.lookup(calls[end].name, modelKey: modelKey);
      if (t == null || !t.concurrencySafeFor(const {})) break;
      end++;
      if (end - start >= _config.maxParallelTools) break;
    }
    return end;
  }

  // ---------------------------------------------------------------- 闸门

  void _enforce(_TurnBudget budget, {String partial = ''}) {
    final v = budget.check();
    if (v == null) return;
    _emit(AgentBudgetBlocked(detail: v.describe(), userLabel: '这一轮我先停在这里，不再往下查了'));
    throw AgentBudgetExceededException(
      kind: v.kind,
      limit: v.limit,
      used: v.used,
      steps: budget.steps,
      usage: budget.usage,
      partialText: partial,
    );
  }

  AgentBudgetExceededException _budgetStop(
    AgentBudgetKind kind,
    num limit,
    num used,
    _TurnBudget budget,
    String partial,
  ) {
    _emit(AgentBudgetBlocked(detail: '$kind', userLabel: '这一轮我先停在这里，不再往下查了'));
    return AgentBudgetExceededException(
      kind: kind,
      limit: limit,
      used: used,
      steps: budget.steps,
      usage: budget.usage,
      partialText: partial,
    );
  }

  static int _historyTurn(List<AgentChatMessage> history) =>
      history.where((m) => m.role == AgentRole.user).length;

  static String _clip(String s, int n) {
    final t = s.replaceAll('\n', ' ').trim();
    return t.length <= n ? t : '${t.substring(0, n)}…';
  }
}

/// 回合内预算读数（闸门，不是仪表）。
class _TurnBudget {
  _TurnBudget(this._cfg);

  final AgentEngineConfig _cfg;
  int steps = 0;
  int stepsWithTools = 0;
  int toolCalls = 0;
  AgentUsage usage = AgentUsage.zero;
  double cost = 0;

  void addUsage(AgentUsage u) {
    usage = usage + u;
    steps++;
    cost += _cfg.costModel.costOf(u);
  }

  _BudgetViolation? check() {
    if (usage.totalTokens > _cfg.maxTokensPerTurn) {
      return _BudgetViolation(AgentBudgetKind.tokens, _cfg.maxTokensPerTurn,
          usage.totalTokens);
    }
    if (cost > _cfg.maxCostPerTurn) {
      return _BudgetViolation(
          AgentBudgetKind.cost, _cfg.maxCostPerTurn, num.parse(cost.toStringAsFixed(2)));
    }
    if (toolCalls > _cfg.maxToolCallsPerTurn) {
      return _BudgetViolation(
          AgentBudgetKind.toolCalls, _cfg.maxToolCallsPerTurn, toolCalls);
    }
    return null;
  }
}

class _BudgetViolation {
  const _BudgetViolation(this.kind, this.limit, this.used);

  final AgentBudgetKind kind;
  final num limit;
  final num used;

  String describe() => switch (kind) {
        AgentBudgetKind.steps => 'steps $used/$limit',
        AgentBudgetKind.tokens => 'tokens $used/$limit',
        AgentBudgetKind.cost => 'cost $used/$limit',
        AgentBudgetKind.toolCalls => 'tool_calls $used/$limit',
      };
}

/// 工具级连续失败熔断（方案 §3.6 第 2 行）。
/// 一次工具调用的产出：回填给模型的消息 + **是否真的执行过执行体**。
///
/// 「整轮一次真活都没干」与「干了活但结果不理想」在熔断收口上是两件事：
/// 前者才该尽快如实收口，后者还该给模型一次用已有信息作答的机会。
class _CallOutcome {
  const _CallOutcome(this.message, {this.executed = false, this.asked = false});

  final AgentChatMessage? message;
  final bool executed;

  /// 这条调用是否把澄清题成功交给了界面（`agent.ask_user` 且没报错）。
  /// 主循环据此「问完就地收口」，形状与 [executed] 一样是**一步一个事实**，
  /// 不是在循环里另立一套状态机。
  final bool asked;
}

class _ToolCircuitBreaker {
  _ToolCircuitBreaker(this.limit);

  final int limit;
  final Map<String, int> _failures = {};
  final Set<String> _tripped = {};

  bool isTripped(String name) => _tripped.contains(name);
  int failuresOf(String name) => _failures[name] ?? 0;
  List<String> get tripped => _tripped.toList();

  bool recordSuccess(String name) {
    _failures[name] = 0;
    return _tripped.contains(name);
  }

  /// 记一次失败；返回 `true` = **本次**触发熔断（用于只播报一次）。
  bool recordFailure(String name) {
    final n = (_failures[name] ?? 0) + 1;
    _failures[name] = n;
    if (n >= limit && !_tripped.contains(name)) {
      _tripped.add(name);
      return true;
    }
    return false;
  }
}
