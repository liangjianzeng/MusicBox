/// 服务端技能投递层（rank 150，方案 §4.2 / 契约 v5.5.12）。
///
/// 两个端点（服务端 `api/agent.js` 已落地，机检 V35-⑧⑨ 钉住**目录不含正文**）：
/// * `GET /v1/agent/skills` → `{rank:150, skills:[{name,description,rank,kind}]}`
/// * `GET /v1/agent/skills/:name` → `{name,description,body,rank,kind}`（404 = 没有这条）
///
/// 于是目录常驻、正文按需 —— 正文只在 `load_skill` 真的命中时才付 token。
/// 下发不可达时回落 APK 内置集（rank 100）并**如实告知**，不许拿旧配方冒充最新。
library;

import '../engine/agent_transport.dart';
import 'agent_skill.dart';

/// 目录与正文的路径字面量（服务端 `api/agent.js:210-211`）。
const String kSkillsCatalogPath = '/v1/agent/skills';
const String kSkillsBodyPathPrefix = '/v1/agent/skills/';

/// 正文路由的**服务端字面量**（与 `api/agent.js:211` 路由表逐字一致）。
///
/// 机检 verify_routes.mjs 按字面量对账：这条串必须原样出现在 App 里，
/// 否则「server 有路由、App 从不调用」那条检查会永远指错地方。
const String kSkillsBodyRoutePattern = '/v1/agent/skills/:name';

/// 用真实技能名填出可请求路径（名字里可能有中文/斜杠，必须转义）。
String skillBodyPath(String name) =>
    kSkillsBodyRoutePattern.replaceFirst(':name', Uri.encodeComponent(name));

class RemoteSkillSource {
  RemoteSkillSource({
    required AgentHttpGet get,
    this.catalogPath = kSkillsCatalogPath,
    String? bodyPathPrefix,
    this.rank = kSkillRankServer,
  })  : _get = get,
        // 路径用字面量常量，不要在运行时拼出来：机检 scripts/verify_routes.mjs
        // 按字面量扫客户端消费者，拼串的写法会让「服务端有路由、App 未调用」这条检查失真。
        bodyPathPrefix = bodyPathPrefix ?? kSkillsBodyPathPrefix;

  final AgentHttpGet _get;
  final String catalogPath;
  final String bodyPathPrefix;

  /// 默认走 [skillBodyPath]（路由字面量模板），宿主给了自定义前缀才退化拼接。
  String _bodyPath(String name) => bodyPathPrefix == kSkillsBodyPathPrefix
      ? skillBodyPath(name)
      : '$bodyPathPrefix${Uri.encodeComponent(name)}';

  /// 服务端下发的 rank 恒为 150（压过 APK 内置 100，低于用户自定义 200）。
  final int rank;

  /// 最近一次取目录是否成功 —— 失败时目录要显式说明「这是本机已有版本」。
  bool reachable = true;

  /// 拉目录（**只**含 name/description/rank/kind；body 恒为空）。
  Future<List<AgentSkill>> fetchCatalog() async {
    try {
      final body = await _get(catalogPath);
      final list = body['skills'];
      final out = <AgentSkill>[];
      if (list is List) {
        for (final raw in list) {
          if (raw is! Map) continue;
          final name = '${raw['name'] ?? ''}'.trim();
          if (name.isEmpty) continue;
          out.add(AgentSkill(
            name: name,
            description: '${raw['description'] ?? ''}'.trim(),
            whenToUse: '${raw['when_to_use'] ?? raw['whenToUse'] ?? ''}'.trim(),
            // 目录不带正文：正文必须走 fetchBody（否则等于把 body 常驻 prefill）
            body: '',
            invocation: raw['invocation'] == null ? null : '${raw['invocation']}',
            rank: _asInt(raw['rank'], rank),
            source: AgentSkillSource.server,
            defaultEnabled: _asInt(raw['enabled'], 1) == 1,
            visible: _asInt(raw['delivered'], _asInt(raw['visible'], 1)) == 1,
            kind: '${raw['kind'] ?? 'method'}',
          ));
        }
      }
      reachable = true;
      return out;
    } catch (_) {
      reachable = false;
      return const [];
    }
  }

  /// 按需取正文。取不到返回 null（调用方须如实降级，不得静默）。
  Future<String?> fetchBody(String name) async {
    try {
      final body = await _get(_bodyPath(name));
      final text = '${body['body'] ?? ''}'.trim();
      if (text.isEmpty) {
        // 正文为空 = 服务端没给全，与「没有这个技能」同等对待（不猜、不编）。
        reachable = false;
        return null;
      }
      return text;
    } catch (_) {
      return null;
    }
  }

  static int _asInt(Object? v, int d) =>
      v is int ? v : (v is num ? v.toInt() : int.tryParse('$v') ?? d);
}
