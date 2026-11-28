/// 端侧智能体的对话数据结构（纯 Dart，禁止 import material —— 方案 §11.1）。
///
/// 形状与服务端代理 `POST /v1/agent/llm` 的 `messages` 逐字对齐：
/// `{"role","content"}` 是必填两项；`tool_calls` / `tool_call_id` / `name`
/// 是多回合工具循环必需的**可选追加字段**（缺省时不出现在 JSON 里）。
library;

import 'dart:convert';

/// 消息角色。与服务端 / OpenAI 形状同名。
enum AgentRole { system, user, assistant, tool }

String agentRoleWireName(AgentRole role) => switch (role) {
      AgentRole.system => 'system',
      AgentRole.user => 'user',
      AgentRole.assistant => 'assistant',
      AgentRole.tool => 'tool',
    };

AgentRole agentRoleFromWire(String? raw) => switch (raw) {
      'system' => AgentRole.system,
      'user' => AgentRole.user,
      'assistant' => AgentRole.assistant,
      'tool' => AgentRole.tool,
      _ => AgentRole.user,
    };

/// 模型发起的一次工具调用（回填自 `message.tool_calls[]`）。
///
/// [argumentsJson] 保留模型原始字符串：解析失败要能原样交给护栏做「重试一次」，
/// 不能在解析层就把信息丢掉。
class AgentToolCallDto {
  const AgentToolCallDto({
    required this.id,
    required this.name,
    required this.argumentsJson,
  });

  final String id;
  final String name;
  final String argumentsJson;

  /// OpenAI 形状的宽松解析：兼容 `{function:{name,arguments}}` 与扁平两种。
  factory AgentToolCallDto.fromJson(Map<String, dynamic> json, {int index = 0}) {
    final fn = json['function'];
    final Map<String, dynamic> body = fn is Map
        ? Map<String, dynamic>.from(fn)
        : json;
    final args = body['arguments'];
    return AgentToolCallDto(
      id: '${json['id'] ?? body['id'] ?? 'call_$index'}',
      name: '${body['name'] ?? ''}'.trim(),
      argumentsJson: args is String
          ? args
          : (args is Map ? _encode(args) : ''),
    );
  }

  static String _encode(Map<dynamic, dynamic> m) {
    try {
      return jsonEncode(m);
    } catch (_) {
      return '';
    }
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': 'function',
        'function': {'name': name, 'arguments': argumentsJson},
      };

  @override
  String toString() => '$name($argumentsJson)';
}

/// 一条会话消息。
///
/// ⚠️ 纪律（方案 §3.2 / 附录 A）：**思考内容绝不进 `content`**。
/// `reasoning` 只存在于 [AgentLlmReply]（留痕用），永远不被构造成
/// [AgentChatMessage] 回填给模型 —— 那等于把想法当事实喂回去。
class AgentChatMessage {
  const AgentChatMessage({
    required this.role,
    this.content = '',
    this.toolCalls = const [],
    this.toolCallId,
    this.name,
  });

  factory AgentChatMessage.system(String text) =>
      AgentChatMessage(role: AgentRole.system, content: text);

  factory AgentChatMessage.user(String text) =>
      AgentChatMessage(role: AgentRole.user, content: text);

  factory AgentChatMessage.assistant(String text,
          {List<AgentToolCallDto> toolCalls = const []}) =>
      AgentChatMessage(
        role: AgentRole.assistant,
        content: text,
        toolCalls: toolCalls,
      );

  factory AgentChatMessage.tool({
    required String toolCallId,
    required String toolName,
    required String content,
  }) =>
      AgentChatMessage(
        role: AgentRole.tool,
        content: content,
        toolCallId: toolCallId,
        name: toolName,
      );

  final AgentRole role;
  final String content;
  final List<AgentToolCallDto> toolCalls;
  final String? toolCallId;
  final String? name;

  bool get isSystem => role == AgentRole.system;
  bool get isTool => role == AgentRole.tool;
  bool get hasToolCalls => toolCalls.isNotEmpty;

  /// 估算长度用的纯文本（含工具调用摘要）。
  String get plainText {
    if (toolCalls.isEmpty) return content;
    final calls = toolCalls.map((c) => '${c.name}(${c.argumentsJson})').join(';');
    return content.isEmpty ? calls : '$content\n$calls';
  }

  Map<String, dynamic> toJson() => {
        'role': agentRoleWireName(role),
        'content': content,
        if (toolCalls.isNotEmpty)
          'tool_calls': toolCalls.map((c) => c.toJson()).toList(),
        if (toolCallId != null) 'tool_call_id': toolCallId,
        if (name != null) 'name': name,
      };

  factory AgentChatMessage.fromJson(Map<String, dynamic> json) {
    final rawCalls = json['tool_calls'];
    final calls = <AgentToolCallDto>[];
    if (rawCalls is List) {
      for (var i = 0; i < rawCalls.length; i++) {
        final c = rawCalls[i];
        if (c is Map) {
          calls.add(AgentToolCallDto.fromJson(Map<String, dynamic>.from(c),
              index: i));
        }
      }
    }
    return AgentChatMessage(
      role: agentRoleFromWire(json['role'] as String?),
      content: '${json['content'] ?? ''}',
      toolCalls: calls,
      toolCallId: json['tool_call_id'] == null ? null : '${json['tool_call_id']}',
      name: json['name'] == null ? null : '${json['name']}',
    );
  }

  @override
  String toString() => '${agentRoleWireName(role)}: $plainText';
}
