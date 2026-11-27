import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/features/create/style_options.dart';

/// 详情页/卡片标签中文化的回归钉（六项里的③，2026-11-27 小米13 真机）。
/// 现场：作品详情写着一排 `calm · relax · tipsy`。查下来分两类：
///  · `tipsy` 在服务端真源里是 `微醺` 的 **alias**（规范 en 是 `tipsy vocal`），作品表存的就是别名，
///    而客户端目录是 const 镜像、不带 aliases → 反查只认规范词，翻不回来就整排甩英文；
///  · `calm` / `relax` 真源里根本没有对应条目 —— 那种词**必须原样回显**，
///    在客户端私编一个「平静」就是把词典抄第二份，正是这个项目要杀掉的东西。
void main() {
  const cat = StyleCatalog.fallback;

  group('别名也要翻得回来', () {
    test('库里存 tipsy（微醺的别名）时显示「微醺」，不再甩英文', () {
      expect(cat.zhFor('tipsy'), '微醺');
      // 大小写不敏感（引擎回执见过 Tipsy / TIPSY）
      expect(cat.zhFor('TIPSY'), '微醺');
    });

    test('真机那条作品的整排标签，能翻的都翻成中文', () {
      final shown = cat.displayTags(
          ['female vocal', 'saxophone', 'vinyl crackle', 'tipsy']);
      expect(shown, containsAll(<String>['女声', '萨克斯', '黑胶噪点', '微醺']),
          reason: '用户不需要读引擎词汇表：$shown');
    });

    test('规范词照旧直接命中，不被词头兜底干扰', () {
      expect(cat.zhFor('tipsy vocal'), '微醺');
      expect(cat.zhFor('微醺'), '微醺');
    });
  });

  group('不许编词', () {
    test('真源里没有的词原样回显（不自己造一个中文）', () {
      // calm / relax 就是这种：真要中文化，得往服务端词典加条目，不能在端侧硬编
      expect(cat.zhFor('calm'), 'calm');
      expect(cat.zhFor('relax'), 'relax');
      expect(cat.zhFor('totally_made_up_word'), 'totally_made_up_word');
    });

    test('词头撞上多个条目时不猜，回显', () {
      const ambiguous = StyleCatalog(
        moods: <StyleOption>[],
        genres: <StyleOption>[
          StyleOption('流行', en: 'pop song'),
          StyleOption('流行摇滚', en: 'pop rock'),
        ],
        styleWords: <StyleOption>[],
        voice: <StyleOption>[],
      );
      expect(ambiguous.zhFor('pop'), 'pop',
          reason: '两个规范词都以 pop 开头，猜一个就是瞎翻');
    });

    test('空串与空白不炸', () {
      expect(cat.zhFor(''), '');
      expect(cat.zhFor('   '), '');
      expect(cat.displayTags(<String>['', '  ']), isEmpty);
    });
  });
}
