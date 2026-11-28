/// 用户偏好的读写工具（方案 §4.7 三层分工 —— 只有「事实」走这里）。
///
/// 两个工具都归 [AgentToolKind.propose]：**画像变更必须让用户看得见**，
/// 端侧只负责把它送到服务端并如实回执，不在本地落盘（端侧无写权限是红线）。
///
/// 三道守门（都在执行体里，不靠 prompt 承诺）：
/// * key 必须小写 ascii（`^[a-z0-9_.:-]{1,48}$`）—— 端侧先校验，别拿中文白跑一趟；
/// * 「怎么做」（方法）与「有哪些取值」（数据）被 [memoryLayerViolation] 挡回，
///   并回填指路：方法写成技能、取值走词典；
/// * 写入回执必须带**删除路径** —— 只写不删等于把一次猜错永久固化成画像。
library;

import '../engine/agent_memory.dart';
import '../engine/agent_tool.dart';

const String kMemoryWriteToolName = 'memory.write';
const String kMemoryForgetToolName = 'memory.forget';

/// 记下一条用户偏好（`PUT /v1/agent/memory`）。
AgentTool buildMemoryWriteTool({required AgentMemoryStore memory, int rank = 105}) {
  return AgentTool(
    name: kMemoryWriteToolName,
    activityLabel: '我记下了这个偏好',
    rank: rank,
    kind: AgentToolKind.propose,
    description: '当用户明确说出**只属于他本人的稳定口味**时记一条偏好'
        '（例如"我一般要 92 bpm""不要男声""喜欢偏暗的音色"）。'
        '不记：平台有哪些曲风/情绪/音色（那是词典）、也不记怎么做一份配方的步骤（那是技能）。'
        '键名必须是英文小写（如 tempo_pref、vocal_no_male），内容写在值里。'
        '一次只记一条；用户改主意了就更新同一条。',
    parameters: const {
      'type': 'object',
      'properties': {
        'key': {
          'type': 'string',
          'description': '英文小写键名（字母数字与 _ . : -），如 tempo_pref',
        },
        'value': {
          'type': 'string',
          'description': '一句话说清他要什么，例如「偏好 92 bpm 左右」',
        },
      },
      'required': ['key', 'value'],
    },
    isConcurrencySafe: (_) => false,
    execute: (ctx) async {
      final rawKey = ctx.stringArg('key');
      final value = ctx.stringArg('value');

      // 端侧先按服务端正则判死（api/agent.js:188）：中文键名跑一趟网络只会白等。
      final normalized = RemoteAgentMemory.normalizeKey(rawKey);
      if (!RemoteAgentMemory.isSafeKey(normalized)) {
        return ToolResult.error(
          '记不下这条：${RemoteAgentMemory.kBadKeyHint} '
          '（你刚才写的是「$rawKey」）',
          degradation: '偏好键名不合格已端侧拦下（未发请求）',
        );
      }

      // 三层分工守门：数据走词典、方法走技能，偏好层不是垃圾桶。
      final violation = memoryLayerViolation(value);
      if (violation != null) {
        return ToolResult.error(violation, degradation: '内容属数据/方法层，已挡在偏好层外');
      }

      final res = await memory.write(key: normalized, value: value);
      if (!res.ok) {
        return ToolResult.error(res.error.isEmpty ? '这条偏好没记上。' : res.error);
      }
      return ToolResult.json(
        {'key': res.key, 'requires_confirmation': false, 'removable': true},
        note: '已记下这条偏好（${res.key}），下次做歌时会照它来。'
            '这条对用户可见，也随时可以撤：用户说「忘掉这条」就把它删掉，'
            '对用户说话时不要念键名这类内部代号。',
      );
    },
  );
}

/// 抹掉一条用户偏好（`DELETE /v1/agent/memory/:key`）。
///
/// 存在的意义不是「方便」，而是**没有它这套画像机制就不该上线**：
/// 助手记下的偏好可能是一次猜错，用户必须能撤销。
AgentTool buildMemoryForgetTool({required AgentMemoryStore memory, int rank = 104}) {
  return AgentTool(
    name: kMemoryForgetToolName,
    activityLabel: '我把那条偏好撤掉了',
    rank: rank,
    kind: AgentToolKind.propose,
    description: '用户说某条偏好不是他要的、或让你忘掉某个口味时调用，'
        '把它从他的画像里删掉。删不掉要照实说，不要假装已经忘掉。',
    parameters: const {
      'type': 'object',
      'properties': {
        'key': {'type': 'string', 'description': '要删掉的偏好键名（英文小写）'},
      },
      'required': ['key'],
    },
    isConcurrencySafe: (_) => false,
    execute: (ctx) async {
      final rawKey = ctx.stringArg('key');
      final normalized = RemoteAgentMemory.normalizeKey(rawKey);
      if (!RemoteAgentMemory.isSafeKey(normalized)) {
        return ToolResult.error(
          '删不掉：${RemoteAgentMemory.kBadKeyHint}（你刚才写的是「$rawKey」）',
          degradation: '偏好键名不合格已端侧拦下（未发请求）',
        );
      }
      final removed = await memory.remove(normalized);
      if (!removed) {
        return ToolResult.error(
          '「$normalized」这次没删掉（可能服务端没回话）。'
          '请如实告诉用户没删掉，别当作已经忘掉。',
          degradation: '删除失败：$normalized（服务端未确认）',
        );
      }
      return ToolResult.json(
        {'key': normalized, 'removed': true},
        note: '已经把这条偏好删掉了（$normalized），以后不会再拿它当依据。',
      );
    },
  );
}
