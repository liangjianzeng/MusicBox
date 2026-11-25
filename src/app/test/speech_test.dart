// 端侧语音层单测（不依赖真机/网络）：WAV 往返、诚实字段、档位偏好、下载清单纪律。
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/speech/speech_model_manager.dart';
import 'package:musicbox/core/speech/speech_settings.dart';
import 'package:musicbox/core/speech/wav_util.dart';

void main() {
  group('WAV 工具', () {
    test('PCM16 → WAV → 解析：采样率与时长跟着数据走', () {
      // 0.5s @ 16k mono 的正弦
      const n = 8000;
      final pcm = Uint8List(n * 2);
      final bd = ByteData.sublistView(pcm);
      for (var i = 0; i < n; i++) {
        bd.setInt16(i * 2, (32000 * (i % 32 == 0 ? 1 : -1)).clamp(-32768, 32767), Endian.little);
      }
      final wav = wrapWav(pcm, 16000);
      expect(wav.length, 44 + pcm.length);
      expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
      expect(String.fromCharCodes(wav.sublist(36, 40)), 'data');
      final back = parseWavPcm16(wav);
      expect(back, isNotNull, reason: '自己拼的 WAV 必须能自解析');
      expect(back!.sampleRate, 16000);
      expect(back.durationSec, closeTo(0.5, 0.001));
      expect(back.samples.length, n);
    });

    test('22.05k 的朗读结果按 16k 头去拼会被解析成不同时长（采样率纪律）', () {
      final pcm = Uint8List(4410 * 2);
      final w22 = wrapWav(pcm, 22050);
      final w16 = wrapWav(pcm, 16000);
      expect(parseWavPcm16(w22)!.sampleRate, 22050);
      expect(parseWavPcm16(w16)!.sampleRate, 16000);
      expect(parseWavPcm16(w22)!.durationSec,
          closeTo(parseWavPcm16(w16)!.durationSec * (16000 / 22050), 0.001));
    });

    test('非 WAV / 非 PCM16 一律返回 null，不猜', () {
      expect(parseWavPcm16(Uint8List(10)), isNull);
      expect(parseWavPcm16(Uint8List(60)), isNull); // 长度够但不是 RIFF
      final fake = Uint8List(44);
      for (var i = 0; i < 4; i++) {
        fake[i] = 'RIFF'.codeUnitAt(i);
        fake[8 + i] = 'WAVE'.codeUnitAt(i);
        fake[12 + i] = 'fmt '.codeUnitAt(i);
      }
      fake.buffer.asByteData().setUint32(16, 16, Endian.little);
      fake.buffer.asByteData().setUint16(22, 8, Endian.little); // 8-bit → 不支持
      expect(parseWavPcm16(fake), isNull);
    });

    test('PCM16 字节数换算时长：16k mono = 32KB/s', () {
      expect(pcm16DurationSec(32000), 1.0);
      expect(pcm16DurationSec(16000 * 2 * 60), 60.0);
    });
  });

  group('识别结果诚实性', () {
    test('流式档给不出情绪就是 null，契约 JSON 里不得凭空出现 emotion/events', () {
      const o = AsrOutcome(text: '来点治愈的', source: AsrSource.onDeviceStreaming);
      expect(o.emotion, isNull);
      expect(o.events, isEmpty);
      final j = o.toContractJson();
      expect(j.containsKey('emotion'), isFalse, reason: '没有情绪就不能给 emotion 键');
      expect(j.containsKey('events'), isFalse);
      expect(j['text'], '来点治愈的');
    });

    test('精听档的情绪/事件按契约形状透出', () {
      const o = AsrOutcome(
        text: '今天有点冷',
        source: AsrSource.onDeviceOffline,
        emotion: 'sad',
        events: ['rain'],
        durationSec: 2.4,
      );
      final j = o.toContractJson();
      expect(j['emotion'], 'sad');
      expect(j['events'], ['rain']);
      expect(j['duration'], 2.4);
    });

    test('空结果 ok=false，不得被当成功上报', () {
      expect(AsrOutcome.empty.ok, isFalse);
      expect(const AsrOutcome(text: '   ', source: AsrSource.none).ok, isFalse);
      expect(AsrOutcome.empty.copyWith(durationSec: 1.2).durationSec, 1.2);
    });
  });

  group('语音档位偏好', () {
    test('档位与朗读偏好可往返，档位名不含模型型号', () {
      const s = SpeechSettings(
        asrEngine: AsrEngineKind.senseVoiceOffline,
        autoSpeak: true,
        speakRate: 1.3,
        speakerId: 4,
        fallbackToServer: false,
      );
      final back = SpeechSettings.fromMap(s.toMap());
      expect(back.asrEngine, AsrEngineKind.senseVoiceOffline);
      expect(back.autoSpeak, isTrue);
      expect(back.speakRate, 1.3);
      expect(back.speakerId, 4);
      expect(back.fallbackToServer, isFalse);
      // 引擎型号名绝不进用户可见文案
      for (final t in [s.asrEngineLabel, s.asrEngineHint]) {
        expect(t, isNot(contains('SenseVoice')));
        expect(t, isNot(contains('Zipformer')));
        expect(t, isNot(contains('sherpa')));
      }
    });

    test('脏数据回落默认档位，不炸', () {
      final back = SpeechSettings.fromMap({'asr_engine': '量子速读', 'speak_rate': 'x'});
      expect(back.asrEngine, AsrEngineKind.streamingZipformer);
      expect(back.speakRate, 1.0);
      expect(back.onDevice, isTrue);
    });

    test('落盘形态是 k=v 字符串：布尔/数字回读不得丢（否则开关像自己会跳）', () {
      // prefs 里读回来一律是字符串，这里刻意把 toMap 的值全转字符串再回读
      final asText = const SpeechSettings(
        autoSpeak: true,
        fallbackToServer: false,
        speakRate: 1.4,
        speakerId: 7,
      ).toMap().map((k, v) => MapEntry(k, '$v'));
      final back = SpeechSettings.fromMap(asText);
      expect(back.autoSpeak, isTrue, reason: '"true" 必须认成开');
      expect(back.fallbackToServer, isFalse, reason: '"false" 必须认成关');
      expect(back.speakRate, 1.4);
      expect(back.speakerId, 7);
    });
  });

  group('模型清单纪律', () {
    test('三套资产各就各位，体积=清单求和，下载顺序小文件先行', () {
      expect(SpeechModelManager.specs.length, 3);
      for (final m in SpeechModel.values) {
        final spec = SpeechModelManager.specOf(m);
        expect(spec.files.isNotEmpty, isTrue);
        var sum = 0;
        for (final v in spec.files.values) {
          sum += v;
        }
        expect(spec.totalBytes, sum);
        final ordered = spec.orderedFiles;
        for (var i = 1; i < ordered.length; i++) {
          expect(spec.files[ordered[i - 1]]! <= spec.files[ordered[i]]!, isTrue,
              reason: '必须先下小文件，用户才不是干等大文件');
        }
        // 设置页文案不得出现引擎型号名
        expect(spec.capability, isNot(contains('SenseVoice')));
        expect(spec.capability, isNot(contains('vits')));
        expect(spec.capability, isNot(contains('zipformer')));
      }
    });

    test('精听只下 int8 权重，不拖 fp32 全集', () {
      final sv = SpeechModelManager.specOf(SpeechModel.asrSenseVoice);
      expect(sv.files.containsKey('model.int8.onnx'), isTrue);
      expect(sv.files.containsKey('model.onnx'), isFalse,
          reason: 'fp32 权重 937MB，绝不下');
      final tts = SpeechModelManager.specOf(SpeechModel.ttsZh);
      expect(tts.files.containsKey('lexicon.txt'), isTrue, reason: '中文声库缺 lexicon 会念错');
      expect(tts.files.keys.any((k) => k.startsWith('dict/')), isTrue,
          reason: '中文分词 dict 必须在清单里');
    });
  });
}
