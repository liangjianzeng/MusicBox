import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/speech/speech_service.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/core/ws_client.dart';
import 'package:musicbox/features/mv/assistant_sheet.dart';
import 'package:musicbox/features/mv/mv_api_client.dart';
import 'package:musicbox/features/mv/mv_models.dart';
import 'package:musicbox/features/mv/mv_progress_page.dart';
import 'package:musicbox/features/mv/mv_state.dart';
import 'package:musicbox/features/mv/widgets/mv_common.dart';
import 'package:shared_preferences/shared_preferences.dart';

MvShot _shot(
  String id,
  int seq, {
  String kind = 'story',
  double sec = 5,
  String? desc,
  String? camera,
  String status = 'draft',
}) =>
    MvShot(
      id: id,
      projectId: 'p1',
      seq: seq,
      kind: kind,
      sec: sec,
      desc: desc ?? '镜头 $id',
      camera: camera ?? '中景',
      status: status,
    );

Map<String, dynamic> _detail({
  int ver = 1,
  String status = 'scripting',
  List<MvShot> shots = const [],
  List<Map<String, dynamic>> tickets = const [],
}) =>
    {
      'project': {
        'id': 'p1',
        'work_id': 'w1',
        'title': '审查修复样片',
        'kind': 'vocal',
        'status': status,
        'script_ver': ver,
        'est_ver': 'est-hash',
        'created_at': '2026-11-24T00:00:00Z',
      },
      'characters': const [],
      'shots': [
        for (final s in shots)
          {
            'id': s.id,
            'project_id': s.projectId,
            'seq': s.seq,
            'kind': s.kind,
            'sec': s.sec,
            'desc': s.desc,
            'camera': s.camera,
            'status': s.status,
          },
      ],
      'tickets': tickets,
      'assistant': {'enabled': true, 'chat_enabled': true},
    };

class _FakeMvApi extends Fake implements MvApiClient {
  _FakeMvApi(this.detail);

  Map<String, dynamic> detail;
  Map<String, dynamic>? nextProjectResponse;
  bool failProject = false;
  bool staleOnce = false;
  int projectCalls = 0;
  int patchCalls = 0;
  int shotJobCalls = 0;
  int confirmCalls = 0;
  int denyCalls = 0;
  String? confirmedVer;
  String? confirmedHash;
  String? deniedId;
  final patches = <Map<String, dynamic>>[];
  Map<String, dynamic> assistantResponse = const {};
  String? assistantText;
  List<Map<String, dynamic>> assistantChips = const [];

  @override
  Future<Map> project(String id) async {
    projectCalls++;
    if (failProject) {
      throw ApiException(code: 'NETWORK', message: '刷新失败');
    }
    final next = nextProjectResponse;
    if (next != null) {
      nextProjectResponse = null;
      return next;
    }
    return detail;
  }

  @override
  Future<Map> patchProject(
    String projectId, {
    required int ver,
    String? title,
    String? brief,
    Map<String, dynamic>? scriptJson,
    String? queueMode,
    int? budgetCredits,
  }) async {
    patchCalls++;
    patches.add({'ver': ver, 'script_json': scriptJson});
    if (staleOnce && patchCalls == 1) {
      throw ApiException(code: 'STALE', message: '版本过期', status: 409);
    }
    final payload = scriptJson?['shots'] as List? ?? const [];
    final byId = {
      for (final s in MvProjectDetail.fromMap(detail).shots) s.id: s
    };
    detail = {
      ...detail,
      'project': {
        ...(detail['project'] as Map),
        'script_ver': ver + 1,
      },
      'shots': [
        for (var i = 0; i < payload.length; i++)
          () {
            final raw = payload[i] as Map;
            final base = byId['${raw['id']}'];
            return {
              ...(detail['shots'] as List).cast<Map>().firstWhere(
                    (s) => s['id'] == raw['id'],
                    orElse: () => <String, dynamic>{},
                  ),
              'id': raw['id'],
              'project_id': 'p1',
              'seq': raw['seq'] ?? i + 1,
              'kind': raw['kind'] ?? base?.kind ?? 'story',
              'sec': raw['sec'] ?? base?.sec ?? 5,
              'desc': raw['desc'] ?? base?.desc ?? '',
              'camera': raw['camera'] ?? base?.camera ?? '',
              'status': base?.status ?? 'draft',
            };
          }(),
      ],
    };
    return {'project': detail['project']};
  }

  @override
  Future<Map> shotJob(
    String shotId, {
    required String type,
    String? reason,
    String initiatedBy = 'user',
  }) async {
    shotJobCalls++;
    return {'job_id': 'j1', 'credits_charged': 40, 'idempotent': false};
  }

  @override
  Future<Map> assistantMessages({
    String? sessionId,
    required String text,
    List<Map<String, dynamic>> chips = const [],
  }) async {
    assistantText = text;
    assistantChips = chips;
    return assistantResponse;
  }

  @override
  Future<Map> confirmTicket(String ticketId,
      {String? ver, String? hash}) async {
    confirmCalls++;
    confirmedVer = ver;
    confirmedHash = hash;
    return {'executed': true};
  }

  @override
  Future<void> denyTicket(String ticketId) async {
    denyCalls++;
    deniedId = ticketId;
  }
}

Future<ProviderContainer> _container(_FakeMvApi api) async {
  final container = ProviderContainer(overrides: [
    mvApiClientProvider.overrideWithValue(api),
  ]);
  final subscription =
      container.listen(mvProjectDetailProvider('p1'), (_, __) {});
  addTearDown(subscription.close);
  addTearDown(container.dispose);
  final notifier = container.read(mvProjectDetailProvider('p1').notifier);
  await notifier.refresh();
  // 构造器的首次 refresh 与显式 refresh 合并后可能补排一次静默刷新，
  // 先把微任务队列排空，避免它消费测试准备的 CAS 响应。
  await Future<void>.delayed(Duration.zero);
  await notifier.refresh();
  return container;
}

void main() {
  test('MV 外来文案保留正常信息且屏蔽费用运营话术', () {
    expect(mvUserVisibleText('镜头已进入拍摄队列'), '镜头已进入拍摄队列');
    expect(userVisibleText('本次需要支付 10 元'), '本次操作未完成，请稍后重试');
    expect(mvUserVisibleText('本次消耗 40 积分，余额不足'), '本次操作未完成，请稍后重试');
    expect(
      mvUserVisibleError(
          ApiException(code: 'BUDGET_EXCEEDED', message: '超出预算')),
      '本次操作未完成，请稍后重试',
    );
  });

  test('镜卡序列化在调序和删镜后仍保留稳定 id', () {
    final a = _shot('shot-a', 1);
    final b = _shot('shot-b', 2);
    final c = _shot('shot-c', 3);
    final reordered = [c.copyWith(seq: 1), a.copyWith(seq: 2)];

    expect(reordered.map((s) => s.toScriptShot()['id']), ['shot-c', 'shot-a']);
    expect(reordered.map((s) => s.toScriptShot()['seq']), [1, 2]);
    expect(reordered.any((s) => s.id == b.id), isFalse);
  });

  test('确认票兼容助手 ticket_id/est 与详情 flat/ver/hash', () {
    final issued = MvTicket.fromMap({
      'ticket_id': 't1',
      'action': 'mv.shot_reshoot',
      'est': {'credits': 40, 'minutes': 3},
    });
    expect(issued.id, 't1');
    expect(issued.status, 'pending');
    expect(issued.estCredits, 40);
    expect(issued.estMinutes, 3);
    expect(issued.ver, isNull);
    expect(issued.hash, isNull);

    final hydrated = MvTicket.fromMap({
      'id': 't1',
      'action': 'mv.shot_reshoot',
      'status': 'pending',
      'est_credits': 40,
      'est_minutes': 3,
      'ver': 'ticket-ver',
      'hash': 'ticket-hash',
    });
    expect(hydrated.ver, 'ticket-ver');
    expect(hydrated.hash, 'ticket-hash');
  });

  test('failed 与 shooting 同级，允许恢复门禁', () {
    final failed = MvProject.fromMap({
      'id': 'p1',
      'status': 'failed',
    });
    final shooting = MvProject.fromMap({
      'id': 'p2',
      'status': 'shooting',
    });
    expect(failed.statusRank, shooting.statusRank);
    expect(failed.canBootGate, isTrue);
    expect(failed.hasScript, isTrue);
  });

  test('CAS rebase 保留并发字段与新增镜，并应用用户字段和顺序', () {
    final a = _shot('a', 1, desc: '原 A');
    final b = _shot('b', 2, desc: '原 B');
    final base = [a, b];
    final edited = [
      b.copyWith(seq: 1, camera: '近景'),
      a.copyWith(seq: 2, desc: '用户 A'),
    ];
    final fresh = [
      a.copyWith(sec: 9),
      b.copyWith(kind: 'broll'),
      _shot('concurrent', 3, desc: '并发新增'),
    ];

    final result = rebaseMvShotEdits(base: base, edited: edited, fresh: fresh);
    expect(result.error, isNull);
    expect(result.shots!.map((s) => s.id), ['b', 'a', 'concurrent']);
    expect(result.shots!.map((s) => s.seq), [1, 2, 3]);
    expect(result.shots![0].camera, '近景');
    expect(result.shots![0].kind, 'broll');
    expect(result.shots![1].desc, '用户 A');
    expect(result.shots![1].sec, 9);
    expect(result.shots![2].desc, '并发新增');
  });

  test('CAS rebase 同字段并发修改时明确冲突，不覆盖新值', () {
    final a = _shot('a', 1, desc: '原描述');
    final result = rebaseMvShotEdits(
      base: [a],
      edited: [a.copyWith(desc: '用户描述')],
      fresh: [a.copyWith(desc: '并发描述')],
    );
    expect(result.shots, isNull);
    expect(result.error, contains('请刷新后重试'));
  });

  test('STALE 后第二次 PATCH 使用 rebase  payload，而非旧全量剧本', () async {
    final a = _shot('a', 1, desc: '原 A');
    final b = _shot('b', 2, desc: '原 B');
    final api = _FakeMvApi(_detail(shots: [a, b]))..staleOnce = true;
    final container = await _container(api);
    final notifier = container.read(mvProjectDetailProvider('p1').notifier);
    final edited = [b.copyWith(seq: 1), a.copyWith(seq: 2, desc: '用户 A')];
    api.nextProjectResponse = _detail(
      ver: 2,
      shots: [a.copyWith(sec: 8), b, _shot('new', 3)],
    );

    expect(await notifier.editScript(edited), isNull);
    expect(api.patchCalls, 2);
    expect(api.patches.last['ver'], 2);
    final retryShots =
        (api.patches.last['script_json'] as Map)['shots'] as List;
    expect(retryShots.map((s) => (s as Map)['id']), ['b', 'a', 'new']);
    final retryA = retryShots[1] as Map;
    expect(retryA['desc'], '用户 A');
    expect(retryA['sec'], 8);
  });

  test('PATCH 成功后刷新失败不会永久锁住下一处编辑', () async {
    final a = _shot('a', 1);
    final api = _FakeMvApi(_detail(shots: [a]));
    final container = await _container(api);
    final notifier = container.read(mvProjectDetailProvider('p1').notifier);
    api.failProject = true;

    expect(await notifier.editScript([a.copyWith(desc: '第一次修改')]), isNull);
    expect(
        container.read(mvProjectDetailProvider('p1')).detail!.shots.single.desc,
        '第一次修改');
    api.failProject = false;
    expect(await notifier.editScript([a.copyWith(desc: '第二次修改')]), isNull);
    expect(api.patchCalls, 2);
  });

  test('运动改写只发助手确认票，不直接调用扣费 shotJob', () async {
    final api = _FakeMvApi(_detail(shots: [_shot('s1', 1)]))
      ..assistantResponse = {
        'session_id': 'session-1',
        'reply': '需要您批准：重拍该镜头',
        'ticket': {
          'ticket_id': 'ticket-1',
          'project_id': 'p1',
          'action': 'mv.shot_reshoot',
          'est': {'credits': 40, 'minutes': 3},
        },
      };
    final container = await _container(api);
    final notifier = container.read(mvAssistantProvider('p1').notifier);

    await notifier.quickMotion('s1');
    expect(api.shotJobCalls, 0);
    expect(api.assistantText, contains('动作不对'));
    expect(api.assistantChips.map((c) => c['type']), contains('shot'));
    expect(
        api.assistantChips.firstWhere((c) => c['type'] == 'shot')['id'], 's1');
    final msg = notifier.state.messages.last;
    expect(msg.ticket!.id, 'ticket-1');
    expect(msg.text, contains('批准后'));
    expect(msg.text, contains('幂等命中'));
    expect(msg.text, isNot(contains('⚡')));
    expect(msg.text, isNot(contains('积分')));
  });

  test('批准前从 detail 水合 ver/hash，拒绝不伪造凭据', () async {
    final api = _FakeMvApi(_detail(
      shots: [_shot('s1', 1)],
      tickets: [
        {
          'id': 'ticket-1',
          'action': 'mv.shot_reshoot',
          'status': 'pending',
          'est_credits': 40,
          'est_minutes': 3,
          'ver': 'server-ver',
          'hash': 'server-hash',
        },
      ],
    ));
    final container = await _container(api);
    final detailNotifier =
        container.read(mvProjectDetailProvider('p1').notifier);

    expect(await detailNotifier.resolveTicket('ticket-1', true), isNull);
    expect(api.confirmCalls, 1);
    expect(api.confirmedVer, 'server-ver');
    expect(api.confirmedHash, 'server-hash');

    expect(await detailNotifier.resolveTicket('ticket-1', false), isNull);
    expect(api.denyCalls, 1);
    expect(api.deniedId, 'ticket-1');
  });

  test('发票缺凭据且 detail 查不到时，批准明确失败并允许重试', () async {
    final api = _FakeMvApi(_detail(shots: [_shot('s1', 1)]))
      ..assistantResponse = {
        'ticket': {
          'ticket_id': 'missing-ticket',
          'action': 'mv.shot_reshoot',
          'est': {'credits': 40, 'minutes': 3},
        },
      };
    final container = await _container(api);
    final notifier = container.read(mvAssistantProvider('p1').notifier);
    await notifier.quickMotion('s1');
    final msg = notifier.state.messages.last;

    await notifier.approveTicket(msg);
    expect(api.confirmCalls, 0);
    expect(notifier.state.messages.last.text, contains('未执行任何操作'));
    expect(
      notifier.state.messages
          .firstWhere((m) => m.ticket?.id == 'missing-ticket')
          .ticketHandled,
      isFalse,
    );

    await notifier.denyTicket(MvChatMsg(role: 'ai', text: '空票'));
    expect(notifier.state.messages.last.text, contains('未执行任何操作'));
  });

  test('从服务端恢复未完成 MV 并落到正确步骤，不重复建项目', () async {
    final api = _FakeMvApi({
      ..._detail(shots: [_shot('s1', 1)]),
      'project': {
        ...(_detail()['project'] as Map),
        'status': 'previewed',
        'preview_url': 'http://localhost/f/preview.mp4',
        'brief': '雨夜',
      },
      'characters': const [
        {
          'id': 'c1',
          'project_id': 'p1',
          'gender': 'f',
          'source': 'ai',
          'confirmed_at': '2026-11-25T00:00:00Z',
        },
      ],
    });
    final container = ProviderContainer(overrides: [
      mvApiClientProvider.overrideWithValue(api),
    ]);
    addTearDown(container.dispose);
    final n = container.read(mvWizardProvider('w1').notifier);

    expect(await n.resumeProject('p1'), isTrue);
    expect(n.state.project?.id, 'p1');
    expect(n.state.workId, 'w1');
    expect(n.state.brief, '雨夜');
    expect(n.state.lookConfirmed, isTrue);
    expect(n.state.step, 4);
    final callsAfterResume = api.projectCalls;
    expect(callsAfterResume, greaterThan(0));
    expect(await n.submitCast(), isTrue);
    expect(n.state.step, 2);
    expect(api.projectCalls, callsAfterResume);
  });

  test('恢复失败保留明确错误且不会卡在加载态', () async {
    final api = _FakeMvApi(_detail())..failProject = true;
    final container = ProviderContainer(overrides: [
      mvApiClientProvider.overrideWithValue(api),
    ]);
    addTearDown(container.dispose);
    final n = container.read(mvWizardProvider('w1').notifier);

    expect(await n.resumeProject('p1'), isFalse);
    expect(n.state.resuming, isFalse);
    expect(n.state.resumeError, isNotEmpty);
    expect(n.state.project, isNull);
  });

  testWidgets('离开确认只弹一次，临时 canPop 后真实 pop', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navigator,
      home: Builder(builder: (context) {
        return Scaffold(
          body: FilledButton(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => const Scaffold(
                body: MvLeaveGuard(
                  busy: true,
                  child: Text('受保护页面'),
                ),
              ),
            )),
            child: const Text('进入'),
          ),
        );
      }),
    ));
    await tester.tap(find.text('进入'));
    await tester.pumpAndSettle();
    expect(find.text('受保护页面'), findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('离开当前页面？'), findsOneWidget);
    await tester.tap(find.text('确认离开'));
    await tester.pumpAndSettle();

    expect(find.text('受保护页面'), findsNothing);
    expect(find.text('离开当前页面？'), findsNothing);
    expect(navigator.currentState!.canPop(), isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('failed 项目通告板开放重拍和运动改写', (tester) async {
    final api = _FakeMvApi(_detail(
      status: 'failed',
      shots: [_shot('s1', 1, status: 'stale')],
    ));
    final ws =
        WsClient(wsUrl: 'ws://127.0.0.1:1/ws', tokenProvider: () => null);
    addTearDown(ws.dispose);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        mvApiClientProvider.overrideWithValue(api),
        wsClientProvider.overrideWithValue(ws),
      ],
      child: const MaterialApp(
        home: MvProgressPage(projectId: 'p1'),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.textContaining('本次制作未成功'), findsOneWidget);
    expect(find.text('重拍'), findsOneWidget);
    expect(find.text('运动改写'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('助手页面关闭后，迟到的语音会话取消且不 start', (tester) async {
    final created = Completer<StreamingAsrSession?>();
    final speech = _FakeSpeechService(created);
    final session = _FakeAsrSession();
    SharedPreferences.setMockInitialValues({});
    final prefs = Prefs(await SharedPreferences.getInstance());
    final api = _FakeMvApi(_detail(shots: [_shot('s1', 1)]));

    await tester.pumpWidget(ProviderScope(
      overrides: [
        prefsProvider.overrideWithValue(prefs),
        speechServiceProvider.overrideWithValue(speech),
        mvApiClientProvider.overrideWithValue(api),
      ],
      child: const MaterialApp(
        home: Scaffold(body: MvAssistantSheet(projectId: 'p1', shotId: 's1')),
      ),
    ));

    final gesture = await tester
        .startGesture(tester.getCenter(find.byIcon(Icons.mic_rounded)));
    await tester.pump(kLongPressTimeout + const Duration(milliseconds: 100));
    expect(speech.createCalls, 1);
    await gesture.up();
    await tester.pump();
    await tester.pumpWidget(const SizedBox());

    created.complete(session);
    await tester.pump();
    expect(session.cancelCalls, 1);
    expect(session.startCalls, 0);
    expect(tester.takeException(), isNull);
  });
}

class _FakeSpeechService extends Fake implements SpeechService {
  _FakeSpeechService(this.created);

  final Completer<StreamingAsrSession?> created;
  int createCalls = 0;

  @override
  Future<StreamingAsrSession?> createSession({String? saveWavPath}) {
    createCalls++;
    return created.future;
  }

  @override
  Future<void> stopSpeak() async {}
}

class _FakeAsrSession extends Fake implements StreamingAsrSession {
  int startCalls = 0;
  int cancelCalls = 0;

  @override
  Stream<String> get partialText => const Stream.empty();

  @override
  Future<void> start() async {
    startCalls++;
  }

  @override
  Future<AsrOutcome> stop() async => AsrOutcome.empty;

  @override
  Future<void> cancel() async {
    cancelCalls++;
  }

  @override
  Future<void> dispose() async {}
}
