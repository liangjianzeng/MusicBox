/// 分层工具注册表（纯 Dart，禁止 import material —— 方案 §11.1 / §3.5）。
///
/// 三条硬规矩：
/// 1. **名称唯一**：同名注册直接抛错（`replace` 是唯一显式覆盖口，按 rank 高者胜）；
/// 2. **按 rank 降序**：可见集与 schema 导出顺序稳定，prefill 前缀可复用；
/// 3. **权限靠限制能力，不靠 prompt 承诺**：`restrictUser({allow})` 之后，
///    被排除的工具在 `lookup()` 里直接返回 null —— 模型想调也调不到，
///    而不是「调了报错」，更不是「prompt 里叮嘱它别调」（方案 §3.5）。
library;

import 'agent_tool.dart';

/// 注册表层面的异常（同名重复注册等）。
class AgentRegistryException implements Exception {
  const AgentRegistryException(this.message);
  final String message;
  @override
  String toString() => 'AgentRegistryException: $message';
}

class _Restriction {
  const _Restriction({this.allow, this.deny});
  final Set<String>? allow;
  final Set<String>? deny;
}

/// 工具注册表。
class AgentToolRegistry {
  AgentToolRegistry({List<AgentTool> tools = const []}) {
    for (final t in tools) {
      register(t);
    }
  }

  final Map<String, AgentTool> _all = {};
  final Map<String, _Restriction> _modelRestrictions = {};
  _Restriction? _userRestriction;
  final Set<String> _retired = {};

  /// 注册工具。同名重复 = 编程错误，直接抛（方案：名称唯一）。
  void register(AgentTool tool) {
    if (tool.name.trim().isEmpty) {
      throw const AgentRegistryException('工具名不能为空');
    }
    if (_all.containsKey(tool.name)) {
      throw AgentRegistryException('工具「${tool.name}」已注册，覆盖请用 replace()');
    }
    _all[tool.name] = tool;
  }

  /// 显式覆盖：同名时 rank 高者胜；rank 相同则后来者胜（下发覆盖内置的语义）。
  bool replace(AgentTool tool) {
    final old = _all[tool.name];
    if (old == null) {
      register(tool);
      return true;
    }
    if (tool.rank < old.rank) return false;
    _all[tool.name] = tool;
    return true;
  }

  /// 注销（幂等）。
  bool unregister(String name) => _all.remove(name) != null;

  /// 模型层可见性限制（按模型 key 分档）。传 null 两个参数 = 解除限制。
  void restrictModel(String modelKey, {Set<String>? allow, Set<String>? deny}) {
    if (allow == null && deny == null) {
      _modelRestrictions.remove(modelKey);
      return;
    }
    _modelRestrictions[modelKey] = _Restriction(allow: allow, deny: deny);
  }

  /// 用户/会话层可见性限制 —— 最近层，遮蔽模型层。
  ///
  /// 板块小助手的「封顶」与只读规划模式都走这里（方案 §2.1 / §3.5）：
  /// `restrictUser(allow: registry.readOnlyNames())` 之后，任何写类/建议类
  /// 工具对模型都不存在，schema 里一个字节都不占。
  void restrictUser({Set<String>? allow, Set<String>? deny}) {
    if (allow == null && deny == null) {
      _userRestriction = null;
      return;
    }
    _userRestriction = _Restriction(allow: allow, deny: deny);
  }

  /// 解除用户层限制。
  void clearUserRestriction() => _userRestriction = null;

  /// 当前用户层是否处于限制状态（封顶模式的自检判据）。
  bool get isUserRestricted => _userRestriction != null;

  /// 被弃用的幻觉工具名留痕（护栏写入，UI/审计可读）。
  Set<String> get retiredTools => Set.unmodifiable(_retired);

  /// 登记一个「模型幻觉出来的工具名」为弃用（护栏调用，只留痕不执行）。
  void retire(String name) => _retired.add(name);

  /// 全部已注册工具（不经可见性过滤，供诊断）。
  List<AgentTool> get all => _sorted(_all.values.toList());

  /// 当前可见工具集：注册表全局 → 模型层 → 用户层，**按 rank 降序**。
  List<AgentTool> visible({String? modelKey}) {
    var tools = _all.values.toList();
    if (modelKey != null) {
      tools = _apply(tools, _modelRestrictions[modelKey]);
    }
    tools = _apply(tools, _userRestriction);
    return _sorted(tools);
  }

  /// 只读工具名集合（封顶/规划模式的 allow 集）。
  Set<String> readOnlyNames({String? modelKey}) =>
      visible(modelKey: modelKey).where((t) => t.isReadOnly).map((t) => t.name).toSet();

  /// 查找**可见**工具；不可见 = 当作不存在（未知工具处理走护栏留痕）。
  AgentTool? lookup(String name, {String? modelKey}) {
    final tool = _all[name];
    if (tool == null) return null;
    for (final t in visible(modelKey: modelKey)) {
      if (t.name == name) return tool;
    }
    return null;
  }

  /// 工具是否注册过但被限制挡在外面（用于区分「幻觉」与「越权」两种留痕）。
  bool isRegisteredButHidden(String name, {String? modelKey}) =>
      _all.containsKey(name) && lookup(name, modelKey: modelKey) == null;

  /// 机械导出给模型的 schema 清单。执行体不在其中（白名单纪律）。
  List<Map<String, dynamic>> schemas({String? modelKey}) =>
      visible(modelKey: modelKey).map((t) => t.toModelSchema()).toList();

  List<AgentTool> _apply(List<AgentTool> tools, _Restriction? r) {
    if (r == null) return tools;
    var out = tools;
    final allow = r.allow;
    if (allow != null) out = out.where((t) => allow.contains(t.name)).toList();
    final deny = r.deny;
    if (deny != null && deny.isNotEmpty) {
      out = out.where((t) => !deny.contains(t.name)).toList();
    }
    return out;
  }

  /// rank 降序；同 rank 按名字典序，保证 schema 前缀稳定。
  List<AgentTool> _sorted(List<AgentTool> tools) {
    tools.sort((a, b) {
      final byRank = b.rank.compareTo(a.rank);
      return byRank != 0 ? byRank : a.name.compareTo(b.name);
    });
    return tools;
  }
}
