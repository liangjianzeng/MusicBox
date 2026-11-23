import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/state.dart';
import 'features/create/create_page.dart';
import 'features/library/library_page.dart';
import 'features/me/me_page.dart';
import 'features/persona/persona_page.dart';
import 'features/player/mini_player_bar.dart';

/// 全局壳：创建 / 曲库 / 人格 / 我的 + 常驻 mini player
class RootShell extends ConsumerStatefulWidget {
  const RootShell({super.key});

  @override
  ConsumerState<RootShell> createState() => _RootShellState();
}

class _RootShellState extends ConsumerState<RootShell> {
  @override
  void initState() {
    super.initState();
    // 进入主界面即预热人格列表 / 刷新积分
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(personasProvider.notifier).load();
      ref.read(sessionProvider.notifier).refreshCredits();
    });
  }

  @override
  Widget build(BuildContext context) {
    final tab = ref.watch(_tabProvider);
    return Scaffold(
      body: IndexedStack(
        index: tab,
        children: const [
          CreatePage(),
          LibraryPage(),
          PersonaPage(),
          MePage(),
        ],
      ),
      bottomNavigationBar: const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          MiniPlayerBar(),
          _BottomNav(),
        ],
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
            icon: Icon(Icons.mic), label: '人格'),
        NavigationDestination(
            icon: Icon(Icons.person_outline), label: '我的'),
      ],
    );
  }
}

/// tab 索引（RootShell 与底部导航共享）
final _tabProvider = StateProvider<int>((ref) => 0);
