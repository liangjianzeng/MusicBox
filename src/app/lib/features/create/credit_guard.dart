import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';

/// 积分口径（契约 §1）
///
/// 这些常量**只是兜底**，不是权威价：真实单价在运营配置中心（服务端 `AC.credits()`，可热改），
/// 由 `/v1/credits 的 prices` 下发（契约 v5.6.15）。界面展示与扣费闸门一律走 [creditPrice]，
/// 只有老服务端没下发 prices 时才退回这里的值 —— 拿手抄价当权威，运营一改价界面就开始说谎
/// （按旧价放行、派单时被服务端拒）。判词 V41-③ 钉住"显示价 == 真扣价"。
const kCreditGenerateEach = 15; // generate 每候选（兜底）
const kCreditAdjust = 10; // 微调 variation（兜底）
const kCreditExtendCover = 20; // extend / cover（兜底）
const kCreditDsp = 5; // dsp（兜底）
const kDailyQuota = 50; // 每日免费积分（兜底）

/// 服务端下发的单价（`/v1/credits 的 prices`），拿不到才用兜底常量。
/// key 与服务端一致：per_candidate / adjust / extend / cover / dsp。
int creditPrice(WidgetRef ref, String key, int fallback) {
  final c = ref.read(sessionProvider).credits;
  return c == null ? fallback : c.priceFor(key, fallback);
}

/// 执行前检查账户状态。费用展示由调用方负责（简约档已把「N 首 · M⚡」写在按钮上）。
Future<bool> ensureCredits(BuildContext context, WidgetRef ref, int cost,
    {String action = '生成'}) async {
  final session = ref.read(sessionProvider);
  final bal = session.credits?.balance;
  if (bal == null || bal >= cost) return true;
  if (!context.mounted) return false;
  await showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      icon: const Icon(Icons.co2_outlined),
      title: const Text('暂时无法开始'),
      content: Text('当前无法执行「$action」，请稍后重试。'),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('我知道了'),
        ),
      ],
    ),
  );
  return false;
}
