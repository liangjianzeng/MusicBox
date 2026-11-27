import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config.dart';
import '../../core/state.dart';

/// 三档共享的创作状态树（同一 CreationSession，渐进披露不换资产）
class CreationState {
  const CreationState({
    required this.tier,
    this.prompt = '',
    this.lyrics = '',
    this.tags = '',
    this.mood = const [],
    this.voice = const [],
    this.genre,
    this.instrumental = false,
    this.sec = 45,
    this.bpm = 100,
    this.count = 3,
    this.personaId,
    this.coverStrength,
    this.seed,
    this.intentId,
  });

  final int tier; // 0 简约 / 1 标准 / 2 深度
  final String prompt;
  final String lyrics;
  final String tags;
  final List<String> mood;
  final String? genre;
  final bool instrumental; // false=人声
  /// 人声维度选中项（存中文标签，提交时换算成规范词）：谁来唱 + 怎么唱。
  /// 单独成字段而不是混进 tags 字符串：性别是这首歌最贵的选择，不该和装饰词同锅。
  final List<String> voice;
  final int sec; // 15-240
  final int bpm; // 60-180
  final int count; // 1-4
  final String? personaId;
  /// 音色贴近程度（0=只借编排，1=完全贴这条声线）。选人格时才生效。
  /// 这是唯一能锁住音色/性别的旋钮（引擎只吃 tags/lyrics/prompt/bpm，「女声」在纯文本里锁不住），
  /// 所以必须让用户调，而不是由代码里写死的 0.2 说了算。null=跟随服务端默认。
  final double? coverStrength;
  final int? seed;
  final String? intentId;

  CreationState copyWith({
    int? tier,
    String? prompt,
    String? lyrics,
    String? tags,
    List<String>? mood,
    List<String>? voice,
    String? genre,
    bool? instrumental,
    int? sec,
    int? bpm,
    int? count,
    Object? personaId = _keep,
    Object? coverStrength = _keep,
    Object? seed = _keep,
    String? intentId,
  }) =>
      CreationState(
        tier: tier ?? this.tier,
        prompt: prompt ?? this.prompt,
        lyrics: lyrics ?? this.lyrics,
        tags: tags ?? this.tags,
        mood: mood ?? this.mood,
        voice: voice ?? this.voice,
        genre: genre ?? this.genre,
        instrumental: instrumental ?? this.instrumental,
        sec: sec ?? this.sec,
        bpm: bpm ?? this.bpm,
        count: count ?? this.count,
        personaId: identical(personaId, _keep)
            ? this.personaId
            : personaId as String?,
        coverStrength: identical(coverStrength, _keep)
            ? this.coverStrength
            : coverStrength as double?, // 声明了就必须转发：analyze 看不见没用的参数
        seed: identical(seed, _keep) ? this.seed : seed as int?,
        intentId: intentId ?? this.intentId,
      );

  static const _keep = Object();
}

class CreationNotifier extends StateNotifier<CreationState> {
  CreationNotifier(this._prefs)
      : super(CreationState(
            tier: _prefs.createTier,
            // 「设为默认」必须真的有用。以前 defaultPersonaProvider 定义了却没有任何人读，
            // 用户在人格页点了「设为默认」，创建页照样出默认音色 —— 等于一个骗人的按钮。
            personaId: _prefs.defaultPersonaId,
          ));

  final Prefs _prefs;

  void setTier(int t) {
    state = state.copyWith(tier: t);
    _prefs.setCreateTier(t);
  }

  void setPrompt(String v) => state = state.copyWith(prompt: v);
  void setLyrics(String v) => state = state.copyWith(lyrics: v);
  void setTags(String v) => state = state.copyWith(tags: v);
  void setMood(List<String> v) => state = state.copyWith(mood: v);
  void setGenre(String? v) => state = state.copyWith(genre: v);
  void setInstrumental(bool v) => state = state.copyWith(instrumental: v);
  void setVoice(List<String> v) => state = state.copyWith(voice: v);
  void setSec(int v) => state = state.copyWith(sec: v);
  void setBpm(int v) => state = state.copyWith(bpm: v);
  void setCount(int v) => state = state.copyWith(count: v);
  void setPersona(String? v) => state = state.copyWith(personaId: v);
  void setCoverStrength(double v) => state = state.copyWith(coverStrength: v);
  /// 交回服务端说了算（null=不传 cover_strength，由 config.persona 兜底）
  void resetCoverStrength() => state = state.copyWith(coverStrength: null);
  void setSeed(int? v) => state = state.copyWith(seed: v);
  void setIntent(String? v) => state = state.copyWith(intentId: v);
}

final creationProvider =
    StateNotifierProvider<CreationNotifier, CreationState>((ref) {
  return CreationNotifier(ref.watch(prefsProvider));
});
