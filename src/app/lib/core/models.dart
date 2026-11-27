/// 数据模型：与 CONTRACTS.md 的 REST 形状逐字对齐
/// 纪律：gen.engine（引擎型号名）一律不进入任何 UI 字符串
library;

int _asInt(dynamic v, [int d = 0]) =>
    v is int ? v : (v is num ? v.toInt() : int.tryParse('$v') ?? d);

double _asDouble(dynamic v, [double d = 0]) =>
    v is double ? v : (v is num ? v.toDouble() : double.tryParse('$v') ?? d);

List<String> _asStrList(dynamic v) {
  if (v is List) return v.map((e) => '$e').toList();
  return const [];
}

/// 服务端 created_at 是 ISO 字符串，本地缓存里存的是秒级 int：两种都吃。
/// 以前用 _asInt 硬转 ISO → 恒为 0，曲库与「曲库 · 暂存」的时间显示全塌成 1970。
int _asEpochSec(dynamic v) {
  if (v == null) return 0;
  int norm(int n) => n > 100000000000 ? n ~/ 1000 : n; // 13 位当毫秒处理
  if (v is int) return norm(v);
  if (v is num) return norm(v.toInt());
  final s = '$v'.trim();
  if (s.isEmpty) return 0;
  final n = int.tryParse(s);
  if (n != null) return norm(n);
  final dt = DateTime.tryParse(s); // 2026-11-24T10:12:33.000Z
  return dt == null ? 0 : dt.millisecondsSinceEpoch ~/ 1000;
}

class AppUser {
  AppUser(
      {required this.id,
      required this.nickname,
      this.phoneMasked,
      required this.isGuest});

  final String id;
  final String nickname;
  final String? phoneMasked;
  final bool isGuest;

  factory AppUser.fromMap(Map m) => AppUser(
        id: '${m['id'] ?? ''}',
        nickname: '${m['nickname'] ?? '音乐旅人'}',
        phoneMasked: m['phone_masked']?.toString(),
        isGuest: m['is_guest'] == true,
      );
}

class Credits {
  Credits({required this.balance, required this.dailyQuota, required this.dailyUsed});

  final int balance;
  final int dailyQuota;
  final int dailyUsed;

  factory Credits.fromMap(Map m) => Credits(
        balance: _asInt(m['balance']),
        dailyQuota: _asInt(m['daily_quota']),
        dailyUsed: _asInt(m['daily_used']),
      );
}

/// POST /v1/me 响应
class MeInfo {
  MeInfo({required this.user, required this.credits});

  final AppUser user;
  final Credits credits;

  factory MeInfo.fromMap(Map m) => MeInfo(
        user: AppUser.fromMap(m['user'] ?? {}),
        credits: Credits.fromMap(m['credits'] ?? {}),
      );
}

/// candidate = {id, seq, title, audio_url, duration_sec, format, waveform_url, meta}
class JobGen {
  JobGen(
      {this.lyrics,
      this.mood,
      this.bpm,
      this.sec,
      this.tags = const [],
      this.instrumental});

  final String? lyrics;
  final String? mood;
  final int? bpm;
  final int? sec;
  final List<String> tags;
  final bool? instrumental;

  bool get hasLyrics => (lyrics ?? '').trim().isNotEmpty;

  factory JobGen.fromMap(Map m) => JobGen(
        lyrics: m['lyrics']?.toString(),
        mood: m['mood']?.toString(),
        bpm: m['bpm'] == null ? null : _asInt(m['bpm']),
        sec: m['sec'] == null ? null : _asInt(m['sec']),
        tags: _asStrList(m['tags']),
        instrumental: m['instrumental'] == null ? null : m['instrumental'] == true,
      );
}

class Candidate {
  Candidate({
    required this.id,
    required this.seq,
    required this.title,
    required this.audioUrl,
    required this.durationSec,
    required this.format,
    this.waveformUrl,
    this.meta = const {},
  });

  final String id;
  final int seq;
  final String title;
  final String audioUrl;
  final double durationSec;
  final String format;
  final String? waveformUrl;
  final Map meta;

  /// 人格是否**真的**套到了这条成品上。
  /// 引擎的音色/性别锁定只发生在 stage②（cover 变声，ref_audio+cover_strength）；
  /// 那一步失败时执行器诚实标 stage2_failed 且 applied 必为 false。
  /// 端侧必须把它说出来：不能让用户把默认音色当成自己的声线（v5.2.6 禁止"以为克隆生效"）。
  /// 克隆回执的唯一读取入口。首选根上的 `meta.clone`（服务端 store.candidateOf 归位过，
  /// 契约 v5.6.9）；但**老服务端/老快照**只把它放在 `raw.meta.clone` —— 那里读不到就等于
  /// 揭晓页永远不显示「没有套上」（真机 2026-11-27 的现场）。容错不是冗余：静默的乐观
  /// 比诚实的报错更贵。
  Map? get _clone {
    final c = meta['clone'];
    if (c is Map) return c;
    final raw = meta['raw'];
    if (raw is Map) {
      final rm = raw['meta'];
      if (rm is Map) {
        final c2 = rm['clone'];
        if (c2 is Map) return c2;
      }
    }
    return null;
  }

  bool get personaApplied => _clone?['applied'] == true;

  /// 选了人格但这条其实没套上（变声失败 / 声纹取不到 / 强度非法）。
  /// 注意：**只要 stage2_failed 为真就算失败**，哪怕同一份 meta 里还写着 applied:true
  /// （历史上真出现过这种自相矛盾的谎话数据，见契约 v5.6.1）。
  bool get personaFailed {
    final c = _clone;
    if (c == null) return false;
    return c['stage2_failed'] == true ||
        c['ref_unavailable'] == true ||
        c['invalid_strength'] == true;
  }

  String get personaFailReason {
    final c = _clone;
    if (c == null) return '未套用';
    if (c['ref_unavailable'] == true) return '声纹取不到';
    if (c['invalid_strength'] == true) return '强度非法';
    final e = c['stage2_error'];
    // 跨机部署下 MUSIC_HTTP 绝大多数是"引擎那台机器读不到这个路径"（执行器已把 ref_path/engine
    // 落进 meta，见契约 v5.6.10）。把这句说出来，用户才知道这不是"人格没录好"，而是部署缺口。
    if (e == 'MUSIC_HTTP' && c['ref_path'] != null && c['engine'] != null) {
      return '变声失败（MUSIC_HTTP）：引擎 ${c['engine']} 可能读不到这条声纹 ${c['ref_path']}'
          '（跨机部署需要引擎侧声纹通道）';
    }
    return e == null ? '变声失败' : '变声失败（$e）';
  }

  factory Candidate.fromMap(Map m) => Candidate(
        id: '${m['id'] ?? ''}',
        seq: _asInt(m['seq']),
        title: '${m['title'] ?? ''}',
        audioUrl: '${m['audio_url'] ?? ''}',
        durationSec: _asDouble(m['duration_sec']),
        format: '${m['format'] ?? 'mp3'}',
        waveformUrl: m['waveform_url']?.toString(),
        meta: (m['meta'] as Map?) ?? const {},
      );
}

/// work 形状（全接口一致）
class Work {
  Work({
    required this.id,
    required this.title,
    required this.status,
    this.mood,
    this.genres = const [],
    this.bpm,
    required this.durationSec,
    this.lyrics,
    this.language,
    this.seed,
    this.lineageKind = 'origin',
    this.parentId,
    this.depth = 0,
    this.personaId,
    this.rating,
    this.aiLabel = true,
    this.visibility = 'private',
    this.audioUrl,
    this.waveformUrl,
    required this.createdAt,
  });

  final String id;
  final String title;
  final String status;
  final String? mood;
  final List<String> genres;
  final int? bpm;
  final double durationSec;
  final String? lyrics;
  final String? language;
  final int? seed; // gen.seed（engine 不解析、不展示）
  final String lineageKind; // origin/adjust/variation/extend/cover
  final String? parentId;
  final int depth;
  final String? personaId;
  final int? rating;
  final bool aiLabel;
  final String visibility;
  final String? audioUrl;
  final String? waveformUrl;
  final int createdAt;

  /// 数据不完整的"空壳作品"：标题、时长、标签、歌词、音频**全空**。
  /// 判定放在这儿是因为它是**一个判断**，不是页面的私有细节：真机现场是这种对象被当正经作品
  /// 渲染成「未命名作品 · 0:00 · 仅自己」，用户以为"我的歌变成了一首空歌"，比直接报错更吓人。
  /// 端侧任何地方要区分"作品"与"骨架"，都必须走这里，别各写一份（写了就一定会飘）。
  bool get isHusk {
    // fromMap 会把 null 标题补成「未命名作品」显示用；空壳判定必须把这个占位符当"没有标题"，
    // 否则服务端给 null 标题时，骨架就混过了检查（只有五个字段全空才会走到这里，不会误伤
    // 一首真叫「未命名作品」且有音频的正常歌）。
    final t = title.trim();
    return (t.isEmpty || t == '未命名作品') &&
        durationSec <= 0 &&
        genres.isEmpty &&
        (lyrics ?? '').trim().isEmpty &&
        (audioUrl ?? '').isEmpty;
  }

  factory Work.fromMap(Map m) {
    final gen = (m['gen'] as Map?) ?? const {};
    final lineage = (m['lineage'] as Map?) ?? const {};
    return Work(
      id: '${m['id'] ?? ''}',
      title: '${m['title'] ?? '未命名作品'}',
      status: '${m['status'] ?? 'draft'}',
      mood: m['mood']?.toString(),
      genres: _asStrList(m['genres']),
      bpm: m['bpm'] == null ? null : _asInt(m['bpm']),
      durationSec: _asDouble(m['duration_sec']),
      lyrics: m['lyrics']?.toString(),
      language: m['language']?.toString(),
      seed: gen['seed'] == null ? null : _asInt(gen['seed']),
      lineageKind: '${lineage['kind'] ?? 'origin'}',
      parentId: lineage['parent_id']?.toString(),
      depth: _asInt(lineage['depth']),
      personaId: m['persona_id']?.toString(),
      rating: m['rating'] == null ? null : _asInt(m['rating']),
      aiLabel: m['ai_label'] != false,
      visibility: '${m['visibility'] ?? 'private'}',
      audioUrl: m['audio_url']?.toString(),
      waveformUrl: m['waveform_url']?.toString(),
      createdAt: _asEpochSec(m['created_at']),
    );
  }

  Map<String, dynamic> toMap() => {
        'id': id,
        'title': title,
        'status': status,
        'mood': mood,
        'genres': genres,
        'bpm': bpm,
        'duration_sec': durationSec,
      'lyrics': lyrics,
      'language': language,
      'gen': {'seed': seed}, // engine 型号名不落本地、不进 UI
      'lineage': {
        'kind': lineageKind,
        'parent_id': parentId,
        'depth': depth,
      },
      'persona_id': personaId,
        'rating': rating,
        'ai_label': aiLabel,
        'visibility': visibility,
        'audio_url': audioUrl,
        'waveform_url': waveformUrl,
        'created_at': createdAt,
      };

}

/// GET /v1/jobs/:id
class Job {
  Job({
    required this.id,
    required this.type,
    required this.status,
    required this.progress,
    this.note,
    this.candidates,
    this.error,
    this.resultWorkId,
    this.gen,
  });

  final String id;
  final String type;
  final String status; // queued/leased/running/done/failed/canceled
  final int progress;
  final String? note;
  final List<Candidate>? candidates;
  final Map? error;
  final String? resultWorkId;

  /// 用户当初提交的歌词与配方回显（契约 v3.3 `gen`）。
  /// 「歌词不能用完就丢」：候选/暂存架离开生成页后也要能看到当时填的词。
  final JobGen? gen;

  bool get isDone => status == 'done';
  bool get isFailed => status == 'failed' || status == 'canceled';
  bool get isQueued => status == 'queued' || status == 'leased';

  factory Job.fromMap(Map m) {
    List<Candidate>? cands;
    if (m['candidates'] is List) {
      cands = (m['candidates'] as List)
          .whereType<Map>()
          .map(Candidate.fromMap)
          .toList();
    }
    return Job(
      id: '${m['id'] ?? ''}',
      type: '${m['type'] ?? ''}',
      status: '${m['status'] ?? 'queued'}',
      progress: _asInt(m['progress']),
      note: m['note']?.toString(),
      candidates: cands,
      error: m['error'] as Map?,
      resultWorkId: m['result_work_id']?.toString(),
      gen: m['gen'] is Map ? JobGen.fromMap(m['gen'] as Map) : null,
    );
  }
}

/// 意图卡（多模态意图线）
class IntentOption {
  IntentOption({required this.idx, required this.label});

  final int idx;
  final String label;

  factory IntentOption.fromMap(Map m) =>
      IntentOption(idx: _asInt(m['idx']), label: '${m['label'] ?? ''}');
}

class IntentQuestion {
  IntentQuestion(
      {required this.qIdx,
      required this.q,
      required this.options,
      this.recommendedIdx});

  final int qIdx;
  final String q;
  final List<IntentOption> options;
  final int? recommendedIdx;

  factory IntentQuestion.fromMap(Map m) => IntentQuestion(
        qIdx: _asInt(m['q_idx']),
        q: '${m['q'] ?? ''}',
        options: (m['options'] as List? ?? const [])
            .whereType<Map>()
            .map(IntentOption.fromMap)
            .toList(),
        recommendedIdx: m['recommended_idx'] == null
            ? null
            : _asInt(m['recommended_idx']),
      );
}

class IntentAnswer {
  IntentAnswer({required this.qIdx, required this.optionIdx});

  final int qIdx;
  final int optionIdx;

  Map<String, dynamic> toJson() => {'q_idx': qIdx, 'option_idx': optionIdx};
}

class Intent {
  Intent({
    required this.id,
    required this.sourceKind,
    required this.status,
    this.mood = const [],
    this.sceneDesc,
    this.genreHypotheses = const [],
    this.vocal = 'unknown',
    this.durationHint,
    required this.confidence,
    this.questions = const [],
    this.answers = const [],
    this.sourceText,
    this.degraded = false,
    required this.createdAt,
  });

  final String id;
  final String sourceKind; // voice/image/text
  final String status; // clarifying/ready/consumed
  final List<String> mood;
  final String? sceneDesc;
  final List<String> genreHypotheses;
  final String vocal; // song/instrumental/unknown
  final String? durationHint;
  final double confidence;
  final List<IntentQuestion> questions;
  final List<IntentAnswer> answers;

  /// 用户到底说了什么（语音=逐字转写，文本=原话，图片=画面理解）。
  /// 服务端没给就是 null —— 前端不许拿场景描述之类的顶替。
  final String? sourceText;

  /// 这次理解是不是本地词典兜底出来的（识别/理解服务没起来）。
  /// true 时 UI 必须明说，不能装作听懂了。
  final bool degraded;
  final int createdAt;

  bool get ready => status == 'ready';
  bool get clarifying => status == 'clarifying';
  bool get consumed => status == 'consumed';
  bool get processing =>
      status != 'clarifying' && status != 'ready' && status != 'consumed';

  factory Intent.fromMap(Map m) => Intent(
        id: '${m['id'] ?? ''}',
        sourceKind: '${m['source_kind'] ?? 'text'}',
        status: '${m['status'] ?? 'processing'}',
        mood: _asStrList(m['mood']),
        sceneDesc: m['scene_desc']?.toString(),
        genreHypotheses: _asStrList(m['genre_hypotheses']),
        vocal: '${m['vocal'] ?? 'unknown'}',
        durationHint: m['duration_hint']?.toString(),
        confidence: _asDouble(m['confidence']),
        questions: (m['questions'] as List? ?? const [])
            .whereType<Map>()
            .map(IntentQuestion.fromMap)
            .toList(),
        answers: (m['answers'] as List? ?? const [])
            .whereType<Map>()
            .map((e) =>
                IntentAnswer(qIdx: _asInt(e['q_idx']), optionIdx: _asInt(e['option_idx'])))
            .toList(),
        sourceText: m['source_text'] == null ? null : '${m['source_text']}',
        degraded: _asInt(m['degraded']) == 1,
        createdAt: _asEpochSec(m['created_at']),
      );

  /// 本地乐观修改（服务端 PATCH 回包前的展示层状态；真正的持久化走
  /// PATCH /v1/intent/:id，见 ApiClient.intentPatch / 契约 v2.19）
  Intent copyWith({
    List<String>? mood,
    String? vocal,
    List<String>? genreHypotheses,
    String? sceneDesc,
    String? durationHint,
  }) =>
      Intent(
        id: id,
        sourceKind: sourceKind,
        status: status,
        mood: mood ?? this.mood,
        sceneDesc: sceneDesc ?? this.sceneDesc,
        genreHypotheses: genreHypotheses ?? this.genreHypotheses,
        vocal: vocal ?? this.vocal,
        durationHint: durationHint ?? this.durationHint,
        confidence: confidence,
        questions: questions,
        answers: answers,
        sourceText: sourceText,
        degraded: degraded,
        createdAt: createdAt,
      );
}

class Persona {
  Persona(
      {required this.id,
      required this.name,
      required this.isPublic,
      required this.useCount,
      required this.createdAt});

  final String id;
  final String name;
  final bool isPublic;
  final int useCount;
  final int createdAt;

  factory Persona.fromMap(Map m) => Persona(
        id: '${m['id'] ?? ''}',
        name: '${m['name'] ?? '无名音色'}',
        isPublic: m['is_public'] == true,
        useCount: _asInt(m['use_count']),
        createdAt: _asEpochSec(m['created_at']),
      );
}

/// GET /v1/works/:id/seed-pack —— 分享时不展示 engine 型号名
class SeedPack {
  SeedPack({
    required this.prompt,
    required this.tags,
    required this.bpm,
    required this.sec,
    required this.seed,
    required this.engine,
  });

  final String prompt;
  final List<String> tags;
  final int bpm;
  final int sec;
  final int seed;
  final String engine; // 仅存储，禁止出现在 UI

  factory SeedPack.fromMap(Map m) => SeedPack(
        prompt: '${m['prompt'] ?? ''}',
        tags: _asStrList(m['tags']),
        bpm: _asInt(m['bpm']),
        sec: _asInt(m['sec']),
        seed: _asInt(m['seed']),
        engine: '${m['engine'] ?? ''}',
      );

  /// 面向用户的分享文案（不含引擎名）
  String toShareText({String? title}) {
    final buf = StringBuffer();
    if (title != null && title.isNotEmpty) buf.writeln('《$title》');
    if (prompt.isNotEmpty) buf.writeln('灵感：$prompt');
    if (tags.isNotEmpty) buf.writeln('标签：${tags.join(' / ')}');
    buf.writeln('BPM：$bpm    时长：${sec}s    Seed：$seed');
    buf.write('—— 来自 MusicBox，AI 生成');
    return buf.toString();
  }
}

/// GET /v1/works/:id → {work, lineage_parents, children_count}
class WorkDetail {
  WorkDetail({
    required this.work,
    this.parents = const [],
    required this.childrenCount,
  });

  final Work work;
  final List<Work> parents;
  final int childrenCount;

  factory WorkDetail.fromMap(Map m) => WorkDetail(
        work: Work.fromMap(m['work'] ?? {}),
        parents: (m['lineage_parents'] as List? ?? const [])
            .whereType<Map>()
            .map(Work.fromMap)
            .toList(),
        childrenCount: _asInt(m['children_count']),
      );
}
