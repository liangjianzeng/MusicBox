/// 端侧朗读（TTS）：sherpa-onnx OfflineTts，跑在独立 worker isolate。
///
/// 为什么也放 worker：`OfflineTts.generate()` 是阻塞 FFI，首次加载声库是秒级，
/// 放主 isolate 会直接卡住列表滚动与按钮响应（TongYi-Lite 的已知取舍与出路）。
///
/// 采样率跟着结果走：不同声库 16k/22.05k 不一样，拿引擎级常量拼 WAV 头会变调。
library;

import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

/// 一次合成的产物：PCM16 + 真实采样率（来自合成结果，不是引擎常量）。
class TtsPcm {
  const TtsPcm(this.pcm16, this.sampleRate);
  final Uint8List pcm16;
  final int sampleRate;
  double get durationSec => sampleRate <= 0 ? 0 : (pcm16.length ~/ 2) / sampleRate;
}

class SherpaTtsEngine {
  SherpaTtsEngine._();

  static _TtsWorker? _w;

  static Future<_TtsWorker> _require() async {
    var w = _w;
    if (w == null) {
      w = _TtsWorker();
      _w = w;
      await w.spawn();
    }
    return w;
  }

  /// 中文声库必须有 model.onnx + tokens.txt + lexicon.txt + dict/；
  /// 缺件直接判不可用（硬跑会念错甚至崩），由调用方决定回落或提示。
  static bool layoutOk(String dir) {
    try {
      bool f(String n) => File(p.join(dir, n)).existsSync();
      bool d(String n) => Directory(p.join(dir, n)).existsSync();
      return f('model.onnx') && f('tokens.txt') && f('lexicon.txt') && d('dict');
    } catch (_) {
      return false;
    }
  }

  /// 预热：加载声库（秒级），让第一条播报不再干等。失败静默。
  static Future<void> prewarm(String modelDir, {int numThreads = 2}) async {
    if (!layoutOk(modelDir)) return;
    try {
      final w = await _require();
      await w.load(modelDir, numThreads: numThreads);
      debugPrint('[speech] 声库预热完成');
    } catch (e) {
      debugPrint('[speech] 声库预热跳过: $e');
    }
  }

  /// 合成一段文本。返回 null = 没成（调用方决定回落在线朗读还是诚实提示）。
  static Future<TtsPcm?> synth(
    String modelDir,
    String text, {
    int speakerId = 0,
    double speed = 1.0,
    int numThreads = 2,
  }) async {
    final t = text.trim();
    if (t.isEmpty || !layoutOk(modelDir)) return null;
    try {
      final w = await _require();
      await w.load(modelDir, numThreads: numThreads);
      return await w.synth(t, sid: speakerId, speed: speed);
    } catch (e) {
      debugPrint('[speech] 端侧合成失败: $e');
      return null;
    }
  }

  /// 释放原生资源与 worker（设置页删除声库时用；漏 free 就是几十 MB 常驻）
  static Future<void> release() async {
    try {
      await _w?.unload();
    } catch (_) {}
    _w?.kill();
    _w = null;
  }
}

// ======================= worker isolate =======================

class _TtsWorker {
  Isolate? _iso;
  ReceivePort? _rx;
  ReceivePort? _handRx;
  SendPort? _toWorker;
  final Map<int, Completer<Object?>> _pending = {};
  int _seq = 0;
  bool _alive = false;

  Future<void> spawn() async {
    if (_alive) return;
    final rx = ReceivePort();
    final handRx = ReceivePort();
    rx.listen((msg) {
      if (msg is! Map) return;
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
    _iso = await Isolate.spawn(_ttsMain, [rx.sendPort, handRx.sendPort],
        errorsAreFatal: false, debugName: 'speech-tts');
    final sp = await handRx.first.timeout(const Duration(seconds: 20),
        onTimeout: () => throw StateError('朗读引擎启动超时'));
    if (sp is! SendPort) throw StateError('朗读引擎握手失败');
    _toWorker = sp;
    _alive = true;
  }

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
      if (!c.isCompleted) c.completeError(StateError('朗读引擎已关闭'));
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
      Duration timeout = const Duration(seconds: 120)}) async {
    await spawn();
    final sp = _toWorker;
    if (sp == null) throw StateError('朗读引擎未就绪');
    final id = ++_seq;
    final c = Completer<Object?>();
    _pending[id] = c;
    sp.send({'id': id, 'cmd': cmd, 'p': payload});
    final v = await c.future.timeout(timeout,
        onTimeout: () => throw TimeoutException('朗读引擎响应超时'));
    return v as T;
  }

  Future<void> load(String dir, {int numThreads = 2}) => _call<void>('load',
      payload: {'dir': dir, 'threads': numThreads},
      timeout: const Duration(seconds: 300));

  Future<TtsPcm?> synth(String text,
      {required int sid, required double speed}) async {
    final r = await _call<List<Object?>?>('synth',
        payload: {'text': text, 'sid': sid, 'speed': speed},
        timeout: const Duration(seconds: 120));
    if (r == null) return null;
    return TtsPcm(r[0] as Uint8List, r[1] as int);
  }

  Future<void> unload() =>
      _call<void>('unload', timeout: const Duration(seconds: 20));
}

void _ttsMain(List<Object?> args) {
  final replyPort = args[0] as SendPort;
  final handPort = args[1] as SendPort;
  final incoming = ReceivePort();
  sherpa.OfflineTts? tts;
  String? sig;
  handPort.send(incoming.sendPort);

  incoming.listen((msg) async {
    if (msg is! Map) return;
    final id = msg['id'] as int? ?? 0;
    final cmd = msg['cmd'] as String? ?? '';
    Object? v;
    String? err;
    try {
      switch (cmd) {
        case 'load':
          final p0 = msg['p'] as Map;
          final dir = p0['dir'] as String;
          final threads = p0['threads'] as int;
          final s = 'T:$dir:$threads';
          if (tts == null || sig != s) {
            sherpa.initBindings();
            tts?.free();
            tts = sherpa.OfflineTts(sherpa.OfflineTtsConfig(
              model: sherpa.OfflineTtsModelConfig(
                vits: sherpa.OfflineTtsVitsModelConfig(
                  model: p.join(dir, 'model.onnx'),
                  tokens: p.join(dir, 'tokens.txt'),
                  lexicon: p.join(dir, 'lexicon.txt'),
                  dictDir: p.join(dir, 'dict'),
                ),
                numThreads: threads,
                provider: 'cpu',
                debug: false,
              ),
            ));
            sig = s;
          }
        case 'synth':
          final p0 = msg['p'] as Map;
          final engine = tts;
          if (engine == null) throw StateError('声库未加载');
          final audio = engine.generate(
            text: p0['text'] as String,
            sid: p0['sid'] as int,
            speed: (p0['speed'] as num).toDouble(),
          );
          final samples = audio.samples;
          v = samples.isEmpty
              ? null
              : [_pcm16(samples), audio.sampleRate]; // 采样率跟结果走
        case 'unload':
          tts?.free();
          tts = null;
          sig = null;
        case 'exit':
          tts?.free();
          tts = null;
          sig = null;
          incoming.close();
          return;
      }
    } catch (e, s) {
      err = e.toString();
      debugPrint('[speech] tts worker 异常: $e\n$s');
    }
    if (id != 0) replyPort.send({'id': id, 'v': v, 'error': err});
  });
}

Uint8List _pcm16(Float32List samples) {
  final out = Uint8List(samples.length * 2);
  final bd = ByteData.sublistView(out);
  for (var i = 0; i < samples.length; i++) {
    var v = samples[i];
    if (v > 1.0) v = 1.0;
    if (v < -1.0) v = -1.0;
    bd.setInt16(i * 2, (v * 32767).round(), Endian.little);
  }
  return out;
}
