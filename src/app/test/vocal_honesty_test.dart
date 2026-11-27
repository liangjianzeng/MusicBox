import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/models.dart';

/// 2026-11-28 小米13 真机现场：用户在深度档选了「人声演唱」，歌词留空（界面写着
/// 「留空则由 AI 自动填词」—— 而那个功能全仓零实现），派单载荷原样是
/// `{"lyrics":"", "instrumental":false}`，引擎没有歌词可唱，出的就是**纯音乐**。
/// 用户的第一反应是「这不是纯音乐么？」—— 他说得对，是我们在说谎。
///
/// 执行器那半由判词 V40-①…④ 钉（test/acceptance/v40_vocal_honesty.test.js）：
/// 不许拿 instrumental:false 去骗引擎，且必须落 `meta.vocal`。
/// 这里钉端侧这半：**回执读不到 / 读错了，界面就永远不说破**（和 v5.6.9 的 clone 同一课）。
Candidate _cand(Map<String, dynamic> meta) => Candidate.fromMap(<String, dynamic>{
      'id': 'c_v40',
      'seq': 1,
      'title': '夜晚 · 候选1',
      'audio_url': 'http://x/a.mp3',
      'duration_sec': 45,
      'format': 'mp3',
      'meta': meta,
    });

void main() {
  group('「要人声」的兑现回执（v5.6.14）', () {
    test('要了人声、给的是纯音乐 → 必须判定为未兑现，且说得出原因', () {
      final c = _cand(<String, dynamic>{
        'vocal': <String, dynamic>{
          'requested': true,
          'delivered': false,
          'reason': 'no_lyrics',
        },
      });
      expect(c.vocalUnmet, isTrue, reason: '选了人声却拿到纯音乐，界面必须说破');
      expect(c.vocalUnmetReason, contains('纯音乐'));
      expect(c.vocalUnmetReason, contains('写词'),
          reason: '要说清是"AI 写词没实现"，用户才知道不是自己歌词写得不好');
    });

    test('老快照只把它嵌在 raw.meta 里也必须认出来', () {
      // 真机 2026-11-27 的同一课：数据诚实、读的人读不到 = 对用户就是说谎
      final c = _cand(<String, dynamic>{
        'seed': 424242,
        'raw': <String, dynamic>{
          'meta': <String, dynamic>{
            'vocal': <String, dynamic>{
              'requested': true,
              'delivered': false,
              'reason': 'no_lyrics',
            },
          },
        },
      });
      expect(c.vocalUnmet, isTrue, reason: '只读根上的 meta.vocal 会让这条永远不报警');
    });

    test('真给了歌词、人声做到了 → 不许误报', () {
      final c = _cand(<String, dynamic>{
        'vocal': <String, dynamic>{
          'requested': true,
          'delivered': true,
          'reason': null,
        },
      });
      expect(c.vocalUnmet, isFalse, reason: '兑现了的歌不该被扣上"其实是纯音乐"');
    });

    test('用户本来就要纯音乐 → 根本不许冒出这个告警', () {
      // 执行器只在 requested=true 时留这个块；这里再钉一次端侧判断：
      // 没有 requested 就不许凭空告状，否则纯音乐用户每条都看到莫名其妙的红条
      expect(_cand(<String, dynamic>{}).vocalUnmet, isFalse);
      expect(_cand(<String, dynamic>{
        'vocal': <String, dynamic>{'delivered': false},
      }).vocalUnmet, isFalse, reason: '没要过人声，delivered 单独为假不构成"没兑现"');
      expect(_cand(<String, dynamic>{
        'vocal': <String, dynamic>{'requested': false, 'delivered': false},
      }).vocalUnmet, isFalse);
    });
  });

}
