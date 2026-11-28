import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/models.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/creation/tier_config.dart';
import 'package:musicbox/features/create/shell_replica.dart';

/// 复刻档端侧判据（契约 v5.7.2 / v5.7.5 / v5.7.10 的端侧镜像）。
/// 服务端断言在 test/acceptance/v38_replica.test.js，本文件只钉 UI 行为：
///  ① 灰度位数据驱动：replicaMode 关 → 档位列表没有「复刻」；开 → 出现且 tier=4
///  ② 残留 tier=4 + 灰度关 → resolveStoredTier 回落简约（V35-㉕ 同款语义）
///  ③ 谱面诚实性：BPM 恒标「估」、降级归纳必须明说、来源行说清出处
///  ④ 谱面特征词原样展示（端侧不造词），四个域各成一行
ReplicaProfile _profile({bool degraded = false, int? bpm = 110}) =>
    ReplicaProfile(
      id: 'rp_test',
      sourceKind: 'web',
      sourceRef: 'abc123',
      title: '我的参考曲',
      moods: const ['欢快', '治愈'],
      genres: const ['电子', '流行'],
      styleWords: const ['温暖', '钢琴'],
      voice: const ['女声', '气声'],
      bpmEst: bpm,
      summary: '轻快的电子节拍配温暖钢琴，女声气声唱法。',
      confidence: 0.72,
      degraded: degraded,
      jobId: 'j_test',
      createdAt: 0,
    );

class _SilentApi implements ApiClient {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  test('tier 列表数据驱动：复刻随 replicaMode 出没，tier 身份不变', () {
    final off = CreationTiers.visible(cocreateEnabled: false);
    expect(off.any((e) => e.tier == CreationTiers.tierReplica), isFalse,
        reason: 'replicaEnabled 缺省 false（fail-closed）：旧调用方拿不到复刻档');
    final on = CreationTiers.visible(
        cocreateEnabled: true, replicaEnabled: true);
    expect(on.length, 4, reason: '简约/标准/深度/复刻（智能体只留底栏入口）');
    expect(on[3].tier, CreationTiers.tierReplica);
    expect(on[3].label, '复刻');
    expect(on.any((e) => e.tier == CreationTiers.tierCocreate), isFalse);
    expect(CreationTiers.labelOf(CreationTiers.tierReplica), '复刻');
    expect(CreationTiers.indexOfTier(4,
        cocreateEnabled: true, replicaEnabled: true), 3);
  });

  test('残留 tier=4 的回落：灰度关 → 简约；越界 → 简约', () {
    expect(
        CreationTiers.resolveStoredTier(4,
            cocreateEnabled: true, replicaEnabled: false),
        CreationTiers.tierEasy,
        reason: '复刻被灰度关掉后不能停在空白档位（v5.7.2）');
    expect(
        CreationTiers.resolveStoredTier(4,
            cocreateEnabled: true, replicaEnabled: true),
        CreationTiers.tierReplica);
    expect(
        CreationTiers.resolveStoredTier(5,
            cocreateEnabled: true, replicaEnabled: true),
        CreationTiers.tierEasy);
    // 存量行为零回归（agent_ui_test 已钉 3 档，这里补 4 档上界下的旧值）
    expect(
        CreationTiers.resolveStoredTier(2,
            cocreateEnabled: false, replicaEnabled: false), 2);
  });

  testWidgets('谱面诚实性：BPM 标「估」、降级归纳明说、来源行说清出处', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(_SilentApi()),
          replicaPresetProvider.overrideWith((ref) => _profile(degraded: true)),
        ],
        child: const MaterialApp(
          home: Scaffold(body: ShellReplica()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('来自对「我的参考曲」的公开资料分析'), findsOneWidget,
        reason: '来源行必须说清出处（v5.7.5）');
    expect(find.textContaining('降级归纳'), findsWidgets,
        reason: 'degraded=true 必须明说走了降级归纳（v5.7.10）');
    expect(find.textContaining('BPM 约 110（估）'), findsOneWidget,
        reason: 'bpm_est 是推断值，UI 恒标「估」（v5.7.5）');
    expect(find.text('心情'), findsOneWidget);
    expect(find.text('曲风'), findsOneWidget);
    expect(find.text('质感'), findsOneWidget);
    expect(find.text('谁来唱'), findsOneWidget);
    for (final w in ['欢快', '电子', '温暖', '女声', '气声']) {
      expect(find.text(w), findsOneWidget,
          reason: '特征词原样展示，端侧不造词（v5.7.6）');
    }
    expect(find.text('按这个风格写一首新的'), findsOneWidget);
    expect(find.text('换一首参考歌'), findsOneWidget);
  });

  testWidgets('无降级时不出降级横幅；无 BPM 时不出估行', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(_SilentApi()),
          replicaPresetProvider.overrideWith((ref) => _profile(bpm: null)),
        ],
        child: const MaterialApp(
          home: Scaffold(body: ShellReplica()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('降级归纳'), findsNothing);
    expect(find.textContaining('BPM 约'), findsNothing,
        reason: 'bpm_est=null 绝不拿别的数顶替（v5.7.5）');
    expect(find.textContaining('把握 72%'), findsOneWidget);
  });

  testWidgets('来源页有两条通道 + 合规边界说明；关键件可被语义命中', (tester) async {
    final sem = tester.ensureSemantics();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(_SilentApi()),
        ],
        child: const MaterialApp(
          home: Scaffold(body: ShellReplica()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('从曲库选'), findsOneWidget);
    expect(find.text('搜歌名'), findsOneWidget);
    expect(find.textContaining('只学风格，不学身份'), findsOneWidget,
        reason: '声纹红线的话术必须先于用户动作出现');
    // 语义节点可测性：打得到才算存在（IA review #10/#14/#15 同源纪律）
    // Semantics 标签在合并后可能拼接子节点文本，这里用包含式匹配（RegExp 语义）
    expect(
        find.bySemanticsLabel(
            RegExp(r'从曲库选：用你自己的作品做风格参考')),
        findsOneWidget,
        reason: '关键交互件必须能被语义命中（可测性=无障碍）');
    expect(
        find.bySemanticsLabel(
            RegExp(r'搜歌名：按公开资料归纳风格特征')),
        findsOneWidget);
    sem.dispose();
  });
}
