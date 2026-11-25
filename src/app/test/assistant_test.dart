import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/core/ws_client.dart';
import 'package:musicbox/features/assistant/assistant_api_client.dart';
import 'package:musicbox/features/assistant/assistant_models.dart';
import 'package:musicbox/features/assistant/assistant_state.dart';
import 'package:musicbox/features/assistant/assistant_surface.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeApi extends Fake implements ApiClient {}

class _FakeAssistantApi extends Fake implements AssistantApiClient {
  _FakeAssistantApi(this.bootstrapData);

  AssistantBootstrap bootstrapData;
  final sentRefs = <List<AssistantRef>>[];
  final sentClientIds = <String>[];
  int confirmCalls = 0;

  @override
  Future<AssistantBootstrap> bootstrap() async => bootstrapData;

  @override
  Future<AssistantMessagePage> messages(String sessionId,
      {int afterSeq = 0}) async {
    return const AssistantMessagePage([
      AssistantMessage(id: 'm1', seq: 1, role: 'assistant', content: '上次聊到这里'),
    ], 1);
  }

  @override
  Future<AssistantMessageResult> sendMessage({
    String? sessionId,
    required String clientMsgId,
    required String text,
    String surface = 'create',
    List<AssistantRef> refs = const [],
  }) async {
    sentRefs.add(refs);
    sentClientIds.add(clientMsgId);
    return AssistantMessageResult(
        sessionId: sessionId ?? 's1',
        message: AssistantMessage(
            id: 'u_$clientMsgId',
            seq: 2,
            role: 'user',
            content: text,
            clientMsgId: clientMsgId),
        reply: '已收到',
        meta: const {'mode': 'rule'});
  }

  @override
  Future<List<AssistantTask>> tasks() async => const [];

  @override
  Future<List<AssistantTicket>> tickets() async => const [];

  @override
  Future<AssistantTicket> confirmTicket(
      String id, String ver, String hash) async {
    confirmCalls++;
    return AssistantTicket(
        id: id,
        action: 'music.set_title',
        status: 'succeeded',
        ver: ver,
        hash: hash,
        reply: '标题已更新');
  }

  @override
  Future<AssistantTicket> denyTicket(String id) async =>
      AssistantTicket(id: id, action: 'music.set_title', status: 'denied');

  @override
  Future<AssistantEventPage> events(int afterSeq) async =>
      AssistantEventPage(const [], afterSeq);
}

AssistantBootstrap _bootstrap({List<AssistantTicket> tickets = const []}) =>
    AssistantBootstrap(
        available: true,
        mode: 'rule',
        capabilities: const {'chat': true, 'music': true},
        recentSession: const AssistantSession(id: 's1', title: '昨夜灵感'),
        pendingTickets: tickets);

Future<ProviderContainer> _container(_FakeAssistantApi api) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = Prefs(await SharedPreferences.getInstance());
  final ws = WsClient(wsUrl: 'ws://127.0.0.1:1/ws', tokenProvider: () => null);
  final container = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(prefs),
    apiClientProvider.overrideWithValue(_FakeApi()),
    wsClientProvider.overrideWithValue(ws),
    assistantApiClientProvider.overrideWithValue(api),
  ]);
  addTearDown(() {
    container.dispose();
    ws.dispose();
  });
  return container;
}

void main() {
  test('统一助手模型保留会话、实体、确认票和事件游标', () {
    final ticket = AssistantTicket.fromMap({
      'ticket_id': 't1',
      'action': 'music.adjust_params',
      'status': 'pending',
      'ver': '3',
      'hash': 'h',
      'est': {'credits': 12, 'minutes': 2},
      'diff': '速度 90 → 100',
    });
    expect(ticket.canConfirm, isTrue);
    expect(ticket.credits, 12);
    expect(ticket.meta['diff'], '速度 90 → 100');

    final page = AssistantEventPage.fromMap({
      'next_seq': 9,
      'items': [
        {
          'seq': 8,
          'event': {
            'type': 'assistant.message',
            'payload': {'session_id': 's1'}
          }
        }
      ]
    });
    expect(page.nextSeq, 9);
    expect(page.items.single.type, 'assistant.message');
  });

  test('重开助手恢复服务端最近会话，显式脱离不发送旧实体', () async {
    final api = _FakeAssistantApi(_bootstrap());
    final container = await _container(api);
    final notifier = container.read(assistantProvider.notifier);
    await notifier.bootstrap();
    expect(notifier.state.sessionId, 's1');
    expect(notifier.state.messages.single.content, '上次聊到这里');

    container.read(assistantContextProvider.notifier).state =
        const AssistantContext(
            surface: 'library', refs: [AssistantRef('work', 'w1')]);
    await notifier.send('解释这首作品');
    await notifier.send('讲点通用的', attachContext: false);
    expect(api.sentRefs.first, [const AssistantRef('work', 'w1')]);
    expect(api.sentRefs.last, isEmpty);
    expect(api.sentClientIds.toSet().length, 2);
  });

  test('确认票处理中防重复，成功后禁用再次确认', () async {
    const ticket = AssistantTicket(
        id: 't1',
        action: 'music.set_title',
        status: 'pending',
        ver: '1',
        hash: 'h');
    final api = _FakeAssistantApi(_bootstrap(tickets: [ticket]));
    final container = await _container(api);
    final notifier = container.read(assistantProvider.notifier);
    await notifier.bootstrap();

    await notifier.confirmTicket(ticket);
    expect(api.confirmCalls, 1);
    expect(notifier.state.tickets.single.status, 'succeeded');
    expect(notifier.state.tickets.single.canConfirm, isFalse);
    await notifier.confirmTicket(ticket);
    expect(api.confirmCalls, 1);
    expect(notifier.state.tickets.single.status, 'succeeded');
    expect(notifier.state.tickets.single.canConfirm, isFalse);
  });

  testWidgets('全局助手入口显示在播放器上方且不增加底部导航项', (tester) async {
    final api = _FakeAssistantApi(_bootstrap());
    final container = await _container(api);
    await container.read(assistantProvider.notifier).bootstrap();
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(
        home: Scaffold(
          bottomNavigationBar: Column(
            mainAxisSize: MainAxisSize.min,
            children: [AssistantDock(), SizedBox(height: 10)],
          ),
        ),
      ),
    ));
    expect(find.text('创作助手'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);

    await tester.tap(find.text('创作助手'));
    await tester.pumpAndSettle();
    expect(find.text('对话'), findsOneWidget);
    expect(find.text('任务'), findsOneWidget);
    expect(find.text('确认'), findsOneWidget);
  });
}
