/// `load_skill` 工具（纯 Dart —— 方案 §4.7 缺口 A 的修复点）。
///
/// 上游 TongYi-Lite 的 `load_skill_tool.dart` 只有一句 `provider.skillText(name)`：
/// **同会话重复调用就把 40~90 行正文重复注入 N 次**。伴创一次创作要串 5~6 个技能，
/// 上下文很快被吃光 —— 那是「智能体越用越笨」的典型来源。
///
/// 这里必须**按会话去重**（验收 ㉘）：同一会话第二次装载同一技能，只返回
/// 「本会话已装载」+ 一行摘要，**不再返回全文**。
///
/// 另一条端到端纪律（V35-㉑b）：目录里出现的每个技能都必须真的能从这里取到 body
/// —— 上游曾经「只注入目录、body 永远没有调用方」，整条链路断了却无人发现。
library;

import '../engine/agent_tool.dart';
import '../skills/skill_provider.dart';

/// 注册名（UI 的「技能已加载」状态点按它匹配）。
const String kLoadSkillToolName = 'load_skill';

/// 已装载时的提示语（单测按「不含全文」断言）。
const String kAlreadyLoadedHint = '本会话已装载';

AgentTool buildLoadSkillTool({
  required SkillProvider skills,
  required SkillLoadLedger ledger,
  int rank = 120,
}) {
  final names = skills.catalog.map((s) => s.name).toList();
  return AgentTool(
    name: kLoadSkillToolName,
    activityLabel: '我翻出这套做法',
    rank: rank,
    kind: AgentToolKind.readOnly,
    description: '取一份创作手册（技能）的完整指引，然后按指引执行。'
        '当任务匹配 <available_skills> 里某条的「适用」时调用它；'
        '同一会话里已经装载过的不必重复装载。'
        '可用技能：${names.isEmpty ? "（本轮没有可装载的技能）" : names.join("、")}。',
    parameters: const {
      'type': 'object',
      'properties': {
        'name': {
          'type': 'string',
          'description': '技能名（必须来自 <available_skills> 目录）',
        },
      },
      'required': ['name'],
    },
    // 装载是纯读，不改任何业务态；但为了与「出网即副作用」的规矩一致，仍声明可并发。
    isConcurrencySafe: (_) => true,
    execute: (ctx) async {
      final name = ctx.stringArg('name');
      if (name.isEmpty) {
        return ToolResult.error('没写要装载哪一份手册（name 是必填的技能名）');
      }
      final skill = skills.byName(name);
      if (skill == null) {
        return ToolResult.error('没有这份手册：$name。'
            '本轮可用的只有：${names.isEmpty ? "（无）" : names.join("、")}');
      }
      if (!skills.loadable(name)) {
        // 三态启用（方案 §4.3）：未勾选 / 不可见的技能连装载都不该发生。
        return ToolResult.error('「$name」此刻没启用，用不了。'
            '要用的话请用户先在「我的 → 智能体技能」里勾选它。');
      }

      // ① 同会话去重：第二次只回摘要，绝不重发全文。
      if (ledger.isLoaded(ctx.scopeKey, name)) {
        return ToolResult(
          content: '「$name」$kAlreadyLoadedHint，请按上文的指引执行，不必再取一次。\n'
              '一句话要点：${skill.oneLine}',
          data: {'name': name, 'deduped': true},
        );
      }
      // ② 正文按需取：服务端下发的目录只有 name/description，正文走
      //    GET /v1/agent/skills/:name（V35-⑧⑨ 钉住目录不含 body）。
      final text = await skills.skillTextAsync(name);
      if (text.trim().isEmpty) {
        // 目录里有、正文取不到 = 链路断了：如实报错 + 记一次可归因降级，
        // 绝不拿目录里的一行摘要冒充正文，也不静默少做一步。
        return ToolResult.error(
          '「$name」的正文这次没取到（下发没送达或为空），我按没有这份指引处理，'
          '并按通用规矩谨慎执行。',
          degradation: '正文取用失败：$name（服务端未返回 body，已按无指引降级）',
        );
      }
      ledger.markLoaded(ctx.scopeKey, name);
      return ToolResult(
        content: text,
        data: {'name': name, 'deduped': false},
      );
    },
  );
}
