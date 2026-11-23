import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/config.dart';
import 'core/db.dart';
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
      home: const SessionGate(),
    );
  }
}

