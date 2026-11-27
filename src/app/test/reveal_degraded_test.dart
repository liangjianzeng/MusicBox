import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/features/create/reveal_page.dart';

/// 2026-11-27 小米13 真机反馈「暂存的歌曲没法收下」的回归钉。
/// 现场：服务端那条任务已不存在（被 dev 脚本清库清掉了），App 吃本地暂存快照打开了候选页，
/// 收下按钮拿着快照里的「已收下 ✓」把 onPressed 置成 null —— 一颗长得像正常按钮的东西，
/// 点了没反应、没原因、也没有"删掉这条失效暂存"的出路。用户只能反复点，然后来报 bug。
/// 立规矩：**能点必须有反应；不能点必须自证状态（有话说）**。
void main() {
  group('收下按钮判定（adoptButton）', () {
    test('降级态：必须可点，点开给原因与出路；不许显示"已收下"糊弄人', () {
      for (final adopted in [true, false]) {
        final b = adoptButton(degraded: true, adopted: adopted, busy: false);
        expect(b.enabled, isTrue,
            reason: '降级态按钮必须可点 —— 点它是为了说清为什么收不下并给"删除这条暂存"');
        expect(b.text, contains('失效'), reason: '要直说任务已失效');
        expect(b.text, isNot(contains('已收下')),
            reason: '快照里记的收下状态不可信，不能拿它当结论');
        expect(b.loading, isFalse);
      }
    });

    test('正常态：已收下禁用但文案自证；未收下可点；请求中 loading 且不可点', () {
      final kept = adoptButton(degraded: false, adopted: true, busy: false);
      expect(kept.enabled, isFalse);
      expect(kept.text, contains('已收下'));
      expect(kept.reason, isNotNull, reason: '禁用必须说清为什么');
      final fresh = adoptButton(degraded: false, adopted: false, busy: false);
      expect(fresh.enabled, isTrue);
      expect(fresh.text, contains('收下这首'));
      final busy = adoptButton(degraded: false, adopted: false, busy: true);
      expect(busy.enabled, isFalse);
      expect(busy.loading, isTrue);
    });

    test('全组合不变量：只要不可点，就必须带 reason（不许出现没解释的死按钮）', () {
      for (final degraded in [true, false]) {
        for (final adopted in [true, false]) {
          for (final busy in [true, false]) {
            final b = adoptButton(
                degraded: degraded, adopted: adopted, busy: busy);
            if (!b.enabled) {
              expect(b.reason, isNotNull,
                  reason: 'degraded=$degraded adopted=$adopted busy=$busy：'
                      '按钮点不动却什么都不说，就是这次的 bug');
            }
            expect(b.text.trim().isNotEmpty, isTrue);
          }
        }
      }
    });
  });
}
