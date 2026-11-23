// 模型解析冒烟测试（不依赖网络）
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/models.dart';

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
}
