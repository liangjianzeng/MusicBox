// 「建议 → 确认票 → 真开工」这条链的回归测试（v5.9.9.5）。
//
// 为什么单开一个文件：真机上那条链断得很难看 —— 模型问完三题、用户逐题点完、点了简报卡主
// CTA，界面上**什么也不再发生**：没有确认票、没有新卡片、没有新气泡，服务端 jobs 表零行。
// 成因是两端都没接线（装配处没传 `onProposal`、服务端没有出票路由、票面通道 provider 恒为
// null），而单测里谁都没判「用户点完之后到底还有没有可点的东西」。
//
// 这里判的是**用户视角的收尾**：全部走真装配（`buildAgentEngine` + 真 `AgentBridgeSession`
// + 真 `AgentUiController`），只把最外层两条 HTTP 换成假的（模型回包、出票通道）。
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/features/agent/agent_bootstrap.dart' as bootstrap;
import 'package:musicbox/features/agent/agent_config.dart';
import 'package:musicbox/features/agent/engine/agent_events.dart';
import 'package:musicbox/features/agent/engine/agent_messages.dart';
import 'package:musicbox/features/agent/engine/agent_transport.dart';
import 'package:musicbox/features/agent/tools/proposal_tools.dart';
import 'package:musicbox/features/agent/ui/agent_view_model.dart' as ui;

// ── 假的模型回包（脚本化）与假的出票通道 ────────────────────────────────────

class _ScriptedTransport implements AgentTransport {
  _ScriptedTransport(this.replies);
  final List<AgentLlmReply> replies;
  final requests = <AgentLlmRequest>[];

  @override
  Future<AgentLlmReply> complete(AgentLlmRequest r) async {
    requests.add(r);
    return requests.length <= replies.length
        ? replies[requests.length - 1]
        : replies.last;
  }
}

AgentLlmReply _toolReply(List<Map<String, String>> calls) => AgentLlmReply(
      content: '',
      toolCalls: [
        for (var i = 0; i < calls.length; i++)
          AgentToolCallDto(
            id: calls[i]['id'] ?? 'call_$i',
            name: calls[i]['name']!,
            argumentsJson: calls[i]['args'] ?? '{}',
          ),
      ],
      finishReason: AgentFinishReason.toolCalls,
      usage: const AgentUsage(promptTokens: 100, completionTokens: 30),
    );

AgentLlmReply _textReply(String t) => AgentLlmReply(
      content: t,
      finishReason: AgentFinishReason.stop,
      usage: const AgentUsage(promptTokens: 120, completionTokens: 40),
    );

/// 假的服务端出票层。形状照 `src/server/api/agent.js` 那三条路由回；
/// **谁是权威**也照它：条数由服务端定（这里固定 3 条），端侧不许自己拍。
class _FakeTicketServer {
  final issued = <Map<String, dynamic>>[];
  final confirmed = <String, Map<String, String>>{};
  final denied = <String>[];

  /// 真派出活的票（= 服务端真的建出过任务）。测试判"有没有偷偷开工"就看这个。
  final dispatched = <String>[];

  /// true = 带 `auto_confirm` 的请求在同一次里就验票开工（方案 D-2：出曲前一次总确认）。
  bool executedOnIssue = true;
  String nextJobId = 'job_test_1';

  bootstrap.AgentProposalClient get client => bootstrap.AgentProposalClient(
        issue: (body) async {
          issued.add(body);
          final action = '${body['action']}';
          final id = 'tk_${issued.length}';
          final payload = body['payload'] is Map
              ? Map<String, dynamic>.from(body['payload'] as Map)
              : <String, dynamic>{};
          final params = <String, dynamic>{
            // 模型没填 count 就回落平台默认 3（= 服务端 config.gen.count_default）。
            // 真机上那个「候选条数：1 条」就是端侧工具的默认值冒充了用户意愿。
            'count': payload['count'] ?? 3,
            'sec': payload['sec'] ?? 45,
          };
          // 凭据总是先记着：pending 那张也得能被 confirm 验掉（服务端把 ver/hash 随票回带）。
          confirmed[id] = {'ver': '1', 'hash': 'h$id'};
          final executed = body['auto_confirm'] == true && executedOnIssue;
          if (executed) {
            dispatched.add(id);
            return {
              'executed': true,
              'job_id': nextJobId,
              'intent_id': 'in_agent_1',
              'reply': '好，这版已经开始排队，出 ${params['count']} 条候选。',
              'ticket': {
                'ticket_id': id,
                'action': action,
                'status': 'succeeded',
                'ver': '1',
                'hash': 'h$id',
                'diff': '出 ${params['count']} 条候选 · 大约 ${params['sec']} 秒',
                'minutes': 2,
                'params': params,
                'job_id': nextJobId,
              },
            };
          }
          return {
            'executed': false,
            'ticket': {
              'ticket_id': id,
              'action': action,
              'status': 'pending',
              'ver': '1',
              'hash': 'h$id',
              'diff': '出 ${params['count']} 条候选 · 大约 ${params['sec']} 秒',
              'minutes': 2,
              'params': params,
            },
          };
        },
        confirm: (id, ver, hash) async {
          // 端侧对应服务端那五连校验：凭据不对就不给办。
          final want = confirmed[id];
          if (want == null || want['hash'] != hash || want['ver'] != ver) {
            throw StateError('TICKET_UNUSABLE');
          }
          dispatched.add(id);
          return {
            'executed': true,
            'ticket_id': id,
            'job_id': '${nextJobId}_$id',
            'intent_id': 'in_agent_1',
            'params': const {'count': 3, 'sec': 45},
            'reply': '好，这版已经开始排队。',
          };
        },
        deny: (id) async {
          denied.add(id);
        },
      );
}

/// 真装配的脚手架：真引擎 + 真防腐层 + 真 VM。
class _Harness {
  _Harness(
    List<AgentLlmReply> replies, {
    bootstrap.AgentProposalClient? tickets,
    bool injectGateway = true,
    AgentEngineConfig config = const AgentEngineConfig(),
  }) : transport = _ScriptedTransport(replies) {
    engine = buildAgentEngine(
      transport: transport,
      config: config,
      librarySearch: (_, __) async => const [],
      // 装配处挂不挂这一条就是断头路的分水岭；缺它的用例显式不给 tickets。
      onProposal: tickets == null ? null : (p) => session.handleProposal(p),
      onEvent: (e) {
        if (!ctl.isClosed) ctl.add(e);
      },
    );
    session = bootstrap.AgentBridgeSession(
      engine: engine,
      events: ctl.stream,
      tickets: tickets,
    );
    vm = ui.AgentUiController(
      session: session,
      tickets: injectGateway && tickets != null ? session.ticketGateway : null,
    );
  }

  final _ScriptedTransport transport;
  final ctl = StreamController<AgentEvent>.broadcast(sync: true);
  late final AgentEngine engine;
  late final bootstrap.AgentBridgeSession session;
  late final ui.AgentUiController vm;

  /// 走完真机上那一段：说一句灵感 → 三题逐题点选（回填「我选：…」）。
  Future<void> walkToAnswers({int asked = 3}) async {
    await vm.send('来一首深夜加班听的歌');
    await pumpEventQueue();
    for (var i = 0; i < asked; i++) {
      await vm.selectOption(vm.snapshot.questions[i].qIdx, 0);
    }
    await pumpEventQueue();
  }

  static List<String> h(ui.AgentUiState s) => s.entries
      .where((e) => e.role == ui.AgentEntryRole.notice)
      .map((e) => e.text)
      .toList();

  Future<void> dispose() async {
    // ignore: invalid_use_of_visible_for_testing_member
    vm.dispose();
    await session.dispose();
    await ctl.close();
  }
}

/// 三题的标准脚本（真机上模型问的那三题）。
List<AgentLlmReply> _askThenPatchThenText() => [
      _toolReply([
        {
          'name': 'agent.ask_user',
          'args': '{"questions":['
              '{"q":"情绪基调","options":["安静专注","有点力量"]},'
              '{"q":"谁来唱","options":["纯音乐","女声"]},'
              '{"q":"曲风偏哪边","options":["Lo-Fi","爵士"]}]}'
        }
      ]),
      _toolReply([
        {
          'name': 'music.propose_card_patch',
          'args': '{"intent_id":"in_agent_1","reason":"按你选的三条改"}'
        }
      ]),
      _textReply('就按这三条来，确认后我开始做。'),
    ];

void main() {
  group('确认票这条链（真装配）', () {
    test('用户拍一次板，服务端就真建出任务，界面也敢说自己开工了', () async {
      final server = _FakeTicketServer();
      final h = _Harness(
        [
          ..._askThenPatchThenText(),
          // 拍板之后模型才提「真开始做」那一条；count 故意不填 —— 条数归服务端定
          _toolReply([
            {
              'name': 'music.propose_generate',
              'args': '{"intent_id":"in_agent_1","reason":"就用这三条"}'
            }
          ]),
          _textReply('已经开始排队了。'),
        ],
        tickets: server.client,
      );
      addTearDown(h.dispose);

      await h.walkToAnswers();
      expect(h.vm.snapshot.questions.length, 3);
      expect(h.vm.snapshot.briefRows.any((r) => r.label == '出几首'), isTrue);

      await h.vm.confirmBrief();
      await pumpEventQueue();

      // ① 草稿真去了服务端，而且带着「人已经拍过板」这一句
      final gen = server.issued.last;
      expect(gen['action'], 'music.propose_generate');
      expect(gen['auto_confirm'], true,
          reason: '用户按过主 CTA，服务端应当同一次里验票开工，不必再逼他点第二遍');
      // ② 票被消费掉，服务端回了真任务编号
      expect(h.vm.snapshot.ticket?.jobId, isNotNull,
          reason: '没有任务编号就不许说"开工"');
      // ③ 界面上那句"开工"是事件换来的，不是模型说啥就念啥；条数以服务端为准
      expect(
          _Harness.h(h.vm.snapshot)
              .any((t) => t.contains('交给后台排队') && t.contains('3 条')),
          isTrue,
          reason: '念的条数必须是服务端那个 3，不是模型草稿里的 1');
      expect(h.vm.snapshot.confirmed, isTrue);
      // ④ 不该再逼用户点第二遍
      // 第 1 张票是「改任务单」，第 2 张才是「出曲」；只有后者该派出活。
      expect(server.dispatched, ['tk_${server.issued.length}'],
          reason: '只开工一次：auto_confirm 在同一次里消费掉，端侧不该再打一次 confirm');
    });

    test('没拍板时票必须挂在界面上：长出可点的按钮，点了才开工', () async {
      final server = _FakeTicketServer()..executedOnIssue = false;
      final h = _Harness(
        [
          ..._askThenPatchThenText(),
          _toolReply([
            {
              'name': 'music.propose_generate',
              'args': '{"intent_id":"in_agent_1","reason":"先列着"}'
            }
          ]),
          _textReply('我先列成一张票，等你点头。'),
        ],
        tickets: server.client,
      );
      addTearDown(h.dispose);

      await h.walkToAnswers();
      await pumpEventQueue();

      final pending = h.vm.snapshot.ticket;
      expect(pending, isNotNull, reason: '服务端换了票，界面上就得看得见');
      expect(pending!.pending, isTrue);
      expect(h.vm.snapshot.showBrief, isTrue, reason: '票挂在简报卡里，不能藏在屏幕外');
      expect(server.dispatched, isEmpty, reason: '用户还没拍板，一单都不该派');
      expect(_Harness.h(h.vm.snapshot).any((t) => t.contains('就按这张票办')), isTrue,
          reason: '要让用户知道下一步点哪儿（§11.5：失败态与等待态都得给出路）');

      await h.vm.confirmTicket(pending.id);
      await pumpEventQueue();

      expect(server.confirmed[pending.id], {'ver': '1', 'hash': 'h${pending.id}'},
          reason: 'confirm 必须带票面上的 ver/hash —— 服务端五连校验认的就是这两个');
      expect(_Harness.h(h.vm.snapshot).any((t) => t.contains('已经开始做了')), isTrue);
      expect(h.vm.snapshot.ticket?.settled, isTrue);
      expect(server.dispatched, [pending.id], reason: '点了那颗钮才第一次派活，且只派一次');
    });

    test('出票通道没接上时：不许演"在等你确认"，也不许把主 CTA 锁死', () async {
      final h = _Harness(
        [
          ..._askThenPatchThenText(),
          _toolReply([
            {
              'name': 'music.propose_generate',
              'args': '{"intent_id":"in_agent_1","reason":"开始做"}'
            }
          ]),
          _textReply('这一步还只是草稿，没有真正开始做。'),
        ],
        // tickets 故意不给：装配缺件时用户看到的必须是「没交上去」，
        // 而不是一张摆了却点了没反应的假票面。
      );
      addTearDown(h.dispose);

      await h.walkToAnswers();
      await h.vm.confirmBrief();
      await pumpEventQueue();

      final s = h.vm.snapshot;
      expect(s.ticket, isNull, reason: '根本没有票，不许在屏幕上摆一张假的');
      expect(s.confirmed, isFalse,
          reason: '什么都没换出来却把钮锁死，用户连重试的入口都没有（断头路的最后一米）');
      expect(s.confirmGate.enabled, isTrue, reason: '这颗钮必须还能再按');
      final n = _Harness.h(s);
      expect(n.any((t) => t.contains('没真的开工')), isTrue);
      expect(n.any((t) => t.contains('已开始') || t.contains('做完了')), isFalse,
          reason: '没开工就绝不念「已开始 / 做完了」（CONTRACTS.md:828）');
    });

    test('票面通道没注入时，点「就按这张票办」必须喊出来，不许静默', () async {
      final server = _FakeTicketServer()..executedOnIssue = false;
      final h = _Harness(
        [
          ..._askThenPatchThenText(),
          _toolReply([
            {
              'name': 'music.propose_generate',
              'args': '{"intent_id":"in_agent_1","reason":"先列着"}'
            }
          ]),
          _textReply('先列张票。'),
        ],
        tickets: server.client,
        injectGateway: false, // 会话能出票，但界面没拿到票面通道（正是 main.dart 漏 override 的那种接线）
      );
      addTearDown(h.dispose);

      await h.walkToAnswers();
      await pumpEventQueue();
      final pending = h.vm.snapshot.ticket;
      expect(pending, isNotNull);

      await h.vm.confirmTicket(pending!.id);
      await pumpEventQueue();

      expect(h.vm.snapshot.error, isNotNull,
          reason: '以前这里是 `if (g == null) return;` —— 用户点了，屏幕上什么反应都没有');
      expect(h.vm.snapshot.entries.any((e) => e.text.contains('通道没接上')), isTrue);
      expect(server.dispatched, isEmpty, reason: '通道没接上就不能真的开工');
    });

    test('引擎试过但没开头的步骤也要留在屏幕上，内部名一个都不许外泄', () async {
      final server = _FakeTicketServer();
      final h = _Harness([
        _toolReply([
          // 入参不合格：引擎只发 finished(ok:false)，没有 started
          {'name': 'music.propose_generate', 'args': '{"reason":"缺 intent_id"}'},
          // 模型喊了个不存在的 capability：引擎只发 tool/deprecated
          {'name': 'knowledge.web_searchx', 'args': '{}'},
        ]),
        _textReply('我再换个说法。'),
      ], tickets: server.client);
      addTearDown(h.dispose);

      await h.vm.send('来一首深夜加班听的歌');
      await pumpEventQueue();

      final steps = h.vm.snapshot.steps;
      expect(steps.length, greaterThanOrEqualTo(2),
          reason: '这两类"只有结果没有开头"的步骤以前被整条吞掉 —— 真机上模型明明试过了，'
              '屏幕上连一张卡都没出现过');
      expect(steps.every((s) => s.label.isNotEmpty), isTrue);
      final joined =
          '${h.vm.snapshot.entries.map((e) => e.text).join(' ')} ${steps.map((s) => s.label).join(' ')}';
      for (final leak in ['propose_generate', 'web_searchx', 'music.', 'agent.']) {
        expect(joined.contains(leak), isFalse, reason: '内部名不许上屏（§11.5 黑话纪律）：$leak');
      }
    });

    test('降级那一轮不许把同一句助手回复念两遍', () async {
      final server = _FakeTicketServer()..executedOnIssue = false;
      final h = _Harness([
        _toolReply([
          {'name': 'music.propose_card_patch', 'args': '{"intent_id":"i","reason":"改一下"}'},
        ]),
        _textReply('我先把要改的列出来。'),
      ], tickets: server.client);
      addTearDown(h.dispose);

      await h.vm.send('帮我把情绪改成安静点');
      await pumpEventQueue();

      final said = h.vm.snapshot.entries
          .where((e) => e.role == ui.AgentEntryRole.assistant)
          .map((e) => e.text)
          .toList();
      expect(said.where((t) => t == '我先把要改的列出来。').length, 1,
          reason: '真机上并排出现两条一模一样的气泡：引擎那条 + 会话合成的那条都念了 r.text');
    });

    test('三个建议工具都得有界面上念得出的人话，不许落到那句含糊的兜底', () {
      for (final t in [
        buildProposeCardPatchTool(),
        buildProposeGenerateTool(),
        buildProposeMvShotReworkTool(),
      ]) {
        expect(t.activityLabel.trim().isNotEmpty, isTrue, reason: '${t.name} 没有活动名');
        expect(ui.agentHumanToolLabel(t.name).contains('助手正在办一件事'), isFalse,
            reason: '${t.name} 落到兜底那句，用户看不出这张卡到底在办什么');
      }
    });
  });
}
