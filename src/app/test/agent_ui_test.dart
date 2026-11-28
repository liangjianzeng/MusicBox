import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/models.dart';
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/speech/speech_service.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/agent/ui/agent_composer.dart';
import 'package:musicbox/features/agent/ui/agent_cocreate_page.dart';
import 'package:musicbox/features/agent/ui/agent_view_model.dart';
import 'package:musicbox/features/agent/ui/ask_card.dart';
import 'package:musicbox/features/agent/ui/brief_card.dart';
import 'package:musicbox/features/creation/tier_config.dart';

// ── 假的引擎会话：只按 lead 定的 AgentSession 接口实现，UI 不碰真引擎 ────────

class _FakeSession implements AgentSession {
  // sync: true —— 与真防腐层（AgentBridgeSession._out）同一投递口径。
  // 异步投递会让「拍板收尾那一句话」先按"还没开工"念出来，事件后到半拍：
  // 测出来的顺序和真机上的顺序就不是一回事了。
  final _ctl = StreamController<AgentEvent>.broadcast(sync: true);
  final sent = <String>[];
  final answered = <int, int?>{};
  final skipped = <int>[];

  /// true = 这一回合答不上来（板块小助手的上交触发条件）
  bool cannotAnswer = false;

  /// true = 主 CTA 那一回合，服务端换出了一张**待用户点**的确认票。
  /// 「已提交确认」这句现在必须由真结果换（v5.9.9.5）：什么都没换出来时这颗钮还得能再按，
  /// 所以这里得能演出"真换了张票"的样子，而不是让假会话替服务端空口担保。
  bool confirmYieldsTicket = false;

  @override
  Stream<AgentEvent> get events => _ctl.stream;

  @override
  Future<void> send(String text) async {
    sent.add(text);
    if (cannotAnswer) {
      _ctl.add(const TurnFinished(ok: false, usedTool: false, gated: true));
      return;
    }
    _ctl.add(TurnStarted(turnId: sent.length));
    if (confirmYieldsTicket && text == kAgentConfirmUtterance) {
      _ctl.add(const TicketIssued(AgentTicketInfo(
        id: 'tk_ui_1',
        actionLabel: '开始做这首歌',
        diff: '出 3 条候选 · 大约 45 秒',
        minutes: 2,
        count: 3,
        sec: 45,
      )));
    }
    _ctl.add(const AssistantTextDelta('懂了，我按这个方向来'));
    _ctl.add(const TurnFinished(
        reply: '懂了，我按这个方向来', usedTool: true, mode: 'llm+rule'));
  }

  @override
  Future<void> answer(int qIdx, int? optionIdx) async =>
      answered[qIdx] = optionIdx;

  @override
  Future<void> skipQuestion(int qIdx) async => skipped.add(qIdx);


  void emitAsk({int limit = 3}) {
    _ctl.add(NeedsUserAnswer(
      _questions.take(limit).toList(),
      lead: '先定这三件事，之后就不用再问了',
    ));
  }

  void emitToolAndResult() {
    _ctl.add(const ToolCallRequested(AgentToolCall(
        id: 'c1', name: 'music.adjust_params', arguments: {})));
    _ctl.add(const ToolResultReceived(
        toolCallId: 'c1', ok: true, summary: '我把速度调慢了一点'));
  }
}

class _FakeApi extends Fake implements ApiClient {}

class _FakeSpeech extends Fake implements SpeechService {
  int stopSpeakCalls = 0;

  @override
  Future<StreamingAsrSession?> createSession({String? saveWavPath}) async =>
      null; // 本机识别模型没就位

  // AssistantVoiceController.dispose() 会调它：不实现就会在拆树时抛 UnimplementedError。
  @override
  Future<void> stopSpeak() async {
    stopSpeakCalls++;
  }
}

class _Cfg extends RemoteConfigNotifier {
  _Cfg(super.ref, Map<String, dynamic> data) {
    state = RemoteConfig(data);
  }

  @override
  Future<void> refresh() async {}
}

/// 开场三题（服务端形状 `{q_idx,q,options:[{idx,label,set}],recommended_idx}`）。
/// 选项自带生效载荷，界面不靠猜 label 字面（契约 v5.5.9）。
const List<Map<String, dynamic>> _questions = [
  {
    'q_idx': 0,
    'q': '想要什么情绪？',
    'recommended_idx': 1,
    'options': [
      {'idx': 0, 'label': '平静', 'set': {'mood_add': ['平静']}},
      {'idx': 1, 'label': '热血', 'set': {'mood_add': ['热血'], 'bpm': 128}},
      {'idx': 2, 'label': '微醺', 'set': {'mood_add': ['微醺']}},
    ],
  },
  {
    'q_idx': 1,
    'q': '谁来唱？',
    'recommended_idx': 0,
    'options': [
      {
        'idx': 0,
        'label': '女声',
        'set': {
          'tags_add': ['female vocal'],
          'dim': 'gender',
        }
      },
      {'idx': 1, 'label': '男声', 'set': {'tags_add': ['male vocal']}},
      {'idx': 2, 'label': '纯音乐', 'set': {'vocal': 'instrumental'}},
    ],
  },
  {
    'q_idx': 2,
    'q': '曲风偏哪边？',
    'recommended_idx': 0,
    'options': [
      {'idx': 0, 'label': '电子', 'set': {'genre_add': ['电子']}},
      {'idx': 1, 'label': '民谣', 'set': {'genre_add': ['民谣']}},
    ],
  },
];

Future<AgentUiController> _pump(
  WidgetTester tester, {
  _FakeSession? session,
  bool? agentMode,
  bool enableVoice = false,
  Widget Function(AgentUiController)? widgetFor,
  List<Override> extraOverrides = const [],
  Size size = const Size(430, 1600),
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final s = session ?? _FakeSession();
  final controller = AgentUiController(
    session: s,
  );
  addTearDown(controller.dispose);

  final page = widgetFor?.call(controller) ??
      AgentCocreatePage(
        controller: controller,
        enableVoice: enableVoice,
      );

  await tester.pumpWidget(ProviderScope(
    overrides: [
      agentSessionProvider.overrideWithValue(s),
      if (agentMode != null)
        remoteConfigProvider.overrideWith((ref) => _Cfg(ref, {
              'features': {'createAgentMode': agentMode},
              'credits': {'per_candidate': 15},
            })),
      ...extraOverrides,
    ],
    child: MaterialApp(
      theme: ThemeData(useMaterial3: true, brightness: Brightness.dark),
      home: page,
    ),
  ));
  await tester.pumpAndSettle();
  return controller;
}

/// 语义节点断言：直接查**声明出来的** `Semantics` 件（不依赖语义树是否被打开）。
/// 这比 `find.bySemanticsLabel` 更硬 —— 它要求节点真的带 label / button / enabled
/// 挂在件上（§11.6：语义节点 = 可测性；V35-㉜）。
Finder semNode(String label, {bool? enabled, bool button = true}) {
  return find.byWidgetPredicate((w) {
    if (w is! Semantics) return false;
    final p = w.properties;
    if (p.label != label) return false;
    if (button && p.button != true) return false;
    if (enabled != null && p.enabled != enabled) return false;
    return true;
  });
}

/// 不可点的件必须带 reason（§11.6）：enabled=false 时 hint 不许为空。
bool _semEnabled(WidgetTester tester, String label) {
  final node = tester.widget<Semantics>(semNode(label));
  if (node.properties.enabled == true) return true;
  expect(node.properties.hint, isNotNull,
      reason: '「$label」不可点时必须在语义节点上给出不敢点的原因（§11.6）');
  return false;
}

/// 点一下语义件 —— 不加任何静音参数：没挂语义节点或点不到，测试直接红。
Future<void> _tap(WidgetTester tester, Finder finder) async {
  expect(finder, findsOneWidget);
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('伴创主页：三题与聊天同屏，不是弹层', (tester) async {
    final session = _FakeSession();
    final controller = await _pump(tester, session: session);
    await session.send('来一首深夜加班听的歌');
    session.emitAsk();
    await tester.pumpAndSettle();

    // 聊天流里有助手说的话，且与三题同时在屏幕上
    expect(find.textContaining('懂了，我按这个方向来'), findsWidgets);
    expect(find.byType(AgentAskCard), findsNWidgets(3));
    expect(find.text('想要什么情绪？'), findsOneWidget);
    expect(find.text('谁来唱？'), findsOneWidget);
    expect(find.text('曲风偏哪边？'), findsOneWidget);
    expect(find.text('先定这三件事，之后就不用再问了'), findsWidgets);
    // 推荐项高亮（recommended_idx）
    expect(find.text('有推荐'), findsWidgets);
    expect(controller.state.questions.length, 3);
    // 三题一次给齐，且不超过 3 题（ask_budget=3）
    session.emitAsk(limit: 3);
    await tester.pumpAndSettle();
    expect(find.byType(AgentAskCard), findsNWidgets(3));
  });

  testWidgets('选择后状态即时更新并写回引擎；载荷生效不靠猜 label',
      (tester) async {
    final session = _FakeSession();
    final controller = await _pump(tester, session: session);
    session.emitAsk();
    await tester.pumpAndSettle();

    await _tap(tester, find.text('热血'));

    expect(controller.state.answers[0], 1);
    expect(session.answered[0], 1);
    expect(find.text('你选了「热血」'), findsOneWidget);
    // 选项自带 set.bpm=128 → 简报里看得见（不是从 label 猜出来的）
    expect(find.text('快慢'), findsOneWidget);
    expect(find.text('128'), findsOneWidget);
  });

  testWidgets('跳过这题生效：按推荐值填、写回引擎、简报看得见', (tester) async {
    final session = _FakeSession();
    final controller = await _pump(tester, session: session);
    session.emitAsk();
    await tester.pumpAndSettle();

    await _tap(tester, semNode('跳过这题：谁来唱？'));

    expect(controller.state.skipped.contains(1), isTrue);
    expect(session.skipped, contains(1));
    expect(find.textContaining('已跳过，先用推荐的「女声」'), findsOneWidget);
    expect(find.text('谁来唱'), findsOneWidget);
    expect(find.text('女声'), findsWidgets);
    // 「女声」是唱法，不许被当成曲风（IA review #1 的同一根因）
    expect(find.textContaining('曲风 女声'), findsNothing);
  });

  // ---- 2026-11-28 产品拍板：智能体页不呈现计费 ----
  // 原来这两条判的是「简报卡必须报价」「积分不够必须给出路且不许开始」。现在口径反过来：
  // 页面上根本不出现计费；主 CTA 也不许被计费扣住——钱只由服务端裁决，真不够时它的原话上屏。
  testWidgets('智能体页不呈现计费：整页不许出现单价/合计/余额/刷新价格', (tester) async {
    // 先把题问出来 —— 简报卡如今只在"真定下了东西"时才出现
    // （过去它靠 price.known 也能被撑出来，那等于给还没开始的活儿先摆一张价目表）。
    final session = _FakeSession();
    await _pump(tester, session: session);
    session.emitAsk();
    await tester.pumpAndSettle();
    expect(find.byType(AgentBriefCard), findsOneWidget, reason: '简报卡本身还得在');
    for (final bad in ['每首', '合计', '余额', '刷新价格', '积分', '价格', '花钱']) {
      expect(find.textContaining(bad), findsNothing, reason: '智能体页不该出现计费文案：' + bad);
    }
  });

  testWidgets('主 CTA 不被计费扣住：答完就能开始，也不出现积分不够那套话', (tester) async {
    final session = _FakeSession();
    final controller = await _pump(tester, session: session);
    session.emitAsk();
    await tester.pumpAndSettle();
    for (final q in _questions) {
      await _tap(tester, semNode('跳过这题：' + q['q'] as String));
    }
    expect(controller.state.unansweredCount, 0);
    expect(_semEnabled(tester, '就用这些，开始做（待你确认）'), isTrue);
    expect(find.textContaining('积分不够'), findsNothing);
    expect(find.textContaining('价格'), findsNothing);
  });

  testWidgets('拍板权在人：没答完不可点（带原因），答完才走"待你确认"',
      (tester) async {
    final session = _FakeSession()..confirmYieldsTicket = true;
    final controller = await _pump(tester, session: session);
    session.emitAsk();
    await tester.pumpAndSettle();

    expect(_semEnabled(tester, '就用这些，开始做（待你确认）'), isFalse);
    expect(find.textContaining('题没答'), findsWidgets); // 不可点必须说清为什么

    for (final q in _questions) {
      await _tap(tester, semNode('跳过这题：${q['q']}'));
    }
    expect(controller.state.unansweredCount, 0);
    expect(_semEnabled(tester, '就用这些，开始做（待你确认）'), isTrue);

    await _tap(tester, semNode('就用这些，开始做（待你确认）'));

    expect(session.sent, contains(kAgentConfirmUtterance));
    expect(controller.state.confirmed, isTrue);
    expect(find.textContaining('已交给你确认过'), findsWidgets);
    // 界面永不宣布"办成了"（CONTRACTS.md:828 / §11.5）
    expect(find.textContaining('已生成'), findsNothing);
    expect(find.textContaining('已完成'), findsNothing);
  });

  testWidgets('createAgentMode 关闭：伴创档位整档隐藏、残留 tier 回落、页面不假可用',
      (tester) async {
    // 档位数据驱动：伴创整档不出现，其余三档一字不变（create_layout_test 零回归）
    final off = CreationTiers.visible(cocreateEnabled: false);
    expect(off.map((e) => e.label).toList(), ['简约', '标准', '深度']);
    expect(off.any((e) => e.tier == CreationTiers.tierCocreate), isFalse);
    // 2026-11-28 产品拍板：档位条不放「智能体」跳转位（底栏才是伴创入口）——
    // 开态下档位条 = 三档（+复刻灰度开时 4）
    expect(CreationTiers.visible(cocreateEnabled: true).length, 3);
    expect(
        CreationTiers.visible(cocreateEnabled: true, replicaEnabled: true)
            .length,
        4);
    // tier 是持久化身份（0/1/2 不可变、3=伴创），显示顺序与 tier 解耦
    expect(CreationTiers.labelOf(0), '简约');
    expect(CreationTiers.labelOf(2), '深度');
    expect(CreationTiers.byTier(3), isNull,
        reason: '档位条数据源不含智能体（tier=3 只是持久化身份）');
    expect(CreationTiers.indexOfTier(3, cocreateEnabled: true), isNull);
    // 开关关闭时持久化里残留的 tier=3 回落简约（V35-㉕）
    expect(CreationTiers.resolveStoredTier(3, cocreateEnabled: false),
        CreationTiers.tierEasy);
    expect(CreationTiers.resolveStoredTier(2, cocreateEnabled: false), 2);
    expect(cocreateEnabledOf(null), isFalse); // 配置没下来 = 关

    // 真被挂上时也不许假可用：说清楚 + 给出路 + 不出现输入区
    await _pump(
      tester,
      agentMode: false,
      widgetFor: (_) => const AgentCocreatePage(enableVoice: false),
    );
    expect(find.text('还没对你开放'), findsOneWidget);
    expect(find.textContaining('回「创建」'), findsOneWidget);
    expect(find.byType(AgentComposer), findsNothing);
  });

  testWidgets('语音发送落地：复用 AssistantVoiceButton，识别不了给出路',
      (tester) async {
    await _pump(
      tester,
      enableVoice: true,
      extraOverrides: [
        speechServiceProvider.overrideWithValue(_FakeSpeech()),
      ],
    );
    final mic = find.byIcon(Icons.mic_rounded);
    expect(mic, findsOneWidget); // 此前全仓 0 调用方，这里真正用上
    await tester.ensureVisible(mic);
    await tester.pumpAndSettle();
    await tester.longPress(mic); // 语音键没挂语义节点就该红，不静音
    await tester.pumpAndSettle();
    expect(find.textContaining('直接用打字'), findsOneWidget); // 失败必须给下一步
  });

  // 2026-11-27 产品更正：**层级只有一个方向** —— 小助理办不了往上交给智能体；
  testWidgets('输入区：打字发送正常，且老大页不给「交给小助手」的下沉出口', (tester) async {
    final session = _FakeSession();
    await _pump(
      tester,
      session: session,
    );

    await tester.enterText(find.byType(TextField), '把副歌做得更亮一点');
    await tester.pump();
    await _tap(tester, semNode('发送'));
    expect(session.sent, contains('把副歌做得更亮一点'));

    // 老大页不许有下沉出口：既没有语义按钮，也不许有那句引导文案。
    expect(semNode('交给小助手'), findsNothing);
    expect(find.textContaining('交给小助手'), findsNothing);
  });

  testWidgets('步骤流不外泄工具名与黑话', (tester) async {
    final session = _FakeSession();
    await _pump(tester, session: session);
    session.emitToolAndResult();
    await tester.pumpAndSettle();

    expect(find.textContaining('我把速度调慢了一点'), findsWidgets);
    expect(find.textContaining('music.adjust_params'), findsNothing);
    expect(find.textContaining('tool'), findsNothing);
    expect(find.textContaining('token'), findsNothing);
    expect(find.textContaining('skill'), findsNothing);
  });

  // 真机 K90 上原本只有一条路：模型把三题写成正文，用户只能打字。这条用例把口径钉反
  // —— 题到了就点得动，点完主 CTA 就能走，全程不碰输入框（打字不是必需路径）。
  testWidgets('提问卡：三题点得动，点完主 CTA 可用（一个字都不用打）', (tester) async {
    final session = _FakeSession();
    final controller = await _pump(tester, session: session);
    session.emitAsk();
    await tester.pumpAndSettle();

    // 每题点一个：候选是挂在语义节点上的按钮，没挂或点不动就该红（不静音、不 warnIfMissed）
    await _tap(tester, find.text('平静'));
    await _tap(tester, find.text('纯音乐'));
    await _tap(tester, find.text('电子'));

    expect(controller.state.answers[0], 0);
    expect(controller.state.answers[1], 2);
    expect(controller.state.answers[2], 0);
    expect(controller.state.unansweredCount, 0);
    // 点选要写回会话 —— 攒答案的是会话层，界面上"看着选中了"不算答完
    expect(session.answered[0], 0);
    expect(session.answered[1], 2);
    expect(session.answered[2], 0);

    expect(_semEnabled(tester, '就用这些，开始做（待你确认）'), isTrue);
    // 全程没往输入框里打过一个字
    expect(
        tester.widget<TextField>(find.byType(TextField)).controller?.text ?? '',
        isEmpty,
        reason: '答完题不该还要打字才能开始（澄清必须走可点选的提问卡）');
  });
}
