import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../core/ws_client.dart';
import 'assistant_api_client.dart';
import 'assistant_models.dart';

final assistantContextProvider = StateProvider<AssistantContext>((ref) {
  return const AssistantContext();
});

enum AssistantTab { chat, tasks, tickets }

class AssistantState {
  const AssistantState({
    this.available = false,
    this.loading = false,
    this.sending = false,
    this.mode = 'rule',
    this.capabilities = const {},
    this.sessionId,
    this.messages = const [],
    this.tasks = const [],
    this.tickets = const [],
    this.busyTicketIds = const {},
    this.error,
  });

  final bool available;
  final bool loading;
  final bool sending;
  final String mode;
  final Map capabilities;
  final String? sessionId;
  final List<AssistantMessage> messages;
  final List<AssistantTask> tasks;
  final List<AssistantTicket> tickets;
  final Set<String> busyTicketIds;
  final String? error;

  int get pendingTickets => tickets.where((t) => t.status == 'pending').length;
  int get activeTasks => tasks
      .where((t) => !const {
            'done',
            'failed',
            'canceled',
            'succeeded',
            'compensated'
          }.contains(t.status))
      .length;

  AssistantState copyWith({
    bool? available,
    bool? loading,
    bool? sending,
    String? mode,
    Map? capabilities,
    String? sessionId,
    List<AssistantMessage>? messages,
    List<AssistantTask>? tasks,
    List<AssistantTicket>? tickets,
    Set<String>? busyTicketIds,
    String? error,
    bool clearError = false,
  }) =>
      AssistantState(
        available: available ?? this.available,
        loading: loading ?? this.loading,
        sending: sending ?? this.sending,
        mode: mode ?? this.mode,
        capabilities: capabilities ?? this.capabilities,
        sessionId: sessionId ?? this.sessionId,
        messages: messages ?? this.messages,
        tasks: tasks ?? this.tasks,
        tickets: tickets ?? this.tickets,
        busyTicketIds: busyTicketIds ?? this.busyTicketIds,
        error: clearError ? null : (error ?? this.error),
      );
}

class AssistantNotifier extends StateNotifier<AssistantState> {
  AssistantNotifier(this._ref) : super(const AssistantState()) {
    _ref.listen(sessionProvider.select((s) => s.user?.id), (_, userId) {
      if (userId == null) return;
      state = const AssistantState(loading: true);
      _cursor = 0;
      unawaited(bootstrap());
    });
    final ws = _ref.read(wsClientProvider);
    _bindWs(ws);
    _ref.listen(wsClientProvider, (_, next) => _bindWs(next));
  }

  final Ref _ref;
  StreamSubscription<WsEvent>? _wsSub;
  StreamSubscription<WsStatus>? _wsStatusSub;
  int _cursor = 0;
  bool _bootstrapping = false;

  void _bindWs(WsClient ws) {
    _wsSub?.cancel();
    _wsStatusSub?.cancel();
    _wsSub = ws.events.listen((event) {
      if (event is AssistantWsEvent) {
        _applyEvent(event.seq, event.event.type, event.event.payload);
      }
    });
    _wsStatusSub = ws.statusStream.listen((status) {
      if (status == WsStatus.connected) unawaited(_replayEvents());
    });
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    _wsStatusSub?.cancel();
    super.dispose();
  }

  AssistantApiClient get _api => _ref.read(assistantApiClientProvider);

  Future<void> bootstrap() async {
    if (_bootstrapping) return;
    _bootstrapping = true;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final data = await _api.bootstrap();
      final recent = data.recentSession;
      if (recent != null && recent.id.isNotEmpty) {
        final page = await _api.messages(recent.id);
        state = state.copyWith(
          available: data.available,
          loading: false,
          mode: data.mode,
          capabilities: data.capabilities,
          sessionId: recent.id,
          messages: page.messages,
          tasks: data.tasks,
          tickets: _mergeTickets(data.pendingTickets),
          clearError: true,
        );
      } else {
        state = state.copyWith(
          available: data.available,
          loading: false,
          mode: data.mode,
          capabilities: data.capabilities,
          messages: const [],
          tasks: data.tasks,
          tickets: _mergeTickets(data.pendingTickets),
          clearError: true,
        );
      }
      await _replayEvents();
    } on ApiException catch (e) {
      state = state.copyWith(loading: false, error: _friendly(e));
    } catch (_) {
      state = state.copyWith(loading: false, error: '助手暂时连不上，请稍后重试');
    } finally {
      _bootstrapping = false;
    }
  }

  Future<void> refresh() async {
    await Future.wait([refreshTasks(), refreshTickets()]);
    final id = state.sessionId;
    if (id != null && id.isNotEmpty) await refreshMessages(id);
  }

  Future<void> refreshMessages(String sessionId) async {
    try {
      final page = await _api.messages(sessionId);
      if (state.sessionId != sessionId) return;
      state = state.copyWith(messages: page.messages);
    } on ApiException catch (_) {}
  }

  Future<void> refreshTasks() async {
    try {
      state = state.copyWith(tasks: await _api.tasks());
    } on ApiException catch (_) {}
  }

  Future<void> refreshTickets() async {
    try {
      state = state.copyWith(tickets: _mergeTickets(await _api.tickets()));
    } on ApiException catch (_) {}
  }

  Future<void> newSession() async {
    final context = _ref.read(assistantContextProvider);
    try {
      final session = await _api.createSession(
          surface: context.surface, refs: context.refs);
      state = state.copyWith(
          sessionId: session.id, messages: const [], clearError: true);
    } on ApiException catch (e) {
      state = state.copyWith(error: _friendly(e));
    }
  }

  Future<void> send(String text, {bool attachContext = true}) async {
    final input = text.trim();
    if (input.isEmpty || state.sending || !state.available) return;
    if (!state.available) {
      state = state.copyWith(error: '创作助手当前未开放');
      return;
    }
    final context = _ref.read(assistantContextProvider);
    final refs = attachContext ? context.refs : const <AssistantRef>[];
    final clientId = 'c_${DateTime.now().microsecondsSinceEpoch}';
    final optimistic = AssistantMessage(
        id: clientId,
        seq: 0,
        role: 'user',
        content: input,
        clientMsgId: clientId);
    state = state.copyWith(
        sending: true,
        messages: [...state.messages, optimistic],
        clearError: true);
    try {
      final result = await _api.sendMessage(
        sessionId: state.sessionId,
        clientMsgId: clientId,
        text: input,
        surface: context.surface,
        refs: refs,
      );
      final messages = [...state.messages];
      final optimisticIndex = messages.indexWhere((m) => m.id == clientId);
      if (optimisticIndex >= 0) {
        final optimistic = messages[optimisticIndex];
        messages[optimisticIndex] = AssistantMessage(
            id: optimistic.id,
            seq: result.message.seq > 0
                ? result.message.seq - 1
                : optimistic.seq,
            role: 'user',
            content: optimistic.content,
            clientMsgId: clientId);
      }
      if (result.message.id.isNotEmpty &&
          !messages.any((m) => m.id == result.message.id)) {
        messages.insert(
            optimisticIndex >= 0 ? optimisticIndex + 1 : messages.length,
            result.message);
      }
      state = state.copyWith(
          sending: false,
          sessionId:
              result.sessionId.isEmpty ? state.sessionId : result.sessionId,
          messages: messages,
          tickets: result.ticket == null
              ? state.tickets
              : _mergeTickets([result.ticket!, ...state.tickets]),
          mode: '${result.meta['mode'] ?? state.mode}',
          clearError: true);
    } on ApiException catch (e) {
      state = state.copyWith(sending: false, error: _friendly(e), messages: [
        ...state.messages,
        AssistantMessage(
            id: 'error_$clientId',
            seq: 0,
            role: 'system',
            content: _friendly(e)),
      ]);
    }
  }

  Future<void> confirmTicket(AssistantTicket ticket) async {
    final current =
        state.tickets.where((item) => item.id == ticket.id).firstOrNull;
    if (current == null ||
        !current.canConfirm ||
        state.busyTicketIds.contains(current.id)) {
      return;
    }
    final id = current.id;
    final ver = current.ver!;
    final hash = current.hash!;
    state = state.copyWith(
        busyTicketIds: {...state.busyTicketIds, id}, clearError: true);
    try {
      final result = await _api.confirmTicket(id, ver, hash);
      state = state.copyWith(
          tickets: _mergeTickets([result]),
          busyTicketIds: {...state.busyTicketIds}..remove(id),
          messages: [
            ...state.messages,
            AssistantMessage(
                id: 'ticket_${id}_${DateTime.now().microsecondsSinceEpoch}',
                seq: 0,
                role: 'system',
                content: result.reply?.isNotEmpty == true
                    ? result.reply!
                    : '已批准，任务开始执行。'),
          ],
          clearError: true);
      unawaited(_ref.read(sessionProvider.notifier).refreshCredits());
      unawaited(refreshTasks());
    } on ApiException catch (e) {
      state = state.copyWith(
          busyTicketIds: {...state.busyTicketIds}..remove(id),
          error: _friendly(e));
      unawaited(refreshTickets());
    }
  }

  Future<void> denyTicket(AssistantTicket ticket) async {
    final current =
        state.tickets.where((item) => item.id == ticket.id).firstOrNull;
    if (current == null ||
        !current.pending ||
        state.busyTicketIds.contains(current.id)) {
      return;
    }
    final id = current.id;
    state = state.copyWith(
        busyTicketIds: {...state.busyTicketIds, id}, clearError: true);
    try {
      final result = await _api.denyTicket(id);
      state = state.copyWith(
          tickets: _mergeTickets([result]),
          busyTicketIds: {...state.busyTicketIds}..remove(id),
          messages: [
            ...state.messages,
            AssistantMessage(
                id: 'ticket_${id}_${DateTime.now().microsecondsSinceEpoch}',
                seq: 0,
                role: 'system',
                content: '已拒绝这张确认票，没有执行或扣费。'),
          ],
          clearError: true);
    } on ApiException catch (e) {
      state = state.copyWith(
          busyTicketIds: {...state.busyTicketIds}..remove(id),
          error: _friendly(e));
    }
  }

  Future<void> feedback(String messageId, String result) async {
    if (messageId.isEmpty) return;
    try {
      await _api.feedback(messageId, result);
    } on ApiException catch (_) {}
  }

  List<AssistantTicket> _mergeTickets(List<AssistantTicket> incoming) {
    final merged = <String, AssistantTicket>{
      for (final t in state.tickets) t.id: t
    };
    for (final ticket in incoming) {
      final old = merged[ticket.id];
      if (old != null && ticket.hash == null && old.hash != null) {
        merged[ticket.id] = AssistantTicket(
            id: ticket.id,
            action: ticket.action,
            status: ticket.status,
            sessionId: ticket.sessionId ?? old.sessionId,
            subjectType: ticket.subjectType ?? old.subjectType,
            subjectId: ticket.subjectId ?? old.subjectId,
            ver: ticket.ver ?? old.ver,
            hash: old.hash,
            credits: ticket.credits,
            minutes: ticket.minutes,
            jobId: ticket.jobId ?? old.jobId,
            reply: ticket.reply ?? old.reply,
            meta: ticket.meta.isNotEmpty ? ticket.meta : old.meta,
            createdAt: ticket.createdAt ?? old.createdAt,
            expiresAt: ticket.expiresAt ?? old.expiresAt);
      } else {
        merged[ticket.id] = ticket;
      }
    }
    return merged.values.toList()
      ..sort((a, b) => (b.createdAt ?? '').compareTo(a.createdAt ?? ''));
  }

  Future<void> _replayEvents() async {
    try {
      final page = await _api.events(_cursor);
      for (final event in page.items) {
        if (event.seq > _cursor) _cursor = event.seq;
        _applyEvent(event.seq, event.type, event.payload);
      }
      if (page.nextSeq > _cursor) _cursor = page.nextSeq;
    } on ApiException catch (_) {}
  }

  void _applyEvent(int seq, String type, Map payload) {
    if (seq > _cursor) _cursor = seq;
    if (type == 'assistant.message') {
      final raw = (payload['message'] as Map?) ?? payload;
      final message = AssistantMessage.fromMap(raw);
      final sessionId = payload['session_id']?.toString() ??
          message.meta['session_id']?.toString();
      if (message.id.isNotEmpty &&
          (sessionId == null || sessionId == state.sessionId)) {
        final messages = [...state.messages];
        final existing = messages.indexWhere((m) => m.id == message.id);
        if (existing >= 0) {
          messages[existing] = message;
        } else {
          final optimistic = message.clientMsgId?.isNotEmpty == true
              ? messages.indexWhere((m) =>
                  m.seq == 0 &&
                  m.clientMsgId == message.clientMsgId &&
                  message.seq > 0)
              : -1;
          if (optimistic >= 0) {
            messages[optimistic] = message;
          } else {
            messages.add(message);
          }
        }
        state = state.copyWith(messages: messages);
      }
      return;
    }
    if (type == 'assistant.ticket') {
      final raw = (payload['ticket'] as Map?) ?? payload;
      state = state.copyWith(
          tickets: _mergeTickets([AssistantTicket.fromMap(raw)]));
      return;
    }
    if (type == 'assistant.task') {
      final raw = (payload['task'] as Map?) ?? payload;
      final task = AssistantTask.fromMap(raw);
      if (task.id.isEmpty) {
        unawaited(refreshTasks());
        return;
      }
      final tasks = state.tasks.where((t) => t.id != task.id).toList();
      state = state.copyWith(tasks: [task, ...tasks]);
      return;
    }
    unawaited(refresh());
  }

  String _friendly(ApiException e) => switch (e.code) {
        'NOT_FOUND' => '创作助手当前未开放或会话已失效',
        'FORBIDDEN' => '这个操作不在助手能力范围内',
        'TICKET_UNUSABLE' => '确认票已过期或处理过，未重复执行',
        'STALE' => '内容刚被修改，请刷新后再确认',
        'SESSION_BROKEN' => '本次助手预算已触发保护，请稍后再试',
        _ => e.zh,
      };
}

final assistantProvider =
    StateNotifierProvider<AssistantNotifier, AssistantState>((ref) {
  return AssistantNotifier(ref);
});
