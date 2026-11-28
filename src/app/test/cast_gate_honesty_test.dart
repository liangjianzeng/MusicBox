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

/// 真人通道（契约 v5.6.20）：候选是**用户原片**的三档轻度处理，mode/denoise 必须一路带到界面。
/// 引擎在这台机器上保不住脸（实测身份余弦 h3-image-cast -0.00~0.24、h3-image-edit 0.05~0.11，
/// 同图为 0.94），所以执行侧不许再拿 AI 造的脸冒充定妆照。
List<Map<String, dynamic>> _photoMaster(List<double?> scores, List<double?> denoise) =>
    <Map<String, dynamic>>[
      for (var i = 0; i < scores.length; i++)
        <String, dynamic>{
          'url': <String>[_u1, _u2, _u3][i],
          'score': scores[i],
          'mode': 'photo_master',
          'denoise': denoise[i],
          'gate': <String, dynamic>{
            'ran': true,
            'attempted': scores.length,
            'scored': scores.where((s) => s != null).length,
            'reason': null,
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

/// 取「…拍定妆视频」那颗按钮本体。
/// 注意：`OutlinedButton.icon(...)` 是**工厂**，产出私有子类，
/// `find.byType(OutlinedButton)` 精确匹配不到（曾据此误判成"按钮没渲染"）。
ButtonStyleButton? _castVideoButton(WidgetTester tester) {
  final label = find.textContaining('拍定妆视频');
  if (label.evaluate().isEmpty) return null;
  final hits = find
      .ancestor(
          of: label,
          matching: find.byWidgetPredicate((w) => w is ButtonStyleButton))
      .evaluate();
  return hits.isEmpty ? null : hits.single.widget as ButtonStyleButton;
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

    testWidgets('真人通道：写清"底是你的原片"并露出每档处理力度（不许当成 AI 定妆照）', (tester) async {
      await _pumpLook(tester,
          _detail(_photoMaster(<double?>[0.80, 0.66, 0.55], <double?>[0.1, 0.2, 0.3])));
      expect(find.textContaining('底是你的原片'), findsOneWidget,
          reason: '真人通道的候选就是用户自己那张照片的处理版，含糊成"定妆照"就是撒谎');
      expect(find.text('处理10%'), findsOneWidget);
      expect(find.text('处理20%'), findsOneWidget);
      expect(find.text('处理30%'), findsOneWidget);
      expect(find.text('80'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('没有 mode 标注（老数据/AI 通道）：不许冒出"原片"这句话', (tester) async {
      await _pumpLook(tester, _detail(_gated(<double?>[0.81, 0.72, 0.63])));
      expect(find.textContaining('底是你的原片'), findsNothing,
          reason: 'mode 未标注时按未知呈现，不许替引擎编一句"这是你的原片"');
      expect(find.textContaining('处理10%'), findsNothing);
      expect(find.textContaining('处理20%'), findsNothing);
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
    testWidgets('没点选时不许「看着已选、点不动」：默认必须真选最高分那张', (tester) async {
      // 旧实现：_pickedCast==null 时把第 0 张画成 selected，但 pickedUrl 仍为空
      // → 「用这张拍定妆视频」是灰的。界面显示"已选"而操作上没选，属于界面承诺了没有的状态。
      // 画布按真机（小米13 1080×2400）给：默认 800×600 时这块在折叠区外，Widget 根本没被构建。
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final d = _detail(_photoMaster(<double?>[0.80, 0.66, 0.55], <double?>[0.1, 0.2, 0.3]));
      // 拍板**之前**的态：服务端还没确认过任何一张。留着 cast_image_url 的话，
      // 老实现会走"服务端已确认"分支照样可点，这条判词就成了摆设（破坏验证打过红才作数）。
      ((d['characters'] as List).first as Map)['cast_image_url'] = null;
      await _pumpLook(tester, d);
      final btn = _castVideoButton(tester);
      expect(btn, isNotNull, reason: '定妆视频入口应当渲染出来');
      expect(btn!.onPressed, isNotNull,
          reason: '三张候选都在、最高分 0.80 已过线，却要求用户先点一下才能拍视频；'
              '而卡片已经把某张画成已选中 —— 显示态与操作态必须同源');
      expect(tester.takeException(), isNull);
    });

    testWidgets('一张候选都没有：不许给出可点的「拍定妆视频」入口', (tester) async {
      // 破坏验证：上一条的绿不能是"按钮永远可点"换来的。
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final d = _detail(<dynamic>[]);
      // 真·无首帧态：_detail 默认塞了服务端已确认的 cast_image_url，
      // 而 step_look 会把它补进候选列表（那也是合法首帧）—— 要测"没得拍"必须一起清掉。
      ((d['characters'] as List).first as Map)['cast_image_url'] = null;
      await _pumpLook(tester, d);
      final btn = _castVideoButton(tester);
      expect(btn == null || btn.onPressed == null, isTrue,
          reason: '没有首帧就没有可拍的东西，入口必须缺席或置灰，不许让人点出一个必然失败的任务');
    });
    testWidgets('没出片时不许顶着「约 5 秒」摆人像：标题要承认未拍，封面要标「未拍」', (tester) async {
      // 起因：默认真选首帧后，MvVideoPlayer(url:null, coverUrl:首帧) 会在
      // 「定妆视频（多角度转头 · 约 5 秒）」标题下画一张定妆照 —— 用户会读成"视频已经好了"。
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final d = _detail(_photoMaster(<double?>[0.80, 0.66, 0.55], <double?>[0.1, 0.2, 0.3]));
      ((d['characters'] as List).first as Map)['cast_video_url'] = null;
      await _pumpLook(tester, d);
      expect(find.textContaining('未拍'), findsWidgets,
          reason: '标题或封面必须有一处明说"还没拍"，否则一张人像配上"约 5 秒"就是界面承诺了没有的能力');
      expect(find.textContaining('约 5 秒'), findsNothing,
          reason: '没出片就不许承诺时长');
      expect(tester.takeException(), isNull);
    });
  });
}
