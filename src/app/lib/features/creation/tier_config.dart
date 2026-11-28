import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../create/creation_ui.dart';

/// 「我的 → 复刻偏好 → 去创建页」的落地请求位：root_shell 监听后切回创建 tab（index 0）。
/// 与 cocreateJumpRequestProvider 同款纪律 —— 跳转是产品决定，只开请求位，不开放任意索引。
final replicaJumpRequestProvider = StateProvider<int>((ref) => 0);

/// 创作档位规格（方案 §2.5 / 契约 v5.5.15）。
///
/// **`tier` 整数是持久化身份，不是显示顺序**：0 简约 / 1 标准 / 2 深度 三个值
/// 已经写进用户设备里的 `create_tier`（`core/config.dart`），永远不许改含义；
/// 3 = 伴创（新增）。要调整屏幕上谁先谁后，改 [CreationTiers.all] 的数组顺序，
/// 不要去动 tier 值——那会让老用户升级后档位记忆错位。
class CreationTierSpec {
  const CreationTierSpec({
    required this.tier,
    required this.label,
    required this.icon,
    required this.color,
    this.flagKey,
    this.blurb,
  });

  /// 持久化身份（写入 prefs `create_tier` 的值）。
  final int tier;

  /// 用户可见的档位名（说人话，不出现模式/引擎名）。
  final String label;
  final IconData icon;

  /// 一律取自 [CreationPalette]，禁止在此处出现 `Color(0x…)` 字面量（§11.2）。
  final Color color;

  /// 灰度开关名。null = 恒可见；非 null 且开关关闭 → **整个档位从界面消失**
  /// （不是灰掉、不是"点了没用"，是看不见）。
  final String? flagKey;

  /// 一行说明（可选），给档位下方的一句话用。
  final String? blurb;

  /// 用远程配置的开关判定可见性。缺配置按"关"处理（灰度默认关）。
  bool isVisible(bool Function(String flag) featureOn) {
    final key = flagKey;
    if (key == null) return true;
    return featureOn(key);
  }
}

abstract final class CreationTiers {
  static const int tierEasy = 0;
  static const int tierStandard = 1;
  static const int tierPro = 2;
  static const int tierCocreate = 3;
  static const int tierReplica = 4;

  /// 伴创灰度位（契约 v5.5.2：`GET /v1/app/config` 的 `features.createAgentMode`）。
  static const String cocreateFlag = 'createAgentMode';

  /// 复刻灰度位（契约 v5.7.2：`features.replicaMode`，默认关；关时整档消失且
  /// `/v1/replica/*` 服务端一律 404 —— 两端同一 fail-closed 口径）。
  static const String replicaFlag = 'replicaMode';

  /// 显示顺序 = 数组顺序；tier 值与它解耦。
  static const List<CreationTierSpec> all = [
    CreationTierSpec(
      tier: tierEasy,
      label: '简约',
      icon: Icons.auto_awesome_rounded,
      color: CreationPalette.amber,
    ),
    CreationTierSpec(
      tier: tierStandard,
      label: '标准',
      icon: Icons.tune_rounded,
      color: CreationPalette.green,
    ),
    CreationTierSpec(
      tier: tierPro,
      label: '深度',
      icon: Icons.equalizer_rounded,
      color: CreationPalette.blue,
    ),
    CreationTierSpec(
      tier: tierReplica,
      label: '复刻',
      icon: Icons.content_copy_rounded,
      color: CreationPalette.cyan,
      flagKey: replicaFlag,
      blurb: '拿一首喜欢的歌，学它的风格写新的',
    ),
    // ⚠ 档位条**不放**「智能体」跳转位（2026-11-28 产品拍板）：底栏第 4 槽才是伴创的
    // 独立入口，档位条里再放一个纯跳转 tab 与复刻/三档挤在一起是重复。tier=3 仍是
    // 持久化身份（resolveStoredTier 保留回落逻辑；服务端 ask_budget 走 mode='agent'，
    // 不依赖档位条）——只是它不再出现在本数据源里。
  ];

  /// 当前可见档位（灰度关闭时伴创/复刻整档不出现，其余档位顺序与 index 零变化 →
  /// `create_layout_test.dart` 等既有断言零回归）。
  /// [replicaEnabled] 缺省 false：没接新灰度的旧调用方自动拿不到复刻档（fail-closed）。
  static List<CreationTierSpec> visible({
    required bool cocreateEnabled,
    bool replicaEnabled = false,
  }) =>
      all
          .where((s) => switch (s.flagKey) {
                null => true,
                cocreateFlag => cocreateEnabled,
                replicaFlag => replicaEnabled,
                _ => false, // 未登记的 flagKey：宁可不给，不给探测面
              })
          .toList(growable: false);

  /// 按持久化 tier 取规格（未知 tier 返回 null，调用方自己兜底，不编造档位）。
  static CreationTierSpec? byTier(int tier) {
    for (final s in all) {
      if (s.tier == tier) return s;
    }
    return null;
  }

  /// 档位名（未知值返回空串，由调用方决定怎么显示，绝不回落到"深度"糊弄用户）。
  static String labelOf(int tier) => byTier(tier)?.label ?? '';

  /// tab 条里的下标（不可见档位不存在下标 → 返回 null）。
  static int? indexOfTier(int tier,
      {required bool cocreateEnabled, bool replicaEnabled = false}) {
    final list = visible(cocreateEnabled: cocreateEnabled, replicaEnabled: replicaEnabled);
    for (var i = 0; i < list.length; i++) {
      if (list[i].tier == tier) return i;
    }
    return null;
  }

  /// 显示顺序 → 持久化 tier（tab 回调用：`onChanged(index)` → tier）。
  static int tierAt(int index,
      {required bool cocreateEnabled, bool replicaEnabled = false}) {
    final list = visible(cocreateEnabled: cocreateEnabled, replicaEnabled: replicaEnabled);
    if (index < 0 || index >= list.length) return tierEasy;
    return list[index].tier;
  }

  /// **落库前的兜底**（契约 v5.5.15 / v5.7.2 / 验收 V35-㉕）：开关关闭时持久化里残留的
  /// tier=3 / tier=4 一律回落 简约，避免伴创/复刻被灰度关掉后用户停在空白档位。
  ///
  /// 接线：`create_page` 在渲染前发现"当前 tier 不可见"时回落渲染 + postFrame 清持久化；
  /// 写 `create_tier` 之前也过一遍——
  /// `prefs.setCreateTier(CreationTiers.resolveStoredTier(t, cocreateEnabled: on))`
  static int resolveStoredTier(int stored,
      {required bool cocreateEnabled, bool replicaEnabled = false}) {
    if (stored == tierCocreate && !cocreateEnabled) return tierEasy;
    if (stored == tierReplica && !replicaEnabled) return tierEasy;
    if (stored < tierEasy || stored > tierReplica) return tierEasy;
    return stored;
  }
}

/// 伴创灰度是否命中当前用户。配置还没下来时按"关"处理（宁可不给新档位，
/// 也不能把没灰度到的用户暴露在新功能上）。
bool cocreateEnabledOf(RemoteConfig? rc) =>
    rc?.featureOn(CreationTiers.cocreateFlag) ?? false;

/// 复刻灰度是否命中当前用户（契约 v5.7.2，口径与 [cocreateEnabledOf] 相同）。
bool replicaEnabledOf(RemoteConfig? rc) =>
    rc?.featureOn(CreationTiers.replicaFlag) ?? false;
