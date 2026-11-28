/// 用户偏好层（方案 §4.7 三层分工的第三层）。
///
/// 三层分工在代码里的落点 —— **谁都不许串门**：
/// * **数据**（曲风/情绪/音色词典）→ 服务端 catalog（`catalog.lookup`），**不进记忆**；
/// * **方法**（怎么做一份配方）→ 技能（`load_skill`），**不进记忆**；
/// * **事实**（只属于这个用户的口味：「他偏好 92 bpm」「她不要男声」）→ 本层。
///
/// 三条硬规矩（都是产品红线，不是风格）：
/// 1. 注入时必须标注这是**用户偏好**而不是事实真值，模型不许把它当词典用；
/// 2. 与 catalog 词条冲突时**以用户偏好优先**，但必须**在简报卡里可见**，不许静默覆盖；
/// 3. **只写不删 = 把一次猜测永久固化成画像** —— 所以删除是这套东西的一部分，
///    不是可选附加项：端侧必须能把用户被打上的偏好抹掉。
library;

import 'agent_transport.dart';

/// `GET /v1/agent/memory` 的一行。
class AgentMemoryEntry {
  const AgentMemoryEntry({
    required this.key,
    required this.value,
    this.source = 'agent',
    this.updatedAt = '',
  });

  final String key;
  final String value;

  /// `agent` = 助手记的；`user` = 用户自己写的（界面可区分展示）。
  final String source;
  final String updatedAt;

  factory AgentMemoryEntry.fromJson(Map map) => AgentMemoryEntry(
        key: '${map['key'] ?? ''}'.trim(),
        value: '${map['value'] ?? ''}'.trim(),
        source: '${map['source'] ?? 'agent'}',
        updatedAt: '${map['updated_at'] ?? map['updatedAt'] ?? ''}',
      );

  Map<String, dynamic> toJson() => {
        'key': key,
        'value': value,
        'source': source,
        if (updatedAt.isNotEmpty) 'updated_at': updatedAt,
      };
}

/// 偏好读写出口（单测塞假的；线上用 [remoteAgentMemory]）。
abstract class AgentMemoryStore {
  const AgentMemoryStore();

  /// 起会话时取回（失败应返回空表并置 [unreachable]，不抛）。
  Future<List<AgentMemoryEntry>> load();

  /// 写入一条偏好（同 key 覆盖 —— 服务端 (user_id,key) 唯一）。
  Future<MemoryWriteResult> write({required String key, required String value, String source});

  /// 删除一条偏好（用户能删掉自己被打上的标签）。
  Future<bool> remove(String key);

  /// 最近一次取用是否成功：不可达时要如实说「这次没带上你的偏好」，不许装作没有。
  bool get unreachable;
}

class MemoryWriteResult {
  const MemoryWriteResult({required this.ok, this.key = '', this.error = ''});

  final bool ok;
  final String key;
  final String error;

  factory MemoryWriteResult.from(Map<String, dynamic> body) => MemoryWriteResult(
        ok: body['ok'] == true,
        key: '${body['key'] ?? ''}',
        error: '${body['error'] ?? body['message'] ?? ''}',
      );
}

/// 服务端偏好层：`GET/PUT /v1/agent/memory` + `DELETE /v1/agent/memory/:key`。
class RemoteAgentMemory implements AgentMemoryStore {
  RemoteAgentMemory({
    required AgentHttpGet get,
    required AgentHttpPut put,
    required AgentHttpDelete delete,
    this.path = kMemoryPath,
    this.source = 'agent',
    this.timeout = const Duration(seconds: 8),
  })  : _get = get,
        _put = put,
        _delete = delete;

  /// 路径字面量单独摆出来：机检（scripts/verify_routes.mjs）按字面量扫客户端消费者，
  /// 拼出来的字符串会让这条检查永远失真。
  static const String kMemoryPath = '/v1/agent/memory';
  static const String kMemoryKeyPathPrefix = '/v1/agent/memory/';

  /// 删除路由的**服务端字面量**（与 `api/agent.js:214` 逐字一致，供机检对账）。
  static const String kMemoryKeyRoutePattern = '/v1/agent/memory/:key';

  /// 用真实键名填出可请求路径。
  static String memoryKeyPath(String key) =>
      kMemoryKeyRoutePattern.replaceFirst(':key', Uri.encodeComponent(key));

  final AgentHttpGet _get;
  final AgentHttpPut _put;
  final AgentHttpDelete _delete;
  final String path;

  /// 写入来源标记（服务端限长 24）。
  final String source;
  final Duration timeout;

  @override
  bool unreachable = false;

  @override
  Future<List<AgentMemoryEntry>> load() async {
    try {
      final body = await _get(path).timeout(timeout);
      final rows = body['memories'];
      final out = <AgentMemoryEntry>[];
      if (rows is List) {
        for (final r in rows) {
          if (r is Map && '${r['key'] ?? ''}'.trim().isNotEmpty) {
            out.add(AgentMemoryEntry.fromJson(r));
          }
        }
      }
      unreachable = false;
      return out;
    } catch (_) {
      // 取不到不编造：调用方据此如实告知，且不会把上次缓存当最新。
      unreachable = true;
      return const [];
    }
  }

  @override
  Future<MemoryWriteResult> write({
    required String key,
    required String value,
    String? source,
  }) async {
    final k = normalizeKey(key);
    if (!isSafeKey(k)) {
      return MemoryWriteResult(ok: false, key: k, error: kBadKeyHint);
    }
    if (value.trim().isEmpty) {
      return const MemoryWriteResult(ok: false, error: '这条偏好没内容，写进去只是占位。');
    }
    try {
      final body = await _put(path, {
        'key': k,
        'value': value.trim(),
        'source': source ?? this.source,
      }).timeout(timeout);
      return MemoryWriteResult.from(Map<String, dynamic>.from(body));
    } catch (e) {
      return MemoryWriteResult(ok: false, key: k, error: '没写进去（$e）');
    }
  }

  @override
  Future<bool> remove(String key) async {
    final k = normalizeKey(key);
    if (!isSafeKey(k)) return false;
    try {
      final body = await _delete(memoryKeyPath(k)).timeout(timeout);
      return body['ok'] == true || body['removed'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 服务端强制 `^[a-z0-9_.:-]{1,48}$`（api/agent.js:188）。
  /// 端侧先过一遍：拿中文当 key 白跑一趟网络，只是浪费用户等待。
  static final RegExp _keyPattern = RegExp(r'^[a-z0-9_.:-]{1,48}$');

  static bool isSafeKey(String key) => _keyPattern.hasMatch(key);

  /// 尽量救一把：大小写、首尾空白、空格转下划线。救不动就交给 [isSafeKey] 判死。
  static String normalizeKey(String raw) {
    var k = raw.trim().toLowerCase();
    k = k.replaceAll(RegExp(r'\s+'), '_');
    return k.length > 48 ? k.substring(0, 48) : k;
  }

  static const String kBadKeyHint =
      '这个偏好键用不了：只能用英文小写字母、数字和 _ . : -（比如 tempo_pref、vocal_no_male），'
      '中文请写在值里，不要写在键名里。';
}

/// 注入到 system 尾部的偏好块。
///
/// 三件事一次做完：标注性质（偏好≠真值）、给出冲突处置（偏好优先 + 必须可见）、
/// 以及「想不起来就别提」的止损 —— 少一条都会让模型把口味当词典用。
String memoryPromptBlock(List<AgentMemoryEntry> entries, {bool unreachable = false}) {
  if (unreachable) {
    return '<user_preferences status="unavailable">\n'
        '这次没能取到用户存下的偏好（网络或服务端没回）。'
        '需要口味时**如实说这次没带上他的偏好**，按通用做法给建议，'
        '不要沿用记忆里的旧值，也不要说「你以前说过」。\n'
        '</user_preferences>';
  }
  if (entries.isEmpty) {
    return '<user_preferences count="0">\n'
        '这个用户还没有存下偏好。别编「你以前喜欢过…」；'
        '他说出口的稳定口味才可以用 memory.write 记下来（键名用英文小写）。\n'
        '</user_preferences>';
  }
  final b = StringBuffer();
  b.writeln('<user_preferences count="${entries.length}">');
  b.writeln('以下是**用户偏好**，不是平台事实真值，也不是词典条目：');
  for (final e in entries) {
    b.writeln('- ${e.key}: ${e.value}（来源：${e.source == 'user' ? '用户自己写的' : '助手记下的'}）');
  }
  b.writeln('用法：');
  b.writeln('1) 与平台词典（catalog.lookup）冲突时**以用户偏好优先**，'
      '但要在简报卡里把这条偏好写出来让用户看见，**不许静默替换**；');
  b.writeln('2) 偏好只说明「他要什么」，不能当作曲风/情绪/音色的合法取值；'
      '取值仍以词典为准，对不上就照实说对不上；');
  b.writeln('3) 助手记下的（source=agent）可能是一次猜错：拿不准就当面向用户确认一句，'
      '用户说不是就用 memory.forget 删掉，不要留着反复生效。');
  b.write('</user_preferences>');
  return b.toString();
}

/// 三层分工的守门人：把「其实是数据/方法」的内容挡在记忆层外。
///
/// 返回 null = 可以写；返回一段话 = 不该写进记忆，**这段话直接回填给模型**，
/// 让它改走 catalog 或 skill，而不是把画像层当垃圾桶。
String? memoryLayerViolation(String value) {
  final v = value.trim();
  if (v.isEmpty) return '这条偏好没内容，写进去只是占位。';
  const methodMarks = [
    '步骤', '流程', '第一步', '先...', '首先', '然后', '接着', '按下面', 'SOP', 'how to', 'step 1',
  ];
  for (final m in methodMarks) {
    if (v.toLowerCase().contains(m.toLowerCase())) {
      return '这内容是「怎么做」（方法），不该进用户偏好。'
          '要沉淀做法请写成技能（skill）并让用户在「我的 → 智能体技能」勾选；'
          '偏好层只记这个用户本身的口味，例如「他偏好 92 bpm」「她不要男声」。';
    }
  }
  const dataMarks = ['词典', '词表', '曲风列表', '情绪列表', '可选值', '枚举', 'list of genres'];
  for (final m in dataMarks) {
    if (v.toLowerCase().contains(m.toLowerCase())) {
      return '这内容是「有哪些取值」（数据），该走平台词典（catalog.lookup），不该进用户偏好。'
          '偏好层只记这个用户本身的口味，不记全量词表。';
    }
  }
  if (v.length > 300) {
    return '这条偏好太长了（服务端只收 300 字）。'
          '偏好要短：一句话说清他要什么，长内容属于方法（技能）或数据（词典）。';
  }
  return null;
}
