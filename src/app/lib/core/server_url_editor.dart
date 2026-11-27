import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'config.dart';
import 'state.dart';

/// `showDialog` 返回这个哨兵表示「恢复打包默认基址」。
const String kResetServerUrl = '\u0000__reset__';

/// 服务器地址编辑器：「我的」页与**离线横幅**共用这一份实现。
///
/// 为什么值得单独抽出来：离线时恰恰是最需要改地址的时候，可原来只有「我的」页里有入口，
/// 而离线横幅既不告诉你它在连哪个地址、也不给改的入口 —— 现场只能 `pm clear` 才能救回来。
/// 顺带这里提供「恢复默认」：清掉 SharedPreferences 里的地址覆盖，让打包期
/// `--dart-define=MUSICBOX_BASE_URL` 重新生效（`install -r` 保留旧数据时的唯一出路）。
Future<void> editServerUrl(BuildContext context, WidgetRef ref) async {
  final cfg = ref.read(configProvider);
  final c = TextEditingController(text: cfg.baseUrl);
  final action = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('服务器地址'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: c,
            keyboardType: TextInputType.url,
            decoration: InputDecoration(
              hintText: AppConfig.defaultBaseUrl,
              helperText: '当前：${cfg.baseUrl}\n打包默认：${AppConfig.defaultBaseUrl}\n'
                  '模拟器访问宿主机用 10.0.2.2；真机填同网段 IP 或 Tailscale 地址',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        TextButton(
            onPressed: () => Navigator.pop(ctx, kResetServerUrl),
            child: const Text('恢复默认')),
        FilledButton(
            onPressed: () => Navigator.pop(ctx, c.text.trim()),
            child: const Text('保存')),
      ],
    ),
  );
  if (action == null || !context.mounted) return;
  final notifier = ref.read(configProvider.notifier);
  String applied;
  if (action == kResetServerUrl) {
    await notifier.resetBaseUrl();
    applied = AppConfig.defaultBaseUrl;
  } else {
    if (action.isEmpty) return;
    await notifier.setBaseUrl(action);
    applied = ref.read(configProvider).baseUrl;
  }
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('服务器地址已改为 $applied —— 换地址已清旧令牌，正在重连')));
  // 刷新可选模型/定价等远程配置，并**立刻**探一次在线状态（不等 10s 定时器）
  ref.read(remoteConfigProvider.notifier).refresh();
  ref.read(sessionProvider.notifier).retryNow();
}
