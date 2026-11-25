/// 端侧识别引擎：常驻 worker isolate + `record` PCM 流喂 sherpa-onnx。
///
/// 结构从 TongYi-Lite（MIT）同名实现移植并改造，保留它踩出来的三条硬纪律：
/// 1. **识别器必须长在 worker isolate**：FFI 指针不能跨 isolate，而 `record`
///    的平台通道只能在主 isolate 消费 → 主 isolate 录音，`TransferableTypedData`
///    零拷贝转 PCM 给 worker 解码；早期在主 isolate 加载模型会让首次长按卡死 UI 数秒。
/// 2. **每个用 FFI 的 isolate 都要 `initBindings()`**，否则 "Please initialize
///    sherpa-onnx first"。
/// 3. **OnlineStream / OfflineRecognizer 都要手动 free**，漏了就是几十 MB 常驻。
///
/// 另补 TongYi-Lite 没有的两件事：松手早于 start 完成的孤儿会话收敛；
/// PCM 同时累积成 WAV 落盘，供「上传服务端兜底」与「整段精听」复用，不必二次录音。
library;

import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:record/record.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import 'asr_engine.dart';
import 'wav_util.dart';

/// 一次「按住说话」的会话。`mode` 决定即时档（流式喂）还是精听档（攒完整段再解）。
class SherpaAsrSession implements StreamingAsrSession {
  SherpaAsrSession({
    required this.mode,
    required this.modelDir,
    this.saveWavPath,
  });

  final AsrEngineKind mode;
  final String modelDir;

  /// 非空时把本次录音落成 WAV（16k mono PCM16），供上传/精听复用
  final String? saveWavPath;

  static _SherpaWorker? _worker;

  static Future<_SherpaWorker> _requireWorker() async {
    var w = _worker;
    if (w == null) {
      w = _SherpaWorker();
      _worker = w;
      await w.spawn();
    }
    return w;
  }

  /// 预热：模型页拉进 OS 页缓存 + worker 里预加载识别器（秒开）。失败静默。
  static Future<void> warmup({
    bool useStreaming = true,
    bool useSenseVoice = false,
    String? streamingDir,
    String? senseVoiceDir,
  }) async {
    try {
      if (useStreaming && streamingDir != null) {
        await _requireWorker();
        await Isolate.run(() => _preload(
            streamingDir, const ['tokens.txt', 'joiner.int8.onnx', 'decoder.onnx', 'encoder.int8.onnx']));
        await (_worker!.loadStreaming(streamingDir));
      }
      if (useSenseVoice && senseVoiceDir != null) {
        await _requireWorker();
        await Isolate.run(() =>
            _preload(senseVoiceDir, const ['tokens.txt', 'model.int8.onnx']));
        await (_worker!.loadSenseVoice(senseVoiceDir));
      }
      debugPrint('[speech] 预热完成');
    } catch (e) {
      debugPrint('[speech] 预热跳过: $e');
    }
  }

  static Future<void> shutdown() async {
    _worker?.kill();
    _worker = null;
  }

  static void _preload(String dir, List<String> files) {
    for (final f in files) {
      final file = File(p.join(dir, f));
      if (!file.existsSync()) continue;
      try {
        final raf = file.openSync();
        try {
          while (raf.readSync(1 << 20).isNotEmpty) {} // 每次 1MB 读到 EOF
        } finally {
          raf.closeSync();
        }
      } catch (_) {}
    }
  }

  // ---------- 会话状态 ----------
  final AudioRecorder _rec = AudioRecorder();
  StreamSubscription<Uint8List>? _pcmSub;
  StreamSubscription<String>? _partialSub;
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  final StreamController<String> _partial = StreamController<String>.broadcast();
  _SherpaWorker? _w;
  bool _started = false;
  bool _cancelRequested = false;

  @override
  Stream<String> get partialText => _partial.stream;

  @override
  Future<void> start() async {
    if (_started) return;
    if (!await _rec.hasPermission()) {
      throw const SpeechPermissionException('没有麦克风权限，请在系统设置里允许录音');
    }
    final w = await _requireWorker();
    _w = w;
    if (mode == AsrEngineKind.senseVoiceOffline) {
      await w.loadSenseVoice(modelDir);
    } else {
      await w.loadStreaming(modelDir);
      _partialSub = w.partials.listen(_partial.add);
      await w.startSession();
    }
    if (_cancelRequested) {
      // start 期间用户已松手：当场收尾，不留孤儿会话（浮层滞留 + 麦克风常开）
      await cancel();
      return;
    }
    final stream = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      autoGain: true,
      echoCancel: true,
      noiseSuppress: true,
    ));
    _pcmSub = stream.listen(
      (bytes) {
        if (bytes.isEmpty) return;
        _pcm.add(bytes);
        if (mode == AsrEngineKind.streamingZipformer) w.feedAudio(bytes);
      },
      onError: (Object e) => debugPrint('[speech] pcm 流异常: $e'),
      cancelOnError: false,
    );
    _started = true;
  }

  @override
  Future<AsrOutcome> stop() async {
    final w = _w;
    await _pcmSub?.cancel();
    _pcmSub = null;
    await _partialSub?.cancel();
    _partialSub = null;
    try {
      await _rec.stop();
    } catch (_) {}
    _started = false;
    final pcm = _pcm.takeBytes();
    if (pcm.length < 16000 * 2 * 0.4) {
      await w?.discard();
      return AsrOutcome.empty.copyWith(
          engineLabel: _label(), error: '说得太短啦，按住多说几个字');
    }
    final dur = pcm16DurationSec(pcm.length);
    if (saveWavPath != null) {
      try {
        final f = File(saveWavPath!);
        await f.parent.create(recursive: true);
        await f.writeAsBytes(wrapWav(pcm, 16000), flush: true);
      } catch (e) {
        debugPrint('[speech] WAV 落盘失败: $e');
      }
    }
    if (w == null) {
      return AsrOutcome.empty
          .copyWith(engineLabel: _label(), error: '语音引擎未就绪');
    }
    try {
      if (mode == AsrEngineKind.senseVoiceOffline) {
        final r = await w.offline(pcm);
        final text = (r?['text'] as String? ?? '').trim();
        if (text.isEmpty) {
          return AsrOutcome.empty.copyWith(
              engineLabel: _label(), durationSec: dur, error: '没听清，再说一遍');
        }
        final emo = (r?['emotion'] as String? ?? '').trim();
        return AsrOutcome(
          text: text,
          source: AsrSource.onDeviceOffline,
          emotion: emo.isEmpty ? null : emo,
          events: ((r?['event'] as String? ?? ''))
              .split(RegExp(r'[,，/]'))
              .map((e) => e.trim().toLowerCase())
              .where((e) => e.isNotEmpty)
              .toList(),
          durationSec: dur,
          timestamps: ((r?['timestamps'] as List?) ?? const [])
              .whereType<num>()
              .map((e) => e.toDouble())
              .toList(),
          engineLabel: _label(),
        );
      }
      final text = await w.stopSession();
      if (text.trim().isEmpty) {
        return AsrOutcome.empty.copyWith(
            engineLabel: _label(), durationSec: dur, error: '没听清，再说一遍');
      }
      return AsrOutcome(
        text: text.trim(),
        source: AsrSource.onDeviceStreaming,
        durationSec: dur,
        engineLabel: _label(),
      );
    } catch (e) {
      return AsrOutcome.empty.copyWith(engineLabel: _label(), error: e.toString());
    }
  }

  @override
  Future<void> cancel() async {
    _cancelRequested = true;
    await _pcmSub?.cancel();
    _pcmSub = null;
    await _partialSub?.cancel();
    _partialSub = null;
    try {
      await _rec.cancel();
    } catch (_) {}
    await _w?.discard();
    _pcm.clear();
    _started = false;
  }

  @override
  Future<void> dispose() async {
    await cancel();
    if (!_partial.isClosed) _partial.close();
    _rec.dispose();
  }

  String _label() =>
      mode == AsrEngineKind.senseVoiceOffline ? '端侧·精听' : '端侧·即时';
}

class SpeechPermissionException implements Exception {
  const SpeechPermissionException(this.message);
  final String message;
  @override
  String toString() => message;
}

// ======================= worker isolate =======================

/// 主 isolate 侧的 worker 句柄：命令走 SendPort，回执/partial 走常驻 ReceivePort。
class _SherpaWorker {
  Isolate? _iso;
  ReceivePort? _rx;
  ReceivePort? _handRx;
  SendPort? _toWorker;
  final Map<int, Completer<Object?>> _pending = {};
  final StreamController<String> _partials = StreamController<String>.broadcast();
  int _seq = 0;
  bool _alive = false;

  Stream<String> get partials => _partials.stream;

  Future<void> spawn() async {
    if (_alive) return;
    final rx = ReceivePort();
    final handRx = ReceivePort();
    rx.listen((msg) {
      if (msg is! Map) return;
      if (msg.containsKey('partial')) {
        _partials.add('${msg['partial']}');
        return;
      }
      final id = msg['id'];
      if (id is int) {
        final c = _pending.remove(id);
        if (c == null || c.isCompleted) return;
        if (msg['error'] != null) {
          c.completeError(StateError('${msg['error']}'));
        } else {
          c.complete(msg['v']);
        }
      }
    });
    _rx = rx;
    _handRx = handRx;
    _iso = await Isolate.spawn(_workerMain, [rx.sendPort, handRx.sendPort],
        errorsAreFatal: false, debugName: 'speech-worker');
    final sp = await handRx.first.timeout(const Duration(seconds: 20),
        onTimeout: () => throw StateError('语音引擎启动超时'));
    if (sp is! SendPort) throw StateError('语音引擎握手失败');
    _toWorker = sp;
    _alive = true;
  }

  /// 关 worker（删除模型/退出时回收，避免 isolate 与常驻内存泄漏）
  void kill() {
    try {
      _toWorker?.send({'id': 0, 'cmd': 'exit'});
    } catch (_) {}
    try {
      _iso?.kill(priority: Isolate.beforeNextEvent);
    } catch (_) {}
    try {
      _rx?.close();
    } catch (_) {}
    try {
      _handRx?.close();
    } catch (_) {}
    for (final c in _pending.values) {
      if (!c.isCompleted) c.completeError(StateError('语音引擎已关闭'));
    }
    _pending.clear();
    _iso = null;
    _rx = null;
    _handRx = null;
    _toWorker = null;
    _alive = false;
  }

  Future<T> _call<T>(String cmd,
      {Object? payload,
      TransferableTypedData? blob,
      Duration timeout = const Duration(seconds: 120)}) async {
    await spawn();
    final sp = _toWorker;
    if (sp == null) throw StateError('语音引擎未就绪');
    final id = ++_seq;
    final c = Completer<Object?>();
    _pending[id] = c;
    sp.send({'id': id, 'cmd': cmd, 'p': payload, 'blob': blob});
    final v = await c.future
        .timeout(timeout, onTimeout: () => throw TimeoutException('语音引擎响应超时'));
    return v as T;
  }

  void _fire(String cmd, {Object? payload, TransferableTypedData? blob}) {
    _toWorker?.send({'id': 0, 'cmd': cmd, 'p': payload, 'blob': blob});
  }

  void feedAudio(Uint8List pcm) =>
      _fire('audio', blob: TransferableTypedData.fromList([pcm]));

  Future<void> startSession() => _call<void>('start', timeout: const Duration(seconds: 30));
  Future<String> stopSession() => _call<String>('stop', timeout: const Duration(seconds: 60));
  Future<void> discard() => _call<void>('discard', timeout: const Duration(seconds: 10));
  Future<void> loadStreaming(String dir) =>
      _call<void>('loadStreaming', payload: dir, timeout: const Duration(seconds: 240));
  Future<void> loadSenseVoice(String dir) =>
      _call<void>('loadSenseVoice', payload: dir, timeout: const Duration(seconds: 300));
  Future<Map?> offline(Uint8List pcm) => _call<Map?>('offline',
      blob: TransferableTypedData.fromList([pcm]), timeout: const Duration(seconds: 180));
}

void _workerMain(List<Object?> args) {
  final replyPort = args[0] as SendPort;
  final handPort = args[1] as SendPort;
  final incoming = ReceivePort();
  final ctx = _Ctx(onPartial: (t) => replyPort.send({'partial': t}));
  handPort.send(incoming.sendPort);

  incoming.listen((msg) async {
    if (msg is! Map) return;
    final id = msg['id'] as int? ?? 0;
    final cmd = msg['cmd'] as String? ?? '';
    Object? v;
    String? err;
    try {
      switch (cmd) {
        case 'loadStreaming':
          ctx.loadStreaming(msg['p'] as String);
        case 'loadSenseVoice':
          ctx.loadSenseVoice(msg['p'] as String);
        case 'start':
          ctx.start();
        case 'audio':
          final b = (msg['blob'] as TransferableTypedData).materialize().asUint8List();
          ctx.feed(b);
          return; // 喂数据不回执
        case 'stop':
          v = ctx.stop();
        case 'offline':
          final b = (msg['blob'] as TransferableTypedData).materialize().asUint8List();
          v = ctx.offline(b);
        case 'discard':
          ctx.discard();
        case 'exit':
          ctx.dispose();
          incoming.close();
          return;
      }
    } catch (e, s) {
      // worker 内异常就地捕获回传：引擎失败不能杀死 App
      err = e.toString();
      debugPrint('[speech] worker 异常: $e\n$s');
    }
    if (id != 0) replyPort.send({'id': id, 'v': v, 'error': err});
  });
}

/// worker isolate 内部：两套引擎 + 当前流式会话状态（全部手动 free）。
class _Ctx {
  _Ctx({required this.onPartial});
  final void Function(String) onPartial;

  sherpa.OnlineRecognizer? online;
  String? onlineSig;
  sherpa.OfflineRecognizer? offlineRec;
  String? offlineSig;
  sherpa.OnlineStream? stream;
  final StringBuffer settled = StringBuffer();

  void loadStreaming(String dir) {
    final sig = 'S:$dir';
    if (online != null && onlineSig == sig) return;
    sherpa.initBindings();
    stream?.free();
    stream = null;
    settled.clear();
    online?.free();
    online = sherpa.OnlineRecognizer(sherpa.OnlineRecognizerConfig(
      model: sherpa.OnlineModelConfig(
        transducer: sherpa.OnlineTransducerModelConfig(
          encoder: p.join(dir, 'encoder.int8.onnx'),
          decoder: p.join(dir, 'decoder.onnx'),
          joiner: p.join(dir, 'joiner.int8.onnx'),
        ),
        tokens: p.join(dir, 'tokens.txt'),
        // 空串会让 EncodeHotwords 直接失败（1.13.8 实测坑）
        modelingUnit: 'cjkchar',
        numThreads: 2,
        provider: 'cpu',
        debug: false,
      ),
      decodingMethod: 'greedy_search',
      maxActivePaths: 8,
      blankPenalty: 0.0,
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    ));
    onlineSig = sig;
  }

  void loadSenseVoice(String dir) {
    final sig = 'V:$dir';
    if (offlineRec != null && offlineSig == sig) return;
    sherpa.initBindings();
    offlineRec?.free();
    offlineRec = sherpa.OfflineRecognizer(sherpa.OfflineRecognizerConfig(
      model: sherpa.OfflineModelConfig(
        senseVoice: sherpa.OfflineSenseVoiceModelConfig(
          model: p.join(dir, 'model.int8.onnx'),
          language: '', // auto：中英粤混说都试
          useInverseTextNormalization: true,
        ),
        tokens: p.join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: false,
      ),
    ));
    offlineSig = sig;
  }

  void start() {
    final rec = online;
    if (rec == null) throw StateError('识别器未加载');
    stream?.free();
    settled.clear();
    stream = rec.createStream();
  }

  void feed(Uint8List pcm) {
    final rec = online;
    final st = stream;
    if (rec == null || st == null) return;
    st.acceptWaveform(samples: pcm16ToFloat32(pcm), sampleRate: 16000);
    _drain(rec, st);
    final text = '${settled.toString()}${rec.getResult(st).text}';
    if (rec.isEndpoint(st)) {
      // 静音断句：定稿进 settled 并重置流，继续听下一句
      final seg = rec.getResult(st).text.trim();
      if (seg.isNotEmpty) settled.write(seg);
      rec.reset(st);
    }
    onPartial(text.trim());
  }

  void _drain(sherpa.OnlineRecognizer rec, sherpa.OnlineStream st) {
    var guard = 0;
    while (rec.isReady(st) && guard++ < 10000) {
      rec.decode(st);
    }
  }

  String stop() {
    final rec = online;
    final st = stream;
    if (rec == null || st == null) return settled.toString().trim();
    st.inputFinished();
    _drain(rec, st);
    final full = '${settled.toString()}${rec.getResult(st).text}'.trim();
    st.free();
    stream = null;
    settled.clear();
    return full;
  }

  Map? offline(Uint8List pcm16) {
    final rec = offlineRec;
    if (rec == null) throw StateError('精听引擎未加载');
    final st = rec.createStream();
    try {
      st.acceptWaveform(samples: pcm16ToFloat32(pcm16), sampleRate: 16000);
      rec.decode(st);
      final r = rec.getResult(st);
      return {
        'text': r.text,
        'emotion': r.emotion,
        'event': r.event,
        'timestamps': r.timestamps,
      };
    } finally {
      st.free();
    }
  }

  void discard() {
    stream?.free();
    stream = null;
    settled.clear();
  }

  void dispose() {
    stream?.free();
    online?.free();
    offlineRec?.free();
    stream = null;
    online = null;
    offlineRec = null;
  }
}
