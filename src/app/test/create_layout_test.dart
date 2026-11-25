import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/speech/asr_engine.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/create/create_page.dart';
import 'package:musicbox/features/create/creation_ui.dart';
import 'package:musicbox/features/create/transcript_confirm_page.dart';
import 'package:musicbox/features/create/voice_capture.dart';
import 'package:musicbox/shared/widgets/primary_button.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> _pump(
  WidgetTester tester, {
  required Size size,
  required Widget child,
  double scale = 1,
  double keyboard = 0,
  bool player = false,
  bool navigation = true,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  final prefs = Prefs(await SharedPreferences.getInstance());
  await tester.pumpWidget(ProviderScope(
    overrides: [prefsProvider.overrideWithValue(prefs)],
    child: MaterialApp(
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF8B5CF6),
          brightness: Brightness.dark,
        ),
      ),
      builder: (context, widget) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(scale),
        ),
        child: widget!,
      ),
      home: Scaffold(
        body: child,
        bottomNavigationBar: navigation
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (player)
                    const SizedBox(
                        height: 44, child: ColoredBox(color: Colors.black54)),
                  NavigationBar(
                    height: 64,
                    destinations: const [
                      NavigationDestination(
                          icon: Icon(Icons.auto_awesome), label: '创建'),
                      NavigationDestination(
                          icon: Icon(Icons.library_music), label: '曲库'),
                      NavigationDestination(
                          icon: Icon(Icons.movie_creation_outlined),
                          label: 'MV'),
                      NavigationDestination(icon: Icon(Icons.mic), label: '人格'),
                      NavigationDestination(
                          icon: Icon(Icons.person_outline), label: '我的'),
                    ],
                  ),
                ],
              )
            : null,
      ),
    ),
  ));
  await tester.pump(const Duration(milliseconds: 300));
}

Finder _primaryButton() => find.byType(PrimaryButton);

void _expectVisible(WidgetTester tester, Finder finder, Size viewport) {
  expect(finder, findsOneWidget);
  final rect = tester.getRect(finder);
  expect(rect.left, greaterThanOrEqualTo(0));
  expect(rect.right, lessThanOrEqualTo(viewport.width));
  expect(rect.top, greaterThanOrEqualTo(0));
  expect(rect.bottom, lessThanOrEqualTo(viewport.height));
  expect(tester.getCenter(finder).dy, greaterThan(0));
}

void main() {
  testWidgets('三档切换始终显示对应的彩色图标且墨效局部绘制', (tester) async {
    await _pump(
      tester,
      size: const Size(390, 844),
      child: const CreatePage(),
    );

    const tierIcons = [
      (Icons.auto_awesome_rounded, CreationPalette.amber),
      (Icons.tune_rounded, CreationPalette.green),
      (Icons.equalizer_rounded, CreationPalette.blue),
    ];

    Finder tierIcon(IconData icon) => find.descendant(
          of: find.byType(CreationTierTabs),
          matching: find.byIcon(icon),
        );

    void expectTierIcons() {
      for (final (icon, color) in tierIcons) {
        expect(tierIcon(icon), findsOneWidget);
        expect(tester.widget<Icon>(tierIcon(icon)).color, color);
        final material = tester.widget<Material>(
          find
              .ancestor(of: tierIcon(icon), matching: find.byType(Material))
              .first,
        );
        expect(material.type, MaterialType.transparency);
      }
    }

    expectTierIcons();
    expect(find.byType(ShaderMask), findsNothing);

    await tester.tap(find.text('深度'));
    await tester.pumpAndSettle();

    expectTierIcons();
    expect(tester.takeException(), isNull);
  });

  testWidgets('创作三档不呈现积分信息', (tester) async {
    await _pump(
      tester,
      size: const Size(390, 844),
      child: const CreatePage(),
    );

    void expectNoCredits() {
      expect(find.textContaining('积分'), findsNothing);
      expect(find.byIcon(Icons.bolt_rounded), findsNothing);
      expect(find.text('生成 3 首'), findsOneWidget);
    }

    expectNoCredits();
    await tester.tap(find.text('标准'));
    await tester.pumpAndSettle();
    expectNoCredits();
    await tester.tap(find.text('深度'));
    await tester.pumpAndSettle();
    expectNoCredits();
  });

  testWidgets('简约档语音与生成动作位于屏幕下半部', (tester) async {
    const viewport = Size(390, 844);
    await _pump(tester, size: viewport, child: const CreatePage());

    final mic = tester.getRect(find.byType(HoldToTalkButton));
    expect(mic.center.dy, greaterThan(viewport.height * .55));
    _expectVisible(tester, find.byType(HoldToTalkButton), viewport);
    _expectVisible(tester, _primaryButton(), viewport);
    expect(tester.takeException(), isNull);
  });

  testWidgets('标准档底部输入坞无需滚动即可操作', (tester) async {
    const viewport = Size(390, 844);
    await _pump(tester, size: viewport, child: const CreatePage());
    await tester.tap(find.text('标准'));
    await tester.pumpAndSettle();

    final mic = tester.getRect(find.byType(HoldToTalkButton));
    expect(mic.center.dy, greaterThan(viewport.height * .6));
    _expectVisible(tester, find.byType(HoldToTalkButton), viewport);
    _expectVisible(tester, _primaryButton(), viewport);
    expect(tester.takeException(), isNull);
  });

  testWidgets('深度档主操作固定可见，参数区独立滚动', (tester) async {
    const viewport = Size(390, 844);
    await _pump(tester, size: viewport, child: const CreatePage());
    await tester.tap(find.text('深度'));
    await tester.pumpAndSettle();

    _expectVisible(tester, _primaryButton(), viewport);
    expect(find.byType(ListView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320×568、2 倍字号与播放器共存时不挤压主操作', (tester) async {
    const viewport = Size(320, 568);
    await _pump(
      tester,
      size: viewport,
      scale: 2,
      player: true,
      child: const CreatePage(),
    );

    _expectVisible(tester, find.byType(HoldToTalkButton), viewport);
    _expectVisible(tester, _primaryButton(), viewport);
    expect(find.text('帮我把灵感说清楚'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('键盘打开后三档主灵感输入框均完整位于键盘上方', (tester) async {
    const viewport = Size(390, 844);
    const keyboardHeight = 300.0;
    await _pump(
      tester,
      size: viewport,
      keyboard: keyboardHeight,
      child: const CreatePage(keyboardOpen: true),
    );

    for (final tier in ['简约', '标准', '深度']) {
      if (tier != '简约') {
        await tester.tap(find.text(tier));
        await tester.pumpAndSettle();
      }
      final input = find.byType(TextField).first;
      expect(input, findsOneWidget);
      final rect = tester.getRect(input);
      expect(
        rect.bottom,
        lessThanOrEqualTo(viewport.height - keyboardHeight + 0.5),
        reason: '$tier 主灵感输入框不能伸入键盘区域',
      );
      expect(rect.top, greaterThanOrEqualTo(0));
      await tester.enterText(input, '能看到输入内容');
      await tester.pump();
      expect(tester.widget<TextField>(input).controller!.text, '能看到输入内容');
      expect(tester.takeException(), isNull);
    }

    expect(find.byType(HoldToTalkButton), findsNothing);
    expect(find.text('拍一张'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('点击主灵感框后键盘动态弹出不会遮挡输入', (tester) async {
    const viewport = Size(390, 844);
    const keyboardHeight = 320.0;
    await _pump(tester, size: viewport, child: const CreatePage());

    for (final tier in ['简约', '标准', '深度']) {
      if (tier != '简约') {
        await tester.tap(find.text(tier));
        await tester.pumpAndSettle();
      }
      final input = find.byType(TextField).first;
      await tester.tap(input);
      tester.view.viewInsets =
          const FakeViewPadding(bottom: keyboardHeight);
      tester.binding.handleMetricsChanged();
      await tester.pumpAndSettle();

      final rect = tester.getRect(input);
      expect(
        rect.bottom,
        lessThanOrEqualTo(viewport.height - keyboardHeight + 0.5),
        reason: '$tier 输入框必须随键盘动态上移',
      );
      await tester.enterText(input, '动态键盘可见');
      await tester.pump();
      expect(tester.widget<TextField>(input).controller!.text, '动态键盘可见');

      tester.view.viewInsets = const FakeViewPadding(bottom: 0);
      tester.binding.handleMetricsChanged();
      await tester.pumpAndSettle();
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('语音确认页小屏大字键盘下正文可滚动、动作不溢出', (tester) async {
    const viewport = Size(320, 568);
    await _pump(
      tester,
      size: viewport,
      scale: 2,
      keyboard: 260,
      navigation: false,
      child: const TranscriptConfirmPage(
        easy: true,
        capture: VoiceCaptureResult(
          local: AsrOutcome(
            text: '想听雨夜咖啡馆里的治愈爵士',
            source: AsrSource.onDeviceOffline,
            durationSec: 4.2,
          ),
          engine: AsrEngineKind.senseVoiceOffline,
        ),
      ),
    );

    _expectVisible(tester, find.text('就这句'), viewport);
    expect(find.byType(SingleChildScrollView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
