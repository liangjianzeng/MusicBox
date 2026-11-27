import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/models.dart' as mb;
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/speech/speech_service.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/create/creation_state.dart';
import 'package:musicbox/features/create/shell_easy.dart';
import 'package:musicbox/features/create/shell_standard.dart';
import 'package:musicbox/features/create/transcript_confirm_page.dart';
import 'package:musicbox/features/create/voice_capture.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSpeechService extends Fake implements SpeechService {
  final resolver = Completer<ResolvedEngine>();
  var resolveCalls = 0;

  @override
  Future<ResolvedEngine> resolveEngine() {
    resolveCalls++;
    return resolver.future;
  }
}

class _FakeStreamingSession implements StreamingAsrSession {
  final partials = StreamController<String>.broadcast();
  var started = 0;

  @override
  Stream<String> get partialText => partials.stream;

  @override
  Future<void> start() async {
    started++;
  }

  @override
  Future<AsrOutcome> stop() async => const AsrOutcome(
        text: '雨夜咖啡馆',
        source: AsrSource.onDeviceStreaming,
      );

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() => partials.close();
}

class _ReadySpeechService extends Fake implements SpeechService {
  _ReadySpeechService(this.session);

  final _FakeStreamingSession session;

  @override
  Future<ResolvedEngine> resolveEngine() async =>
      const ResolvedEngine(AsrEngineKind.streamingZipformer);

  @override
  Future<StreamingAsrSession?> createSession({String? saveWavPath}) async =>
      session;
}

class _FakeVoiceApi extends Fake implements ApiClient {
  _FakeVoiceApi(this.pendingPolls);

  final int pendingPolls;
  var polls = 0;
  String? uploadedFilename;

  @override
  Future<String> intentVoice(String filePath, {String? filename}) async {
    uploadedFilename = filename;
    return 'in_voice';
  }

  @override
  Future<mb.Intent> intent(String id) async {
    polls++;
    if (polls <= pendingPolls) {
      return mb.Intent(
        id: id,
        sourceKind: 'voice',
        status: 'clarifying',
        confidence: 0,
        createdAt: 0,
      );
    }
    return mb.Intent(
      id: id,
      sourceKind: 'voice',
      status: 'ready',
      mood: const ['温柔'],
      sceneDesc: '雨夜咖啡馆里的治愈爵士',
      genreHypotheses: const ['爵士'],
      confidence: 0.9,
      sourceText: '我想写一首雨夜咖啡馆的治愈爵士',
      createdAt: 0,
    );
  }
}

Future<Prefs> _prefs() async {
  SharedPreferences.setMockInitialValues({'consent_biometric': true});
  return Prefs(await SharedPreferences.getInstance());
}

Finder _creationField() => find.byType(TextField).first;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('准备录音时松手，迟到的引擎解析不得擅自开始录音', (tester) async {
    var recorderStarts = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('com.llfbandit.record/messages'),
      (call) async {
        if (call.method == 'start') recorderStarts++;
        return null;
      },
    );
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
              const MethodChannel('com.llfbandit.record/messages'), null);
    });
    SharedPreferences.setMockInitialValues({'consent_biometric': true});
    final prefs = Prefs(await SharedPreferences.getInstance());
    final speech = _FakeSpeechService();
    var results = 0;

    await tester.pumpWidget(ProviderScope(
      overrides: [
        prefsProvider.overrideWithValue(prefs),
        speechServiceProvider.overrideWithValue(speech),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: Center(
            child: HoldToTalkButton(onResult: (_) => results++),
          ),
        ),
      ),
    ));

    final gesture = await tester
        .startGesture(tester.getCenter(find.byType(HoldToTalkButton)));
    await tester.pump(kLongPressTimeout + const Duration(milliseconds: 100));
    expect(speech.resolveCalls, 1);

    await gesture.up();
    await tester.pump();
    expect(find.text('已取消，准备好后再说吧'), findsOneWidget);

    speech.resolver.complete(const ResolvedEngine(AsrEngineKind.server));
    await tester.pumpAndSettle();
    expect(recorderStarts, 0);
    expect(results, 0);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('端侧实时转写与终稿都回填宿主输入框', (tester) async {
    const pathChannel = MethodChannel('plugins.flutter.io/path_provider');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathChannel, (call) async {
      if (call.method == 'getTemporaryDirectory') return 'C:/temp';
      return null;
    });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pathChannel, null);
    });
    final prefs = await _prefs();
    final session = _FakeStreamingSession();
    addTearDown(session.dispose);
    final partials = <String>[];
    final results = <VoiceCaptureResult>[];

    await tester.pumpWidget(ProviderScope(
      overrides: [
        prefsProvider.overrideWithValue(prefs),
        speechServiceProvider.overrideWithValue(_ReadySpeechService(session)),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: Center(
            child: HoldToTalkButton(
              onPartial: partials.add,
              onResult: results.add,
            ),
          ),
        ),
      ),
    ));

    final gesture = await tester
        .startGesture(tester.getCenter(find.byType(HoldToTalkButton)));
    await tester.pump(kLongPressTimeout + const Duration(milliseconds: 100));
    await tester.pump();
    expect(session.started, 1);

    session.partials.add('雨夜');
    await tester.pump();
    expect(partials, ['雨夜']);
    expect(find.text('雨夜'), findsOneWidget);

    await gesture.up();
    await tester.pump();
    expect(results.single.local?.text, '雨夜咖啡馆');
    expect(partials.last, '雨夜咖啡馆');
    expect(tester.takeException(), isNull);
  });

  for (final easy in [true, false]) {
    testWidgets('${easy ? '简约' : '标准'}档延迟服务端转写回填同一个灵感框', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.reset);
      final prefs = await _prefs();
      final api = _FakeVoiceApi(60);
      const transcript = '我想写一首雨夜咖啡馆的治愈爵士';

      await tester.pumpWidget(ProviderScope(
        overrides: [
          prefsProvider.overrideWithValue(prefs),
          apiClientProvider.overrideWithValue(api),
        ],
        child: MaterialApp(
          home:
              Scaffold(body: easy ? const ShellEasy() : const ShellStandard()),
        ),
      ));
      await tester.pump();

      final mic =
          tester.widget<HoldToTalkButton>(find.byType(HoldToTalkButton));
      mic.onPartial!('雨夜');
      await tester.pump();
      expect(tester.widget<TextField>(_creationField()).controller!.text, '雨夜');

      mic.onResult(const VoiceCaptureResult(
        wavPath: 'voice.m4a',
        engine: AsrEngineKind.server,
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(TranscriptConfirmPage), findsOneWidget);
      expect(api.uploadedFilename, 'voice.m4a');

      await tester.pump(const Duration(seconds: 30));
      expect(api.polls, greaterThan(60));
      final scope = ProviderScope.containerOf(
          tester.element(find.byType(TranscriptConfirmPage)));
      expect(scope.read(creationProvider).prompt, transcript);

      await tester.tap(find.byIcon(Icons.close_rounded));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(_creationField()).controller!.text,
          transcript);
      expect(tester.takeException(), isNull);
    });
  }
}
