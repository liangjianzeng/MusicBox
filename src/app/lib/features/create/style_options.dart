import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';

/// 创作选择项目录（契约 v3.2 `GET /v1/app/config` → `style_options`）。
///
/// 纪律（第 2 轮 UX 优化实证的坑）：
///  · **中文给用户看，英文规范词喂模型**——生乐引擎 :8190 的 `tags` 吃英文风格词最稳，
///    而中文曲风/心情要靠服务端词典 `dict.scan` 翻译，App 不许自己造英文词；
///  · **服务端词典是唯一真源**，本文件只做同构兜底（离线/首启）。以前 App 硬编一份
///    12+12 的选项、服务端另有一份 24+18，选「激昂/未来感」这类词词典命中不到，
///    BPM/tags 补全静默失效——两份词表各写一份必然漂移， hence 下发。
class StyleOption {
  const StyleOption(this.zh, {this.en, this.bpm});

  /// 界面展示（中文）
  final String zh;

  /// 派单用规范词（英文）；为空表示直接用中文原词（如情绪，引擎本就吃中文）
  final String? en;

  /// 该情绪的典型 BPM（选中的第一项用来给 BPM 滑杆一个合理起点，可再手调）
  final int? bpm;

  String get wire => (en == null || en!.isEmpty) ? zh : en!;
}

/// 心情 24 项（与服务端 ENTRIES(type=mood) 同构）
const kMoodCatalog = <StyleOption>[
  StyleOption('欢快', bpm: 122),
  StyleOption('治愈', bpm: 92),
  StyleOption('平静', bpm: 80),
  StyleOption('助眠', bpm: 62),
  StyleOption('悲伤', bpm: 72),
  StyleOption('忧郁', bpm: 76),
  StyleOption('微醺', bpm: 84),
  StyleOption('浪漫', bpm: 96),
  StyleOption('甜蜜', bpm: 108),
  StyleOption('热血', bpm: 140),
  StyleOption('励志', bpm: 128),
  StyleOption('孤独', bpm: 74),
  StyleOption('思念', bpm: 84),
  StyleOption('怀旧', bpm: 88),
  StyleOption('梦幻', bpm: 90),
  StyleOption('神秘', bpm: 96),
  StyleOption('紧张', bpm: 146),
  StyleOption('史诗', bpm: 110),
  StyleOption('夏日', bpm: 116),
  StyleOption('雨天', bpm: 78),
  StyleOption('清晨', bpm: 100),
  StyleOption('夜晚', bpm: 86),
  StyleOption('节日', bpm: 118),
  StyleOption('童趣', bpm: 112),
  StyleOption('国风', bpm: 98),
];

/// 曲风 18 项（与服务端 ENTRIES(type=genre) 同构）
const kGenreCatalog = <StyleOption>[
  StyleOption('流行', en: 'pop'),
  StyleOption('电子', en: 'electronic'),
  StyleOption('摇滚', en: 'rock'),
  StyleOption('民谣', en: 'folk'),
  StyleOption('古典', en: 'classical'),
  StyleOption('爵士', en: 'jazz'),
  StyleOption('嘻哈', en: 'hiphop'),
  StyleOption('R&B', en: 'rnb'),
  StyleOption('蓝调', en: 'blues'),
  StyleOption('乡村', en: 'country'),
  StyleOption('朋克', en: 'punk'),
  StyleOption('金属', en: 'metal'),
  StyleOption('后摇', en: 'post-rock'),
  StyleOption('轻音乐', en: 'instrumental'),
  StyleOption('LoFi', en: 'lofi'),
  StyleOption('舞曲', en: 'dance'),
  StyleOption('国风', en: 'guofeng'),
  StyleOption('氛围', en: 'ambient'),
];

/// 风格点缀 24 项（原「标签（逗号分隔）」自由文本框的正规替代品）
const kStyleWordCatalog = <StyleOption>[
  StyleOption('复古', en: 'retro'),
  StyleOption('合成器', en: 'synth'),
  StyleOption('空灵', en: 'ethereal'),
  StyleOption('低保真', en: 'lofi'),
  StyleOption('温暖', en: 'warm'),
  StyleOption('弦乐铺底', en: 'strings'),
  StyleOption('钢琴', en: 'piano'),
  StyleOption('电吉他', en: 'electric guitar'),
  StyleOption('木吉他', en: 'acoustic guitar'),
  StyleOption('萨克斯', en: 'saxophone'),
  StyleOption('二胡', en: 'erhu'),
  StyleOption('古筝', en: 'guzheng'),
  StyleOption('鼓点强劲', en: 'heavy drums'),
  StyleOption('鼓机 808', en: '808'),
  StyleOption('现场感', en: 'live'),
  StyleOption('女声', en: 'female vocal'),
  StyleOption('男声', en: 'male vocal'),
  StyleOption('和声层叠', en: 'harmonies'),
  StyleOption('副歌大合唱', en: 'choir'),
  StyleOption('黑胶噪点', en: 'vinyl crackle'),
  StyleOption('大混响', en: 'reverb'),
  StyleOption('节奏切分', en: 'syncopated'),
  StyleOption('情绪渐强', en: 'building'),
  StyleOption('循环洗脑', en: 'hypnotic'),
];

/// 灵感示例（简约档"不知道写什么"时给的可点句子——纯前端文案，不参与派单）
const kInspirationSamples = <String>[
  '雨天咖啡馆的爵士',
  '深夜下班回家的路上',
  '夏天海边的初恋',
  '健身房燃向电子',
  '古风武侠的主题曲',
  '给孩子的安眠摇篮曲',
];

class StyleCatalog {
  const StyleCatalog({
    required this.moods,
    required this.genres,
    required this.styleWords,
  });

  final List<StyleOption> moods;
  final List<StyleOption> genres;
  final List<StyleOption> styleWords;

  static const StyleCatalog fallback = StyleCatalog(
    moods: kMoodCatalog,
    genres: kGenreCatalog,
    styleWords: kStyleWordCatalog,
  );

  /// 远程目录（`style_options`）；任一段缺失/为空即回落本地兜底——
  /// 服务端没下发也要能选，不许把选择项做成空白
  factory StyleCatalog.fromRemote(Map? remote) {
    List<StyleOption> parse(dynamic v, List<StyleOption> dflt, {bool withBpm = false}) {
      if (v is! List || v.isEmpty) return dflt;
      final out = <StyleOption>[];
      for (final e in v.whereType<Map>()) {
        final zh = '${e['zh'] ?? ''}'.trim();
        if (zh.isEmpty) continue;
        final en = '${e['en'] ?? ''}'.trim();
        final bpm = e['bpm'] == null ? null : int.tryParse('${e['bpm']}');
        out.add(StyleOption(zh, en: en.isEmpty ? null : en, bpm: withBpm ? bpm : null));
      }
      return out.isEmpty ? dflt : out;
    }

    return StyleCatalog(
      moods: parse(remote?['moods'], kMoodCatalog, withBpm: true),
      genres: parse(remote?['genres'], kGenreCatalog),
      styleWords: parse(remote?['style_words'], kStyleWordCatalog),
    );
  }

  List<StyleOption> get _all => [...genres, ...styleWords, ...moods];

  /// 英文规范词/未知词 → 中文展示（意图卡的流派假设常是英文 tags）。
  /// 查不到原样回显，绝不编一个中文上去。
  String zhFor(String word) {
    final s = word.trim();
    if (s.isEmpty) return '';
    for (final o in _all) {
      if (o.wire.toLowerCase() == s.toLowerCase() || o.zh == s) return o.zh;
    }
    return s;
  }

  /// 中文或英文都认，返回派单用的规范词
  String? wireFor(String label) {
    final s = label.trim();
    for (final o in _all) {
      if (o.zh == s || o.wire.toLowerCase() == s.toLowerCase()) return o.wire;
    }
    return null;
  }

  /// 选中某心情时的建议 BPM（给滑杆一个合理起点，用户仍可手调）
  int? bpmFor(String zh) {
    for (final o in moods) {
      if (o.zh == zh) return o.bpm;
    }
    return null;
  }

  bool isKnown(String tag) => wireFor(tag) != null;
}

/// 当前生效目录：远程下发优先，未就绪用本地兜底
StyleCatalog styleCatalogOfConfig(RemoteConfig? rc) {
  final so = rc?.data['style_options'];
  return StyleCatalog.fromRemote(so is Map ? so : null);
}

/// 同上（build 里用，随远程配置刷新而重建）
StyleCatalog styleCatalogOf(WidgetRef ref) =>
    styleCatalogOfConfig(ref.watch(remoteConfigProvider));

/// 逗号串 ↔ 标签列表（只按逗号切：英文规范词里有空格，如 "electric guitar"）
List<String> parseTagList(String raw) => raw
    .split(RegExp('[,，]'))
    .map((e) => e.trim())
    .where((e) => e.isNotEmpty)
    .toList();

String joinTagList(List<String> tags) => tags.join(', ');
