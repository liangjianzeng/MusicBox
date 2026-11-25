import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/models.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/create/intent_sync.dart';
import 'package:musicbox/features/create/music_assistant_sheet.dart';

class _FakeApi extends Fake implements ApiClient {
  Future<Intent> Function(String id, Map<String, dynamic> patch)? onPatch;
  Future<Map> Function(List<Map<String, dynamic>>? chips)? onMessage;
  Future<Map> Function()? onConfirm;
  Future<void> Function()? onDeny;
  final chipCalls = <List<Map<String, dynamic>>?>[];
  int confirmCalls = 0;
  int denyCalls = 0;

  @override
  Future<Intent> intentPatch(String id, Map<String, dynamic> patch) =>
      onPatch!(id, patch);

  @override
  Future<Map> musicAssistantMessages({
    String? sessionId,
    required String text,
    List<Map<String, dynamic>> chips = const [],
  }) {
    chipCalls.add(chips);
    return onMessage!(chips);
  }

  @override
  Future<Map> musicConfirmTicket(String ticketId, {String? ver, String? hash}) {
    confirmCalls++;
    return onConfirm!();
  }

  @override
  Future<void> musicDenyTicket(String ticketId) {
    denyCalls++;
    return onDeny!();
  }
}

Intent _intent() => Intent.fromMap({'id': 'i1', 'status': 'ready'});

Map<String, dynamic> _ticketReply() => {
      'session_id': 's1',
      'reply': '请确认',
      'ticket': {
        'ticket_id': 't1',
        'action': 'music.regenerate',
        'ver': 1,
        'hash': 'h1',
        'est': {'credits': 15, 'minutes': 2},
      },
    };

ProviderContainer _container(_FakeApi api) {
  final container = ProviderContainer(overrides: [
    apiClientProvider.overrideWithValue(api),
  ]);
  addTearDown(container.dispose);
  return container;
}

MusicChatMsg _ticketMessage(MusicAssistantNotifier notifier) =>
    notifier.state.messages.singleWhere((m) => m.ticket != null);

void main() {
  test('IntentPatchQueue 失败恢复不覆盖在途期间的新字段', () async {
    final first = Completer<Intent>();
    final patches = <Map<String, dynamic>>[];
    final api = _FakeApi()
      ..onPatch = (_, patch) {
        patches.add(Map<String, dynamic>.from(patch));
        return patches.length == 1 ? first.future : Future.value(_intent());
      };
    final queue = IntentPatchQueue(api, 'i1')
      ..submit({
        'mood': ['旧心情'],
        'sec': 60
      }, delayMs: 60000);

    final flushing = queue.flush();
    queue.submit({
      'mood': ['新心情'],
      'bpm': 100
    }, delayMs: 60000);
    first.completeError(ApiException(code: 'NETWORK', message: ''));
    expect(await flushing, isNull);
    expect(queue.status, IntentPatchStatus.failed);
    expect(queue.hasPending, isTrue);

    await queue.retry();
    expect(patches, [
      {
        'mood': ['旧心情'],
        'sec': 60
      },
      {
        'mood': ['新心情'],
        'bpm': 100,
        'sec': 60,
      },
    ]);
    expect(queue.status, IntentPatchStatus.saved);
    expect(queue.hasPending, isFalse);
  });

  test('音乐助手区分默认上下文与显式空上下文', () async {
    final api = _FakeApi()
      ..onMessage = (_) async => {'session_id': 's1', 'reply': '好的'};
    final notifier =
        _container(api).read(musicAssistantProvider('work:w1').notifier);

    await notifier.send('第一句');
    await notifier.send('第二句', chips: const []);

    expect(api.chipCalls[0], [
      {'type': 'work', 'id': 'w1'}
    ]);
    expect(api.chipCalls[1], isEmpty);
  });

  test('确认票处理中防重复，临时失败可重试，成功后禁用', () async {
    final confirmation = Completer<Map>();
    var fail = true;
    final api = _FakeApi()
      ..onMessage = (_) async {
        return _ticketReply();
      }
      ..onConfirm = () {
        if (fail) {
          fail = false;
          return confirmation.future;
        }
        return Future.value({'credits_charged': 15});
      };
    final notifier =
        _container(api).read(musicAssistantProvider('work:w1').notifier);
    await notifier.send('重出一批');
    final msg = _ticketMessage(notifier);

    final approving = notifier.approveTicket(msg);
    await notifier.approveTicket(msg);
    expect(api.confirmCalls, 1);
    expect(
        _ticketMessage(notifier).ticket!.status, MusicTicketStatus.processing);

    confirmation.completeError(ApiException(code: 'NETWORK', message: ''));
    await approving;
    expect(_ticketMessage(notifier).ticket!.status, MusicTicketStatus.failed);

    await notifier.approveTicket(_ticketMessage(notifier));
    expect(api.confirmCalls, 2);
    expect(_ticketMessage(notifier).ticket!.status, MusicTicketStatus.success);
    await notifier.approveTicket(msg);
    expect(api.confirmCalls, 2);
  });

  test('确认票仅对明确失效错误永久禁用', () async {
    for (final code in ['TICKET_UNUSABLE', 'NOT_FOUND']) {
      final api = _FakeApi()
        ..onMessage = (_) async {
          return _ticketReply();
        }
        ..onConfirm = () async => throw ApiException(code: code, message: '');
      final notifier =
          _container(api).read(musicAssistantProvider('work:w1').notifier);
      await notifier.send('重出一批');

      await notifier.approveTicket(_ticketMessage(notifier));
      expect(
          _ticketMessage(notifier).ticket!.status, MusicTicketStatus.expired);
      await notifier.approveTicket(_ticketMessage(notifier));
      expect(api.confirmCalls, 1);
    }
  });

  test('拒绝票临时失败可重试，成功后禁用', () async {
    var fail = true;
    final api = _FakeApi()
      ..onMessage = (_) async {
        return _ticketReply();
      }
      ..onDeny = () async {
        if (fail) {
          fail = false;
          throw ApiException(code: 'NETWORK', message: '');
        }
      };
    final notifier =
        _container(api).read(musicAssistantProvider('work:w1').notifier);
    await notifier.send('重出一批');

    await notifier.denyTicket(_ticketMessage(notifier));
    expect(_ticketMessage(notifier).ticket!.status, MusicTicketStatus.failed);
    expect(_ticketMessage(notifier).ticket!.failure, MusicTicketFailure.deny);
    await notifier.denyTicket(_ticketMessage(notifier));
    expect(api.denyCalls, 2);
    expect(_ticketMessage(notifier).ticket!.status, MusicTicketStatus.success);
  });
}
