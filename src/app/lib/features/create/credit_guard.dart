import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';

/// 积分口径（契约 §1）
const kCreditGenerateEach = 15; // generate 每候选
const kCreditAdjust = 10; // 微调 variation
const kCreditExtendCover = 20; // extend / cover
const kCreditDsp = 5; // dsp
const kDailyQuota = 50; // 每日免费积分

/// 执行前检查账户状态；费用信息暂不在界面呈现。
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
