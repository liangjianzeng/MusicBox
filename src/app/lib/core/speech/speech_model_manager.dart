/// 端侧语音模型资产治理：按需下载、就绪判定、体积、删除。
///
/// 纪律（对齐 TongYi-Lite 的做法，但下载器改用已有的 dio，不引新依赖）：
/// · **不打包、不自动下**：只有用户要用（长按说话 / 打开朗读）或设置页点下载才动网络；
/// · 小文件先行、大文件最后，逐文件断点续传（dio.download 自带 Range 续传）；
/// · 主源 hf-mirror 失败自动切 huggingface 兜底源；
/// · 就绪判定只认「文件都在且体积 ≥ 清单声明体积的 95%」，不认「目录存在」；
/// · 进度流是单订阅流 → 必须做广播 hub，否则第二个监听者拿不到进度。
library;

import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 三套模型资产（设置页按能力描述，**不出现引擎型号名**）。
enum SpeechModel {
  /// 端侧即时识别（边说边出字）
  asrStreaming,

  /// 端侧精听（整段，带情绪 + 音频事件）
  asrSenseVoice,

  /// 端侧朗读声库（中文）
  ttsZh,
}

class SpeechModelSpec {
  const SpeechModelSpec({
    required this.id,
    required this.dirName,
    required this.repo,
    required this.files,
    required this.capability,
    required this.needNetwork,
  });

  final SpeechModel id;

  /// 本地目录名（不含型号名，避免 UI 泄露；仅落盘用）
  final String dirName;

  /// 远端仓库（hf-mirror / huggingface 同名）
  final String repo;

  /// 相对路径 → 声明体积（字节）。体积来自 hf-mirror tree API 实测，
  /// 不是估的；文件清单变动能在这里第一时间看出来。
  final Map<String, int> files;

  /// 设置页文案：这项能力给人干什么（**禁止型号名**）
  final String capability;

  /// 首次使用是否需要网络
  final bool needNetwork;

  int get totalBytes => files.values.fold(0, (a, b) => a + b);

  /// 清单顺序：小文件先行（秒级见效），大文件最后
  List<String> get orderedFiles => files.keys.toList()
    ..sort((a, b) => files[a]!.compareTo(files[b]!));
}

class SpeechModelManager {
  SpeechModelManager._();

  static const List<String> _mirrors = [
    'https://hf-mirror.com',
    'https://huggingface.co',
  ];

  /// 实测清单（2026-11-24 由 hf-mirror tree API 核对，只列必需件，
  /// test_wavs / README / export 脚本 / fp32 权重一律不下）
  static const Map<SpeechModel, SpeechModelSpec> specs = {
    SpeechModel.asrStreaming: SpeechModelSpec(
      id: SpeechModel.asrStreaming,
      dirName: 'a1',
      repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
      files: {
        'tokens.txt': 20628,
        'joiner.int8.onnx': 1033416,
        'decoder.onnx': 5165083,
        'encoder.int8.onnx': 161141793,
      },
      capability: '边说边出字（即时）',
      needNetwork: true,
    ),
    SpeechModel.asrSenseVoice: SpeechModelSpec(
      id: SpeechModel.asrSenseVoice,
      dirName: 'a2',
      repo:
          'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      files: {
        'tokens.txt': 315894,
        'model.int8.onnx': 239233841,
      },
      capability: '整段精听（含情绪与音频事件）',
      needNetwork: true,
    ),
    SpeechModel.ttsZh: SpeechModelSpec(
      id: SpeechModel.ttsZh,
      dirName: 't1',
      repo: 'csukuangfj/sherpa-onnx-vits-zh-ll',
      files: {
        'tokens.txt': 331,
        'dict/user.dict.utf8': 49,
        'dict/pos_dict/prob_start.utf8': 4347,
        'dict/stop_words.utf8': 8974,
        'dict/pos_dict/prob_trans.utf8': 124159,
        'dict/pos_dict/char_state_tab.utf8': 327139,
        'lexicon.txt': 376868,
        'date.fst': 59154,
        'number.fst': 64482,
        'phone.fst': 88630,
        'new_heteronym.fst': 21974,
        'dict/pos_dict/prob_emit.utf8': 1687686,
        'dict/hmm_model.utf8': 519739,
        'dict/jieba.dict.utf8': 5071204,
        'dict/idf.utf8': 5998717,
        'model.onnx': 121100803,
      },
      capability: '离线朗读（中文）',
      needNetwork: true,
    ),
  };

  static SpeechModelSpec specOf(SpeechModel m) => specs[m]!;

  static Future<Directory> _root() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory(p.join(base.path, 'musicbox', 'speech'));
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static Future<String> dirOf(SpeechModel m) async {
    final r = await _root();
    return p.join(r.path, specOf(m).dirName);
  }

  static File _file(String dir, String rel) => File(p.join(dir, rel));

  /// 就绪：全部文件存在且体积达标（95% 容忍，防止清单体积被上游微调）
  static Future<bool> isReady(SpeechModel m) async {
    try {
      final dir = await dirOf(m);
      final spec = specOf(m);
      for (final e in spec.files.entries) {
        final f = _file(dir, e.key);
        if (!await f.exists()) return false;
        final len = await f.length();
        if (len < (e.value * 0.95).floor()) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 已落盘体积（字节）
  static Future<int> sizeOnDisk(SpeechModel m) async {
    try {
      final dir = await dirOf(m);
      var sum = 0;
      for (final rel in specOf(m).files.keys) {
        final f = _file(dir, rel);
        if (await f.exists()) sum += await f.length();
      }
      return sum;
    } catch (_) {
      return 0;
    }
  }

  static Future<void> delete(SpeechModel m) async {
    try {
      final dir = await dirOf(m);
      final d = Directory(dir);
      if (await d.exists()) await d.delete(recursive: true);
      _fire(const SpeechProgressEvent(model: null, phase: 'deleted'));
    } catch (_) {}
  }

  // ---------- 进度广播（单订阅流 → hub） ----------
  static final StreamController<SpeechProgressEvent> _hub =
      StreamController<SpeechProgressEvent>.broadcast();
  static Stream<SpeechProgressEvent> get updates => _hub.stream;

  static void _fire(SpeechProgressEvent e) {
    if (!_hub.isClosed) _hub.add(e);
  }

  static bool _running = false;

  /// 下载（幂等：已在跑直接返回；已就绪直接返回）。失败抛 [SpeechModelException]。
  static Future<void> ensure(
    SpeechModel m, {
    CancelToken? cancelToken,
    Dio? dioOverride,
  }) async {
    if (await isReady(m)) return;
    if (_running) throw const SpeechModelException('已有语音模型在下载，请等它完成');
    _running = true;
    final dio = dioOverride ??
        Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 20),
          receiveTimeout: const Duration(seconds: 120),
          followRedirects: true,
        ));
    try {
      final dir = await dirOf(m);
      final spec = specOf(m);
      _fire(SpeechProgressEvent(model: m, phase: 'begin', totalBytes: spec.totalBytes));
      for (final rel in spec.orderedFiles) {
        final want = spec.files[rel]!;
        final f = _file(dir, rel);
        if (await f.exists() && await f.length() >= (want * 0.95).floor()) {
          continue;
        }
        final parent = f.parent;
        if (!await parent.exists()) await parent.create(recursive: true);
        var lastErr = '';
        for (final base in _mirrors) {
          if (cancelToken?.isCancelled ?? false) {
            throw const SpeechModelException('已取消下载');
          }
          final url = '$base/${spec.repo}/resolve/main/$rel';
          try {
            _fire(SpeechProgressEvent(
                model: m, phase: 'file', file: rel, fileBytes: want));
            await dio.download(
              url,
              f.path,
              cancelToken: cancelToken,
              onReceiveProgress: (received, total) {
                _fire(SpeechProgressEvent(
                  model: m,
                  phase: 'progress',
                  file: rel,
                  fileBytes: want,
                  received: received,
                  total: total <= 0 ? want : total,
                  overallBytes: spec.totalBytes,
                ));
              },
            );
            if (await f.exists() && await f.length() >= (want * 0.95).floor()) {
              lastErr = '';
              break;
            }
            lastErr = '文件不完整';
          } catch (e) {
            lastErr = e.toString();
            debugPrint('[speech] $base/$rel 失败: $e');
          }
        }
        if (lastErr.isNotEmpty) {
          throw SpeechModelException('「${spec.capability}」模型下载失败：$lastErr');
        }
      }
      if (!await isReady(m)) {
        throw const SpeechModelException('模型文件仍不完整，请删除后重试');
      }
      _fire(SpeechProgressEvent(model: m, phase: 'done', totalBytes: spec.totalBytes));
    } finally {
      _running = false;
      if (dioOverride == null) dio.close(force: true);
    }
  }
}

class SpeechProgressEvent {
  const SpeechProgressEvent({
    required this.model,
    required this.phase,
    this.file,
    this.fileBytes = 0,
    this.received = 0,
    this.total = 0,
    this.totalBytes = 0,
    this.overallBytes = 0,
  });

  final SpeechModel? model;

  /// begin / file / progress / done / deleted
  final String phase;
  final String? file;
  final int fileBytes;
  final int received;
  final int total;
  final int totalBytes;
  final int overallBytes;

  /// 单文件比例（0~1）
  double get fileFraction => total <= 0 ? 0 : (received / total).clamp(0.0, 1.0);
}

class SpeechModelException implements Exception {
  const SpeechModelException(this.message);
  final String message;
  @override
  String toString() => message;
}
