import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 在线状态的**真源**：以真实流量与常驻 WSS 为准，而不是只看启动那一刻。
///
/// 为什么要单独一个源：`SessionState.netOnline` 只在启动连网失败时才置 false，
/// 于是「服务器中途死了」屏上什么都不提示（用户点生成才莫名失败），
/// 而「启动时连不上、后来通了」又会一路挂着红条 —— 两头都在误导。
/// 这里把判定挂到**每一次真实请求**与 **WSS 状态**上：通了就算在线，连不上才离线。
class ConnectivityNotifier extends StateNotifier<bool> {
  ConnectivityNotifier() : super(true);

  Timer? _grace;

  /// 一次真实成功请求 / WSS 连上 → 立刻判在线（横幅当场消失）
  void markOnline() {
    _grace?.cancel();
    _grace = null;
    if (!state) state = true;
  }

  /// 连接类失败 → 宽限一会儿再判离线，避免网络瞬断闪一下横幅。
  /// [grace] 由调用方按信号强弱给：请求失败给短的，WSS 掉线给长的（它会自己重连）。
  void markOffline({Duration grace = const Duration(seconds: 3)}) {
    if (_grace?.isActive ?? false) return;
    _grace = Timer(grace, () {
      if (mounted) state = false;
    });
  }

  /// 强制立即离线（测试/明确断网用），不等宽限
  void markOfflineNow() {
    _grace?.cancel();
    _grace = null;
    if (mounted) state = false;
  }

  @override
  void dispose() {
    _grace?.cancel();
    super.dispose();
  }
}

final connectivityProvider =
    StateNotifierProvider<ConnectivityNotifier, bool>((ref) {
  return ConnectivityNotifier();
});
