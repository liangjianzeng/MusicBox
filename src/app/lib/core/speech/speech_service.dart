/// 语音编排层：档位选择 + 端侧/在线降级 + 播报与音乐播放的焦点协调。
///
/// 三条诚实纪律：
/// 1. **降级要看得见**：`resolveEngine()` 返回「实际用的档位 + 为什么换档」，
///    UI 必须把换档原因显示出来，不许静默换；
/// 2. **不编数据**：端侧即时档给不出情绪就是 null，不拿默认值糊；
/// 3. **失败要能说清**：`speak()` 返回 null 表示成功，否则返回可直接上屏的原因。
library;

import 'dart:async';
import 'dart:io';

import 'package:edge_tts/edge_tts.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'asr_engine.dart';
import 'sherpa_asr.dart';
import 'speech_model_manager.dart';
import 'speech_settings.dart';
import 'tts_engine.dart';
import 'wav_util.dart';

/// 实际生效的识别档位与换档原因。
class ResolvedEngine {
  const ResolvedEngine(this.engine, {this.reason, this.modelMissing = false});
  final AsrEngineKind engine;
  final String? reason;

  /// 模型没就位（设置页可一键下载）
  final bool modelMissing;

  bool get onDevice => engine != AsrEngineKind.server;
}

/// 歌曲播放器协调钩子（由 UI 层注入，core 不反向依赖 features）。
class SpeechCoordination {
  const SpeechCoordination({
    required this.isPlaying,
    required this.pause,
    required this.resume,
  });

  final bool Function() isPlaying;
  final Future<void> Function() pause;
  final Future<void> Function() resume;
}

class SpeechService {
  SpeechService(this._ref);

  final Ref _ref;
  AudioPlayer? _voicePlayer; // 助手播报专用，不碰歌曲播放器
  int _speakSeq = 0;
  bool _speaking = false;

  bool get speaking => _speaking;

  SpeechSettings get _settings => _ref.read(speechSettingsProvider);

  // ---------------- 档位解析 ----------------

  SpeechModel _modelFor(AsrEngineKind k) => switch (k) {
        AsrEngineKind.streamingZipformer => SpeechModel.asrStreaming,
        AsrEngineKind.senseVoiceOffline => SpeechModel.asrSenseVoice,
        AsrEngineKind.server => SpeechModel.asrStreaming,
      };

  /// 用户选的档位 + 现实（模型是否就位）→ 实际档位。
  Future<ResolvedEngine> resolveEngine() async {
    final want = _settings.asrEngine;
    if (want == AsrEngineKind.server) {
      return const ResolvedEngine(AsrEngineKind.server);
    }
    final ready = await SpeechModelManager.isReady(_modelFor(want));
    if (ready) return ResolvedEngine(want);
    if (!_settings.fallbackToServer) {
      return ResolvedEngine(want,
          reason: '语音模型还没下载', modelMissing: true);
    }
    // 端侧模型没就位：允许回落服务端，但原因必须上屏
    return const ResolvedEngine(
      AsrEngineKind.server,
      reason: '本机语音模型还没下载，这次改由服务端识别',
      modelMissing: true,
    );
  }

  /// 建一个识别会话；服务端档返回 null（调用方走上传线）。
  Future<StreamingAsrSession?> createSession({String? saveWavPath}) async {
    final r = await resolveEngine();
    if (!r.onDevice) return null;
    final dir = await SpeechModelManager.dirOf(_modelFor(r.engine));
    return SherpaAsrSession(
      mode: r.engine,
      modelDir: dir,
      saveWavPath: saveWavPath,
    );
  }

  /// 预热（App 启动后 fire-and-forget）：识别器 + 声库各加载一次，首次秒开。
  ///
  /// 必须先确认模型真的在盘上再加载：只看档位不看文件，会让没下过模型的设备
  /// 每次启动都白起一个 worker isolate 并让原生层报模型校验告警（真机 logcat 实录）。
  Future<void> warmup() async {
    try {
      final s = _settings;
      final sd = await SpeechModelManager.dirOf(SpeechModel.asrStreaming);
      final vd = await SpeechModelManager.dirOf(SpeechModel.asrSenseVoice);
      final useStreaming = s.asrEngine == AsrEngineKind.streamingZipformer &&
          await SpeechModelManager.isReady(SpeechModel.asrStreaming);
      final useSenseVoice = s.asrEngine == AsrEngineKind.senseVoiceOffline &&
          await SpeechModelManager.isReady(SpeechModel.asrSenseVoice);
      if (useStreaming || useSenseVoice) {
        await SherpaAsrSession.warmup(
          useStreaming: useStreaming,
          useSenseVoice: useSenseVoice,
          streamingDir: sd,
          senseVoiceDir: vd,
        );
      }
      final td = await SpeechModelManager.dirOf(SpeechModel.ttsZh);
      if (s.autoSpeak && SherpaTtsEngine.layoutOk(td)) {
        await SherpaTtsEngine.prewarm(td);
      }
    } catch (_) {}
  }

  // ---------------- 播报 ----------------

  /// 朗读一段文本。返回 null = 成功；否则返回可直接上屏的失败原因。
  ///
  /// 路由：端侧中文声库 → 失败/未就位则在线朗读。播报期间暂停歌曲，
  /// 播完恢复（只在播报前确实在播的情况下才恢复，不擅自起播）。
  Future<String?> speak(String text, {SpeechCoordination? coordination}) async {
    final t = text.trim();
    if (t.isEmpty) return null;
    final seq = ++_speakSeq;
    final wasPlaying = coordination?.isPlaying() ?? false;
    final parts = _splitForSpeech(t);
    if (wasPlaying) await coordination?.pause();
    _speaking = true;
    String? failure;
    try {
      for (final seg in parts) {
        if (seq != _speakSeq) return null; // 被新的播报/停止取代
        final err = await _speakOne(seg);
        if (err != null) {
          failure = err;
          break;
        }
      }
    } finally {
      _speaking = false;
      if (wasPlaying) await coordination?.resume();
    }
    return failure;
  }

  Future<void> stopSpeak() async {
    _speakSeq++;
    _speaking = false;
    try {
      await _voicePlayer?.stop();
    } catch (_) {}
  }

  /// 单句：先端侧，再在线。两条都不成才报失败。
  Future<String?> _speakOne(String text) async {
    final dir = await SpeechModelManager.dirOf(SpeechModel.ttsZh);
    if (SherpaTtsEngine.layoutOk(dir)) {
      final pcm = await SherpaTtsEngine.synth(dir, text,
          speakerId: _settings.speakerId, speed: _settings.speakRate);
      if (pcm != null && pcm.pcm16.isNotEmpty) {
        return _playBytes(
            wrapWav(pcm.pcm16, pcm.sampleRate), '.wav', 'voice');
      }
      debugPrint('[speech] 端侧合成没出声，转在线朗读');
    }
    try {
      final bytes = await Communicate(
        text: text,
        voice: _onlineVoice,
        rate: _rateParam(_settings.speakRate),
      ).toBytes();
      if (bytes.isEmpty) return '在线朗读没返回音频';
      return _playBytes(bytes, '.mp3', 'net');
    } catch (e) {
      return '本机声库未就位，在线朗读也没连上（$e）';
    }
  }

  Future<String?> _playBytes(
      List<int> bytes, String ext, String prefix) async {
    try {
      final tmp = await getTemporaryDirectory();
      final dir = Directory(p.join(tmp.path, 'voice'));
      if (!await dir.exists()) await dir.create(recursive: true);
      final f = File(p.join(dir.path, '$prefix-${DateTime.now().microsecondsSinceEpoch}$ext'));
      await f.writeAsBytes(bytes, flush: true);
      final player = _voicePlayer ??= AudioPlayer();
      await player.setFilePath(f.path);
      final completer = Completer<void>();
      late StreamSubscription<dynamic> sub;
      sub = player.playerStateStream.listen((s) {
        if (s.processingState == ProcessingState.completed &&
            !completer.isCompleted) {
          completer.complete();
        }
      });
      await player.play().then((_) async {
        // play() 在该句播完后 resolve；兜住 completed 事件漏掉的情况
        if (!completer.isCompleted) completer.complete();
      });
      await completer.future
          .timeout(const Duration(seconds: 120), onTimeout: () {});
      await sub.cancel();
      try {
        await f.delete();
      } catch (_) {}
      return null;
    } catch (e) {
      return '播不出来：$e';
    }
  }

  /// 在线朗读音色（中文女声）。**UI 不出现这个名字，也不出现厂商名**。
  static const String _onlineVoice = 'zh-CN-XiaoxiaoNeural';

  /// 倍率 → 在线接口的 `+N%` 形态
  static String _rateParam(double rate) {
    final pct = ((rate - 1.0) * 100).round();
    return '${pct >= 0 ? '+' : '-'}${pct.abs()}%';
  }

  /// 长文本按句切，单句上限 180 字（端侧一次性合成太长会明显卡顿）
  static List<String> _splitForSpeech(String t) {
    final out = <String>[];
    final buf = StringBuffer();
    void flush() {
      final s = buf.toString().trim();
      if (s.isNotEmpty) out.add(s);
      buf.clear();
    }

    for (final r in t.runes) {
      buf.writeCharCode(r);
      final ch = String.fromCharCode(r);
      final needFlush = '。！？!?；;\n'.contains(ch) && buf.length >= 24 ||
          buf.length >= 180;
      if (needFlush) flush();
    }
    flush();
    return out.isEmpty ? [t] : out;
  }

  // ---------------- 与歌曲播放器的协调：见 SpeechCoordination（由 UI 注入） ----------------

  Future<void> dispose() async {
    _speakSeq++;
    try {
      await _voicePlayer?.dispose();
    } catch (_) {}
    _voicePlayer = null;
    await SherpaAsrSession.shutdown();
    await SherpaTtsEngine.release();
  }
}

final speechServiceProvider =
    Provider<SpeechService>((ref) => SpeechService(ref));
