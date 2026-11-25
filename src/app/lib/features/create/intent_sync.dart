import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';

/// 意图卡「点改」的落库通道（契约 v2.19 PATCH /v1/intent/:id）。
///
/// 为什么要有这个文件：意图卡 UI 早就写着「AI 推测 · 可点改」，但改动只存在于
/// App 内存里，`POST /v1/intent/:id/generate` 无请求体、服务端只按库内卡面派单
/// ——用户改的 mood/人声/流派/时长在生成时被静默丢弃（能看不能改＝假动作）。
/// 这里把点改成真通道：
///  · debounce 合并：连点 chips 只发一次 PATCH（服务端有 intent:<uid> 速率桶）
///  · 乐观更新：UI 立刻改，成功后以服务端回包为准（服务端会裁剪 mood≤3 等）
///  · 失败回滚 + 可重试：不装「已保存」，回退到上次服务端值并保留待重试的改动
///  · 生成前 flush：`_generate` 前必 flush，避免"最后一下改动没保存就去派单"
enum IntentPatchStatus { idle, saving, saved, failed }

class IntentPatchQueue {
  IntentPatchQueue(this._api, this.intentId);

  final ApiClient _api;
  final String intentId;

  final Map<String, dynamic> _pending = {};
  Timer? _timer;

  /// 「上一次发送是否结束」信号（永不带错误完成——错误由 flush 自己消化，
  /// 避免无人 await 的 Completer.completeError 变成未捕获异步错误）
  Future<void>? _flight;

  /// 归属者（同一 intentId 的队列可被面板复用；dispose 时只清自己的回调）
  Object? owner;
  void Function(IntentPatchStatus status)? onStatus;
  void Function(Intent latest)? onApplied;

  IntentPatchStatus status = IntentPatchStatus.idle;
  bool get hasPending => _pending.isNotEmpty;
  bool get busy => _flight != null;

  /// 提交一次点改（延迟合并发送）
  void submit(Map<String, dynamic> patch, {int delayMs = 420}) {
    _pending.addAll(patch);
    _emit(IntentPatchStatus.saving);
    _timer?.cancel();
    _timer = Timer(Duration(milliseconds: delayMs), flush);
  }

  /// 立即落库（生成前、页面退出前调用）；返回服务端最新卡（失败为 null）
  Future<Intent?> flush() async {
    _timer?.cancel();
    final flying = _flight;
    if (flying != null) {
      // 串行化：等上一次发完再发，避免同一卡片并发 PATCH 互相覆盖
      await flying;
    }
    if (_pending.isEmpty) return null;
    final payload = Map<String, dynamic>.from(_pending);
    _pending.clear();
    _emit(IntentPatchStatus.saving);
    final c = Completer<void>();
    _flight = c.future;
    try {
      final latest = await _api.intentPatch(intentId, payload);
      c.complete();
      _flight = null;
      onApplied?.call(latest);
      _emit(_pending.isEmpty ? IntentPatchStatus.saved : IntentPatchStatus.saving);
      return latest;
    } catch (_) {
      c.complete(); // 失败不外泄：状态已置 failed，改动留在 _pending 等重试
      _flight = null;
      _pending.addAll(payload); // 留着，点「重试」直接再发
      _emit(IntentPatchStatus.failed);
      return null;
    }
  }

  /// 失败后重试（保留的待提交改动原样再发一次）
  Future<Intent?> retry() => flush();

  void dispose() {
    _timer?.cancel();
    _timer = null;
    _pending.clear();
    onStatus = null;
    onApplied = null;
    owner = null;
  }

  void _emit(IntentPatchStatus s) {
    status = s;
    onStatus?.call(s);
  }
}

// —— 按 intentId 共享：意图面板与标准/深度档的轻参数控件写同一张卡 ——
final Map<String, IntentPatchQueue> _queues = {};

/// 取（或建）某张意图卡的点改队列
IntentPatchQueue intentQueueFor(WidgetRef ref, String intentId) {
  final q = _queues[intentId];
  if (q != null) return q;
  final created = IntentPatchQueue(ref.read(apiClientProvider), intentId);
  _queues[intentId] = created;
  return created;
}

/// 轻参数（sec/bpm/count）改动同步到已绑定的意图卡；未绑卡则什么都不做。
/// 标准档/深度档的时长、BPM、候选数在有意图卡时必须回传，否则 generate 用不到。
///
/// 接法（三档 shell 的控件回调里加一行即可，state 仍是唯一真源）：
/// ```dart
/// // shell_standard：时长 chips / slider
/// onSelected: (_) { notifier.setSec(s); syncIntentParams(ref, st.intentId, {'sec': s}); }
/// // shell_pro：BPM / 时长 / 候选数
/// onChanged: (v) { notifier.setBpm(v.round()); syncIntentParams(ref, st.intentId, {'bpm': v.round()}); }
/// onSelectionChanged: (s) { notifier.setCount(s.first); syncIntentParams(ref, st.intentId, {'count': s.first}); }
/// ```
/// 面板与这里共用同一 intentId 的队列：连拖 slider 只会发一次 PATCH，
/// 且面板「生成」前会统一 flush，不会漏掉最后一次拖动。
void syncIntentParams(WidgetRef ref, String? intentId, Map<String, dynamic> patch) {
  if (intentId == null || intentId.isEmpty || patch.isEmpty) return;
  intentQueueFor(ref, intentId).submit(patch);
}
