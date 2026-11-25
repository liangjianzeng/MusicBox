import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/config.dart';
import 'core/state.dart';
import 'features/create/create_page.dart';
import 'features/library/library_page.dart';
import 'features/me/me_page.dart';
import 'features/mv/mv_page.dart';
import 'features/persona/persona_page.dart';
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
    // 进入主界面即预热人格列表 / 刷新积分
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(personasProvider.notifier).load();
      ref.read(sessionProvider.notifier).refreshCredits();
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
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('稍后再说')),
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
    final tab = ref.watch(_tabProvider);
    final rc = ref.watch(remoteConfigProvider);
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptUpdate());
    return Scaffold(
      body: Column(
        children: [
          if (rc != null && rc.announcementVisible && rc.announcementText.isNotEmpty)
            _AnnouncementBar(rc),
          Expanded(
            child: rc != null && rc.forceUpdate
                ? _ForceUpdateView(rc: rc)
                : IndexedStack(
                    index: tab,
                    children: const [
                      CreatePage(),
                      LibraryPage(),
                      MvPage(),
                      PersonaPage(),
                      MePage(),
                    ],
                  ),
          ),
        ],
      ),
      bottomNavigationBar: rc != null && rc.forceUpdate
          ? null
          : const Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                MiniPlayerBar(),
                _BottomNav(),
              ],
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
            Text('当前版本 $kAppVersion 已不再支持，请升级到 v${rc.recommended ?? rc.minSupported ?? '最新版'} 后继续使用。',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70)),
            if (rc.downloadUrl != null && rc.downloadUrl!.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(rc.downloadUrl!,
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
    return NavigationBar(
      selectedIndex: tab,
      height: 64,
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      onDestinationSelected: (i) => ref.read(_tabProvider.notifier).state = i,
      destinations: const [
        NavigationDestination(
            icon: Icon(Icons.auto_awesome), label: '创建'),
        NavigationDestination(
            icon: Icon(Icons.library_music), label: '曲库'),
        NavigationDestination(
            icon: Icon(Icons.movie_creation_outlined), label: 'MV'),
        NavigationDestination(
            icon: Icon(Icons.mic), label: '人格'),
        NavigationDestination(
            icon: Icon(Icons.person_outline), label: '我的'),
      ],
    );
  }
}

/// tab 索引（RootShell 与底部导航共享）
final _tabProvider = StateProvider<int>((ref) => 0);
