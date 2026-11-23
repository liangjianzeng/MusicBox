import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';

/// 隐私条款固定文案（PIPL：用途限定 + 最短保存 + 不训练）
const kBiometricPrivacyText =
    '你的语音/照片仅用于本次生成使用，72 小时后自动删除，不用于训练。';

/// 首次语音/拍照前的同意对话框。返回是否同意。
Future<bool> ensureBiometricConsent(BuildContext context, WidgetRef ref) async {
  final prefs = ref.read(prefsProvider);
  if (prefs.biometricConsented) return true;
  final ok = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      title: const Text('开始录制前'),
      content: const Text(kBiometricPrivacyText),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: const Text('暂不'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('同意并继续'),
        ),
      ],
    ),
  );
  if (ok == true) {
    await prefs.setBiometricConsented(true);
    return true;
  }
  return false;
}
