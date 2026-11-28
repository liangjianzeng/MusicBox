/// 伴创装配层（集成方，方案 §3 / §7 v5.5）。
///
/// **为什么单独一个文件**：引擎（`engine/`，agent-engine）与界面（`ui/`，agent-ui）是两个人
/// 并行按同一份契约写的，界面侧把契约声明成了"第 0 段占位"，明确要求集成时只改一处。
/// 那"一处"就是这里 —— 引擎改类名只崩这个文件，不会把界面测试带崩。
///
/// 三条纪律在这个文件里守住：
/// 1. **引擎不认识 Dio、也不认识 token**（§3.4）：所有出口都用 `ApiClient.send`，
///    沿用 App 既有的 Bearer + 401 单飞刷新，不在这里另起一套鉴权。
/// 2. **`reasoning` 永不上屏**（V35-㉟）：引擎的 `AgentReasoningRecorded` 在这里**直接丢弃**，
///    不映射成任何 UI 事件 —— 界面拿不到想法，就不可能被想法污染回复。
/// 3. **没有的通道不许假装有**：答题通道未注入时如实报错，不静默吞掉用户的作答。
///
/// 第四条（2026-11-28 产品拍板）：**问用户必须走可点选的提问卡**。模型喊出
/// `agent.ask_user` 时由本文件把题面挂成 `NeedsUserAnswer`，用户的点选也在这里攒成
/// **一条用户消息**送回同一会话 —— 引擎不认识界面，界面也不认识引擎，翻译只在这一处。
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import 'agent_config.dart';
import 'engine/agent_events.dart' as eng;
import 'engine/agent_memory.dart';
import 'engine/agent_messages.dart';
import 'engine/agent_transport.dart';
import 'skills/remote_skill_source.dart';
import 'tools/ask_tools.dart';
import 'tools/knowledge_web_search_tool.dart';
import 'tools/proposal_tools.dart';
import 'ui/agent_view_model.dart';

// ———— 宿主 HTTP 出口：全部走 ApiClient，让 token 机制只有一份 ————

AgentHttpPost _httpPost(ApiClient api) => (path, body) async =>
    Map<String, dynamic>.from(await api.send(() => api.http.post(path, data: body)) as Map);

AgentHttpGet _httpGet(ApiClient api) => (path) async =>
    Map<String, dynamic>.from(await api.send(() => api.http.get(path)) as Map);

AgentHttpPut _httpPut(ApiClient api) => (path, body) async =>
    Map<String, dynamic>.from(await api.send(() => api.http.put(path, data: body)) as Map);

AgentHttpDelete _httpDelete(ApiClient api) => (path) async =>
    Map<String, dynamic>.from(await api.send(() => api.http.delete(path)) as Map);

/// 装配一个伴创会话（灰度命中时由 `main.dart` 注入 `agentSessionProvider`）。
///
/// `onAnswer` 是 P3 的答题通道（服务端 `POST /v1/intent/:id/answer`）。它不在引擎里，
/// 也不该在 —— 澄清题是意图卡的状态，不是模型循环的状态。**未注入时会话会如实告诉用户
/// "作答通道没接上"**，而不是把点击吞掉：静默失败比明确失败更难被发现。
AgentSession buildCocreateSession(
  ApiClient api, {
  Future<void> Function(int qIdx, int? optionIdx)? onAnswer,
  AgentEngineConfig config = const AgentEngineConfig(),
}) {
  final post = _httpPost(api);
  final get = _httpGet(api);
  // **sync: true** —— 引擎事件经这里转出去，而提问卡那条是会话自己 add 的（同步）。
  // 异步投递会让「提问卡」排在真正的工具事件前面：真机上抓到的
  // `TurnFinished` 早于 `ToolCallRequested`、同一条回复出现两遍，就是这么来的。
  final ctl = StreamController<eng.AgentEvent>.broadcast(sync: true);

  // 出票 / 验票那条通道（v5.9.9.5）。真机上整条断头路就断在这儿：这条从来没建过，
  // 于是模型调完 `music.propose_generate` 回一句「等服务端出确认票」，而那张票永远不来。
  final tickets = AgentProposalClient(
    issue: (body) => post('/v1/agent/proposals', body),
    confirm: (id, ver, hash) =>
        post('/v1/agent/tickets/$id/confirm', {'ver': ver, 'hash': hash}),
    deny: (id) async {
      await post('/v1/agent/tickets/$id/deny', const <String, dynamic>{});
    },
  );

  late final AgentBridgeSession bridge;
  final engine = buildAgentEngine(
    transport: buildAgentTransport(post: post),
    config: config,
    // 技能：目录 + 正文都走服务端投递层（rank 150，改正文不必发版，§4.7 / v5.5.12）
    skillSource: RemoteSkillSource(get: get),
    // 检索：服务端唯一通道，App 不直连外部引擎（v5.5.4）
    webSearch: remoteWebSearchGateway(post: post),
    // 偏好：只存"属于这个用户的口味"，且必须能删（v5.5.16）
    memoryStore: RemoteAgentMemory(
      get: _httpGet(api),
      put: _httpPut(api),
      delete: _httpDelete(api),
    ),
    // ———— 三条**只读**查询通道：装配处过去一个都没挂 ————
    // 条件注册（`if (jobStatus != null) tools.replace(...)`）于是从来没成立过：
    // 模型在真机上只看得见 6 个工具，而内置技能正文又硬性要求它「用 catalog.lookup
    // 返回的词出候选」——技能在要求一件装配上没给它的能力，它只能自己编词。
    // 能挂的先挂上；`catalog.lookup` 服务端**没有**对应路由，不在这里凭空造一条，
    // 那件事归词条目录那条线（已写进汇报）。
    librarySearch: (keyword, limit) async {
      final r = await get('/v1/works?q=${Uri.encodeQueryComponent(keyword)}&limit=$limit');
      return _rows(r['works']).map(_workBrief).toList();
    },
    jobStatus: (jobId) async {
      final r = await get('/v1/jobs/${Uri.encodeQueryComponent(jobId)}');
      final j = r['job'];
      return j is Map ? _jobBrief(Map<String, dynamic>.from(j)) : null;
    },
    intentRead: (intentId) async {
      final r = await get('/v1/intent/${Uri.encodeQueryComponent(intentId)}');
      final c = r['intent'] ?? r['card'] ?? r;
      return c is Map ? Map<String, dynamic>.from(c) : null;
    },
    // 草稿 → 确认票 → 开工。**没有这一个参数，三个 propose 工具就是三个空转的把手。**
    onProposal: (proposal) => bridge._handleProposal(proposal),
    onEvent: (e) {
      if (!ctl.isClosed) ctl.add(e);
    },
  );
  bridge = AgentBridgeSession(
    engine: engine,
    events: ctl.stream,
    onAnswer: onAnswer,
    tickets: tickets,
  );
  return bridge;
}

/// `/v1/works` 的返回里只挑给模型看的几项（刻意**不带**任何账本字段）。
Map<String, dynamic> _workBrief(Map<String, dynamic> w) => {
      'id': w['id'],
      'title': w['title'],
      if (w['mood'] != null) 'mood': w['mood'],
      if (w['genres'] != null) 'genres': w['genres'],
      if (w['status'] != null) 'status': w['status'],
    };

/// `/v1/jobs/:id` 里只挑进度那几项：进度之外的一律不给模型。
Map<String, dynamic> _jobBrief(Map<String, dynamic> j) => {
      'id': j['id'],
      'status': j['status'],
      if (j['progress'] != null) 'progress': j['progress'],
      if (j['note'] != null) 'note': j['note'],
    };

List<Map<String, dynamic>> _rows(Object? v) => v is List
    ? v.whereType<Map>().map(Map<String, dynamic>.from).toList()
    : const [];

/// 从 HTTP 失败里取**服务端给的那句人话**（服务端文案已过禁词表）。
/// 取不到就换一句不撒谎的兜底：绝不能把 Dio 的英文堆栈念给用户。
String _serverMessage(Object e) {
  if (e is DioException) {
    final d = e.response?.data;
    if (d is Map) {
      final m = d['message'] ?? d['error'];
      if (m is String && m.trim().isNotEmpty) return agentHuman(m);
    }
  }
  return '这一步没交上去，可以再让我提一次。';
}

int? _asInt(Object? v) {
  if (v is int) return v;
  if (v is num) return v.round();
  if (v is String) return int.tryParse(v.trim());
  return null;
}

/// 出票 / 验票的宿主出口（**注入用**：测试塞个假的，就能把「草稿→票→开工」整条跑通，
/// 不必真起服务端）。三个方法各自对应 [agent.js] 里的一条路由。
class AgentProposalClient {
  const AgentProposalClient({required this.issue, required this.confirm, required this.deny});

  /// POST /v1/agent/proposals —— 草稿换确认票（带 auto_confirm 时顺带开工）。
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> body) issue;

  /// POST /v1/agent/tickets/:id/confirm —— 五连校验要票面上的 ver/hash，故一并带上。
  final Future<Map<String, dynamic>> Function(String id, String ver, String hash) confirm;

  /// POST /v1/agent/tickets/:id/deny
  final Future<void> Function(String id) deny;
}

/// 引擎 → 界面的防腐层。引擎事件在这里翻译完，`ui/` 下其余文件只认 UI 自己那套事件。
class AgentBridgeSession
    implements AgentSession, AgentBriefApproval, AgentTicketCapableSession {
  AgentBridgeSession({
    required this.engine,
    required Stream<eng.AgentEvent> events,
    this.onAnswer,
    this.tickets,
  }) {
    // 订阅只开一次：重复订阅会让同一步在界面上出现两遍（重复出卡那一类 bug 的根）。
    _sub = events.listen(_forward);
    _attachAskTool();
  }

  final AgentEngine engine;
  final Future<void> Function(int qIdx, int? optionIdx)? onAnswer;

  /// 出票通道。null = 这个会话**没有**开工的能力（灰度未接线，或测试里只看对话）。
  /// 缺它时工具如实回「没有交上去」，界面上也不会出现一颗点了没反应的票面按钮。
  final AgentProposalClient? tickets;

  StreamSubscription<eng.AgentEvent>? _sub;
  /// **sync: true** —— 这条流上的事件顺序就是用户看到的顺序。
  ///
  /// 异步投递会把顺序打乱两回：① 提问卡是会话自己 `add` 的（同步），会插到引擎事件前面；
  /// ② 出票那条 `TicketSettled` 也是在工具执行里 add 的，异步投递会让它落在
  /// `send()` 返回**之后** —— 于是"拍板收尾那句话"先按"还没开工"念了出来，
  /// 半秒后才补一条"已经开始做了"，屏幕上并排两句自相矛盾。
  final _out = StreamController<AgentEvent>.broadcast(sync: true);
  final List<AgentChatMessage> _history = <AgentChatMessage>[];
  String? _sessionId;
  int _turn = 0;
  List<String> handedOff = const [];

  /// 当前挂在界面上的提问卡（qIdx → 题面与候选原文）。留**原文**是为了把点选照字拼回
  /// 一句话给模型：让模型看「我选：1」这种答案，等于让它回头猜自己刚才问了什么。
  final Map<int, _AskCard> _askCards = <int, _AskCard>{};

  /// 用户的点选（qIdx → 候选下标；null = 这题跳过）。齐了才发，见 [_answerAsk]。
  final Map<int, int?> _askPicks = <int, int?>{};

  /// 已经拼好发出去的那批题号：发过之后再收到点击只当没发生，绝不重发第二条。
  Set<int> _askFlushed = <int>{};

  // ── 拍板授权与票面（v5.9.9.5）────────────────────────────────────────────
  /// 用户按过主 CTA 的那一**回合号**（一次性，用完即销）。只有它和当前回合对得上，
  /// 草稿才被允许直接开工 —— 模型没有任何途径把它写成 true：它是界面→会话的一次方法调用，
  /// 不在工具入参里，也不进消息历史。
  int? _grantedTurn;

  /// 引擎自己那条 `AgentTurnFinished` 是否已经转出去过（用来挡住重复的助手气泡）。
  bool _turnFinishedEmitted = false;

  /// 已发票的 ver/hash（票面按钮点下去时要带；服务端五连校验认的就是这两个值）。
  final Map<String, _TicketCreds> _creds = <String, _TicketCreds>{};

  /// 用户在本会话里说的**第一句**话。草稿里没带灵感描述时拿它兜底 —— 那是用户亲口说的，
  /// 比让模型复述更可信，也让服务端能就地建出一张有内容的任务单（而不是回一句"还不知道做什么"）。
  String? _firstUserText;

  @override
  void grantBriefApproval() => _grantedTurn = _turn;

  @override
  AgentTicketGateway get ticketGateway => _BridgeTicketGateway(this);

  void _emit(AgentEvent e) {
    if (!_out.isClosed) _out.add(e);
  }

  @override
  Stream<AgentEvent> get events => _out.stream;

  /// 把「问用户」这条路挂到引擎上 —— **只在全功能形态**。
  ///
  /// 为什么挂在这儿、而不是在 `buildAgentEngine` 里注册：提问工具恰好是 readOnly，
  /// 而封顶形态（板块小助手）装配时那句 `restrictUser(allow: readOnlyNames())`
  /// 会把**当时在册的**只读工具全数放行进白名单 —— 早注册一步，单轮 0 题的契约
  /// v5.8.3 就被自己人的白名单**误放行**了。这里用 `isCapped` 判据挡在注册之前；
  /// 万一以后有人绕过这条，注册发生在白名单快照之后，它也只是 `isRegisteredButHidden`，
  /// 模型侧一个字节都看不到（两道闸，不靠单点自觉）。
  void _attachAskTool() {
    if (engine.config.isCapped) return;
    engine.registry.replace(buildAskUserTool(onAsk: _onAsk));
  }

  /// 引擎问的题 → 界面的可点选题卡。
  ///
  /// 只做两件映射：① 按出现顺序补 `q_idx`（0..n-1 连续，作答回填靠它对上）；
  /// ② 每题候选裁到界面装得下的数量 —— `applyQuestions` 会把**整题丢掉**超过 4 项的题
  /// （ui/agent_view_model.dart 里那条「契约 v1：每题 2–4 项」的夹条），
  /// 整题凭空消失比少两个候选更糟：用户会以为助手少问了一件事。
  /// 代价：模型给的第 5 个之后的候选用户看不到（工具侧上限 6，最多裁掉 2 个）。
  Future<void> _onAsk(AgentAskRequest req) async {
    _askCards.clear();
    _askPicks.clear();
    _askFlushed = <int>{};
    final cards = <Map<String, dynamic>>[];
    for (var i = 0; i < req.questions.length; i++) {
      final draft = req.questions[i];
      final options = draft.options.length <= _kUiMaxOptions
          ? List<String>.from(draft.options)
          : draft.options.sublist(0, _kUiMaxOptions);
      final title = _AskCard.titleOf(draft.q, i);
      cards.add({
        'q_idx': i,
        'q': title,
        // 不给 `recommended_idx`：模型没标推荐，硬指一个就是把猜测说成用户该照办的默认值
        // （跳过的语义在会话侧是「都行」，见 [_answerAsk]）。
        // 也不给 `set` 载荷：候选只是词，简报卡的参数仍由模型后续整理，不从卡片字面猜。
        'options': [
          for (var k = 0; k < options.length; k++) {'idx': k, 'label': options[k]},
        ],
      });
      _askCards[i] = _AskCard(title: title, options: options);
    }
    if (_out.isClosed) return;
    // draft.multi 刻意不进卡片：界面一题只落一个选择（answers 是 Map<int,int>），
    // 长成"能多选"的样子却只记一个，比明说一题一个更容易被当成 bug。
    _out.add(NeedsUserAnswer(cards, lead: req.lead));
  }

  /// 界面装得下的候选数（与 `applyQuestions` 那条 `> 4` 的夹条同一个数）。
  static const int _kUiMaxOptions = 4;

  /// 引擎事件 → 界面事件。刻意**不**转发 `AgentReasoningRecorded`（想法永不上屏）。
  void _forward(eng.AgentEvent e) {
    if (_out.isClosed) return;
    if (e is eng.AgentTurnStarted) return _out.add(TurnStarted(turnId: e.turnIndex));
    if (e is eng.AgentAssistantText) return _out.add(AssistantTextDelta(e.text));
    if (e is eng.AgentToolStarted) {
      // 步骤文案用引擎给的人话 userLabel，绝不把 toolName 递到界面上（§11.5）。
      // `label` 也要带：真机上引擎给「我把这次要做的事列成清单了」，界面上却是一片
      // 「助手正在办一件事」—— 名字在半路被丢了，用户看不出这张卡到底在办什么。
      return _out.add(ToolCallRequested(AgentToolCall(
          id: e.callId, name: e.toolName, label: e.userLabel)));
    }
    if (e is eng.AgentToolFinished) {
      return _out.add(ToolResultReceived(
          toolCallId: e.callId, ok: e.ok, summary: e.userLabel, label: e.userLabel));
    }
    if (e is eng.AgentToolSkipped) {
      // 注意 id 用的是**工具名**（引擎这条没有 callId）：它多半对不上任何已开的步骤，
      // 所以界面侧必须能"没有开头也补一条步骤"，否则这条就被整条丢掉。
      return _out.add(ToolResultReceived(
          toolCallId: e.toolName, ok: false, skipped: true,
          summary: e.userLabel, label: e.userLabel));
    }
    if (e is eng.AgentToolDeprecated) {
      // 模型喊了一个不存在 / 这条路已关的工具：以前这条**根本没转发**，于是模型明明试过、
      // 屏幕上却连一张卡都没有（真机现象之一）。只在首次时转，免得同一句刷屏。
      if (!e.firstTime) return;
      return _out.add(ToolResultReceived(
          toolCallId: 'gone:${e.toolName}', ok: false, skipped: true,
          summary: e.userLabel, label: '这条路现在走不通'));
    }
    if (e is eng.AgentBudgetBlocked) {
      // 出路必须写实：额度按账号累计，新开会话不会清零（v5.5.7 的诚实性口径）
      return _out.add(BudgetExceeded(
        reason: e.userLabel,
        wayOut: '这是护栏不是故障，它按账号算，新开一对话也不会绕过去；可以少出几版，或切回标准创作流程。',
      ));
    }
    if (e is eng.AgentTurnFinished) {
      // awaitingUser 也算办成：题已经挂到用户眼前了，这一轮的沉默是在等人不是在等模型。
      // 报成 ok=false 会让界面把提问那一回合演成"没办成"，用户就找不到刚才是谁在问他。
      final done = e.stopReason == eng.AgentStopReason.completed ||
          e.stopReason == eng.AgentStopReason.awaitingUser;
      _turnFinishedEmitted = true;
      return _out.add(TurnFinished(
        ok: done,
        reply: e.text,
        usedTool: e.steps > 0,
        mode: e.steps > 0 ? 'llm+rule' : 'rule',
      ));
    }
    // 其余（step/start、skill/loaded、context/compact、circuit_open…）是过程性事件：
    // 界面自己有步骤流呈现策略，这里不硬塞成 UI 事件，免得为"看得见"而编造语义。
  }

  @override
  Future<void> send(String text) async {
    final t = text.trim();
    if (t.isEmpty) return;
    // 用户亲口的第一句话留着兜底：草稿没带灵感描述时用它替模型复述（服务端据此建任务单）。
    _firstUserText ??= t;
    _turnFinishedEmitted = false;
    final turn = _turn;
    try {
      final r = await engine.ask(
        sessionId: _sessionId,
        userText: t,
        history: _history,
        turnIndex: _turn,
      );
      // 服务端回传的 session_id 必须带回去（token 用量按会话归因，v5.5.3）
      _sessionId = r.sessionId ?? _sessionId;
      _history.addAll(r.newMessages);
      _turn++;
      // 这一回合的拍板授权到此作废：**一次性**，跨回合不再复用（否则下一轮模型自己
      // 提一句草稿就能顶着"用户已经点过"的名义开工）。
      if (_grantedTurn == turn) _grantedTurn = null;
      if (r.transportError != null || r.budget != null || r.warnings.isNotEmpty) {
        // 降级必须让用户看见：装了却装作一切正常，比降级本身更糟。
        // 但**不许把同一句回复念两遍**：引擎收尾那条 TurnFinished 已经带过 r.text，
        // 这里再带一次，屏幕上就并排出现两条一模一样的人工回复（真机现象之一）。
        if (!_out.isClosed) {
          _out.add(TurnFinished(
            ok: false,
            // 引擎自己那条 TurnFinished 已经念过 r.text 了（真机上并排两条一模一样的
            // 人工回复就是这么来的）；只有它没发出来时这里才补念一次。
            reply: _turnFinishedEmitted ? null : r.text,
            usedTool: r.steps > 0,
            notice: [
              if (r.transportError != null) '理解服务暂时没接上，你的输入已保留，可稍后重试。',
              if (r.budget != null) '这一轮被预算护栏拦住了。',
              ...r.warnings,
            ].join(' '),
          ));
        }
      }
    } catch (err) {
      if (!_out.isClosed) {
        _out.add(TurnFinished(
            ok: false, notice: '这一轮没跑成：$err。可以直接重试，或切回标准创作流程。'));
      }
    }
  }

  @override
  Future<void> answer(int qIdx, int? optionIdx) => _answerAsk(qIdx, optionIdx);

  /// 跳过 = 不给倾向（会话侧写成「都行」）。
  ///
  /// 与 P3 意图卡的「按 recommended_idx 填」刻意不同：提问卡上的推荐是**模型自己**标的，
  /// 跳过还替它选一个，等于把它的猜测包装成用户的决定再喂回它自己。
  @override
  Future<void> skipQuestion(int qIdx) => _answerAsk(qIdx, null);

  /// 攒点选 → 齐了才发一条用户消息。
  ///
  /// 三条规矩，每条都对应一种真会发生的坏味道：
  /// 1. **部分作答绝不抢发**：只答了两题就发出去，模型会照着那两题做，第三题它自己编；
  /// 2. 发出去的是**一条用户消息**（走现有 [send]），不是一条工具回填：
  ///    模型必须看见「用户答了」，才知道这是它上一轮提问的答复；
  /// 3. 发过之后再收到点击只当没发生 —— 最后一题被连点两下不该吐出第二条「我选：…」，
  ///    更不该因为卡片已清空就退回 P3 通道去报"提交通道没接上"（那是用户没做错的错）。
  Future<void> _answerAsk(int qIdx, int? optionIdx) async {
    if (!_askCards.containsKey(qIdx)) {
      if (_askFlushed.contains(qIdx)) return;
      return _legacyAnswer(qIdx, optionIdx); // P3 意图卡的澄清题：那条路一字不变
    }
    _askPicks[qIdx] = optionIdx; // 改主意就覆盖，齐了之前一条都不发
    if (_askPicks.length < _askCards.length) return;
    final text = _composeAskAnswer();
    _askFlushed = _askPicks.keys.toSet();
    _askCards.clear();
    _askPicks.clear();
    if (text.isEmpty) return;
    await send(text);
  }

  /// 把点选拼成一句话。确切形状：`我选：情绪基调＝安静专注；谁来唱＝纯音乐；曲风＝氛围电子`
  /// —— 题面与候选都用**卡片上的原文**，跳过的题写「都行」。
  String _composeAskAnswer() {
    final parts = <String>[];
    for (final entry in _askCards.entries) {
      if (!_askPicks.containsKey(entry.key)) return ''; // 保险：没齐不发（调用处已判一次）
      final pick = _askPicks[entry.key];
      parts.add('${entry.value.title}＝${entry.value.labelOf(pick)}');
    }
    return '我选：${parts.join('；')}';
  }

  /// P3 的答题通道（澄清题属于意图卡的状态，不是模型循环的状态）—— 原有行为一字不变。
  Future<void> _legacyAnswer(int qIdx, int? optionIdx) async {
    if (onAnswer == null) {
      if (!_out.isClosed) {
        _out.add(const TurnFinished(ok: false,
            notice: '澄清题的提交通道还没接上，请在创作页里作答或直接打字告诉我。'));
      }
      return;
    }
    await onAnswer!(qIdx, optionIdx);
  }

  /// 宿主收到草稿的唯一入口（装配处把它接到 `buildAgentEngine(onProposal:)` 上）。
  ///
  /// 生产里 `agent_config` 只认那个回调，测试要从外面把同一条路径走一遍，故开这个口 ——
  /// 刻意只给测试用：**别**在界面侧调它，界面永远只通过"用户点了哪颗钮"参与。
  @visibleForTesting
  Future<AgentProposalReceipt?> handleProposal(AgentProposal p) => _handleProposal(p);

  // ── 草稿 → 确认票 → 开工（v5.9.9.5）──────────────────────────────────────
  ///
  /// 这是那条断头路的接头处：`music.propose_*` 工具把结构化草稿交到这里，这里送去服务端
  /// 换一张真票，并把票**推到界面上**。三种结果各回各的实话（见 `_proposalNote`）：
  ///  · 通道没接上（`tickets == null`）→ 回 null，工具说「没有交上去」；
  ///  · 用户已拍过板（本回合按过主 CTA）→ 带 `auto_confirm` 让服务端验票开工；
  ///  · 没拍过板 → 只发票，界面上长出「就按这张票办」那颗钮。
  ///
  /// **绝不**在这里替用户宣布"已开始做"：`executed` 只认服务端回的那个字段，
  /// 而界面上「已经开始做了」那句话只认 [TicketSettled] 里的 job 编号。
  Future<AgentProposalReceipt?> _handleProposal(AgentProposal p) async {
    final client = tickets;
    if (client == null) return null;
    final payload = <String, dynamic>{...p.payload};
    final idea = '${payload['scene_desc'] ?? ''}'.trim();
    if (idea.isEmpty && _firstUserText != null) {
      // 草稿没带灵感就用用户亲口那句：服务端要靠它建任务单，也比让模型复述更可信。
      payload['scene_desc'] = _firstUserText;
    }
    final auto = _grantedTurn != null && _grantedTurn == p.turnIndex;
    try {
      final r = await client.issue({
        'action': p.action,
        'payload': payload,
        if (p.sessionId != null && p.sessionId!.trim().isNotEmpty) 'session_id': p.sessionId,
        if (p.reason.trim().isNotEmpty) 'reason': p.reason,
        if (auto) 'auto_confirm': true,
      });
      final t = r['ticket'] is Map ? Map<String, dynamic>.from(r['ticket'] as Map) : const <String, dynamic>{};
      final id = '${t['ticket_id'] ?? ''}'.trim();
      if (id.isEmpty) {
        return const AgentProposalReceipt(
          status: AgentProposalStatus.failed,
          error: '服务端没给回确认票，这一步没有交上去。',
        );
      }
      final params = t['params'] is Map
          ? Map<String, dynamic>.from(t['params'] as Map)
          : const <String, dynamic>{};
      final count = _asInt(params['count']);
      final sec = _asInt(params['sec']);
      final executed = r['executed'] == true;
      final jobId = ('${r['job_id'] ?? t['job_id'] ?? ''}').trim();
      final intentId = ('${r['intent_id'] ?? t['intent_id'] ?? ''}').trim();
      final reply = '${r['reply'] ?? ''}'.trim();
      _creds[id] = _TicketCreds(
        ver: '${t['ver'] ?? ''}',
        hash: '${t['hash'] ?? ''}',
        action: p.action,
      );
      _emit(TicketIssued(
        AgentTicketInfo(
          id: id,
          actionLabel: _ticketActionLabel(p.action),
          diff: '${t['diff'] ?? ''}',
          minutes: _asInt(t['minutes']),
          status: executed ? 'succeeded' : 'pending',
          count: count,
          sec: sec,
          jobId: jobId.isEmpty ? null : jobId,
        ),
        startedWork: executed,
      ));
      if (executed) {
        _emit(TicketSettled(
          ticketId: id,
          jobId: jobId.isEmpty ? null : jobId,
          intentId: intentId.isEmpty ? null : intentId,
          count: count,
          sec: sec,
          reply: reply.isEmpty ? null : reply,
        ));
      }
      return AgentProposalReceipt(
        status: executed ? AgentProposalStatus.executed : AgentProposalStatus.pending,
        ticketId: id,
        jobId: jobId.isEmpty ? null : jobId,
        intentId: intentId.isEmpty ? null : intentId,
        count: count,
        sec: sec,
        diff: '${t['diff'] ?? ''}',
        minutes: _asInt(t['minutes']),
      );
    } catch (e) {
      // 服务端退回（参数不合格 / 还没定下要做什么 / 这条路不归智能体管）：
      // 把它那句话原样带回给模型转告用户，不演成"在等你确认"。
      return AgentProposalReceipt(status: AgentProposalStatus.failed, error: _serverMessage(e));
    }
  }

  static String _ticketActionLabel(String action) {
    switch (action) {
      case 'music.propose_generate':
        return '开始做这首歌';
      case 'music.propose_card_patch':
        return '改这张任务单';
      default:
        return '按这张票办一件事';
    }
  }

  /// 票面通道给界面用（`agentTicketGatewayProvider` 默认从会话身上取到这个）。
  Future<void> _confirmTicket(String id) async {
    final client = tickets;
    final creds = _creds[id];
    if (client == null || creds == null) {
      throw StateError('这张票的凭据不在了，请让助手再提一次');
    }
    final r = await client.confirm(id, creds.ver, creds.hash);
    final jobId = ('${r['job_id'] ?? ''}').trim();
    final params = r['params'] is Map
        ? Map<String, dynamic>.from(r['params'] as Map)
        : const <String, dynamic>{};
    _emit(TicketSettled(
      ticketId: id,
      jobId: jobId.isEmpty ? null : jobId,
      intentId: ('${r['intent_id'] ?? ''}').trim().isEmpty ? null : '${r['intent_id']}'.trim(),
      count: _asInt(params['count']),
      sec: _asInt(params['sec']),
      reply: '${r['reply'] ?? ''}'.trim().isEmpty ? null : '${r['reply']}'.trim(),
    ));
  }

  Future<void> _denyTicket(String id) async {
    final client = tickets;
    if (client == null) throw StateError('确认通道没接上');
    await client.deny(id);
    _creds.remove(id);
  }

  Future<void> dispose() async {
    await _sub?.cancel();
    _askCards.clear();
    _askPicks.clear();
    _askFlushed = <int>{};
    await _out.close();
  }
}

/// 一张挂在界面上的题：留题面与候选**原文**，是为了把点选照字拼回一句话给模型。
/// 一张已发票在端上留下的凭据（点「就按这张票办」时要带 ver/hash 去验）。
class _TicketCreds {
  const _TicketCreds({required this.ver, required this.hash, required this.action});
  final String ver;
  final String hash;
  final String action;
}

/// 界面 ↔ 票面的窄通道（`AgentUiController.confirmTicket/denyTicket` 走这里）。
class _BridgeTicketGateway implements AgentTicketGateway {
  _BridgeTicketGateway(this._s);
  final AgentBridgeSession _s;

  @override
  Future<void> confirm(String ticketId) => _s._confirmTicket(ticketId);

  @override
  Future<void> deny(String ticketId) => _s._denyTicket(ticketId);
}

class _AskCard {
  const _AskCard({required this.title, required this.options});

  final String title;
  final List<String> options;

  /// 点选 → 用户那句话里的值。null（跳过）写「都行」：
  /// 它是"我不挑"的意思，不是"按推荐的来"，模型据此知道这里得它自己按常规定。
  String labelOf(int? idx) {
    if (idx == null) return '都行';
    if (idx < 0 || idx >= options.length) return '都行';
    return options[idx];
  }

  /// 题面进用户消息前去掉模型爱手写在前面的「1. / 2、/ 3）」和结尾的问号冒号：
  /// 拼出来是「我选：情绪基调＝安静专注」，不是「我选：1. 情绪基调？＝安静专注」。
  static String titleOf(String raw, int fallbackIdx) {
    var s = raw.trim();
    s = s.replaceFirst(RegExp(r'^\s*[（(\[【]?\s*\d+\s*[.、．:：)）\]]\s*'), '');
    s = s.replaceFirst(RegExp(r'[？?。！!：:；;，,\s]+$'), '');
    s = s.trim();
    return s.isEmpty ? '第 ${fallbackIdx + 1} 件事' : s;
  }
}

// ———— 业务页「助手」入口：灰度命中直达智能体（老大），未命中回现网弹层 ————

/// 「去伴创」的请求位。root_shell 监听它把底部 tab 切到第 4 槽位。
///
/// 为什么是"请求位"而不是直接暴露 `setTab(i)`：跳转是**产品决定**，不该让各板块
/// 想跳哪就跳哪（那会退化成人人可写的导航栈）。这里只提供"去伴创"这一个动作。
final cocreateJumpRequestProvider = StateProvider<int>((ref) => 0);

/// 板块小助手入口（灰度分流）。
///
/// 灰度未命中 → **原样**打开现网那个 sheet，一行行为都不变（红线：规则模式永远可用）；
/// 命中 → 打开封顶形态的小助手：单轮、不问三题、答不了必须显式上交并给去向。
/// 上交后由本函数负责"收起弹层 + 请求跳伴创"，界面层不偷偷跳 tab（agent-ui 的约定）。
Future<void> openPanelAssistant(
  BuildContext context, {
  required String panelId,
  required bool cocreateEnabled,
  required Future<void> Function() legacy,
}) async {
  if (!cocreateEnabled) return legacy();
  // 灰度命中：直接进智能体（老大）。层级只有一个方向 —— 用户搞不清楚时点到的是能干活的
  // 那个，而不是只能接待的那个小助理。小助理不当下沉的垃圾桶，也不当门面。
  // 去之前先把「你在问哪一页」带过去，智能体开场就知道上下文，不用用户重述一遍。
  final ref = ProviderScope.containerOf(context, listen: false);
  ref.read(agentPanelContextProvider.notifier).state = panelId;
  ref.read(cocreateJumpRequestProvider.notifier).state++;
}

/// 从业务页带过来的「我在问哪一页」。智能体开场读它，用户不必重述位置。
final agentPanelContextProvider = StateProvider<String?>((ref) => null);
