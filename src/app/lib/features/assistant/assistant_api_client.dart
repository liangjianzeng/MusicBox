import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import 'assistant_models.dart';

class AssistantApiClient {
  AssistantApiClient(this._api);

  final ApiClient _api;

  Future<AssistantBootstrap> bootstrap() async {
    final data =
        await _api.send(() => _api.http.get('/v1/assistant/bootstrap'));
    return AssistantBootstrap.fromMap(data as Map);
  }

  Future<AssistantSession> createSession({
    String? title,
    String surface = 'create',
    List<AssistantRef> refs = const [],
  }) async {
    final data =
        await _api.send(() => _api.http.post('/v1/assistant/sessions', data: {
              if (title != null && title.isNotEmpty) 'title': title,
              'context': {
                'surface': surface,
                'refs': refs.map((r) => r.toJson()).toList(),
              },
            })) as Map;
    return AssistantSession.fromMap((data['session'] as Map?) ?? data);
  }

  Future<AssistantMessagePage> messages(String sessionId,
      {int afterSeq = 0}) async {
    final data = await _api.send(() => _api.http.get(
          '/v1/assistant/sessions/$sessionId/messages',
          queryParameters: {'after_seq': '$afterSeq'},
        )) as Map;
    return AssistantMessagePage.fromMap(data);
  }

  Future<AssistantMessageResult> sendMessage({
    String? sessionId,
    required String clientMsgId,
    required String text,
    String surface = 'create',
    List<AssistantRef> refs = const [],
  }) async {
    final data =
        await _api.send(() => _api.http.post('/v1/assistant/messages', data: {
              if (sessionId != null && sessionId.isNotEmpty)
                'session_id': sessionId,
              'client_msg_id': clientMsgId,
              'text': text,
              'context': {
                'surface': surface,
                'refs': refs.map((r) => r.toJson()).toList(),
              },
            })) as Map;
    return AssistantMessageResult.fromMap(data);
  }

  /// 上传照片到统一助手（POST /v1/assistant/image，multipart；PIPL consent=true）。
  /// 返回 image_id，供消息 context.refs 使用。
  Future<String> uploadImage(String filePath, {String? filename}) async {
    final fd = FormData();
    fd.fields.add(MapEntry('consent', 'true'));
    fd.files.add(MapEntry(
        'file',
        await MultipartFile.fromFile(filePath,
            filename:
                filename ?? (filePath.toLowerCase().endsWith('.png') ? 'photo.png' : 'photo.jpg'))));
    final d =
        await _api.send(() => _api.http.post('/v1/assistant/image', data: fd)) as Map;
    return '${d['image_id']}';
  }

  Future<List<AssistantTask>> tasks() async {
    final data =
        await _api.send(() => _api.http.get('/v1/assistant/tasks')) as Map;
    return (data['items'] as List? ?? const [])
        .whereType<Map>()
        .map(AssistantTask.fromMap)
        .toList();
  }

  Future<List<AssistantTicket>> tickets() async {
    final data =
        await _api.send(() => _api.http.get('/v1/assistant/tickets')) as Map;
    return (data['items'] as List? ?? const [])
        .whereType<Map>()
        .map(AssistantTicket.fromMap)
        .toList();
  }

  Future<AssistantTicket> confirmTicket(
      String id, String ver, String hash) async {
    final data = await _api.send(() => _api.http.post(
          '/v1/assistant/tickets/$id/confirm',
          data: {'ver': ver, 'hash': hash},
        )) as Map;
    return AssistantTicket.fromMap((data['ticket'] as Map?) ?? data);
  }

  Future<AssistantTicket> denyTicket(String id) async {
    final data = await _api
        .send(() => _api.http.post('/v1/assistant/tickets/$id/deny')) as Map;
    return AssistantTicket.fromMap((data['ticket'] as Map?) ?? data);
  }

  Future<AssistantEventPage> events(int afterSeq) async {
    final data = await _api.send(() => _api.http.get(
          '/v1/assistant/events',
          queryParameters: {'after_seq': '$afterSeq', 'limit': '100'},
        )) as Map;
    return AssistantEventPage.fromMap(data);
  }

  Future<void> feedback(String messageId, String result) async {
    await _api.send(() => _api.http.post('/v1/assistant/feedback', data: {
          'message_id': messageId,
          'result': result,
        }));
  }
}

final assistantApiClientProvider = Provider<AssistantApiClient>((ref) {
  return AssistantApiClient(ref.watch(apiClientProvider));
});
