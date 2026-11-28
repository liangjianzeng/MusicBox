/// Skill 装载与目录（纯 Dart，禁止 import material —— 方案 §4.1~§4.3 / §4.7）。
///
/// 两层职责：
/// * 目录 [catalogText]：每回合常驻，只注入**已启用**技能的一行短句 —— 唯一常驻 prefill 成本；
/// * 正文 [skillText]：`load_skill` 按需取，配合 [SkillLoadLedger] 做**同会话去重**。
///
/// 去重规则按 rank 降序（100 内置 / 150 服务端下发 / 200 用户），同名保留最高者 ——
/// 于是「服务端下发」天然压过 APK 内置，调话术不必发版（方案 §4.2）。
library;

import 'agent_skill.dart';

/// 服务端正文取用器（`GET /v1/agent/skills/:name`）。取不到返回 null。
typedef SkillBodyLoader = Future<String?> Function(String name);

/// 技能装载台账（方案 §4.7 缺口 A：上游 `load_skill` 每次都全量返回正文，
/// 同会话重复装载会把 40~90 行 body 重复注入 N 次，很快吃光上下文）。
///
/// 按**会话**记名：同一会话内第二次装载同一技能 → 只回「已装载」+ 一行摘要。
class SkillLoadLedger {
  final Map<String, Set<String>> _loaded = {};

  /// 尝试装载。返回 `false` = 本会话此前已装载过（调用方须走「已装载」分支）。
  bool markLoaded(String sessionId, String skillName) =>
      (_loaded[sessionId] ??= <String>{}).add(skillName);

  bool isLoaded(String sessionId, String skillName) =>
      _loaded[sessionId]?.contains(skillName) ?? false;

  /// 本会话已装载的技能名（按装载顺序）。
  List<String> loadedIn(String sessionId) =>
      (_loaded[sessionId] ?? const <String>{}).toList(growable: false);

  /// 清账：给 sessionId 清单个会话，null 清全部（新会话不复用旧去重）。
  void reset([String? sessionId]) {
    if (sessionId == null) {
      _loaded.clear();
    } else {
      _loaded.remove(sessionId);
    }
  }
}

/// 技能提供者：三层来源合并 + 去重 + 三态启用。
class SkillProvider {
  SkillProvider({
    List<AgentSkill> builtin = const [],
    List<AgentSkill> server = const [],
    List<AgentSkill> user = const [],
    Set<String>? enabledOverride,
    Set<String>? hiddenOverride,
    bool remoteReachable = true,
  })  : _all = _dedupeByRank(<AgentSkill>[
          ...builtin.map((s) => _tag(s, kSkillRankBuiltin, AgentSkillSource.builtin)),
          ...server.map((s) => _tag(s, kSkillRankServer, AgentSkillSource.server)),
          ...user.map((s) => _tag(s, kSkillRankUser, AgentSkillSource.user)),
        ].map((s) {
          // 用户勾选结果（prefs）压过 defaultEnabled；运营隐藏压过 visible。
          final enabled = enabledOverride != null && enabledOverride.isNotEmpty
              ? enabledOverride.contains(s.name)
              : s.defaultEnabled;
          final hidden = hiddenOverride?.contains(s.name) ?? false;
          return s.copyWith(defaultEnabled: enabled, visible: s.visible && !hidden);
        }).toList()),
        _remoteReachable = remoteReachable;

  List<AgentSkill> _all;
  bool _remoteReachable;

  /// 服务端正文取用器（目录不含正文，`load_skill` 命中时才取）。
  SkillBodyLoader? remoteBodyLoader;

  static AgentSkill _tag(AgentSkill s, int rank, AgentSkillSource src) =>
      s.rank == rank && s.source == src
          ? s
          : AgentSkill(
              name: s.name,
              description: s.description,
              whenToUse: s.whenToUse,
              body: s.body,
              rank: rank,
              invocation: s.invocation,
              source: src,
              kind: s.kind,
              defaultEnabled: s.defaultEnabled,
              visible: s.visible,
            );

  /// 去重后的全量技能（rank 降序）。
  List<AgentSkill> get skills => List.unmodifiable(_all);

  /// 服务端下发是否可达：不可达时目录要**如实告知**（方案 §4.2 最后一句），
  /// 不许拿旧配方冒充最新。
  bool get remoteReachable => _remoteReachable;

  /// 合并服务端下发的同名技能（rank 150 压过内置 100）。
  /// 返回是否取到了东西；取不到时保持内置集并把 [remoteReachable] 置 false。
  bool mergeRemote(List<AgentSkill> remote, {bool? reachable}) {
    _remoteReachable = reachable ?? remote.isNotEmpty;
    if (remote.isEmpty) return false;
    _all = _dedupeByRank(<AgentSkill>[
      ..._all.where((s) => s.source != AgentSkillSource.server),
      ...remote.map((s) => _tag(s, kSkillRankServer, AgentSkillSource.server)),
    ]);
    return true;
  }

  /// 进目录的技能：已启用 && 可见。
  List<AgentSkill> get catalog => _all.where((s) => s.defaultEnabled && s.visible).toList();

  /// 「我的 → 伴创技能」列表用：可见技能（含未勾选的）。
  List<AgentSkill> get selectable => _all.where((s) => s.visible).toList();

  AgentSkill? byName(String name) {
    for (final s in _all) {
      if (s.name == name) return s;
    }
    return null;
  }

  /// 能否被 `load_skill` 装载（三态判据：未勾选 / 不可见 一律不可装载）。
  bool loadable(String name) {
    final s = byName(name);
    return s != null && s.defaultEnabled && s.visible;
  }

  /// 每回合注入的目录（只含 name/description/whenToUse 的一行短句）。
  ///
  /// 目录里没有的技能，模型既看不见也不该猜 —— 这是「全量入库、默认只 8 个进目录」
  /// 的落地（方案 §4.3 / 验收 ⑳）。
  String catalogText() {
    final items = catalog;
    if (items.isEmpty) return '';
    final b = StringBuffer('<available_skills>\n');
    for (final s in items) {
      b.writeln('- ${s.name}: ${s.oneLine}'
          '${s.whenToUse.isEmpty ? '' : '（适用：${s.whenToUse}）'}');
    }
    b.write('</available_skills>\n');
    b.write('任务匹配某条「适用」时，先调用 load_skill（name=技能名）取完整指引，再按指引执行；'
        '同一会话里装过的不必重复装。');
    if (!_remoteReachable) {
      b.write('\n（注：最新配方此刻没取到，以下是设备里已有的版本，可能与最新有差别。）');
    }
    return b.toString();
  }

  /// 完整 body 注入文本（本地已有正文的技能）。
  ///
  /// ⚠️ 端到端断言（V35-㉑b）：目录里出现的每个技能都必须能从这里取到 body。
  String skillText(String name) {
    final s = byName(name);
    if (s == null || s.bodyPending) return '';
    return _wrap(s.name, s.kind, s.body);
  }

  /// 按需取正文：本地有就用本地的，服务端技能走 `GET /v1/agent/skills/:name`。
  ///
  /// 取不到返回空串 —— 调用方必须**如实报错**，不许拿目录里的一行摘要冒充正文。
  Future<String> skillTextAsync(String name) async {
    final s = byName(name);
    if (s == null) return '';
    if (!s.bodyPending) return _wrap(s.name, s.kind, s.body);
    final loader = remoteBodyLoader;
    if (loader == null) return '';
    final body = (await loader(name))?.trim() ?? '';
    if (body.isEmpty) return '';
    // 回填进目录集：同会话第二次装载直接命中本地，不再打服务端。
    _all = _all
        .map((e) => e.name == name ? _tag(e.copyWith(body: body), e.rank, e.source) : e)
        .toList();
    return _wrap(s.name, s.kind, body);
  }

  /// 装载形态：带上 kind（method / orchestrator），模型据此知道这是「怎么做」而非「是什么」。
  static String _wrap(String name, String kind, String body) =>
      '<skill name="$name" kind="$kind">\n$body\n</skill>';

  /// 三层同名去重：列表已按 rank 降序，保留第一个 = 最高 rank。
  static List<AgentSkill> _dedupeByRank(List<AgentSkill> skills) {
    final sorted = [...skills]..sort((a, b) {
        final byRank = b.rank.compareTo(a.rank);
        return byRank != 0 ? byRank : a.name.compareTo(b.name);
      });
    final seen = <String>{};
    final out = <AgentSkill>[];
    for (final s in sorted) {
      if (seen.add(s.name)) out.add(s);
    }
    return out;
  }
}
