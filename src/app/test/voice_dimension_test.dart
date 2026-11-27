// 人声维度回归钉（2026-11-27 真机）。
// 现场：用户在深度档选了「女声」，出来的歌是男声；问他选了什么，「女声」和「钢琴 / 黑胶噪点」
// 排在同一个「风格点缀」组里 —— 因为最初的设计把 女声/男声 当成了风格词。歌声不是曲声：
// 同一份编曲可以女声唱也可以男声唱，可以清醒唱也可以微醺唱。于是"谁来唱"跟装饰词抢同一份
// tags 配额（cap 6），还能被挤掉。这里把分类钉死，防止哪天又被塞回去。
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/features/create/shelf_store.dart';
import 'package:musicbox/features/create/style_options.dart';

void main() {
  group('人声是独立维度（谁在唱 ≠ 怎么编曲）', () {
    test('本地兜底目录里，性别与演唱状态都归人声，且绝不混进风格点缀', () {
      const cat = StyleCatalog.fallback;
      expect(cat.genders.map((e) => e.zh), containsAll(<String>['女声', '男声']));
      expect(cat.deliveries.map((e) => e.zh), containsAll(<String>['微醺', '气声']));
      for (final w in cat.styleWords) {
        expect(w.dim, isNull, reason: '风格点缀不该带人声维度：${w.zh}');
        expect((w.en ?? w.zh).toLowerCase(), isNot(contains('vocal')),
            reason: '${w.zh} 是人声，不该出现在风格点缀里');
      }
    });

    test('微醺属于"怎么唱"，不是心情（开心能微醺唱，难过也能）', () {
      const cat = StyleCatalog.fallback;
      expect(cat.moods.map((e) => e.zh), isNot(contains('微醺')));
      expect(cat.deliveries.map((e) => e.zh), contains('微醺'));
    });

    test('服务端下发 voice 时以服务端为准，缺失时回落本地，绝不留空白', () {
      final remote = StyleCatalog.fromRemote({
        'voice': [
          {'zh': '女声', 'en': 'female vocal', 'dim': 'gender'},
          {'zh': '气声', 'en': 'breathy', 'dim': 'delivery'},
        ],
      });
      expect(remote.genders.length, 1);
      expect(remote.deliveries.map((e) => e.zh), <String>['气声']);
      final empty = StyleCatalog.fromRemote({'voice': <Object>[]});
      expect(empty.voice.length, StyleCatalog.fallback.voice.length,
          reason: '服务端没发也必须能选，选择项不许空白');
    });

    test('展示层把规范词翻回中文；带空格的词不许被切碎、查不到的不许编中文', () {
      const cat = StyleCatalog.fallback;
      // 真机现场：曲库卡片与全屏播放器写的是 `夜晚 · female · vocal · sax…`
      // —— 服务端 util.toArr 把空格当分隔符切碎了 female vocal / vinyl crackle，
      // 界面又直接 join 原始规范词，等于把引擎词汇表甩给用户看。
      expect(cat.displayTags(['female vocal', 'vinyl crackle', 'pop']),
          containsAll(<String>['女声', '黑胶噪点', '流行']));
      expect(cat.displayTags(['female vocal']).first, isNot('female'),
          reason: '带空格规范词不许被切成两截');
      expect(cat.displayTags(['彻夜未眠']), <String>['彻夜未眠'],
          reason: '目录外的词原样回显，不许编中文');
      expect(cat.displayTags(['女声', 'female vocal']), <String>['女声'],
          reason: '中英同义重复出现时只留一个，别把同一件事说两遍');
    });

    test('要素面板也必须按维度分行：性别/唱法不许再混进「风格」', () {
      // 真机截图：「本次是按这些要素生成的」里写着 `风格 微醺 / 气声 / 流行 / 古典 / 女声`。
      // 用户在生成端纠正过的同一件事（歌声≠曲声），这个面板当时漏了 —— 分类必须在**所有**
      // 露出的地方一致，只在生成页做对等于没做。
      const brief = TaskBrief(
        action: '生成',
        tags: ['female vocal', 'tipsy vocal', 'breathy', 'pop', 'classical', 'strings',
              'orchestral', '方言说唱'],
        vocal: '人声演唱',
      );
      final rows = {for (final r in brief.toRows()) r.label: r.value};
      expect(rows.containsKey('风格'), isFalse,
          reason: '维度混排的老行名不许再出现');
      expect(rows['谁在唱'], allOf(contains('女声'), contains('人声演唱')));
      expect(rows['怎么唱'], allOf(contains('微醺'), contains('气声')));
      expect(rows['曲风'], allOf(contains('流行'), contains('古典')));
      expect(rows['质感'], contains('弦乐铺底'));
      // 漂移现场：服务端词典里 orchestral=弦乐铺底，App 本地兜底目录却只写了 strings。
      // 兜底目录查不到的词**必须原样进「其他说法」**而不是被悄悄丢掉（否则用户看到的选择
      // 比实际派单少，等于界面在撒谎）；这条同时把"两个真源"的债留在测试里 visible。
      expect(rows['其他说法'], allOf(contains('orchestral'), contains('方言说唱')));
      expect(rows['谁在唱'], isNot(contains('微醺')), reason: '唱法不是性别');
      expect(rows['曲风'], isNot(contains('女声')), reason: '性别不是曲风');

    });

    test('中文标签换算成派单词；查不到的原样交出，不自造英文词', () {
      const cat = StyleCatalog.fallback;
      expect(cat.wireOf('女声'), 'female vocal');
      expect(cat.wireOf('微醺'), 'tipsy vocal');
      expect(cat.wireOf('没这个词'), '没这个词');
    });
  });
}
