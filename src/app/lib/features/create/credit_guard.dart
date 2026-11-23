import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';

/// 积分口径（契约 §1）
const kCreditGenerateEach = 15; // generate 每候选
const kCreditAdjust = 10; // 微调 variation
const kCreditExtendCover = 20; // extend / cover
const kCreditDsp = 5; // dsp
const kDailyQuota = 50; // 每日免费积分

/// generate 前余额不足弹说明卡。返回 true=可继续。
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
      title: const Text('积分不足'),
      content: Text(
        '本次「$action」约需 $cost 积分，当前余额 $bal 积分。\n\n'
        '· 每日登录自动发放 $kDailyQuota 免费积分（当日有效，不结转）\n'
        '· 生成失败会自动全额返还\n'
        '· 稍后回来看看，第二天的免费积分就会刷新',
      ),
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
