/// 端侧工具契约（纯 Dart，禁止 import material —— 方案 §11.1）。
///
/// 白名单纪律（方案 §3.3）：给模型的只有 `name / description / parameters`，
/// 执行体（[AgentTool.execute]）**绝不外泄**进 schema。
///
/// 端侧只有两类工具（红线：写操作一律不在端侧）：
/// * [AgentToolKind.readOnly] —— 查询/检索，无副作用；
/// * [AgentToolKind.propose] —— 只产出「待确认建议」，由服务端出确认票后才执行。
/// 不存在第三种「端侧写工具」：需要副作用的能力根本不在这里注册，
/// 而不是注册了再靠 prompt 叮嘱它别调（方案 §3.5「靠限制能力，不靠承诺」）。
library;

import 'dart:convert';

/// 工具类别。端侧枚举里**没有** write。
enum AgentToolKind { readOnly, propose }

/// 工具执行结果，回填给模型。
class AgentToolResult {
  const AgentToolResult({
    required this.content,
    this.isError = false,
    this.data,
    this.degradation,
  });

  factory AgentToolResult.error(String message, {String? degradation}) =>
      AgentToolResult(content: message, isError: true, degradation: degradation);

  factory AgentToolResult.json(Object? value, {String? note, String? degradation}) =>
      AgentToolResult(
        content: note == null
            ? _encode(value)
            : '$note\n${_encode(value)}',
        data: value is Map ? Map<String, dynamic>.from(value) : null,
        degradation: degradation,
      );

  /// 回填模型的文本。
  final String content;

  /// 失败标记：失败时 [content] 是给模型看的可读原因。
  final bool isError;

  /// 结构化原件，只给 UI/审计用，不进模型。
  final Map<String, dynamic>? data;

  /// **降级留痕**（可归因）：工具没失败、但少做了某件事时填一句原因。
  ///
  /// 循环会把它汇总进 [AgentRunResult.warnings]，供界面与审计追责 ——
  /// 「服务端少给一个字段」于是变成一次看得见的降级，而不是端侧崩溃。
  final String? degradation;
}

/// 工具层短名别名（写工具时不必带 Agent 前缀，两个名字同源）。
typedef ToolResult = AgentToolResult;

/// 工具执行上下文（会话作用域：技能装载去重、幂等键都挂在这）。
class AgentToolCallContext {
  const AgentToolCallContext({
    required this.sessionId,
    required this.turnIndex,
    required this.callId,
    this.step = 0,
    this.args = const {},
  });

  /// 会话作用域（服务端还没建会话时为 null，工具须自己兜底成稳定键）。
  final String? sessionId;
  final int turnIndex;
  final String callId;

  /// 工具内部按会话记账用的稳定键。
  String get scopeKey => scopeKeyOf(sessionId);

  /// 会话可能还没由服务端建立（首轮请求前 session_id 为 null）。
  /// 记账/归因一律走这个稳定键，**不做强转**：缺字段就降级，不崩。
  static String scopeKeyOf(String? sessionId) {
    final s = sessionId?.trim() ?? '';
    return s.isEmpty ? kAnonymousScope : s;
  }

  /// 无会话时的记账键（可归因，且与真实会话 id 不撞名）。
  static const String kAnonymousScope = 'session:pending';
  final int step;

  /// 已通过 schema 校验的入参。
  final Map<String, dynamic> args;

  String stringArg(String key, {String fallback = ''}) {
    final v = args[key];
    if (v == null) return fallback;
    final s = '$v'.trim();
    return s.isEmpty ? fallback : s;
  }

  int intArg(String key, {int fallback = 0}) {
    final v = args[key];
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? fallback;
  }
}

/// 一次可注册的工具。
class AgentTool {
  const AgentTool({
    required this.name,
    required this.description,
    required this.parameters,
    required this.execute,
    this.kind = AgentToolKind.readOnly,
    this.rank = 100,
    this.timeout,
    this.isConcurrencySafe,
    this.activityLabel = '我查了一下',
  });

  /// 工具名（注册表内唯一）。
  final String name;

  /// 给模型看的说明 —— 也是模型行为的第一约束位（方案 §0.3「P1 正面证据」）。
  final String description;

  /// 参数 JSON Schema（仅描述）。
  final Map<String, dynamic> parameters;

  /// 执行体。
  final Future<AgentToolResult> Function(AgentToolCallContext ctx) execute;

  final AgentToolKind kind;

  /// **上屏用**的人话（方案 §11.5：界面不得出现工具名/协议名）。
  /// 例：「我去查了一下资料」「我看了一眼刚才那件事的进度」。
  final String activityLabel;

  /// 同名覆盖用：rank 高者胜（与 skill 的 rank 语义同构）。
  final int rank;

  final Duration? timeout;

  /// 并行安全声明。
  ///
  /// ⚠️ 方案 §3.5 点名的上游漏洞：`web_search` 这类**出网**工具未声明
  /// `isConcurrencySafe: false` 会被当只读放进白名单。MusicBox 侧
  /// `knowledge.web_search` 显式 false（见 tools/knowledge_web_search_tool.dart）。
  final bool Function(Map<String, dynamic> args)? isConcurrencySafe;

  bool get isReadOnly => kind == AgentToolKind.readOnly;
  bool get isProposal => kind == AgentToolKind.propose;

  bool concurrencySafeFor(Map<String, dynamic> args) =>
      isConcurrencySafe?.call(args) ?? isReadOnly;

  /// 送给模型的唯一形状（白名单：只有 name/description/parameters）。
  Map<String, dynamic> toModelSchema() => {
        'type': 'function',
        'function': {
          'name': name,
          'description': description,
          'parameters': parameters,
        },
      };
}

/// 工具入参校验（对照上游 `validateArgs`，方案 §3.3 段 3）。
///
/// 返回可读违规列表（空 = 通过）。错误信息带 `<type>` 与参数描述，
/// 让模型有机会**一次**补全 —— 这是「工具老是调不通」的根治层。
List<String> validateToolArguments(
  Map<String, dynamic> args,
  Map<String, dynamic> schema,
) {
  final violations = <String>[];
  final required = schema['required'];
  final props = schema['properties'];

  if (required is List) {
    for (final key in required) {
      final name = '$key';
      final value = args[name];
      String? usage;
      String? type;
      if (props is Map && props[name] is Map) {
        final p = Map<String, dynamic>.from(props[name] as Map);
        usage = p['description']?.toString();
        type = p['type']?.toString();
      }
      final hint = type != null ? '<$type>' : '';
      final tail = usage != null ? '（$usage）' : '';
      if (value == null) {
        violations.add('缺少必填参数 $name$hint$tail');
      } else if (value is String && value.trim().isEmpty) {
        violations.add('必填参数 $name$hint 不能为空$tail');
      }
    }
  }

  // 类型抽查：模型偶尔把 integer 写成 "12"，这里宽松收下单标量，
  // 但把「数组写成字符串」这类结构性错误当场指出，省一次来回。
  if (props is Map) {
    for (final entry in props.entries) {
      final value = args['${entry.key}'];
      if (value == null || entry.value is! Map) continue;
      final declared = (entry.value as Map)['type'];
      if (declared == 'array' && value is! List) {
        violations.add('参数 ${entry.key} 应为数组');
      }
      if (declared == 'object' && value is! Map) {
        violations.add('参数 ${entry.key} 应为对象');
      }
    }
  }
  return violations;
}

String _encode(Object? v) {
  try {
    return jsonEncode(v);
  } catch (_) {
    return '$v';
  }
}
