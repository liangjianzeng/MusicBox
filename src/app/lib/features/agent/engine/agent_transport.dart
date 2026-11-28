/// 端侧智能体的 LLM 传输层（纯 Dart，禁止 import material —— 方案 §11.1）。
///
/// 契约（方案 §3.2 / v5.5.3）：App **只跟自己 server 说话**。
/// 唯一出口是服务端代理 `POST /v1/agent/llm`，请求体
/// ```json
/// { "session_id": String?, "turn_index": int,
///   "messages": [{"role","content"}],
///   "tools": [{"type":"function","function":{"name","description","parameters"}}],
///   "tool_choice": "auto", "max_tokens": int }
/// ```
/// 响应是 OpenAI 形状：
/// ```json
/// {"choices":[{"message":{"content","reasoning","tool_calls":[...]},
///              "finish_reason":"tool_calls"|"stop"}],
///  "usage":{"prompt_tokens","completion_tokens",
///           "completion_tokens_details":{"reasoning_tokens"}}}
/// ```
///
/// ⚠️ **思考模型的关键陷阱（本项目已实测确认，方案附录 A）**：
/// 模型决定调用工具时 `content` 为 `null`，想法整体落在 `reasoning`。
/// 因此 [AgentLlmReply.content] **只**取 `message.content`，
/// [AgentLlmReply.reasoning] **只**作可折叠的过程留痕 ——
/// 绝不允许 `content ?? reasoning` 这类兜底（那是 `prompts/intent.js:39`
/// 那句临时补丁的成因，会把独白当回复呈现给用户）。
library;

import 'dart:async';

import 'agent_messages.dart';

/// 一次回合的 token 计量（成本闸门的输入，方案 §3.6）。
class AgentUsage {
  const AgentUsage({
    this.promptTokens = 0,
    this.completionTokens = 0,
    this.reasoningTokens = 0,
  });

  final int promptTokens;
  final int completionTokens;

  /// `completion_tokens_details.reasoning_tokens`：思考模型的真实思考开销。
  final int reasoningTokens;

  int get totalTokens => promptTokens + completionTokens;

  static const AgentUsage zero = AgentUsage();

  factory AgentUsage.fromJson(Map<String, dynamic>? json) {
    if (json == null) return zero;
    final details = json['completion_tokens_details'];
    return AgentUsage(
      promptTokens: _asInt(json['prompt_tokens']),
      completionTokens: _asInt(json['completion_tokens']),
      reasoningTokens: details is Map
          ? _asInt(details['reasoning_tokens'])
          : _asInt(json['reasoning_tokens']),
    );
  }

  AgentUsage operator +(AgentUsage other) => AgentUsage(
        promptTokens: promptTokens + other.promptTokens,
        completionTokens: completionTokens + other.completionTokens,
        reasoningTokens: reasoningTokens + other.reasoningTokens,
      );

  Map<String, dynamic> toJson() => {
        'prompt_tokens': promptTokens,
        'completion_tokens': completionTokens,
        'reasoning_tokens': reasoningTokens,
        'total_tokens': totalTokens,
      };

  @override
  String toString() =>
      'prompt=$promptTokens completion=$completionTokens reasoning=$reasoningTokens';
}

/// `choices[0].finish_reason`。
enum AgentFinishReason { stop, toolCalls, length, contentFilter, error, unknown }

/// 一次回合的模型返回。
class AgentLlmReply {
  /// ⚠️ [content] 与 [reasoning] 分道：构造时**不得**互相兜底。
  /// 用 [AgentLlmReply.fromOpenAi] 解析真实响应即自动守住这条。
  const AgentLlmReply({
    this.content = '',
    this.reasoning = '',
    this.toolCalls = const [],
    this.finishReason = AgentFinishReason.stop,
    this.usage = AgentUsage.zero,
    this.hasContentField = true,
    this.sessionId,
  });

  /// 服务端创建/复用的智能体会话 id（`session_id`）。
  ///
  /// 端侧**必须带它回传**：token 用量按会话归因，预算护栏也按会话累计。
  final String? sessionId;

  /// 模型给的正经回复（`message.content`）。思考模型调工具时为空串 —— 这是正常，不是缺数据。
  final String content;

  /// 模型的思考留痕（`message.reasoning`）。**只能折叠展示，不得当回复、不得回填模型**。
  final String reasoning;

  final List<AgentToolCallDto> toolCalls;
  final AgentFinishReason finishReason;
  final AgentUsage usage;

  /// 响应里 `content` 键是否存在过（null 与 "" 的区分留给诊断用）。
  final bool hasContentField;

  bool get wantsTools => toolCalls.isNotEmpty;
  bool get hasContent => content.trim().isNotEmpty;
  bool get hasReasoning => reasoning.trim().isNotEmpty;
  bool get truncated => finishReason == AgentFinishReason.length;

  /// 从服务端代理的 OpenAI 形状解析。容错：`choices` 缺失/为空一律按空回复 + error。
  factory AgentLlmReply.fromOpenAi(Map<String, dynamic> json) {
    final choices = json['choices'];
    if (choices is! List || choices.isEmpty) {
      return const AgentLlmReply(finishReason: AgentFinishReason.error);
    }
    final first = choices.first;
    final Map<String, dynamic> choice =
        first is Map ? Map<String, dynamic>.from(first) : const {};
    final messageRaw = choice['message'];
    final Map<String, dynamic> message = messageRaw is Map
        ? Map<String, dynamic>.from(messageRaw)
        : const {};

    // —— 唯一取值口：content 只来自 content，reasoning 只来自 reasoning ——
    final contentRaw = message['content'];
    final reasoningRaw = message['reasoning'] ?? message['reasoning_content'];

    final calls = <AgentToolCallDto>[];
    final rawCalls = message['tool_calls'];
    if (rawCalls is List) {
      for (var i = 0; i < rawCalls.length; i++) {
        final c = rawCalls[i];
        if (c is! Map) continue;
        final dto =
            AgentToolCallDto.fromJson(Map<String, dynamic>.from(c), index: i);
        if (dto.name.isNotEmpty) calls.add(dto);
      }
    }

    return AgentLlmReply(
      sessionId: json['session_id'] == null ? null : '${json['session_id']}',
      content: contentRaw == null ? '' : '$contentRaw',
      reasoning: reasoningRaw == null ? '' : '$reasoningRaw',
      toolCalls: calls,
      finishReason: finishReasonFromWire(choice['finish_reason']),
      usage: AgentUsage.fromJson(
          json['usage'] is Map ? Map<String, dynamic>.from(json['usage'] as Map) : null),
      hasContentField: message.containsKey('content'),
    );
  }

  static AgentFinishReason finishReasonFromWire(Object? raw) =>
      switch ('${raw ?? ''}') {
        'stop' => AgentFinishReason.stop,
        'tool_calls' => AgentFinishReason.toolCalls,
        'length' => AgentFinishReason.length,
        'content_filter' => AgentFinishReason.contentFilter,
        'error' => AgentFinishReason.error,
        _ => AgentFinishReason.unknown,
      };
}

/// 一次模型请求（与 §3.2 请求体逐字对齐）。
class AgentLlmRequest {
  const AgentLlmRequest({
    this.sessionId,
    required this.turnIndex,
    required this.messages,
    this.tools = const [],
    this.toolChoice = 'auto',
    this.maxTokens = 1024,
    this.thinkingEnabled = false,
  });

  final String? sessionId;
  final int turnIndex;
  final List<AgentChatMessage> messages;

  /// 机械导出的工具 schema：`[{"type":"function","function":{name,description,parameters}}]`。
  /// 执行体永不进这里（方案 §3.3 白名单纪律）。
  final List<Map<String, dynamic>> tools;
  final String toolChoice;
  final int maxTokens;

  /// 是否让模型先思考再答（默认【关】）。
  /// 关的理由是实测：这条线一发思考 47–48 秒，而用户在等的只是一句回话；服务端又把超时
  /// 写死成 30s，于是【会思考的模型 + 30s 超时】必然被掐成一轮空话。真要动脑的动作再显式打开。
  final bool thinkingEnabled;

  Map<String, dynamic> toJson() => {
        'session_id': sessionId,
        'turn_index': turnIndex,
        'messages': messages.map((m) => m.toJson()).toList(),
        'tools': tools,
        'tool_choice': toolChoice,
        'max_tokens': maxTokens,
        'thinking': thinkingEnabled,
      };
}

/// 传输层接缝：单测在此塞假实现喂响应形状（对齐 V35-㉟ 的做法）。
abstract class AgentTransport {
  Future<AgentLlmReply> complete(AgentLlmRequest request);
}

/// 真实 HTTP 出口由宿主注入 —— 引擎不认识 Dio，也不认识 token。
///
/// UI 层的接线只有一行（沿用 App 现有 token 机制：`ApiClient.http` 的
/// Bearer 拦截器 + 401 单飞刷新，见 `core/api_client.dart`，本文件不改它）：
/// ```dart
/// RemoteAgentTransport(
///   post: (path, body) async =>
///       Map<String, dynamic>.from(await api.send(() => api.http.post(path, data: body)) as Map),
/// );
/// ```
typedef AgentHttpPost = Future<Map<String, dynamic>> Function(
    String path, Map<String, dynamic> body);

/// GET 出口（技能目录 / 偏好读取）。宿主沿用现有 token 机制注入。
typedef AgentHttpGet = Future<Map<String, dynamic>> Function(String path);

/// PUT 出口（偏好写入）。
typedef AgentHttpPut = Future<Map<String, dynamic>> Function(
    String path, Map<String, dynamic> body);

/// DELETE 出口（偏好删除 —— 用户能抹掉自己被记下的口味）。
typedef AgentHttpDelete = Future<Map<String, dynamic>> Function(String path);

/// 传输失败（含服务端 404「灰度关」/ 409 会话护栏 / 413 单回合过大 / 503 未就绪）。
///
/// 状态码语义是契约的一部分（服务端 `api/agent.js`），端侧必须**分码处置**，
/// 不能一律「重试一次」了事：
///
/// | 码 | 含义 | 端侧处置 |
/// |---|---|---|
/// | 403 / 404 | 灰度未开（没开放的能力不该被探到） | 不重试；提示切回标准创作流程 |
/// | 409 `SESSION_BROKEN` | 预算护栏已把这个会话暂停 | 不重试；按**护栏**收口，文案须说额度按账号累计、新开会话不清零 |
/// | 413 | 单回合过大 | 不原样重试；**先压缩上下文**再试一次 |
/// | 503 | 理解服务未就绪 / 模型不支持工具调用 | 允许重试一次并如实告知 |
class AgentTransportException implements Exception {
  const AgentTransportException(this.code, this.message, {this.status});

  /// 由 HTTP 状态 + 业务 code 构造（宿主接线层用它把 `ApiException` 翻成本异常，
  /// 引擎因此不必认识 core 的错误类型）。
  factory AgentTransportException.fromStatus(int? status, String code, String message) =>
      AgentTransportException(code, message, status: status);

  final String code;
  final String message;
  final int? status;

  /// 灰度没开：这条路此刻不存在。
  bool get grayedOff => status == 403 || status == 404 || code == 'NOT_FOUND';

  /// 会话被预算护栏暂停（服务端 fuseCheck）。
  bool get sessionBroken => status == 409 || code == 'SESSION_BROKEN';

  /// 单回合过大：该压缩，不该原样重发。
  bool get tooLarge => status == 413;

  /// 理解服务未就绪。
  bool get serviceUnavailable => status == 503 || code == 'SERVICE_UNAVAILABLE';

  /// 是否可原样重试（网络抖动/超时/503 算；护栏与灰度关**不算**）。
  bool get retryable =>
      status == null ||
      status == 408 ||
      status == 429 ||
      serviceUnavailable;

  @override
  String toString() => 'AgentTransportException($code/$status): $message';
}

/// 走服务端代理 `POST /v1/agent/llm` 的传输实现。
class RemoteAgentTransport implements AgentTransport {
  RemoteAgentTransport({
    required AgentHttpPost post,
    this.path = '/v1/agent/llm',
    this.timeout = const Duration(seconds: 60),
    this.maxAttempts = 2,
    AgentLlmReply Function(Map<String, dynamic>)? parse,
  })  : _post = post,
        _parse = parse ?? AgentLlmReply.fromOpenAi;

  /// 契约 v5.5.3 的端点；`assistant_core` 关 → 服务端 404。
  final String path;
  final Duration timeout;

  /// 瞬时失败（超时/连接错）的额外重试次数。策略在传输层，闸门在循环层。
  final int maxAttempts;

  final AgentHttpPost _post;
  final AgentLlmReply Function(Map<String, dynamic>) _parse;

  @override
  Future<AgentLlmReply> complete(AgentLlmRequest request) async {
    Object? lastError;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        final body = await _post(path, request.toJson()).timeout(timeout);
        return _parse(body);
      } on TimeoutException catch (e) {
        lastError = e;
      } on AgentTransportException catch (e) {
        if (!e.retryable) rethrow;
        lastError = e;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError is AgentTransportException) throw lastError;
    throw const AgentTransportException('NETWORK', '连不上服务，请稍后再试');
  }
}

int _asInt(Object? v) =>
    v is int ? v : (v is num ? v.toInt() : int.tryParse('$v') ?? 0);
