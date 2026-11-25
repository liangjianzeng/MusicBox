import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

/// WSS 事件（契约 §3）
abstract class WsEvent {
  WsEvent(this.type);
  final String type;
}

class JobProgressEvent extends WsEvent {
  JobProgressEvent(this.jobId, this.progress, this.note)
      : super('job.progress');
  final String jobId;
  final int progress;
  final String? note;
}

class JobDoneEvent extends WsEvent {
  JobDoneEvent(this.jobId, this.result, this.error) : super('job.done');
  final String jobId;
  final Map? result; // {candidates:[candidate]}
  final Map? error; // {code,message}
  bool get failed => error != null;
}

class IntentCardEvent extends WsEvent {
  IntentCardEvent(this.intentId, this.status) : super('intent.card');
  final String intentId;
  final String status;
}

class AssistantWsEvent extends WsEvent {
  AssistantWsEvent(this.seq, this.event) : super('assistant.event');
  final int seq;
  final AssistantEventData event;
}

class AssistantEventData {
  const AssistantEventData(this.type, this.payload);
  final String type;
  final Map payload;
}

class CreditDeltaEvent extends WsEvent {
  CreditDeltaEvent(this.delta, this.balanceAfter) : super('credit.delta');
  final int delta;
  final int balanceAfter;
}

/// 契约 v2（文档态）：{type:"mv.progress", project_id, status, progress,
/// note, shots:[{id,status}]}。server 侧 MV 路由尚未上线，先按文档解析，
/// 收到即更新，不伪造事件。
class MvProgressEvent extends WsEvent {
  MvProgressEvent(
      this.projectId, this.status, this.progress, this.note, this.shots)
      : super('mv.progress');
  final String projectId;
  final String status;
  final int progress;
  final String? note;
  final List<Map> shots; // [{id,status}]
}

enum WsStatus { disconnected, connecting, connected }

/// /ws?token= 客户端：指数退避重连 + 事件分发（Riverpod 侧监听 events 流）
class WsClient {
  WsClient({required this.wsUrl, required this.tokenProvider});

  final String wsUrl;
  final String? Function() tokenProvider;

  final _events = StreamController<WsEvent>.broadcast();
  final _status = StreamController<WsStatus>.broadcast();
  Stream<WsEvent> get events => _events.stream;
  Stream<WsStatus> get statusStream => _status.stream;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _retryTimer;
  int _attempt = 0;
  bool _closed = false;
  WsStatus _statusVal = WsStatus.disconnected;
  WsStatus get status => _statusVal;

  void _setStatus(WsStatus s) {
    _statusVal = s;
    if (!_status.isClosed) _status.add(s);
  }

  /// 连接（幂等：已连接则忽略）
  void connect() {
    if (_closed) return;
    if (_statusVal == WsStatus.connected || _statusVal == WsStatus.connecting) {
      return;
    }
    final token = tokenProvider();
    if (token == null || token.isEmpty) return;
    _setStatus(WsStatus.connecting);
    try {
      final uri = Uri.parse('$wsUrl?token=${Uri.encodeComponent(token)}');
      final ch = WebSocketChannel.connect(uri);
      _channel = ch;
      _sub?.cancel();
      _sub = ch.stream.listen(
        (raw) {
          _onMessage(raw);
        },
        onDone: () => _scheduleReconnect(),
        onError: (_) => _scheduleReconnect(),
        cancelOnError: true,
      );
      _attempt = 0;
      _setStatus(WsStatus.connected);
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onMessage(dynamic raw) {
    try {
      if (raw is! String) return;
      final m = jsonDecode(raw);
      if (m is! Map) return;
      final type = '${m['type'] ?? ''}';
      WsEvent? ev;
      switch (type) {
        case 'job.progress':
          ev = JobProgressEvent(
              '${m['job_id']}', _asInt(m['progress']), m['note']?.toString());
          break;
        case 'job.done':
          ev = JobDoneEvent(
              '${m['job_id']}', m['result'] as Map?, m['error'] as Map?);
          break;
        case 'intent.card':
          ev = IntentCardEvent('${m['intent_id']}', '${m['status'] ?? ''}');
          break;
        case 'assistant.event':
          {
            final event = m['event'] as Map?;
            if (event != null) {
              ev = AssistantWsEvent(
                  _asInt(m['seq']),
                  AssistantEventData('${event['type'] ?? ''}',
                      (event['payload'] as Map?) ?? const {}));
            }
            break;
          }
        case 'credit.delta':
          ev = CreditDeltaEvent(_asInt(m['delta']), _asInt(m['balance_after']));
          break;
        case 'mv.progress':
          ev = MvProgressEvent(
              '${m['project_id']}',
              '${m['status'] ?? ''}',
              _asInt(m['progress']),
              m['note']?.toString(),
              (m['shots'] as List? ?? const []).whereType<Map>().toList());
          break;
      }
      if (ev != null && !_events.isClosed) _events.add(ev);
    } catch (_) {
      // 忽略无法解析的消息
    }
  }

  static int _asInt(dynamic v) =>
      v is int ? v : (v is num ? v.toInt() : int.tryParse('$v') ?? 0);

  /// 指数退避：1s/2s/4s/8s… 上限 30s + 抖动
  void _scheduleReconnect() {
    if (_closed) return;
    _setStatus(WsStatus.disconnected);
    _sub?.cancel();
    _sub = null;
    _channel = null;
    _retryTimer?.cancel();
    final base = min(30, pow(2, min(_attempt, 5)).toInt());
    _attempt++;
    final delayMs = base * 1000 + Random().nextInt(500);
    _retryTimer = Timer(Duration(milliseconds: delayMs), () {
      if (!_closed) connect();
    });
  }

  /// token 变化后强制重连
  void reconnect() {
    _attempt = 0;
    try {
      _sub?.cancel();
      _channel?.sink.close();
    } catch (_) {}
    _sub = null;
    _channel = null;
    _setStatus(WsStatus.disconnected);
    connect();
  }

  void dispose() {
    _closed = true;
    _retryTimer?.cancel();
    _sub?.cancel();
    try {
      _channel?.sink.close();
    } catch (_) {}
    _events.close();
    _status.close();
  }
}
