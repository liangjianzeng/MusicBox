import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/speech/speech_service.dart';
import 'package:musicbox/core/state.dart';
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
}
