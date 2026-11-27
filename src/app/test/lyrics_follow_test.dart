// 歌词能力回归钉（2026-11-27）。
// 现场：用户用深度档填了完整歌词生成歌曲，歌词好好地存在服务端 works.lyrics 里（纯文本 +
// [Verse]/[Chorus] 这类段落标记，**没有逐行时间戳**）。App 之前只把它当一次性生成参数用，
// 播放界面一个字都不显示，更没有"唱到哪一行"。用户原话：「歌词不能用完就丢」。
//
// 这里钉四件事：
// 1) 解析器不许吞字、不许把段落标记当歌词行、极端输入不许崩；
// 2) 「当前行」只能是按行序线性内插出来的近似值 —— 单调、钳制、拿不到就 null；
// 3) 界面必须自证"近似同步 · 未做逐字对齐"，也不许把"没拿到歌词"演成"这首没歌词"；
// 4) 真·播放页接线：有歌词要看得见、自动跟随要真滚、矮屏不许溢出、时长缺失不许瞎亮。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/models.dart';
import 'package:musicbox/features/player/lyrics.dart';
import 'package:musicbox/features/player/lyrics_view.dart';
import 'package:musicbox/features/player/mini_player_bar.dart';
import 'package:musicbox/features/player/player_page.dart';
import 'package:musicbox/features/player/player_provider.dart';

/// 深度档真实形状：段落标记 + 逐行正文，没有一行带时间戳。
const _deepLyrics = '''
[Verse]
沉默了许久谁都没开口
阳台上的衣服安静地荡着谁都没有收

[Pre-Chorus]
风吹过晾衣绳的缺口

[Chorus]
就算没有人为我鼓掌
我也要唱给自己的耳朵听
[Bridge]
数到三就把它还给风
[Outro]
灯灭了 也没关系
''';

/// 把某行渲染出的 Text 抓出来看样式，用来钉"当前行更亮更大"。
List<Text> _allLineTexts(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .where((t) => t.style?.height == 1.5)
    .toList();

int _activeCount(WidgetTester tester) => _allLineTexts(tester)
    .where((t) => t.style?.fontSize == LyricsView.activeFontSize)
    .length;

/// 小节小标题走的是 letterSpacing .6 这一套样式，用它把小标题从一堆文本里挑出来
/// （不能直接 find.text('歌词')：歌词区顶部的栏目标题也叫「歌词」）。
List<String> _headings(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .where((t) => t.style?.letterSpacing == 0.6)
    .map((t) => t.data ?? '')
    .toList();

void main() {
  group('任务详情回吐用户输入（歌词不能用完就丢）', () {
    test('Job.gen 解析出歌词与配方；空串/空白算没有歌词，不许当有词糊上去', () {
      final j = Job.fromMap({
        'id': 'j_1', 'type': 'generate', 'status': 'done', 'progress': 100,
        'gen': {'lyrics': '[Verse]\n甲\n乙', 'mood': '悲伤', 'bpm': 72, 'sec': 240,
                'tags': ['female vocal', 'tipsy vocal'], 'instrumental': false},
      });
      expect(j.gen, isNotNull);
      expect(j.gen!.hasLyrics, isTrue);
      expect(j.gen!.lyrics, contains('甲'));
      expect(j.gen!.mood, '悲伤');
      expect(j.gen!.bpm, 72);
      expect(j.gen!.sec, 240);
      expect(j.gen!.tags, <String>['female vocal', 'tipsy vocal'],
          reason: '带空格规范词必须在端侧也保持一个词，否则又是被切碎的那类缺陷');
      expect(j.gen!.instrumental, isFalse);

      final empty = Job.fromMap({
        'id': 'j_2', 'type': 'generate', 'status': 'done', 'progress': 100,
        'gen': {'lyrics': '   \n  ', 'tags': []},
      });
      expect(empty.gen!.hasLyrics, isFalse, reason: '全空白不是歌词，界面该说"没填词"而不是显示空气');
      expect(Job.fromMap({'id': 'j_3', 'status': 'done'}).gen, isNull,
          reason: '老服务端不下发 gen 时必须安静降级，不许崩');
    });
  });

  group('歌词解析器（parseLyricLines）', () {
    test('段落标记本身不算一行，但作为所属小节挂在每行上', () {
      final lines = parseLyricLines(_deepLyrics);
      expect(lines.map((l) => l.text), <String>[
        '沉默了许久谁都没开口',
        '阳台上的衣服安静地荡着谁都没有收',
        '风吹过晾衣绳的缺口',
        '就算没有人为我鼓掌',
        '我也要唱给自己的耳朵听',
        '数到三就把它还给风',
        '灯灭了 也没关系',
      ], reason: '[Verse] 这类标记是分组提示，不是歌词；当行唱出来就成鬼畜了');
      expect(lines.map((l) => l.section).toSet(),
          containsAll(<String>['Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro']));
      expect(lines[0].section, 'Verse');
      expect(lines[2].section, 'Pre-Chorus');
      expect(lines[5].section, 'Bridge');
    });

    test('每个小节只在首行画一次小标题；同名小节再出现还要再画', () {
      final lines = parseLyricLines('[Verse]\n甲\n乙\n[Chorus]\n丙\n[Verse]\n丁');
      expect(lines.map((l) => l.startsSection), <bool>[true, false, true, true]);
      // 重复的 [Verse] 不能因为"同名"就被当成同一段继续，那是另一遍副歌，得看得见
      final last = lines.last;
      expect(last.section, 'Verse');
      expect(last.startsSection, isTrue);
    });

    test('全文没有小节标记也要能工作：整段当一段，一行不丢', () {
      final lines = parseLyricLines('甲\n乙\n\n丙\n   \n丁');
      expect(lines.length, 4, reason: '没有 [Verse] 不等于没有歌词，照样要能唱跟');
      expect(lines.map((l) => l.section).toSet(), <String>{untitledSection});
      expect(lines.first.startsSection, isTrue);
      expect(lines.skip(1).every((l) => !l.startsSection), isTrue,
          reason: '没出现过的段落标记不许在界面上编一个小标题出来');
    });

    test('连续空行、纯空白行丢弃，不产生空洞行', () {
      final lines = parseLyricLines('\n\n  \n\t\n第一行\n   \n\n   \n第二行\n\n');
      expect(lines.map((l) => l.text), <String>['第一行', '第二行']);
    });

    test('只有段落标记、一行正文都没有 → 空列表（界面走"只有段落标记"空态）', () {
      final lines = parseLyricLines('[Verse]\n\n[Chorus]\n[Outro]');
      expect(lines, isEmpty);
      final sheet = LyricSheet.fromText('[Verse]\n\n[Chorus]');
      expect(sheet.availability, LyricAvailability.tagOnly);
      expect(sheet.hintText, isNotEmpty, reason: '一片空白会让人以为界面坏了');
      expect(sheet.isReady, isFalse);
    });

    test('表外标签原样当小节名；全角【】也认；混着正文的行不吞字', () {
      expect(parseLyricLines('[Hook]\n甲').first.section, 'Hook');
      expect(parseLyricLines('【副歌】\n甲').first.section, '副歌');
      expect(parseLyricLines('[pre-chorus]\n甲').first.section, 'Pre-Chorus',
          reason: '大小写、连字符不敏感，别因为模型写了小写就分不出段');
      final mixed = parseLyricLines('[Chorus] 我来了\n甲');
      expect(mixed.map((l) => l.text), <String>['[Chorus] 我来了', '甲'],
          reason: '整行才是标记；混着正文的行是正文，吞字就是丢歌词');
    });

    test('null（这条数据没带歌词）与空串（确认没填词）是两种空态，文案必须不同', () {
      final notSent = LyricSheet.fromText(null);
      final blank = LyricSheet.fromText('   \n  ');
      expect(notSent.availability, LyricAvailability.unknown);
      expect(blank.availability, LyricAvailability.blank);
      expect(notSent.hintText, isNot(blank.hintText));
      expect(blank.hintText, lyricHintBlank);
      expect(lyricHintBlank, contains('纯音乐或未填词'));
      expect(notSent.hintText, contains('没随这条播放带过来'),
          reason: '候选试听/旧缓存里 lyrics 是 null，说人家"没有歌词"就是界面撒谎');
    });

    test('Work.lyrics 必须原样保住 null 与空串的区别（整套空态判定都压在这上面）', () {
      // 服务端 core/store.js workOf() 发的是 `lyrics: r.lyrics || ''` —— 空串才是"确认没填词"；
      // 候选试听用 Candidate 拼的 Work 根本没这个字段，是 null。哪天有人把解析改成
      // `m['lyrics']?.toString() ?? ''`，候选页就会对着有歌词的歌说"这首没有歌词"。
      final sent = Work.fromMap({
        'id': 'w1', 'title': 't', 'status': 'draft', 'lyrics': '[Verse]\n甲'
      });
      expect(sent.lyrics, '[Verse]\n甲');
      final instrumental =
          Work.fromMap({'id': 'w1', 'title': 't', 'status': 'draft', 'lyrics': ''});
      expect(instrumental.lyrics, '');
      final notSent = Work.fromMap({'id': 'w1', 'title': 't', 'status': 'draft'});
      expect(notSent.lyrics, isNull);
      expect(LyricSheet.fromText(sent.lyrics).availability,
          LyricAvailability.ready);
      expect(LyricSheet.fromText(instrumental.lyrics).availability,
          LyricAvailability.blank);
      expect(LyricSheet.fromText(notSent.lyrics).availability,
          LyricAvailability.unknown);
      expect(Work.fromMap(sent.toMap()).lyrics, '[Verse]\n甲',
          reason: '本地缓存回灌也不能把歌词洗掉');
    });

    test('有正文就是 ready，近似同步文案常驻', () {      final sheet = LyricSheet.fromText(_deepLyrics);
      expect(sheet.isReady, isTrue);
      expect(sheet.hasSectionTags, isTrue);
      expect(sheet.lineCount, 7);
      expect(lyricSyncDisclaimer, contains('近似同步'));
      expect(lyricSyncDisclaimer, contains('未做逐字对齐'));
    });
  });

  group('当前行映射（lyricLineIndex）—— 按行数在时长上线性内插，不是真实对齐', () {
    test('单调不减：位置往后走，高亮行号绝不回退', () {
      int? prev;
      var sawLast = false;
      for (var ms = -1000; ms <= 300000; ms += 137) {
        final i = lyricLineIndex(
            positionSec: ms / 1000.0, durationSec: 183.6, lineCount: 7);
        expect(i, isNotNull);
        if (prev != null) {
          expect(i! >= prev, isTrue,
              reason: '在 ${ms}ms 处行号从 $prev 退回 $i —— 歌词倒着唱就是 bug');
        }
        prev = i;
        if (i == 6) sawLast = true;
      }
      expect(sawLast, isTrue, reason: '唱到最后必须能走到最后一行');
    });

    test('越界钳制：负位置算第 0 行，超过总时长算最后一行', () {
      int idx(double sec) =>
          lyricLineIndex(positionSec: sec, durationSec: 100, lineCount: 4)!;
      expect(idx(-99999), 0);
      expect(idx(0), 0);
      expect(idx(100), 3);
      expect(idx(1e9), 3, reason: '时长还没报准就 seek 到很远，也不许报出界行号');
    });

    test('边界不提前跳行：第 i 行覆盖 [i*d/n, (i+1)*d/n)', () {
      int idx(double sec) =>
          lyricLineIndex(positionSec: sec, durationSec: 100, lineCount: 4)!;
      expect(idx(24.999), 0);
      expect(idx(25), 1);
      expect(idx(49.999), 1);
      expect(idx(50), 2);
      expect(idx(74.999), 2);
      expect(idx(75), 3);
    });

    test('行数 0 / 时长 0 / null / 负数 → 一律 null，一行都不许亮', () {
      expect(lyricLineIndex(positionSec: 5, durationSec: 60, lineCount: 0), isNull,
          reason: '没有行还亮个高亮，就是凭空指位置');
      expect(lyricLineIndex(positionSec: 5, durationSec: 0, lineCount: 7), isNull);
      expect(lyricLineIndex(positionSec: 5, durationSec: null, lineCount: 7), isNull,
          reason: '时长没报上来就猜当前行 = 界面撒谎');
      expect(lyricLineIndex(positionSec: 5, durationSec: -30, lineCount: 7), isNull);
    });

    test('任何非有限输入都不许崩、也不许给出行号', () {
      expect(
          lyricLineIndex(
              positionSec: double.nan, durationSec: 60, lineCount: 7), isNull);
      expect(
          lyricLineIndex(
              positionSec: double.infinity, durationSec: 60, lineCount: 7), isNull);
      expect(
          lyricLineIndex(
              positionSec: 10, durationSec: double.nan, lineCount: 7), isNull);
      expect(
          lyricLineIndex(
              positionSec: 10, durationSec: double.infinity, lineCount: 7), isNull);
    });

    test('超大输入不崩：位置 1e18、行数 20 万仍落在合法区间', () {
      expect(
          lyricLineIndex(
              positionSec: 1e18, durationSec: 0.001, lineCount: 200000), 199999);
      expect(
          lyricLineIndex(
              positionSec: 1e12, durationSec: 1e-9, lineCount: 1), 0);
    });

    test('只有一行时永远高亮第 0 行（别把唯一一行判成"没唱到"）', () {
      for (final sec in [0.0, 1.0, 99.0, 1e6]) {
        expect(lyricLineIndex(positionSec: sec, durationSec: 120, lineCount: 1), 0);
      }
    });

    test('Duration 版与秒版结论一致（界面上用的是 Duration 版）', () {
      for (final ms in [0, 1999, 2000, 45500, 120000]) {
        final a = lyricLineIndex(
            positionSec: ms / 1000.0, durationSec: 60, lineCount: 6);
        final b = lyricLineIndexOf(
            position: Duration(milliseconds: ms),
            duration: const Duration(seconds: 60),
            lineCount: 6);
        expect(b, a, reason: '${ms}ms 处两个入口给出不同行号');
      }
      expect(
          lyricLineIndexOf(
              position: const Duration(seconds: 3),
              duration: null,
              lineCount: 6),
          isNull);
    });
  });

  group('播放页歌词视图（LyricsView）', () {
    Widget wrap(Widget child) => MaterialApp(
          home: Scaffold(body: SizedBox(height: 520, child: child)),
        );

    testWidgets('有歌词：渲染每一行 + 挂「近似同步 · 未做逐字对齐」，不装精确', (tester) async {
      final sheet = LyricSheet.fromText(_deepLyrics);
      await tester.pumpWidget(wrap(LyricsView(
        sheet: sheet,
        activeIndex: 3,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();

      expect(find.text('我也要唱给自己的耳朵听'), findsOneWidget);
      expect(find.text('灯灭了 也没关系'), findsOneWidget);
      expect(find.text(lyricSyncDisclaimer), findsOneWidget,
          reason: '当前行是按行序线性内插猜的，界面必须自证近似，不许长得像精确卡拉 OK');
      expect(find.textContaining('逐字对齐'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('当前行有且只有一行，且比其它行更大更亮', (tester) async {
      final sheet = LyricSheet.fromText(_deepLyrics);
      await tester.pumpWidget(wrap(LyricsView(
        sheet: sheet,
        activeIndex: 3,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();

      expect(_activeCount(tester), 1, reason: '同时亮两行会让人不知道在唱哪句');
      final active = tester.widget<Text>(find.text('就算没有人为我鼓掌'));
      final idle = tester.widget<Text>(find.text('沉默了许久谁都没开口'));
      expect(active.style!.fontSize!, greaterThan(idle.style!.fontSize!));
      expect(active.style!.color, isNot(idle.style!.color),
          reason: '着色跟进：当前行必须一眼分得出来');
      // FontWeight 的 compareTo 是反的，比厚度取 .value，别用 > 直接比
      expect(active.style!.fontWeight!.value,
          greaterThan(idle.style!.fontWeight!.value));
    });

    testWidgets('小节标签作为小标题出现；无标签的歌词不编小标题', (tester) async {
      await tester.pumpWidget(wrap(LyricsView(
        sheet: LyricSheet.fromText(_deepLyrics),
        activeIndex: 0,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();
      expect(_headings(tester),
          containsAll(<String>['Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro']),
          reason: '小节标签要在界面上作为分组小标题露出来');

      await tester.pumpWidget(wrap(LyricsView(
        sheet: LyricSheet.fromText('甲\n乙'),
        activeIndex: null,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();
      expect(_headings(tester), isEmpty,
          reason: '原文里根本没有段落标记，界面上凭空冒一个段名就是编的');
    });

    testWidgets('时长未知：不猜当前行，并写明原因', (tester) async {
      final sheet = LyricSheet.fromText(_deepLyrics);
      await tester.pumpWidget(wrap(LyricsView(
        sheet: sheet,
        activeIndex: null,
        durationKnown: false,
      )));
      await tester.pumpAndSettle();

      expect(_activeCount(tester), 0, reason: '时长都没有，亮出来的行号就是瞎猜');
      expect(find.text(lyricHintDurationUnknown), findsOneWidget);
      expect(find.text('就算没有人为我鼓掌'), findsOneWidget,
          reason: '时长未知只该停掉跟进，不该把歌词也藏起来');
    });

    testWidgets('没歌词给明确空态，不留一片空白', (tester) async {
      for (final pair in const <MapEntry<LyricAvailability, String>>[
        MapEntry(LyricAvailability.blank, lyricHintBlank),
        MapEntry(LyricAvailability.unknown, lyricHintMissing),
        MapEntry(LyricAvailability.unavailable, lyricHintUnavailable),
        MapEntry(LyricAvailability.tagOnly, lyricHintTagOnly),
      ]) {
        await tester.pumpWidget(wrap(LyricsView(
          sheet: LyricSheet.of(pair.key),
          activeIndex: null,
        )));
        await tester.pumpAndSettle();
        expect(find.text(pair.value), findsOneWidget,
            reason: '${pair.key} 态必须有话说，空白会让人以为播放页坏了');
        expect(tester.takeException(), isNull);
      }
    });

    testWidgets('行数为 0 也不崩（解析出 0 行时 activeIndex 恒为 null）', (tester) async {
      expect(
          lyricLineIndex(positionSec: 12, durationSec: 60, lineCount: 0), isNull);
      await tester.pumpWidget(wrap(LyricsView(
        sheet: LyricSheet.fromText(''),
        activeIndex: lyricLineIndex(
            positionSec: 12, durationSec: 60, lineCount: 0),
      )));
      await tester.pumpAndSettle();
      expect(find.text(lyricHintBlank), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('自动滚到当前行：唱到最后一行，歌词必须跟着滚到底', (tester) async {
      // 现场踩过：歌词用 ListView（哪怕传 children）是惰性构建的，目标行还没进视口时
      // GlobalKey 拿不到 context，ensureVisible 直接 no-op —— 界面不报错，但永远停在第一行。
      final sheet = LyricSheet.fromText(_deepLyrics * 12);
      await tester.pumpWidget(wrap(LyricsView(
        sheet: sheet,
        activeIndex: sheet.lineCount - 1,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();
      final pos =
          tester.state<ScrollableState>(find.byType(Scrollable)).position;
      expect(pos.maxScrollExtent, greaterThan(400), reason: '这份歌词得长到能滚，测试才有意义');
      expect(pos.pixels, greaterThan(pos.maxScrollExtent - 160),
          reason: '唱到最后一行歌词还停在顶上，等于没有跟进');
    });

    testWidgets('用户自己往上翻时不被自动跟随抢走，5 秒后恢复跟进', (tester) async {
      final sheet = LyricSheet.fromText(_deepLyrics * 12); // 84 行，够滚
      expect(sheet.lineCount, greaterThan(60));
      await tester.pumpWidget(wrap(LyricsView(
        sheet: sheet,
        activeIndex: sheet.lineCount - 1,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();

      final bottom =
          tester.widget<Scrollable>(find.byType(Scrollable)).controller!.offset;
      expect(bottom, greaterThan(400), reason: '自动跟随应当已经滚到接近底部');

      await tester.drag(find.byType(SingleChildScrollView), const Offset(0, 300));
      await tester.pump();
      final offsetAfterDrag =
          tester.widget<Scrollable>(find.byType(Scrollable)).controller!.offset;
      expect(offsetAfterDrag, lessThan(bottom), reason: '手势先把列表往回拉一段');
      // 松手立刻改当前行：此时应当尊重用户，不回弹
      await tester.pumpWidget(wrap(LyricsView(
        sheet: sheet,
        activeIndex: 1,
        durationKnown: true,
      )));
      await tester.pumpAndSettle();
      expect(
          tester.widget<Scrollable>(find.byType(Scrollable)).controller!.offset,
          offsetAfterDrag,
          reason: '刚翻过的歌词被自动跟随拽走，等于不让人看');

      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(
          tester.widget<Scrollable>(find.byType(Scrollable)).controller!.offset,
          isNot(offsetAfterDrag),
          reason: '停手之后必须恢复跟进，否则歌词就定格在旧位置上了');
    });

    testWidgets('迷你播放条单行态：唱词挂 ≈ 前缀，状态不隐瞒', (tester) async {
      await tester.pumpWidget(wrap(LyricsView(
        sheet: LyricSheet.fromText(_deepLyrics),
        activeIndex: 5,
        durationKnown: true,
        singleLine: true,
      )));
      await tester.pumpAndSettle();
      expect(find.textContaining('≈ 数到三就把它还给风'), findsOneWidget,
          reason: '≈ 是"按行序近似"的自证，不是装饰符');

      await tester.pumpWidget(wrap(LyricsView(
        sheet: LyricSheet.of(LyricAvailability.unknown),
        activeIndex: null,
        singleLine: true,
      )));
      await tester.pumpAndSettle();
      expect(find.textContaining(lyricHintMissing), findsOneWidget);
    });
  });

  group('播放页接线（PlayerPage / 迷你条真组件）', () {
    Work song({String? lyrics = _deepLyrics, double dur = 183.6}) => Work(
          id: 'w1',
          title: '阳台上的衣服',
          status: 'published',
          durationSec: dur,
          createdAt: 1700000000,
          audioUrl: 'https://example.com/a.mp3',
          lyrics: lyrics,
        );

    /// 把播放器塞进 provider 再打开页面。playQueue 不 await：它 setAudioSource 要等
    /// 平台侧回应，测试环境里可能永远不完成；而队列 state 在第一个 await 之前就写好了。
    Future<void> openPage(WidgetTester tester, Work w, {Size? surface}) async {
      if (surface != null) {
        tester.view.physicalSize = surface * 3.0;
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);
      }
      PlayerNotifier? notifier;
      await tester.pumpWidget(ProviderScope(
        overrides: [
          playerProvider.overrideWith((ref) => notifier = PlayerNotifier(ref)),
        ],
        child: const MaterialApp(home: PlayerPage()),
      ));
      await tester.pumpAndSettle();
      notifier!.playQueue([w], 0);
      await tester.pumpAndSettle();
    }

    testWidgets('全屏播放页：有歌词就渲染出来并挂「近似同步」，当前行只亮一行',
        (tester) async {
      await openPage(tester, song());
      expect(find.text(lyricSyncDisclaimer), findsOneWidget);
      expect(find.text('我也要唱给自己的耳朵听'), findsOneWidget);
      expect(find.text('阳台上的衣服'), findsWidgets,
          reason: '标题在头部和队列 chip 各出现一次');
      // 位置流在测试里不动 → 停在第 0 行，但必须恰好亮一行
      expect(_activeCount(tester), 1);
    });

    testWidgets('全屏播放页：纯音乐空态有话说，不留一片空白', (tester) async {
      await openPage(tester, song(lyrics: ''));
      expect(find.text(lyricHintBlank), findsOneWidget);
    });

    testWidgets('矮屏走整页滚动分支，歌词照给，不许 RenderFlex 溢出', (tester) async {
      await openPage(tester, song(), surface: const Size(320, 400));
      expect(find.text(lyricSyncDisclaimer), findsOneWidget,
          reason: '矮屏可以把歌词收进固定视口，但不能干脆不显示歌词');
      final e = tester.takeException();
      expect('$e', isNot(contains('RenderFlex overflowed')),
          reason: '矮屏还让 Expanded 去吸收负剩余，就是这次要钉的崩溃');
    });

    testWidgets('时长 0 的作品：不崩、不瞎高亮，并说明没在跟进', (tester) async {
      await openPage(tester, song(dur: 0));
      expect(find.text(lyricHintDurationUnknown), findsOneWidget);
      expect(_activeCount(tester), 0);
      final e = tester.takeException();
      expect('$e', isNot(contains('RenderFlex overflowed')));
    });

    testWidgets('迷你播放条：副标题位置换成当前行（带 ≈）', (tester) async {
      final w = song();
      // 迷你条在 <640dp 高的矮屏上本来就不显示副标题，这里给个正常高度的机身
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      PlayerNotifier? notifier;
      await tester.pumpWidget(ProviderScope(
        overrides: [
          playerProvider.overrideWith((ref) => notifier = PlayerNotifier(ref)),
        ],
        child: const MaterialApp(home: Scaffold(body: MiniPlayerBar())),
      ));
      await tester.pumpAndSettle();
      notifier!.playQueue([w], 0);
      await tester.pumpAndSettle();
      // 位置停在 0 → 当前行是第 0 行
      expect(find.textContaining('≈ 沉默了许久谁都没开口'), findsOneWidget);
      expect(find.text('AI 生成 · MusicBox'), findsNothing,
          reason: '有歌词时那行占位符要让位给真正在唱的词');
    });
  });
}
