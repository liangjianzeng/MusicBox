/// Skill 数据结构（纯 Dart，禁止 import material —— 方案 §4.1 / §4.2）。
///
/// 三段式：`name/description`（目录常驻）+ `whenToUse`（命中判据）+ `body`
/// （`load_skill` 按需加载的执行手册）。
///
/// 三条写法纪律（照抄上游 `skill.dart:6-11` 的自述，方案 §4.1）：
/// 1. `description`/`whenToUse` 必须一行短句 —— 目录每回合注入，是唯一常驻 prefill 成本；
/// 2. `body` 要写厚（步骤 + 模板 + 验收清单）—— 写三句话的技能等于没有技能；
/// 3. 正文只绑定本 app 真实存在的工具名，不写空泛指引。
///
/// 副作用红线（方案 §4.5）：body 里凡涉副作用只能写
/// 「调用 `music.propose_*`（需用户确认票）」，禁止祈使式的「生成/发送/删除」。
library;

/// 三级 rank（方案 §4.2：同名按 rank 高者胜）。
const int kSkillRankBuiltin = 100; // APK 内置最小集（离线兜底）
const int kSkillRankServer = 150; // 服务端下发 —— 最需要高频调的东西不进发布通道
const int kSkillRankUser = 200; // 用户自定义

/// 技能来源（审计与「下发不可达时如实告知」用）。
enum AgentSkillSource { builtin, server, user }

class AgentSkill {
  const AgentSkill({
    required this.name,
    required this.description,
    required this.whenToUse,
    required this.body,
    required this.rank,
    this.invocation,
    this.source = AgentSkillSource.builtin,
    this.defaultEnabled = true,
    this.visible = true,
    this.kind = 'method',
  });

  final String name;

  /// 一行短句（目录用）。
  final String description;

  /// 一行短句：什么时候该装它（模型据此命中）。
  final String whenToUse;

  /// 执行手册（按需加载，要厚）。
  final String body;

  final int rank;

  /// 调用形态提示（可选）。
  final String? invocation;

  final AgentSkillSource source;

  /// 技能类别（服务端 `agent_skills.kind`）。
  ///
  /// 判据（方案 §4.7）：**能用表格穷举的是数据**（走 catalog 下发，不该写成技能）、
  /// **需要判断与步骤的才是方法**（kind='method'）、因人而异的走 memory。
  final String kind;

  /// 三态启用（方案 §4.3）：默认启用 / 可勾选未启用 / 不可见。
  final bool defaultEnabled;
  final bool visible;

  /// 正文是否还没取到（服务端目录只给 name/description，正文按需 load）。
  bool get bodyPending => body.trim().isEmpty;

  AgentSkill copyWith({
    int? rank,
    bool? defaultEnabled,
    bool? visible,
    String? body,
    String? description,
    String? whenToUse,
  }) => AgentSkill(
        name: name,
        description: description ?? this.description,
        whenToUse: whenToUse ?? this.whenToUse,
        body: body ?? this.body,
        rank: rank ?? this.rank,
        invocation: invocation,
        source: source,
        kind: kind,
        defaultEnabled: defaultEnabled ?? this.defaultEnabled,
        visible: visible ?? this.visible,
      );

  /// 一行摘要（同会话去重时随「已装载」返回，让模型仍能想起要点）。
  String get oneLine => description.trim().isEmpty ? whenToUse.trim() : description.trim();

  /// `SKILL.md` 解析（frontmatter: name/description/whenToUse/invocation + 正文）。
  ///
  /// 解析失败返回 null —— 单个坏文件不许拖垮整个技能集（上游同款容错）。
  static AgentSkill? parse(String content, {
    required String name,
    int rank = kSkillRankBuiltin,
    AgentSkillSource source = AgentSkillSource.builtin,
    bool defaultEnabled = true,
    bool visible = true,
  }) {
    final lines = content.split('\n');
    final meta = <String, String>{};
    var bodyStart = 0;
    var seenSeparator = false;
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i].trim();
      if (line == '---') {
        if (!seenSeparator) {
          seenSeparator = true;
          continue;
        }
        bodyStart = i + 1;
        break;
      }
      if (!seenSeparator) continue;
      final colon = line.indexOf(':');
      if (colon <= 0) continue;
      meta[line.substring(0, colon).trim()] =
          line.substring(colon + 1).trim();
    }
    final body = lines.skip(bodyStart).join('\n').trim();
    if (body.isEmpty) return null;
    return AgentSkill(
      name: (meta['name'] ?? name).trim(),
      description: (meta['description'] ?? '').trim(),
      whenToUse: (meta['whenToUse'] ?? meta['when_to_use'] ?? '').trim(),
      invocation: meta['invocation']?.trim(),
      body: body,
      rank: rank,
      source: source,
      defaultEnabled: defaultEnabled,
      visible: visible,
    );
  }

  @override
  String toString() => 'AgentSkill($name rank=$rank src=${source.name})';
}
