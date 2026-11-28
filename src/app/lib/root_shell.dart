import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'core/config.dart';
import 'core/connectivity.dart';
import 'core/server_url_editor.dart';
import 'core/state.dart';
import 'features/create/create_page.dart';
import 'features/assistant/assistant_models.dart';
import 'features/assistant/assistant_surface.dart';
import 'features/assistant/assistant_state.dart';
import 'features/library/library_page.dart';
import 'features/me/me_page.dart';
import 'features/mv/mv_page.dart';
import 'features/persona/persona_page.dart';
import 'features/agent/agent_bootstrap.dart';
import 'features/agent/ui/agent_cocreate_page.dart';
import 'features/creation/tier_config.dart';
import 'features/player/mini_player_bar.dart';

/// 全局壳：创建 / 曲库 / 人格 / 我的 / MV + 常驻 mini player
class RootShell extends ConsumerStatefulWidget {
  const RootShell({super.key});

  @override
  ConsumerState<RootShell> createState() => _RootShellState();
}

class _RootShellState extends ConsumerState<RootShell> {
  bool _updatePrompted = false;

  @override
  void initState() {
    super.initState();
    // ⚠ 两条 ref.listen 必须在 build() 里，不能留在这里：riverpod 的 WidgetRef.listen
    // 带 `debugDoingBuild` 断言，在 ConsumerState.initState 里调用会直接抛
    // （'ref.listen can only be used within the build method of a ConsumerWidget'）。
    // 真机 K90 上整屏皆红就是它 —— release 关掉 Dart 断言，所以这坑一直没人看见。
    // 进入主界面即预热人格列表 / 刷新积分
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(personasProvider.notifier).load();
      ref.read(sessionProvider.notifier).refreshCredits();
      if (ref.read(sessionProvider).status == SessionStatus.ready &&
          (ref.read(sessionProvider).user?.id.isNotEmpty ?? false)) {
        unawaited(ref.read(assistantProvider.notifier).bootstrap());
      }
    });
  }

  void _maybePromptUpdate() {
    if (_updatePrompted) return;
    final rc = ref.read(remoteConfigProvider);
    if (rc == null || !rc.suggestUpdate || rc.forceUpdate) return;
    _updatePrompted = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('发现新版本'),
          content: Text('建议升级到 v${rc.recommended} 以获得更好体验。当前版本 $kAppVersion。'),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx), child: const Text('稍后再说')),
            FilledButton(
              onPressed: () {
                Navigator.pop(ctx);
                ref.read(remoteConfigProvider.notifier).refresh();
              },
              child: const Text('知道了'),
            ),
          ],
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    // 必须写在 build 里（见 initState 上方那条 ⚠ 与 test/riverpod_listen_rule_test.dart）。
    // ⚠ 原来这里写的是"见 test/root_shell_nav_test.dart"——那个文件并不存在，空头指针比没指针更坏，
    //   已改指真实存在的用例；底部导航与助手入口的去留由 test/agent_entry_routing_test.dart 钉住。
    // 板块小助手「去伴创」的落地处：只接受这一个跳转请求（见 cocreateJumpRequestProvider 的说明）。
    // 放在这里而不是 _BottomNav：tab 状态本就由这里的 IndexedStack 持有，导航条只负责显示。
    ref.listen(cocreateJumpRequestProvider, (prev, next) {
      if (prev != next) ref.read(_tabProvider.notifier).state = 3;
    });
    // 「我的 → 复刻偏好」回创建页复刻档的落地处（契约 v5.7.9 主权复用入口）。
    ref.listen(replicaJumpRequestProvider, (prev, next) {
      if (prev != next) ref.read(_tabProvider.notifier).state = 0;
    });
    ref.listen(_tabProvider, (_, index) {
      ref.read(assistantContextProvider.notifier).state = AssistantContext(
          surface: switch (index) {
        1 => 'library',
        2 => 'mv',
        4 => 'settings',
        _ => 'create',
      });
    });
    final tab = ref.watch(_tabProvider);
    final rc = ref.watch(remoteConfigProvider);
    final session = ref.watch(sessionProvider);
    // 离线横幅 = 启动没连上 **或** 现在这条真实链路不通（流量/WSS 说话，见 connectivity.dart）
    final netUp = session.netOnline && ref.watch(connectivityProvider);
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptUpdate());
    return Scaffold(
      body: Column(
        children: [
          if (!netUp) const _OfflineBanner(),
          if (rc != null &&
              rc.announcementVisible &&
              rc.announcementText.isNotEmpty)
            _AnnouncementBar(rc),
          Expanded(
            child: rc != null && rc.forceUpdate
                ? _ForceUpdateView(rc: rc)
                : IndexedStack(
                    index: tab,
                    children: [
                      CreatePage(keyboardOpen: keyboardOpen),
                      const LibraryPage(),
                      const MvPage(),
                      // 第 4 槽位数据驱动（D-3）：伴创灰度命中就顶替「人格」，**始终 5 个 tab**，
                      // 不破"不加第六个一级页"的红线。人格在灰度开启时从「我的 → 声音与人格」进入，
                      // 所以这个 swap 必须与 me_page 的入口同批上线，单独上线会让人格变成孤儿页。
                      cocreateEnabledOf(rc)
                          ? const AgentCocreatePage(tierLabel: '智能体')
                          : const PersonaPage(),
                      const MePage(),
                    ],
                  ),
          ),
        ],
      ),
      bottomNavigationBar: rc != null && rc.forceUpdate
          ? null
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // 智能体那一格不给助手悬浮入口（2026-11-28 产品拍板）：那一格就是老大本人，
                // 底栏再挂一个「助手」等于鼓动用户往下找小弟，与"层级单向、只向上交"相反。
                if (showAssistantDockAt(rc, tab)) const AssistantDock(),
                const MiniPlayerBar(),
                const _BottomNav(),
              ],
            ),
    );
  }
}

/// 第 4 格 = 智能体时，**不**渲染底部助手入口；其余各格照旧。
///
/// 刻意抽成纯函数而不是埋在 widget 里：这条是产品口径（"智能体下面就别出助手的入口链接了"），
/// 得起个名字、能被用例直接钉住，而不是靠人眼在 build 里数 `if`。
/// 注意灰度未命中时第 4 格是「人格」页 —— 那时助手入口必须照常给，别把它一起砍了。
bool showAssistantDockAt(RemoteConfig? rc, int tab) =>
    !(cocreateEnabledOf(rc) && tab == 3);

/// 离线兜底提示：游客登录连续失败时展示（每 10s 自动重试，恢复在线后自动消失）。
///
/// 这条横幅**必须把正在连的地址打出来**：现场排障第一个问题永远是「它到底在连哪儿」——
/// SharedPreferences 里的地址覆盖会静默压过打包期的 `--dart-define`，不写出来就只能靠猜。
/// 同时就地给「改地址 / 重试」两个入口，别逼人去 `pm clear`。
class _OfflineBanner extends ConsumerWidget {
  const _OfflineBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = ref.watch(configProvider).baseUrl;
    return Material(
      color: const Color(0xFF402028),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Row(
            children: [
              const Icon(Icons.wifi_off, size: 16, color: Color(0xFFFFC1CC)),
              const SizedBox(width: 8),
              Expanded(
                child: Text('连不上服务器 $url，当前可使用本地功能',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12, color: Color(0xFFFFC1CC))),
              ),
              TextButton(
                onPressed: () => editServerUrl(context, ref),
                child: const Text('改地址',
                    style: TextStyle(fontSize: 12, color: Color(0xFFFFC1CC))),
              ),
              TextButton(
                onPressed: () =>
                    ref.read(sessionProvider.notifier).retryNow(),
                child: const Text('重试',
                    style: TextStyle(fontSize: 12, color: Color(0xFFFFC1CC))),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 后台下发公告 Banner（notice / warn / maint）
class _AnnouncementBar extends StatelessWidget {
  const _AnnouncementBar(this.rc);
  final RemoteConfig rc;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bg = switch (rc.announcementStyle) {
      'warn' => const Color(0xFF5A3A12),
      'maint' => const Color(0xFF402028),
      _ => scheme.primaryContainer.withValues(alpha: .55),
    };
    final fg = switch (rc.announcementStyle) {
      'warn' => const Color(0xFFFFD79A),
      'maint' => const Color(0xFFFFC1CC),
      _ => scheme.onPrimaryContainer,
    };
    return Material(
      color: bg,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              Icon(Icons.campaign_outlined, size: 16, color: fg),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(rc.announcementText,
                      style: TextStyle(fontSize: 12, color: fg))),
            ],
          ),
        ),
      ),
    );
  }
}

/// 强制升级门禁（后台 required 且版本低于最低可用）
class _ForceUpdateView extends StatelessWidget {
  const _ForceUpdateView({required this.rc});
  final RemoteConfig rc;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.system_update_alt, size: 56),
            const SizedBox(height: 16),
            const Text('需要更新到最新版本',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text(
                '当前版本 $kAppVersion 已不再支持，请升级到 v${rc.recommended ?? rc.minSupported ?? '最新版'} 后继续使用。',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70)),
            if (rc.downloadUrl != null && rc.downloadUrl!.isNotEmpty) ...[
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: () async {
                  final uri = Uri.tryParse(rc.downloadUrl!);
                  if (uri == null) {
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('下载地址无效，请稍后再试')));
                    return;
                  }
                  try {
                    final opened = await launchUrl(uri,
                        mode: LaunchMode.externalApplication);
                    if (!opened && context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('无法打开下载页面，可复制地址后重试')));
                    }
                  } catch (_) {
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('无法打开下载页面，可复制地址后重试')));
                    }
                  }
                },
                icon: const Icon(Icons.download_rounded),
                label: const Text('去更新'),
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: rc.downloadUrl!));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context)
                        .showSnackBar(const SnackBar(content: Text('下载地址已复制')));
                  }
                },
                icon: const Icon(Icons.copy_rounded),
                label: const Text('复制下载地址'),
              ),
              const SizedBox(height: 10),
              SelectableText(rc.downloadUrl!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 12, color: Colors.white38)),
            ],
          ],
        ),
      ),
    );
  }
}

class _BottomNav extends ConsumerWidget {
  const _BottomNav();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // 与 RootShell 的 IndexedStack 共享 tab：用 holder Provider 同步
    final tab = ref.watch(_tabProvider);
    final rc = ref.watch(remoteConfigProvider);
    // 列表顺序即显示顺序；第 4 槽位随灰度换人，数量恒为 5（红线：不新增底部一级页）
    final cocreate = cocreateEnabledOf(rc);
    final destinations = <NavigationDestination>[
      const NavigationDestination(icon: Icon(Icons.auto_awesome), label: '创建'),
      const NavigationDestination(icon: Icon(Icons.library_music), label: '曲库'),
      const NavigationDestination(
          icon: Icon(Icons.movie_creation_outlined), label: 'MV'),
      cocreate
          ? const NavigationDestination(
              icon: Icon(Icons.auto_awesome_motion_outlined), label: '智能体')
          : const NavigationDestination(icon: Icon(Icons.mic), label: '人格'),
      const NavigationDestination(icon: Icon(Icons.person_outline), label: '我的'),
    ];
    return NavigationBar(
      selectedIndex: tab.clamp(0, destinations.length - 1),
      height: 64,
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      onDestinationSelected: (i) => ref.read(_tabProvider.notifier).state = i,
      destinations: destinations,
    );
  }
}

/// tab 索引（RootShell 与底部导航共享）
final _tabProvider = StateProvider<int>((ref) => 0);
