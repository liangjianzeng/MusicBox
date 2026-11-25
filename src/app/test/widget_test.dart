// 模型解析冒烟测试（不依赖网络）
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/models.dart';
import 'package:musicbox/features/create/shelf_store.dart';

void main() {
  test('Work 解析与缓存序列化', () {
    final w = Work.fromMap({
      'id': 'w1',
      'title': '雨天咖啡馆',
      'status': 'published',
      'mood': '治愈',
      'genres': ['爵士', 'Bossa'],
      'bpm': 92,
      'duration_sec': 83.4,
      'gen': {'engine': 'internal-x', 'seed': 42},
      'lineage': {'kind': 'adjust', 'parent_id': 'w0', 'depth': 2},
      'rating': 4,
      'ai_label': true,
      'visibility': 'public',
      'audio_url': 'http://x/a.mp3',
      'created_at': 1700000000,
    });
    expect(w.id, 'w1');
    expect(w.seed, 42);
    expect(w.lineageKind, 'adjust');
    expect(w.depth, 2);
    expect(w.aiLabel, isTrue);
    // engine 不进入 UI：toMap 不含引擎名
    expect(w.toMap().containsKey('engine'), isFalse);
    expect(Work.fromMap(w.toMap()).title, '雨天咖啡馆');
  });

  test('Intent 解析：题目/推荐/置信度', () {
    final i = Intent.fromMap({
      'id': 'i1',
      'source_kind': 'voice',
      'status': 'clarifying',
      'mood': ['治愈'],
      'genre_hypotheses': ['爵士'],
      'vocal': 'song',
      'confidence': 0.6,
      'questions': [
        {
          'q_idx': 0,
          'q': '想要快一点还是慢一点？',
          'options': [
            {'idx': 0, 'label': '慢一点'},
            {'idx': 1, 'label': '快一点'},
          ],
          'recommended_idx': 0,
        }
      ],
    });
    expect(i.clarifying, isTrue);
    expect(i.questions.single.recommendedIdx, 0);
    expect(i.questions.single.options.length, 2);
  });

  test('SeedPack 分享文案不含引擎名', () {
    final sp = SeedPack.fromMap({
      'prompt': '雨天爵士',
      'tags': ['jazz'],
      'bpm': 90,
      'sec': 60,
      'seed': 7,
      'engine': 'internal-x',
    });
    final text = sp.toShareText(title: 't');
    expect(text.contains('internal-x'), isFalse);
    expect(text.contains('Seed：7'), isTrue);
  });

  test('时间戳解析：服务端 ISO 字符串不再塌成 0（曲库/暂存架时间显示）', () {
    final iso = Work.fromMap({
      'id': 'w1', 'title': 't', 'status': 'draft',
      'created_at': '2026-11-24T10:12:33.000Z',
    });
    expect(iso.createdAt,
        DateTime.parse('2026-11-24T10:12:33.000Z').millisecondsSinceEpoch ~/ 1000);
    expect(iso.createdAt > 1700000000, isTrue); // 曾恒为 0 → 1970
    expect(
        Work.fromMap({
          'id': 'w2', 'title': 't', 'status': 'draft', 'created_at': 1700000000
        }).createdAt,
        1700000000); // 本地缓存的秒级 int 原样
    expect(
        Work.fromMap({
          'id': 'w3', 'title': 't', 'status': 'draft', 'created_at': 1700000000123
        }).createdAt,
        1700000000); // 13 位当毫秒归一
    expect(
        Work.fromMap({
          'id': 'w4', 'title': 't', 'status': 'draft', 'created_at': '1700000000'
        }).createdAt,
        1700000000);
    expect(
        Work.fromMap({
          'id': 'w5', 'title': 't', 'status': 'draft', 'created_at': 'n/a'
        }).createdAt,
        0); // 认不出就 0，不编一个时间
  });

  test('暂存架：要素与候选/收下状态可完整回灌（重开续听不丢）', () {
    const base = TaskBrief(
        action: '生成', tierLabel: '简约', sourceLabel: '一句话', count: 3);
    final brief = base.copyLike(
        prompt: '雨夜霓虹下的独自行走', mood: const ['治愈'], tags: const ['爵士'], bpm: 92, sec: 60);
    final s = ShelfSession(
      jobId: 'j1',
      title: '雨夜霓虹下的独自行走',
      brief: brief,
      candidates: [
        Candidate.fromMap({
          'id': 'c1',
          'seq': 1,
          'title': '候选一',
          'audio_url': 'http://x/a.mp3',
          'duration_sec': 45.2,
          'format': 'mp3',
          'waveform_url': 'http://x/a.json',
        })
      ],
      adopted: const {'c1': 'w1'},
      createdAt: 1700000000,
      updatedAt: 1700000060,
    );
    final back = ShelfSession.fromRow(s.toRow());
    expect(back.jobId, 'j1');
    expect(back.brief.prompt, '雨夜霓虹下的独自行走');
    expect(back.brief.tierLabel, '简约');
    expect(back.brief.toRows().any((r) => r.value.contains('治愈')), isTrue);
    expect(back.adopted['c1'], 'w1'); // 「已收下」只有本地知道，必须能回来
    expect(back.candidates.single.audioUrl, 'http://x/a.mp3');
    expect(back.candidates.single.durationSec, closeTo(45.2, 0.01));
    expect(back.createdAt, 1700000000);
  });
}
