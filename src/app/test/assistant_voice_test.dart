// 统一助手语音层单测（不依赖真机/网络）：无模型给明确引导、终稿回显、朗读、麦克风归还。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/speech/speech_service.dart';
import 'package:musicbox/features/assistant/assistant_voice.dart';

/// 播报期间不碰歌曲播放器的协调钩子（测试里全部空实现）。
SpeechCoordination _coord() => SpeechCoordination(
      isPlaying: () => false,
      pause: () async {},
      resume: () async {},
    );

/// 假的识别会话（抽象接口，可直接实现）。
class _FakeAsrSession implements StreamingAsrSession {
  final AsrOutcome _outcome;
  int starts = 0;
  int cancels = 0;
  final _partial = StreamController<String>();

  _FakeAsrSession(this._outcome);

  @override
  Stream<String> get partialText => _partial.stream;

  @override
  Future<void> start() async => starts++;

  @override
  Future<AsrOutcome> stop() async => _outcome;

  @override
  Future<void> cancel() async {
    cancels++;
    await _partial.close();
  }

  @override
  Future<void> dispose() async {}
}

/// 假的语音服务（只实现控制器用到的方法，其余由 Fake 兜底抛错）。
class _FakeSpeechService extends Fake implements SpeechService {
  StreamingAsrSession? _session;
  int speakCalls = 0;

  @override
  Future<StreamingAsrSession?> createSession({String? saveWavPath}) async =>
      _session;

  @override
  Future<String?> speak(String text, {SpeechCoordination? coordination}) async {
    speakCalls++;
    return null;
  }

  @override
  Future<void> stopSpeak() async {}
}

void main() {
  group('无模型/服务端档', () {
    test('识别给不了就给明确出路，不空转', () async {
      final svc = _FakeSpeechService(); // 会话为 null
      final ctrl = AssistantVoiceController(
        service: svc,
        inputController: TextEditingController(),
        coordination: _coord(),
      );
      await ctrl.startTalk();
      expect(ctrl.listening, isFalse);
      expect(ctrl.talkError, contains('本机识别'));
      expect(ctrl.talkError, contains('下载模型'));
      ctrl.dispose();
    });
  });

  group('识别结果回显', () {
    test('松手后终稿写入输入框并选中末尾', () async {
      final svc = _FakeSpeechService();
      svc._session = _FakeAsrSession(
          const AsrOutcome(text: '帮我改一下', source: AsrSource.onDeviceStreaming));
      final input = TextEditingController();
      final ctrl = AssistantVoiceController(
        service: svc,
        inputController: input,
        coordination: _coord(),
      );
      await ctrl.startTalk();
      await ctrl.stopTalk();
      expect(input.text, '帮我改一下');
      expect(input.selection,
          const TextSelection.collapsed(offset: '帮我改一下'.length));
      ctrl.dispose();
    });

    test('没听清（无文本且无错误）给回退原因，不清空输入框', () async {
      final svc = _FakeSpeechService();
      // 空文本且无 error：走回退文案「没听清，再说一遍」
      svc._session =
          _FakeAsrSession(AsrOutcome(text: '', source: AsrSource.none));
      final input = TextEditingController();
      input.text = '打了一半';
      final ctrl = AssistantVoiceController(
        service: svc,
        inputController: input,
        coordination: _coord(),
      );
      await ctrl.startTalk();
      await ctrl.stopTalk();
      expect(input.text, '打了一半');
      expect(ctrl.talkError, contains('没听清'));
      ctrl.dispose();
    });
  });

  group('朗读', () {
    test('speak 调用声库（端侧优先，失败原因落到 talkError）', () async {
      final svc = _FakeSpeechService();
      final ctrl = AssistantVoiceController(
        service: svc,
        inputController: TextEditingController(),
        coordination: _coord(),
      );
      await ctrl.speak('你好');
      expect(svc.speakCalls, 1);
      expect(ctrl.talkError, isNull);
      ctrl.dispose();
    });

    test('空文本朗读是 no-op，不触发声库', () async {
      final svc = _FakeSpeechService();
      final ctrl = AssistantVoiceController(
        service: svc,
        inputController: TextEditingController(),
        coordination: _coord(),
      );
      await ctrl.speak('   ');
      expect(svc.speakCalls, 0);
      expect(ctrl.speaking, isFalse);
      ctrl.dispose();
    });
  });

  group('麦克风归还', () {
    test('startTalk 后 cancelTalk 归还麦克风并清空监听态', () async {
      final svc = _FakeSpeechService();
      final session = _FakeAsrSession(AsrOutcome.empty);
      svc._session = session;
      final ctrl = AssistantVoiceController(
        service: svc,
        inputController: TextEditingController(),
        coordination: _coord(),
      );
      await ctrl.startTalk();
      ctrl.cancelTalk();
      expect(session.cancels, 1);
      expect(ctrl.listening, isFalse);
      ctrl.dispose();
    });
  });
}
