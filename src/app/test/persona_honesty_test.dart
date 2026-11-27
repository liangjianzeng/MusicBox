import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/models.dart';

/// 2026-11-27 小米13 真机的第二条现场：meta 里明明写着
/// `stage2_failed:true / stage2_error:"MUSIC_HTTP"`，揭晓页却什么都不显示。
/// 查下来是 clone 藏在 `raw.meta.clone`，端侧只读 `meta.clone` —— **数据诚实、读的人读不到，
/// 对用户就是说谎**。服务端归位由判词 V37-⑩ 钉（test/acceptance/v37_clone_honesty.test.js），
/// 这里钉端侧自己那半：两种形状都必须认，自相矛盾的谎话数据必须以"失败"为准。
Candidate _cand(Map meta) => Candidate.fromMap(<String, dynamic>{
      'id': 'c_test',
      'seq': 1,
      'title': '中性 · 候选1',
      'audio_url': 'http://x/a.mp3',
      'duration_sec': 45,
      'format': 'mp3',
      'meta': meta,
    });

void main() {
  // 真机实测形状：clone 只在 raw.meta 下面（老服务端 / 老本地快照）
  const nestedOnly = <String, dynamic>{
    'seed': 478663,
    'gen': null,
    'raw': <String, dynamic>{
      'seq': 1,
      'meta': <String, dynamic>{
        'clone': <String, dynamic>{
          'applied': false,
          'attempted': true,
          'stage2_failed': true,
          'mode': 'fast',
          'cover_strength': 1,
          'stage2_error': 'MUSIC_HTTP',
        },
      },
    },
  };

  test('嵌套形状（raw.meta.clone）也必须判定为"没套上"', () {
    final c = _cand(nestedOnly);
    expect(c.personaFailed, isTrue,
        reason: 'clone 埋在 raw.meta 里就不报错 = 揭晓页永远沉默（真机现场）');
    expect(c.personaApplied, isFalse);
    expect(c.personaFailReason, contains('MUSIC_HTTP'));
  });

  test('归位后的形状（根上 meta.clone）判定一致', () {
    final c = _cand(<String, dynamic>{
      'seed': 1,
      'clone': <String, dynamic>{
        'applied': false,
        'attempted': true,
        'stage2_failed': true,
        'cover_strength': 1,
        'stage2_error': 'MUSIC_HTTP',
      },
    });
    expect(c.personaFailed, isTrue);
    expect(c.personaApplied, isFalse);
  });

  test('自相矛盾的谎话数据（applied:true + stage2_failed:true）必须以失败为准', () {
    // 历史 bug：执行器在发起 cover 之前就写了 applied:true，失败分支只补 stage2_failed，
    // 于是同一条 meta 同时说"用了你的人格"和"变声失败"。用户看到的是"我的声线难听"，
    // 真相是他拿到的根本是默认音色。
    final c = _cand(<String, dynamic>{
      'clone': <String, dynamic>{
        'applied': true,
        'stage2_failed': true,
        'stage2_error': 'MUSIC_HTTP',
      },
    });
    expect(c.personaFailed, isTrue,
        reason: '只要阶段②失败过，applied 说什么都不算（契约 v5.6.1）');
    expect(c.personaFailReason, isNotEmpty);
  });

  test('真套上了才算套上，且不许报失败', () {
    final c = _cand(<String, dynamic>{
      'clone': <String, dynamic>{
        'applied': true,
        'attempted': true,
        'stage2_failed': false,
        'cover_strength': 1,
      },
    });
    expect(c.personaApplied, isTrue);
    expect(c.personaFailed, isFalse);
  });

  test('跨机读不到声纹时要把部署缺口说清楚，不许只丢一个 MUSIC_HTTP', () {
    final c = _cand(<String, dynamic>{
      'clone': <String, dynamic>{
        'applied': false,
        'attempted': true,
        'stage2_failed': true,
        'stage2_error': 'MUSIC_HTTP',
        'ref_path': '/tmp/mb-dev/voices/2026-11/f_x.wav',
        'engine': '100.100.140.75:8190',
      },
    });
    final r = c.personaFailReason;
    expect(r, contains('MUSIC_HTTP'));
    expect(r, contains('100.100.140.75:8190'), reason: '引擎地址要可见，否则每次都得翻执行器日志');
    expect(r, anyOf(contains('读不到'), contains('跨机')),
        reason: '要说人话：这是部署缺口，不是用户人格没录好');
  });

  test('声纹取不到 / 强度非法各自报得出名字', () {
    expect(
        _cand(<String, dynamic>{
          'clone': <String, dynamic>{'applied': false, 'ref_unavailable': true}
        }).personaFailReason,
        contains('声纹'));
    expect(
        _cand(<String, dynamic>{
          'clone': <String, dynamic>{'applied': false, 'invalid_strength': true}
        }).personaFailReason,
        contains('强度'));
  });

  test('没有 clone 时不许假装成功', () {
    final c = _cand(<String, dynamic>{'seed': 1});
    expect(c.personaApplied, isFalse);
    expect(c.personaFailed, isFalse, reason: '没试过不算失败，但也不能算套上');
  });
}
