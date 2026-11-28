import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/core/ws_client.dart';
import 'package:musicbox/features/mv/mv_api_client.dart';
import 'package:musicbox/features/mv/mv_models.dart';
import 'package:musicbox/features/mv/mv_state.dart';
import 'package:musicbox/features/mv/steps/step_look.dart';

/// 定妆候选的「身份门控」诚实性判词（契约 v5.6.16，SP-MV-3 口径）。
///
/// 要杀的那类回归：facegate 不可达时，执行侧过去只写一行日志 + 评分缺省、job 照样 done，
/// 于是这一屏把三张**从没和主角脸对照过**的候选摆在用户面前，横幅还写着
/// 「定妆照已回传，点选一张后拍摄定妆视频」。用户挑了主演、扣了积分，等到成片才发现脸不对
/// —— 我们的失败被藏进了用户的损失里。
///
/// 纪律：这里喂的是 `GET /v1/mv/projects/:id` 的**原始 JSON 形状**（不是手搓的 MvCharacter），
/// 所以服务端把 cast_images_json 的形状改坏时这条会红，而不是跟着一起改。
const String _u1 = 'https://mb.test/f/cast_1.png';
const String _u2 = 'https://mb.test/f/cast_2.png';
const String _u3 = 'https://mb.test/f/cast_3.png';

Map<String, dynamic> _detail(Object? castImages) => <String, dynamic>{
      'project': <String, dynamic>{
        'id': 'p1',
        'work_id': 'w1',
        'title': '定妆诚实样片',
        'kind': 'vocal',
        'status': 'scripting',
        'script_ver': 1,
        'est_ver': 'est-hash',
        'created_at': '2026-11-28T00:00:00Z',
      },
      'characters': <dynamic>[
        <String, dynamic>{
          'id': 'c1',
          'project_id': 'p1',
          'gender': 'f',
          'name': '主角',
          'source': 'upload',
          'cast_image_url': _u1,
          'cast_images': castImages,
          'frames': const <dynamic>[],
        },
      ],
      'shots': const <dynamic>[],
      'tickets': const <dynamic>[],
      'assistant': <String, dynamic>{'enabled': false, 'chat_enabled': false},
    };

List<Map<String, dynamic>> _gated(List<double?> scores,
        {bool ran = true, String? reason}) =>
    <Map<String, dynamic>>[
      for (var i = 0; i < scores.length; i++)
        <String, dynamic>{
          'url': <String>[_u1, _u2, _u3][i],
          'score': scores[i],
          'gate': <String, dynamic>{
            'ran': ran,
            'attempted': scores.length,
            'scored': scores.where((s) => s != null).length,
            'reason': reason,
          },
        }
    ];

class _FakeMvApi extends Fake implements MvApiClient {
  _FakeMvApi(this.detail);
  final Map<String, dynamic> detail;

  @override
  Future<Map<String, dynamic>> project(String id) async => detail;
}

Future<void> _pumpLook(WidgetTester tester, Map<String, dynamic> detail) async {
  final api = _FakeMvApi(detail);
  final ws = WsClient(wsUrl: 'ws://127.0.0.1:1/ws', tokenProvider: () => null);
  final container = ProviderContainer(overrides: [
    mvApiClientProvider.overrideWithValue(api),
    wsClientProvider.overrideWithValue(ws),
  ]);
  addTearDown(ws.dispose);
  addTearDown(container.dispose);
  // 真实流程里 wizard.project 由 resumeProject 灌（StepLook 对 null 直接显示「请先在步②确认主演」）
  await container.read(mvWizardProvider('w1').notifier).resumeProject('p1');
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: const MaterialApp(
      // 生产里 StepLook 挂在 MvDetailPage 的 Scaffold 下；少了这层 Material，
      // 候选格子的 InkWell 会直接抛「No Material widget found」。
      home: Scaffold(body: StepLook(workId: 'w1')),
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 200));
}

void main() {
  group('定妆身份门控诚实性（v5.6.16）', () {
    MvCharacter characterFrom(Object? castImages) => MvCharacter.fromMap(
        (_detail(castImages)['characters'] as List).first as Map);

    test('老数据（裸 URL 数组）：候选可读，但门控状态必须是"未标注"而不是"验过了"', () {
      final c = characterFrom(<dynamic>[_u1, _u2, _u3]);
      expect(c.castImages.length, 3,
          reason: '老数据仍要能挑，不能因为扩形状把候选弄没');
      expect(c.castGateRan, isNull,
          reason: '没有 gate 信息=未标注。判成 false 会被写成"没跑成"，判成 true 就是替 facegate 撒谎'
              ' —— 只许 null');
      expect(c.castBestScore, isNull);
    });

    test('新数据：gate.ran=false + reason 必须逐字段透到端上', () {
      final c = characterFrom(
          _gated(<double?>[null, null, null], ran: false, reason: 'unreachable'));
      expect(c.castGateRan, isFalse);
      expect(c.castGateReason, 'unreachable');
      expect(c.castBestScore, isNull);
      expect(c.castImages, <String>[_u1, _u2, _u3],
          reason: '扩成对象后 URL 不许变成 "url: .., score: .." 这种拼接垃圾');
    });

    test('新数据：gate.ran=true 时取最高分作为"最像的一张"依据', () {
      final c = characterFrom(_gated(<double?>[0.81, 0.42, 0.55]));
      expect(c.castGateRan, isTrue);
      expect(c.castBestScore, closeTo(0.81, 1e-9));
    });

    testWidgets('门控没跑成：横幅点名未验脸，格子标「未验」，且不许出现"顺利"文案',
        (tester) async {
      await _pumpLook(tester,
          _detail(_gated(<double?>[null, null, null], ran: false, reason: 'unreachable')));
      expect(find.textContaining('身份门控没跑成'), findsOneWidget);
      expect(find.textContaining('unreachable'), findsOneWidget,
          reason: '原因要露出来，只说"有点问题"等于没说');
      expect(find.text('未验'), findsNWidgets(3));
      expect(find.textContaining('点选一张后拍摄定妆视频'), findsNothing,
          reason: '没验过脸时不许沿用顺利文案，那是把失败藏进用户的损失里');
      expect(tester.takeException(), isNull);
    });

    testWidgets('老数据（gate 未知）同样按未验呈现，不许读成"验过了"', (tester) async {
      await _pumpLook(tester, _detail(<dynamic>[_u1, _u2, _u3]));
      expect(find.textContaining('身份门控没跑成'), findsOneWidget,
          reason: '未标注 ≠ 验过；这里若显示顺利文案，就是端上替一次我们看不见的失败做了担保');
      expect(find.text('未验'), findsNWidgets(3));
      expect(tester.takeException(), isNull);
    });

    testWidgets('过线：不报警，角标露出分数（用户挑"最像的"而不是凭眼缘）', (tester) async {
      await _pumpLook(tester, _detail(_gated(<double?>[0.81, 0.72, 0.63])));
      expect(find.textContaining('身份门控没跑成'), findsNothing);
      expect(find.textContaining('都没过身份门控'), findsNothing);
      expect(find.text('81'), findsOneWidget);
      expect(find.text('未验'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('跑成了但全没过线：点名"都没过"并给出最高分与通过线', (tester) async {
      await _pumpLook(tester, _detail(_gated(<double?>[0.31, 0.28, 0.22])));
      expect(find.textContaining('都没过身份门控'), findsOneWidget);
      expect(find.textContaining('31%'), findsOneWidget);
      expect(find.textContaining('60%'), findsOneWidget,
          reason: '通过线要写出来，否则用户不知道"没过"是没过哪条线');
      expect(find.text('31'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
