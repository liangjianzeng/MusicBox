/// 端侧语音识别抽象层（三档可配置切换）。
///
/// 纪律：
/// · 引擎型号名（SenseVoice / Zipformer / sherpa-onnx…）**不得进入任何 UI 字符串**，
///   只出现在设置页的「能力」描述里（与 models.dart 的 gen.engine 纪律同源）；
/// · 引擎给不出的东西（情绪/事件/时间戳）一律 null，**绝不编**；
///   哪来的就标哪来：[AsrOutcome.source] 记录实际出处，UI 据此诚实标注。
library;

/// 识别引擎档位（设置页可切换，见 core/speech/speech_settings.dart）。
enum AsrEngineKind {
  /// 端侧流式：边说边出字（无标点、无情绪/事件）。默认档。
  streamingZipformer,

  /// 端侧整段：松手后一次推理，带情绪 + 音频事件 + 时间戳。
  senseVoiceOffline,

  /// 不端侧识别：把音频上传服务端，走服务端语音识别 + 意图理解线。
  /// 低端机 / 模型未下载 / 端侧失败时的兜底。
  server,
}

/// 识别结果出处（UI 诚实标注用）。
enum AsrSource {
  /// 端侧流式给出（只有文本）
  onDeviceStreaming,

  /// 端侧整段给出（文本 + 情绪 + 事件）
  onDeviceOffline,

  /// 服务端给出
  server,

  /// 谁都没给出来（超时/静音/引擎不可用）
  none,
}

/// 一次识别的产物。字段口径与服务端契约
/// `{text, emotion, events[], duration}`（CONTRACTS.md §4）逐字对齐，
/// 便于端侧结果直接顶替服务端 ASR 观测字段。
class AsrOutcome {
  const AsrOutcome({
    required this.text,
    required this.source,
    this.emotion,
    this.events = const [],
    this.durationSec,
    this.timestamps = const [],
    this.engineLabel,
    this.error,
  });

  /// 空结果（诚实占位，不当成功用）
  static const empty =
      AsrOutcome(text: '', source: AsrSource.none, error: '没有识别到内容');

  final String text;
  final AsrSource source;

  /// 端侧整段/服务端才有；流式档恒为 null（模型不给，不编）
  final String? emotion;

  /// 音频事件（bgm/applause/laughtery/…），同上：不给就空
  final List<String> events;

  final double? durationSec;

  /// 逐 token 时间戳（秒），仅整段档给；对齐字幕/口型用
  final List<double> timestamps;

  /// 人类可读的引擎档位描述（**不含型号名**），如「端侧·即时」「端侧·精听」「服务端」
  final String? engineLabel;

  /// 失败原因（不吞栈，UI 可原样呈现）
  final String? error;

  bool get hasText => text.trim().isNotEmpty;
  bool get ok => hasText && error == null;

  /// 契约形态：喂给意图编译/服务端落库用
  Map<String, dynamic> toContractJson() => {
        'text': text,
        if (emotion != null && emotion!.isNotEmpty) 'emotion': emotion,
        if (events.isNotEmpty) 'events': events,
        if (durationSec != null) 'duration': durationSec,
      };

  AsrOutcome copyWith({String? error, String? engineLabel, double? durationSec}) =>
      AsrOutcome(
        text: text,
        source: source,
        emotion: emotion,
        events: events,
        durationSec: durationSec ?? this.durationSec,
        timestamps: timestamps,
        engineLabel: engineLabel ?? this.engineLabel,
        error: error ?? this.error,
      );

  @override
  String toString() =>
      'AsrOutcome(len=${text.length}, source=${source.name}, emotion=$emotion, '
      'events=${events.length}, dur=$durationSec, err=$error)';
}

/// 流式会话（一次「按住说话」一个实例）。
abstract interface class StreamingAsrSession {
  /// 实时转写（已定稿片段 + 当前未完成片段）
  Stream<String> get partialText;

  /// 开始录制 + 识别（首次可能加载模型，数秒；调用方必须容忍期间用户已松手）
  Future<void> start();

  /// 结束并返回终稿（同时把录到的 PCM 落一份 WAV，供上传/整段精听复用）
  Future<AsrOutcome> stop();

  /// 放弃本次会话（异常路径清理，麦克风必须归还）
  Future<void> cancel();

  Future<void> dispose();
}
