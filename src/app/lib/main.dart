import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/config.dart';
import 'core/db.dart';
import 'core/speech/speech_service.dart';
import 'core/state.dart';
import 'features/auth/session_gate.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 锁屏/通知栏播放后台支持
  await JustAudioBackground.init(
    androidNotificationChannelId: 'com.musicbox.musicbox.channel.audio',
    androidNotificationChannelName: 'MusicBox 播放',
    androidNotificationOngoing: true,
  );
  final sp = await SharedPreferences.getInstance();
  final prefs = Prefs(sp);
  final db = await LocalDb.open();
  runApp(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      localDbProvider.overrideWithValue(db),
    ],
    child: const MusicBoxApp(),
  ));
}

class MusicBoxApp extends StatelessWidget {
  const MusicBoxApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF8B5CF6);
    return MaterialApp(
      title: 'MusicBox',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: seed,
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF0E0F13),
        appBarTheme: const AppBarTheme(centerTitle: false),
        snackBarTheme:
            const SnackBarThemeData(behavior: SnackBarBehavior.floating),
      ),
      home: const _SpeechWarmup(child: SessionGate()),
    );
  }
}

/// 启动预热：把本机识别器与（开了自动朗读时）朗读声库提前装进常驻 worker。
/// 不预热的代价是首次长按卡数秒（模型 ~160MB 加载）。失败静默，绝不影响启动。
class _SpeechWarmup extends ConsumerStatefulWidget {
  const _SpeechWarmup({required this.child});
  final Widget child;

  @override
  ConsumerState<_SpeechWarmup> createState() => _SpeechWarmupState();
}

class _SpeechWarmupState extends ConsumerState<_SpeechWarmup> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(ref.read(speechServiceProvider).warmup());
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

