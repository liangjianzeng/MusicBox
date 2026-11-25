/// 语音设置（端侧/服务端可配置切换 + 朗读偏好），Riverpod + SharedPreferences。
///
/// 引擎档位是**能力开关**，不是型号开关：UI 只显示「即时 / 精听 / 服务端」，
/// 型号名（SenseVoice、Zipformer、sherpa-onnx…）一律不进字符串。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'asr_engine.dart';

class SpeechSettings {
  const SpeechSettings({
    this.asrEngine = AsrEngineKind.streamingZipformer,
    this.autoSpeak = false,
    this.speakRate = 1.0,
    this.speakerId = 0,
    this.fallbackToServer = true,
  });

  /// 识别档位
  final AsrEngineKind asrEngine;

  /// 助手回复自动朗读
  final bool autoSpeak;

  /// 语速倍率
  final double speakRate;

  /// 声库说话人（多说话人声库有效）
  final int speakerId;

  /// 端侧不可用时是否允许回落服务端
  final bool fallbackToServer;

  bool get onDevice => asrEngine != AsrEngineKind.server;

  /// 档位的人话名字（设置页与录音浮层共用，**不含型号名**）
  String get asrEngineLabel => switch (asrEngine) {
        AsrEngineKind.streamingZipformer => '即时（边说边出字）',
        AsrEngineKind.senseVoiceOffline => '精听（含情绪与音频事件）',
        AsrEngineKind.server => '服务端识别',
      };

  /// 档位一句话解释（诚实说明各档拿不到什么）
  String get asrEngineHint => switch (asrEngine) {
        AsrEngineKind.streamingZipformer => '反应最快；不出标点，也不给情绪标签。',
        AsrEngineKind.senseVoiceOffline => '松手后整段再听一遍，能给出情绪与背景音事件；需要更大模型。',
        AsrEngineKind.server => '录音上传后由服务端识别；没网就没法用，情绪标签看服务端状态。',
      };

  SpeechSettings copyWith({
    AsrEngineKind? asrEngine,
    bool? autoSpeak,
    double? speakRate,
    int? speakerId,
    bool? fallbackToServer,
  }) =>
      SpeechSettings(
        asrEngine: asrEngine ?? this.asrEngine,
        autoSpeak: autoSpeak ?? this.autoSpeak,
        speakRate: speakRate ?? this.speakRate,
        speakerId: speakerId ?? this.speakerId,
        fallbackToServer: fallbackToServer ?? this.fallbackToServer,
      );

  Map<String, Object> toMap() => {
        'asr_engine': asrEngine.name,
        'auto_speak': autoSpeak,
        'speak_rate': speakRate,
        'speaker_id': speakerId,
        'fallback_server': fallbackToServer,
      };

  static SpeechSettings fromMap(Map<String, Object?> m) => SpeechSettings(
        asrEngine: AsrEngineKind.values.firstWhere(
          (e) => e.name == m['asr_engine'],
          orElse: () => AsrEngineKind.streamingZipformer,
        ),
        autoSpeak: _asBool(m['auto_speak'], false),
        speakRate: _asDouble(m['speak_rate'], 1.0),
        speakerId: _asInt(m['speaker_id'], 0),
        fallbackToServer: _asBool(m['fallback_server'], true),
      );

  // 持久化形态是 k=v;k=v 文本，回读一律是字符串 —— 解析必须容脏，
  // 一次崩溃就把整个语音设置打回默认（用户视角=开关自己跳回去）。
  static bool _asBool(Object? v, bool dflt) {
    if (v is bool) return v;
    if (v is num) return v != 0;
    if (v is String) {
      final s = v.trim().toLowerCase();
      if (s == 'true' || s == '1') return true;
      if (s == 'false' || s == '0') return false;
    }
    return dflt;
  }

  static double _asDouble(Object? v, double dflt) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v.trim()) ?? dflt;
    return dflt;
  }

  static int _asInt(Object? v, int dflt) {
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v.trim()) ?? dflt;
    return dflt;
  }
}

class SpeechSettingsNotifier extends StateNotifier<SpeechSettings> {
  SpeechSettingsNotifier() : super(const SpeechSettings()) {
    _load();
  }

  static const String _k = 'speech_settings_v1';
  SharedPreferences? _prefs;

  Future<void> _load() async {
    try {
      final p = await SharedPreferences.getInstance();
      _prefs = p;
      final raw = p.getString(_k);
      if (raw == null || raw.isEmpty) return;
      final map = <String, Object?>{};
      // 手记 KV（与仓库内其它 prefs 用法同风格，避免引 json 依赖）
      for (final part in raw.split(';')) {
        final i = part.indexOf('=');
        if (i > 0) map[part.substring(0, i)] = part.substring(i + 1);
      }
      state = SpeechSettings.fromMap(map);
    } catch (_) {}
  }

  Future<void> _save() async {
    try {
      final p = _prefs ?? await SharedPreferences.getInstance();
      _prefs = p;
      await p.setString(
          _k, state.toMap().entries.map((e) => '${e.key}=${e.value}').join(';'));
    } catch (_) {}
  }

  Future<void> setEngine(AsrEngineKind v) async {
    state = state.copyWith(asrEngine: v);
    await _save();
  }

  Future<void> setAutoSpeak(bool v) async {
    state = state.copyWith(autoSpeak: v);
    await _save();
  }

  Future<void> setSpeakRate(double v) async {
    state = state.copyWith(speakRate: v.clamp(0.6, 1.6));
    await _save();
  }

  Future<void> setSpeakerId(int v) async {
    state = state.copyWith(speakerId: v < 0 ? 0 : v);
    await _save();
  }

  Future<void> setFallbackToServer(bool v) async {
    state = state.copyWith(fallbackToServer: v);
    await _save();
  }
}

final speechSettingsProvider =
    StateNotifierProvider<SpeechSettingsNotifier, SpeechSettings>(
        (ref) => SpeechSettingsNotifier());
