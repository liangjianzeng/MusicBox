import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/db.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import 'creation_state.dart';
import 'style_options.dart';

/// 三档档位名（进度页/暂存架共用，避免各处硬编码）
const kTierLabels = ['简约', '标准', '深度'];

/// 本次任务要素快照：进度页与暂存架都靠它回答「这次到底在按什么生成」。
/// 只装客户端提交时真实知道的参数（含后端回传可用的 seed），不编造后端未给的数据。
class TaskBrief {
  const TaskBrief({
    this.action = '生成',
    this.tierLabel,
    this.sourceLabel,
    this.prompt,
    this.lyrics,
    this.tags = const [],
    this.mood = const [],
    this.vocal,
    this.genre,
    this.bpm,
    this.sec,
    this.count,
    this.personaName,
    this.seed,
    this.modelLabel,
    this.intentId,
    this.extra = const {},
  });

  /// 动作文案：生成 / 微调 / 延长 / 翻唱 / 实验 / 音频处理
  final String action;
  final String? tierLabel; // 简约 / 标准 / 深度
  final String? sourceLabel; // 一句话 / 按住说话 / 拍一张 / 意图卡
  final String? prompt;
  final String? lyrics;
  final List<String> tags;
  final List<String> mood;
  final String? vocal; // 人声演唱 / 纯音乐
  final String? genre;
  final int? bpm;
  final int? sec;
  final int? count;
  final String? personaName;
  final int? seed;
  final String? modelLabel;
  final String? intentId;

  /// 兜底要素（调用方特有的键值，例如 DSP 的 op 参数）
  final Map<String, String> extra;

  bool get isEmpty => toRows().isEmpty;

  /// 要素行（label/value），空值自动剔除，供 UI 直接渲染
  List<TaskFact> toRows() => [
        if (sourceLabel != null && sourceLabel!.isNotEmpty)
          TaskFact('灵感来源', sourceLabel!),
        if (prompt != null && prompt!.isNotEmpty) TaskFact('灵感描述', prompt!),
        if (lyrics != null && lyrics!.isNotEmpty)
          TaskFact('歌词', lyrics!.trim().replaceAll(RegExp(r'\s+'), ' '),
              multiline: true),
        if (mood.isNotEmpty) TaskFact('心情', mood.join(' / ')),
        // 深度档选择项发的是英文规范词（guofeng/synth…，模型要吃的形态）；
        // 要素卡是给人看的，必须翻回中文——用户在 chips 上点的是「国风」「合成器」，
        // 这里不能让他看到另一个世界的词。目录外的自由补充原样显示，不编造翻译。
        if (tags.isNotEmpty)
          TaskFact('风格', tags.map((t) => StyleCatalog.fallback.zhFor(t)).join(' / ')),
        if (genre != null && genre!.isNotEmpty) TaskFact('流派', genre!),
        if (vocal != null && vocal!.isNotEmpty) TaskFact('人声', vocal!),
        if (bpm != null) TaskFact('速度 BPM', '$bpm'),
        if (sec != null) TaskFact('目标时长', '${sec}s'),
        if (count != null) TaskFact('候选数量', '$count 首'),
        if (personaName != null && personaName!.isNotEmpty)
          TaskFact('声音人格', personaName!),
        if (seed != null) TaskFact('随机种子', '$seed'),
        if (modelLabel != null && modelLabel!.isNotEmpty)
          TaskFact('生成模型', modelLabel!),
        ...extra.entries.map((e) => TaskFact(e.key, e.value)),
      ];

  /// 一行摘要：深度 · 3 首 · 60s · 速度 100
  String get headline => [
        if (tierLabel != null && tierLabel!.isNotEmpty) tierLabel!,
        if (count != null) '$count 首',
        if (sec != null) '${sec}s',
        if (bpm != null) '速度 $bpm',
        if (vocal != null && vocal!.isNotEmpty) vocal!,
      ].join(' · ');

  /// 从三档共享状态树构造（简约/标准/深度共用）
  static TaskBrief fromCreation(
    CreationState st, {
    String action = '生成',
    String? prompt,
    String? lyrics,
    List<String>? tags,
    String? modelLabel,
    int? seed,
    String? personaName,
    int? count,
  }) {
    final tagList = (tags ??
            st.tags
                .split(RegExp('[,，\\s]+'))
                .where((e) => e.trim().isNotEmpty)
                .map((e) => e.trim())
                .toList())
        .where((e) => e.isNotEmpty)
        .toList();
    return TaskBrief(
      action: action,
      tierLabel: kTierLabels[st.tier.clamp(0, 2)],
      prompt: (prompt ?? st.prompt).trim(),
      lyrics: (lyrics ?? st.lyrics).trim(),
      tags: tagList,
      mood: st.mood,
      genre: st.genre,
      vocal: st.instrumental ? '纯音乐' : '人声演唱',
      bpm: st.bpm,
      sec: st.sec,
      count: count ?? st.count,
      personaName: personaName,
      seed: seed ?? st.seed,
      modelLabel: modelLabel,
      intentId: st.intentId,
    );
  }

  /// 派生一份改过个别要素的快照（微调/延长等复用同一次创作的参数）
  TaskBrief copyLike({
    String? action,
    String? tierLabel,
    String? sourceLabel,
    String? prompt,
    String? lyrics,
    List<String>? tags,
    List<String>? mood,
    String? vocal,
    String? genre,
    int? bpm,
    int? sec,
    int? count,
    String? personaName,
    int? seed,
    String? modelLabel,
    String? intentId,
  }) =>
      TaskBrief(
        action: action ?? this.action,
        tierLabel: tierLabel ?? this.tierLabel,
        sourceLabel: sourceLabel ?? this.sourceLabel,
        prompt: prompt ?? this.prompt,
        lyrics: lyrics ?? this.lyrics,
        tags: tags ?? this.tags,
        mood: mood ?? this.mood,
        vocal: vocal ?? this.vocal,
        genre: genre ?? this.genre,
        bpm: bpm ?? this.bpm,
        sec: sec ?? this.sec,
        count: count ?? this.count,
        personaName: personaName ?? this.personaName,
        seed: seed ?? this.seed,
        modelLabel: modelLabel ?? this.modelLabel,
        intentId: intentId ?? this.intentId,
        extra: extra,
      );

  Map<String, dynamic> toJson() => {
        'action': action,
        'tier': tierLabel,
        'source': sourceLabel,
        'prompt': prompt,
        'lyrics': lyrics,
        'tags': tags,
        'mood': mood,
        'vocal': vocal,
        'genre': genre,
        'bpm': bpm,
        'sec': sec,
        'count': count,
        'persona': personaName,
        'seed': seed,
        'model': modelLabel,
        'intent_id': intentId,
        'extra': extra,
      };

  factory TaskBrief.fromJson(Map m) => TaskBrief(
        action: '${m['action'] ?? '生成'}',
        tierLabel: m['tier']?.toString(),
        sourceLabel: m['source']?.toString(),
        prompt: m['prompt']?.toString(),
        lyrics: m['lyrics']?.toString(),
        tags: _strList(m['tags']),
        mood: _strList(m['mood']),
        vocal: m['vocal']?.toString(),
        genre: m['genre']?.toString(),
        bpm: m['bpm'] == null ? null : int.tryParse('${m['bpm']}'),
        sec: m['sec'] == null ? null : int.tryParse('${m['sec']}'),
        count: m['count'] == null ? null : int.tryParse('${m['count']}'),
        personaName: m['persona']?.toString(),
        seed: m['seed'] == null ? null : int.tryParse('${m['seed']}'),
        modelLabel: m['model']?.toString(),
        intentId: m['intent_id']?.toString(),
        extra:
            (m['extra'] as Map? ?? const {}).map((k, v) => MapEntry('$k', '$v')),
      );

  static List<String> _strList(dynamic v) => v is List
      ? v.map((e) => '$e').where((e) => e.isNotEmpty).toList()
      : const [];
}

/// 一条要素（label + value）；multiline=true 时 UI 可展开显示更多
class TaskFact {
  const TaskFact(this.label, this.value, {this.multiline = false});
  final String label;
  final String value;
  final bool multiline;
}

/// 暂存架条目：一次生成的候选会话。存 jobId 而非只存音频地址——
/// 重新打开时先回源 GET /v1/jobs/:id 取最新可用产物，本地候选只作离线兜底。
class ShelfSession {
  ShelfSession({
    required this.jobId,
    required this.title,
    required this.brief,
    this.candidates = const [],
    this.adopted = const {},
    required this.createdAt,
    required this.updatedAt,
  });

  final String jobId;
  final String title;
  final TaskBrief brief;
  final List<Candidate> candidates;
  final Map<String, String> adopted; // candidateId -> 已收下的 workId
  final int createdAt; // 秒
  final int updatedAt; // 秒

  int get adoptedCount => adopted.length;

  ShelfSession copyWith({
    String? title,
    TaskBrief? brief,
    List<Candidate>? candidates,
    Map<String, String>? adopted,
    int? updatedAt,
  }) =>
      ShelfSession(
        jobId: jobId,
        title: title ?? this.title,
        brief: brief ?? this.brief,
        candidates: candidates ?? this.candidates,
        adopted: adopted ?? this.adopted,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
      );

  Map<String, Object?> toRow() => {
        'job_id': jobId,
        'title': title,
        'brief': jsonEncode(brief.toJson()),
        'candidates': jsonEncode(candidates.map(_candidateJson).toList()),
        'adopted': jsonEncode(adopted),
        'created_at': createdAt,
        'updated_at': updatedAt,
      };

  factory ShelfSession.fromRow(Map<String, Object?> row) {
    Map<String, String> adopted = const {};
    try {
      final a = jsonDecode((row['adopted'] as String?) ?? '{}');
      if (a is Map) adopted = a.map((k, v) => MapEntry('$k', '$v'));
    } catch (_) {}
    return ShelfSession(
      jobId: '${row['job_id'] ?? ''}',
      title: '${row['title'] ?? ''}',
      brief: TaskBrief.fromJson(
          (jsonDecode((row['brief'] as String?) ?? '{}') as Map?) ?? const {}),
      candidates: _decodeList(row['candidates'] as String?),
      adopted: adopted,
      createdAt: (row['created_at'] as int?) ?? 0,
      updatedAt: (row['updated_at'] as int?) ?? 0,
    );
  }

  static List<Candidate> _decodeList(String? raw) {
    if (raw == null || raw.isEmpty) return const [];
    try {
      final l = jsonDecode(raw);
      if (l is List) return l.whereType<Map>().map(Candidate.fromMap).toList();
    } catch (_) {}
    return const [];
  }

  static Map<String, dynamic> _candidateJson(Candidate c) => {
        'id': c.id,
        'seq': c.seq,
        'title': c.title,
        'audio_url': c.audioUrl,
        'duration_sec': c.durationSec,
        'format': c.format,
        'waveform_url': c.waveformUrl,
        'meta': c.meta,
      };
}

/// 暂存架状态：曲库「暂存 N」筛选片、揭晓页退出留存都读它
class ShelfNotifier extends StateNotifier<List<ShelfSession>> {
  ShelfNotifier(this._db) : super(const []) {
    _load();
  }

  final LocalDb _db;

  Future<void> _load() async {
    try {
      final rows = await _db.shelfRows();
      state = rows.map(ShelfSession.fromRow).toList();
    } catch (_) {}
  }

  /// 写入/更新一次生成会话（保留首次 createdAt，条目自动滚动淘汰到最近 8 次）
  Future<ShelfSession> save({
    required String jobId,
    required String title,
    required TaskBrief brief,
    List<Candidate>? candidates,
    Map<String, String>? adopted,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final prevRow = await _db.shelfRow(jobId);
    final prev = prevRow == null ? null : ShelfSession.fromRow(prevRow);
    final session = ShelfSession(
      jobId: jobId,
      title: title,
      brief: brief,
      candidates: candidates ?? prev?.candidates ?? const [],
      adopted: adopted ?? prev?.adopted ?? const {},
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    );
    await _db.saveShelfRow(session.toRow());
    await _load();
    return session;
  }

  /// 记一次「收下」：只合并 adopted，不整体覆盖
  Future<void> markAdopted(
      String jobId, String candidateId, String workId) async {
    final row = await _db.shelfRow(jobId);
    if (row == null) return;
    final cur = ShelfSession.fromRow(row);
    await _db.saveShelfRow(cur
        .copyWith(
            adopted: {...cur.adopted, candidateId: workId},
            updatedAt: DateTime.now().millisecondsSinceEpoch ~/ 1000)
        .toRow());
    await _load();
  }

  Future<void> remove(String jobId) async {
    await _db.removeShelfRow(jobId);
    await _load();
  }

  /// 某次生成的候选已全部收下 → 从暂存架摘掉（暂存架只放「还没处理完」的）
  Future<void> pruneFullyAdopted() async {
    final done = state
        .where((s) =>
            s.candidates.isNotEmpty &&
            s.candidates.every((c) => s.adopted.containsKey(c.id)))
        .map((s) => s.jobId)
        .toList();
    for (final id in done) {
      await remove(id);
    }
  }
}

final shelfProvider =
    StateNotifierProvider<ShelfNotifier, List<ShelfSession>>((ref) {
  return ShelfNotifier(ref.watch(localDbProvider));
});
