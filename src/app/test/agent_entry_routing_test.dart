// 业务页「助手」入口的分流（2026-11-27 产品更正）：**老大当家**。
//
// 层级只有一个方向 —— 本页小助理办不了往上交给智能体；智能体不把难题推回小助理。
// 所以 createAgentMode 命中时，业务页那个"我搞不清楚"的入口必须直达智能体，
// 而不是先进只能接待的小助理。真机上这四条入口要有作品/有 MV 项目才点得到，
// 所以这条约束由本用例在接缝级钉住，不靠手点。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/agent/agent_bootstrap.dart';
import 'package:musicbox/features/creation/tier_config.dart';
import 'package:musicbox/root_shell.dart';

void main() {
  testWidgets('灰度命中：不打开小助理弹层，改为带上本页上下文请求跳智能体', (tester) async {
    var legacyCalled = 0;
    int? jumpBefore;
    late BuildContext ctx;

    await tester.pumpWidget(ProviderScope(
      child: MaterialApp(
        home: Builder(builder: (c) {
          ctx = c;
          return const SizedBox.shrink();
        }),
      ),
    ));
    final container = ProviderScope.containerOf(ctx, listen: false);
    jumpBefore = container.read(cocreateJumpRequestProvider);

    await openPanelAssistant(
      ctx,
      panelId: 'mv_progress',
      cocreateEnabled: true,
      legacy: () async => legacyCalled++,
    );
    await tester.pump();

    expect(legacyCalled, 0, reason: '灰度命中时不许落到现网那个小助理弹层');
    expect(container.read(cocreateJumpRequestProvider), jumpBefore! + 1,
        reason: '必须请求跳到智能体（第 4 槽位）');
    expect(container.read(agentPanelContextProvider), 'mv_progress',
        reason: '要把"我在问哪一页"带过去，用户不必重述位置');
  });

  testWidgets('灰度未命中：原样打开现网弹层，一行行为都不变（红线：规则模式永远可用）',
      (tester) async {
    var legacyCalled = 0;
    late BuildContext ctx;
    await tester.pumpWidget(ProviderScope(
      child: MaterialApp(
        home: Builder(builder: (c) {
          ctx = c;
          return const SizedBox.shrink();
        }),
      ),
    ));
    final container = ProviderScope.containerOf(ctx, listen: false);
    final before = container.read(cocreateJumpRequestProvider);

    await openPanelAssistant(
      ctx,
      panelId: 'work_detail',
      cocreateEnabled: false,
      legacy: () async => legacyCalled++,
    );

    expect(legacyCalled, 1, reason: '关档必须回到今天的行为，不许偷偷改道');
    expect(container.read(cocreateJumpRequestProvider), before,
        reason: '未命中灰度就不该发生任何跳转');
  });

  // ── 底部助手悬浮入口（2026-11-28 产品拍板：智能体那一格不给）───────────────
  // 真机上的现象是：切到「智能体」，聊天流底下还浮着一个「助手」胶囊。那一格就是老大本人，
  // 底栏再挂个助手等于鼓动用户往下找小弟 —— 与"层级单向、只向上交"（契约 v5.8.4）直接相反。
  group('底部助手悬浮入口', () {
    RemoteConfig cfg(bool on) => RemoteConfig({
          'features': {CreationTiers.cocreateFlag: on},
        });

    test('第 4 格命中智能体时不渲染助手入口', () {
      expect(showAssistantDockAt(cfg(true), 3), isFalse);
    });

    test('其余各格照旧给；第 4 格退回「人格」时也必须给', () {
      for (final t in [0, 1, 2, 4]) {
        expect(showAssistantDockAt(cfg(true), t), isTrue,
            reason: '第 $t 格与智能体无关，不该被顺带砍掉');
      }
      expect(showAssistantDockAt(cfg(false), 3), isTrue,
          reason: '灰度未命中时第 4 格是「人格」页，助手入口必须照常在场');
      expect(showAssistantDockAt(null, 3), isTrue,
          reason: '配置还没下来时按"关"处理，不能给出一条空底栏');
    });
  });
}
