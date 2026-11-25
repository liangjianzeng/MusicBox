/// PCM16 / WAV 工具（端侧识别与朗读共用）。
///
/// 采样率纪律（从 TongYi-Lite 抄来的教训）：**时长与采样率跟着数据走**，
/// 拿引擎级常量去拼 WAV 头会让声音变调；解析时也只认文件头里的真实值。
library;

import 'dart:typed_data';

/// PCM16LE → Float32（归一化到 [-1,1)），sherpa 喂数据用。
Float32List pcm16ToFloat32(Uint8List bytes) {
  final n = bytes.length ~/ 2;
  final data = ByteData.sublistView(bytes);
  final out = Float32List(n);
  for (var i = 0; i < n; i++) {
    out[i] = data.getInt16(i * 2, Endian.little) / 32768.0;
  }
  return out;
}

/// Float32 → PCM16LE（端侧 TTS 输出落 WAV 用）。
Uint8List float32ToPcm16(Float32List samples) {
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

/// 给 PCM16 拼 44 字节 RIFF/WAVE 头（mono）。
Uint8List wrapWav(Uint8List pcm16, int sampleRate, {int channels = 1}) {
  final byteRate = sampleRate * channels * 2;
  final out = Uint8List(44 + pcm16.length);
  final bd = ByteData.sublistView(out);
  void ascii(int off, String s) {
    for (var i = 0; i < s.length; i++) {
      out[off + i] = s.codeUnitAt(i);
    }
  }

  ascii(0, 'RIFF');
  bd.setUint32(4, 36 + pcm16.length, Endian.little);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  bd.setUint32(16, 16, Endian.little); // fmt chunk size
  bd.setUint16(20, 1, Endian.little); // PCM
  bd.setUint16(22, channels, Endian.little);
  bd.setUint32(24, sampleRate, Endian.little);
  bd.setUint32(28, byteRate, Endian.little);
  bd.setUint16(32, channels * 2, Endian.little);
  bd.setUint16(34, 16, Endian.little);
  ascii(36, 'data');
  bd.setUint32(40, pcm16.length, Endian.little);
  out.setRange(44, out.length, pcm16);
  return out;
}

/// 解析 WAV（只支持 PCM16；其它格式返回 null，调用方降级而不是假装成功）。
({Float32List samples, int sampleRate, double durationSec})? parseWavPcm16(
    Uint8List bytes) {
  if (bytes.length < 44) return null;
  final bd = ByteData.sublistView(bytes);
  String tag(int off) => String.fromCharCodes(bytes.sublist(off, off + 4));
  if (tag(0) != 'RIFF' || tag(8) != 'WAVE') return null;
  var off = 12;
  int? fmtRate;
  int? fmtCh;
  int? fmtBits;
  int? dataOff;
  int? dataLen;
  while (off + 8 <= bytes.length) {
    final id = tag(off);
    final size = bd.getUint32(off + 4, Endian.little);
    if (id == 'fmt ') {
      fmtCh = bd.getUint16(off + 10, Endian.little);
      fmtRate = bd.getUint32(off + 12, Endian.little);
      fmtBits = bd.getUint16(off + 22, Endian.little);
    } else if (id == 'data') {
      dataOff = off + 8;
      dataLen = size.clamp(0, bytes.length - dataOff);
      break;
    }
    off += 8 + size + (size.isOdd ? 1 : 0);
  }
  if (dataOff == null || dataLen == null || dataLen <= 0) return null;
  if (fmtRate == null || fmtBits != 16) return null; // 非 PCM16 不猜
  final ch = (fmtCh ?? 1).clamp(1, 8);
  final pcm = bytes.sublist(dataOff, dataOff + dataLen);
  final f32 = pcm16ToFloat32(pcm);
  final mono = ch == 1
      ? f32
      : Float32List.fromList(<double>[
          for (var i = 0; i + ch <= f32.length; i += ch) f32[i],
        ]); // 多取声道则取首声道，不假装混音
  final frames = mono.length;
  return (
    samples: mono,
    sampleRate: fmtRate,
    durationSec: fmtRate > 0 ? frames / fmtRate : 0.0,
  );
}

/// PCM16 字节数 → 秒（16k mono：32KB/s）
double pcm16DurationSec(int byteCount, {int sampleRate = 16000, int channels = 1}) =>
    byteCount / (sampleRate * channels * 2);
