import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/models.dart' as mb;
import 'package:musicbox/core/state.dart';
import 'package:musicbox/features/create/count_picker.dart';
import 'package:musicbox/features/create/shell_easy.dart';
import 'package:musicbox/shared/widgets/primary_button.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 2026-11-28 现场：简约档把候选数量**写死 3 首**（`'count': 3`），按钮只写「生成 3 首」，
/// 一键下去闷声扣 45⚡ —— 而每日免费积分才 50。用户既不能改，也不知道要花多少钱。
/// 同一天还查出更根上的一条：单价是端侧手抄的 `kCreditGenerateEach = 15`，
/// 真价在运营配置中心（`AC.credits()`，可热改），而 `/v1/credits` 当时根本不下发价格
/// —— 闸门拿着旧价放行、派单时被服务端拒（"界面说了不算"）。
///
/// 服务端那半由判词 V41-①…③ 钉（test/acceptance/v41_price_honesty.test.js，
/// 走真管理端改价路径证明"显示价==真扣价"）；这里钉端侧这半：
/// **用户选的数就是发出去的数，界面上的价就是服务端下发的价**。
class _CapApi extends Fake implements ApiClient {
  Map<String, dynamic>? lastBody;
  int calls = 0;

  @override
  Future<Map> generate(Map<String, dynamic> body, {String? model}) async {
    calls++;
    lastBody = body;
    // 抛业务异常让 _onText 走 toast 分支：既不真发单，也不会推进度页留下未销毁的轮询定时器
    throw ApiException(status: 402, code: 'CREDITS_NOT_ENOUGH', message: '测试用');
  }
}

/// 把"服务端下发的价格"种进会话（模拟新服务端 /v1/credits 的 prices）
class _SeededSession extends SessionNotifier {
  _SeededSession(super.ref, Map<String, int> prices) {
    state = SessionState(
      status: SessionStatus.ready,
      credits: mb.Credits(
        balance: 500,
        dailyQuota: 50,
        dailyUsed: 0,
        prices: prices,
      ),
    );
  }
}

Future<_CapApi> _pumpEasy(
  WidgetTester tester, {
  required Map<String, int> prices,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  final prefs = Prefs(await SharedPreferences.getInstance());
  final api = _CapApi();
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      apiClientProvider.overrideWithValue(api),
      sessionProvider.overrideWith((ref) => _SeededSession(ref, prices)),
    ],
    child: const MaterialApp(home: Scaffold(body: ShellEasy())),
  ));
  await tester.pump();
  return api;
}

String _buttonText(WidgetTester tester) =>
    tester.widget<PrimaryButton>(find.byType(PrimaryButton).last).text;

void main() {
  testWidgets('默认是 1 首，且价格用服务端下发的单价（不是端侧抄的 15）', (tester) async {
    await _pumpEasy(tester, prices: const <String, int>{'per_candidate': 23});
    final t = _buttonText(tester);
    expect(t, contains('1 首'), reason: '一键出歌默认 3 首 = 闷声 45⚡，用户没同意过的花费不算花费');
    expect(t, contains('23⚡'), reason: '按钮上的价必须来自 /v1/credits 的 prices，运营改价界面要跟着动');
    expect(t, isNot(contains('3 首')), reason: '「生成 3 首」是写死数量的产物');
  });

  testWidgets('选 2 首 → 按钮价格跟着变，且派单发出的就是 2', (tester) async {
    final api = await _pumpEasy(tester, prices: const <String, int>{'per_candidate': 23});
    // 数量选择器在主按钮同一行（另起一行会把主按钮挤出屏幕，见 count_picker.dart 注释）
    await tester.tap(find.byType(CountPicker));
    await tester.pumpAndSettle();
    await tester.tap(find.text('2 首 · 46⚡'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(_buttonText(tester), contains('46⚡'), reason: '2 首 × 23 = 46，按之前就该看见');

    await tester.enterText(find.byType(TextField).first, '雨夜咖啡馆的治愈爵士');
    await tester.pump();
    await tester.tap(find.byType(PrimaryButton).last);
    await tester.pump();

    expect(api.calls, 1, reason: '点一次就该发一次单');
    expect(api.lastBody?['count'], 2,
        reason: '界面上选的是 2，发出去必须是 2 —— 以前这里恒为写死的 3');
    expect(api.lastBody?['mode'], 'simple');
    expect(api.lastBody?['prompt'], '雨夜咖啡馆的治愈爵士');
  });

  testWidgets('老服务端不下发 prices 时退回兜底 15，但不许显示成 0 或不显示', (tester) async {
    await _pumpEasy(tester, prices: const <String, int>{});
    final t = _buttonText(tester);
    expect(t, contains('15⚡'), reason: '兜底价也要说出来，静默省略价格 = 用户照样不知道');
  });

  testWidgets('没写一句话时点按钮不许发单（不许把 0 内容也计费）', (tester) async {
    final api = await _pumpEasy(tester, prices: const <String, int>{'per_candidate': 23});
    await tester.tap(find.byType(PrimaryButton).last);
    await tester.pump();
    expect(api.calls, 0, reason: '空 prompt 也要生成 = 花用户的积分出一坨随机东西');
  });
}
