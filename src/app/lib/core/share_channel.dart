import 'package:flutter/services.dart';

/// 系统分享（Android ACTION_SEND，由 MainActivity 的 MethodChannel 承接）
class SystemShare {
  static const _ch = MethodChannel('musicbox/share');

  static Future<bool> shareText(String text) async {
    try {
      final ok = await _ch.invokeMethod<bool>('shareText', {'text': text});
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }
}
