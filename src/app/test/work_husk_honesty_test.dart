import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/models.dart';

/// 六项里的「work_detail 空壳 Work 渲染诚实化」的判词（2026-11-27 小米13 真机现场）：
/// 一条 title/duration/genres/lyrics/audio 全空的骨架，以前被当正经作品渲染成
/// 「未命名作品 · 0:00 · 仅自己」+ 一颗能点的播放键。用户看到的效果是
/// "我的歌变成了一首空歌"，比直接说"这条数据不完整"更让人以为数据丢了。
///
/// 判定抽成 `Work.isHusk`（唯一真源，见 models.dart）。这里钉的是它**认得全**、
/// 也**不误伤**：任何一处把某个字段漏掉，骨架就会重新伪装成正经作品。
Work _w(Map<String, dynamic> over) => Work.fromMap(<String, dynamic>{
      'id': 'w_husk',
      'status': 'done',
      ...over,
    });

void main() {
  Work huskBase() => _w(<String, dynamic>{
        'title': '',
        'duration_sec': 0,
        'genres': <String>[],
        'lyrics': null,
        'audio_url': null,
      });

  test('全空骨架必须判为空壳（真机形制）', () {
    expect(huskBase().isHusk, isTrue);
  });

  test('标题给 null 时也要判为空壳（显示占位符不许把它 smuggle 成正经作品）', () {
    // Work.fromMap 会把 null 标题补成「未命名作品」给 UI 用 —— 判定如果直接看显示标题，
    // 服务端一给 null 骨架就漏网。这条钉住那个坑。
    final w = _w(<String, dynamic>{
      'title': null,
      'duration_sec': 0,
      'genres': <String>[],
      'lyrics': null,
      'audio_url': null,
    });
    expect(w.title, '未命名作品', reason: '显示用占位符照常存在');
    expect(w.isHusk, isTrue, reason: '但占位符不能算"有标题"');
  });

  test('五个字段任一个有内容，就不再是空壳', () {
    expect(huskBase().copyWithAudio().isHusk, isFalse, reason: '有音频就是能听的歌');
    expect(
        _w(<String, dynamic>{
          'title': '有名字的',
          'duration_sec': 0,
          'genres': <String>[],
          'lyrics': null,
          'audio_url': null,
        }).isHusk,
        isFalse,
        reason: '有标题（哪怕没音频）不该被当骨架丢掉');
    expect(
        _w(<String, dynamic>{
          'title': '',
          'duration_sec': 45,
          'genres': <String>[],
          'lyrics': null,
          'audio_url': null,
        }).isHusk,
        isFalse,
        reason: '有时长说明成品存在');
    expect(
        _w(<String, dynamic>{
          'title': '',
          'duration_sec': 0,
          'genres': <String>['女声'],
          'lyrics': null,
          'audio_url': null,
        }).isHusk,
        isFalse,
        reason: '有标签就是有内容');
    expect(
        _w(<String, dynamic>{
          'title': '',
          'duration_sec': 0,
          'genres': <String>[],
          'lyrics': '第一段…',
          'audio_url': null,
        }).isHusk,
        isFalse,
        reason: '歌词是资产（用户明确要求"歌词不能用完就丢"），有歌词就不算空壳');
  });

  test('真叫「未命名作品」且有音频的正常歌不被误伤', () {
    final w = _w(<String, dynamic>{
      'title': '未命名作品',
      'duration_sec': 212,
      'genres': <String>['爵士'],
      'lyrics': '…',
      'audio_url': 'http://x/a.mp3',
    });
    expect(w.isHusk, isFalse);
  });
}

extension on Work {
  Work copyWithAudio() => Work.fromMap(<String, dynamic>{
        'id': 'w_husk',
        'status': 'done',
        'title': '',
        'duration_sec': 0,
        'genres': <String>[],
        'lyrics': null,
        'audio_url': 'http://x/a.mp3',
      });
}
