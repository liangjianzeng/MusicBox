/// MV 特性域数据模型（契约 v2 · 文档态）
/// 真源：docs/musicbox-phase2-architecture-design.md §5/§6（CONTRACTS v2 素材）。
/// server 侧 MV 路由（v2.1）并行施工中：解析一律宽容（缺字段不炸），
/// 且不伪造任何字段值。
/// 语言纪律：任何引擎型号名 / 行话（take/seed/prompt/i2v…）不得进入用户面字符串，
/// 这里只提供数据形状；展示文案在页面层统一「人话」。
library;

int _asInt(dynamic v, [int d = 0]) =>
    v is int ? v : (v is num ? v.toInt() : int.tryParse('$v') ?? d);

double _asDouble(dynamic v, [double d = 0]) =>
    v is double ? v : (v is num ? v.toDouble() : double.tryParse('$v') ?? d);

// ---------- 端侧禁词二次幂等过滤（架构 §2 lang_filter 思路，§5.4 三层净化第二层） ----------
// 服务端出话已过 mv_lexicon.sanitize；这里对「服务端回传的任意用户面字符串」
// （通告板 note / 助手回执 / 建议摘要 / 错误文案）再过滤一遍。纯字符串替换、
// 不含状态，重复调用结果不变（幂等）。仅过滤行话与引擎名，不动正常文案。

final List<RegExp> _mvBannedAscii = [
  RegExp(r'\btakes?\b', caseSensitive: false),
  RegExp(r'\bseeds?\b', caseSensitive: false),
  RegExp(r'\bprompts?\b', caseSensitive: false),
  RegExp(r'\bi2v\b', caseSensitive: false),
  RegExp(r'\blip[\s_-]?sync(ing|ed)?\b', caseSensitive: false),
  RegExp(r'\blipsync(ing|ed)?\b', caseSensitive: false),
  RegExp(r'\bloras?\b', caseSensitive: false),
  RegExp(
    r'(minimax|h3[\s_-]?(image|fl2va|ref2va)?|echomimic|musetalk|latentsync|'
    r'sensevoice|ace[\s_-]?step|comfyui|vllm|gguf|nvfp4|int8|mxfp8|wan2)',
    caseSensitive: false,
  ),
];
const List<String> _mvBannedAsciiRepl = [
  '重拍',
  '复刻编号',
  '导演阐述',
  '开机拍摄',
  '口型校准',
  '口型校准',
  '签名档',
  '自部署·高品质',
];
const Map<String, String> _mvBannedCjk = {
  '抽帧': '选镜',
  '定妆抽帧': '定妆选镜',
};

/// 对用户面服务端字符串做幂等禁词过滤（页面层展示一切外来文本前调用）
String mvHuman(String? raw) {
  var s = raw ?? '';
  if (s.isEmpty) return s;
  for (var i = 0; i < _mvBannedAscii.length; i++) {
    s = s.replaceAll(_mvBannedAscii[i], _mvBannedAsciiRepl[i]);
  }
  _mvBannedCjk.forEach((k, v) => s = s.replaceAll(k, v));
  return s;
}

/// 项目状态机（架构 §5）：drafting→casting→scripting→previewed→shooting→
/// composing→ready；任何阶段可 canceled；failed 单列
const kMvProjectStatuses = [
  'drafting',
  'casting',
  'scripting',
  'previewed',
  'shooting',
  'composing',
  'ready',
  'failed',
  'canceled',
];

/// 镜头状态机：draft|queued|boardReady|clipReady|synced|locked|stale
/// queued 是执行器未挂/等待派单时服务端实际会回传的状态。
const kMvShotStatuses = [
  'draft',
  'queued',
  'boardReady',
  'clipReady',
  'synced',
  'locked',
  'stale',
];

/// 用户面「人话」状态（契约 §0/§5.4 语言纪律）
String mvProjectStatusLabel(String status) {
  switch (status) {
    case 'drafting':
      return '筹备中';
    case 'casting':
      return '定妆中';
    case 'scripting':
      return '打磨剧本';
    case 'previewed':
      return '样片就绪';
    case 'shooting':
      return '拍摄中';
    case 'composing':
      return '合成中';
    case 'ready':
      return '成片就绪';
    case 'failed':
      return '没成功';
    case 'canceled':
      return '已取消';
    default:
      return status.isEmpty ? '未知' : status;
  }
}

/// 进行中的项目状态（列表里显示「进度中」）
bool mvProjectInProgress(String status) => const {
      'drafting',
      'casting',
      'scripting',
      'previewed',
      'shooting',
      'composing'
    }.contains(status);

String mvShotStatusLabel(String status) {
  switch (status) {
    case 'draft':
    case 'queued':
      return '排队中';
    case 'boardReady':
      return '画面就绪';
    case 'clipReady':
      return '已拍';
    case 'synced':
      return '已对口型';
    case 'locked':
      return '已锁定';
    case 'stale':
      return '待补拍';
    default:
      return status.isEmpty ? '排队中' : status;
  }
}

String mvKindLabel(String kind) => kind == 'instrumental' ? '纯音乐' : '歌唱曲';

/// 报价快照（契约 v2.8.3：est_json；est_ver=hash12 做开机 CAS）
class MvEstRow {
  MvEstRow(
      {required this.item, this.unit = '', this.count = 0, this.credits = 0});
  final String item; // 拍摄/口型/歌词对齐/成片合成
  final String unit;
  final int count;
  final int credits;

  factory MvEstRow.fromMap(Map m) => MvEstRow(
        item: '${m['item'] ?? ''}',
        unit: '${m['unit'] ?? ''}',
        count: _asInt(m['count']),
        credits: _asInt(m['credits']),
      );
}

class MvEst {
  MvEst({
    this.shots = 0,
    this.singing = 0,
    this.lipsync = 0,
    this.breakdown = const [],
    this.credits = 0,
    this.minutes = 0,
    this.at,
  });

  final int shots;
  final int singing;
  final int lipsync;
  final List<MvEstRow> breakdown;
  final int credits;
  final int minutes;
  final String? at;

  bool get isEmpty => credits == 0 && shots == 0 && breakdown.isEmpty;

  factory MvEst.fromMap(Map? m) {
    if (m == null) return MvEst();
    return MvEst(
      shots: _asInt(m['shots']),
      singing: _asInt(m['singing']),
      lipsync: _asInt(m['lipsync']),
      breakdown: (m['breakdown'] as List? ?? const [])
          .whereType<Map>()
          .map(MvEstRow.fromMap)
          .toList(),
      credits: _asInt(m['credits']),
      minutes: _asInt(m['minutes']),
      at: m['at']?.toString(),
    );
  }
}

/// mv_projects 行（GET /v1/mv/projects/:id 的 project；POST 响应同形）
class MvProject {
  MvProject({
    required this.id,
    required this.workId,
    required this.title,
    required this.kind,
    required this.status,
    this.brief,
    this.scriptVer = 1,
    this.estVer,
    this.est,
    this.budgetCredits = 1200,
    this.paused = false,
    this.previewUrl,
    this.videoUrl,
    this.coverUrl,
    this.durationSec = 0,
    this.creditsCost = 0,
    this.creditsRefunded = 0,
    this.aiLabel = true,
    this.queueMode = 'normal',
    required this.createdAt,
  });

  final String id;
  final String workId;
  final String title;
  final String kind; // vocal|instrumental
  final String status;
  final String? brief;
  final int scriptVer;
  final String? estVer; // 报价快照 hash（开机 CAS 用）
  final MvEst? est; // 报价卡数据源（GET detail 的 project.est）
  final int budgetCredits;
  final bool paused; // >120% 预算护栏暂停（仅人工恢复）
  final String? previewUrl;
  final String? videoUrl;
  final String? coverUrl;
  final double durationSec;
  final int creditsCost;
  final int creditsRefunded;
  final bool aiLabel;
  final String queueMode;
  final String createdAt; // 服务端 ISO 字符串，宽容解析

  bool get ready => status == 'ready';
  bool get isVocal => kind != 'instrumental';

  /// 状态序（架构 §5 状态机）：boot 前置 status≥previewed 的客户端门禁
  int get statusRank {
    const order = [
      'drafting',
      'casting',
      'scripting',
      'previewed',
      'shooting',
      'composing',
      'ready',
    ];
    // 与 server stageRank 对齐：failed 保留拍摄阶段的能力，允许按原报价
    // boot 或从具体镜头重拍恢复，不能把它当成尚未开始的项目。
    if (status == 'failed') return order.indexOf('shooting');
    return order.indexOf(status);
  }

  bool get canBootGate => statusRank >= 3; // ≥previewed
  bool get hasScript => statusRank >= 2; // ≥scripting

  /// 剧本 ver 乐观前移（PATCH 成功后服务端 ver++，本地同步呈现）
  MvProject copyWithScriptVer(int ver) => MvProject(
        id: id,
        workId: workId,
        title: title,
        kind: kind,
        status: status,
        brief: brief,
        scriptVer: ver,
        estVer: estVer,
        est: est,
        budgetCredits: budgetCredits,
        paused: paused,
        previewUrl: previewUrl,
        videoUrl: videoUrl,
        coverUrl: coverUrl,
        durationSec: durationSec,
        creditsCost: creditsCost,
        creditsRefunded: creditsRefunded,
        aiLabel: aiLabel,
        queueMode: queueMode,
        createdAt: createdAt,
      );

  factory MvProject.fromMap(Map m) => MvProject(
        id: '${m['id'] ?? ''}',
        workId: '${m['work_id'] ?? ''}',
        title: '${m['title'] ?? ''}',
        kind: '${m['kind'] ?? 'vocal'}',
        status: '${m['status'] ?? 'drafting'}',
        brief: m['brief']?.toString(),
        scriptVer: _asInt(m['script_ver'], 1),
        estVer: m['est_ver']?.toString(),
        est: m['est'] is Map ? MvEst.fromMap(m['est'] as Map) : null,
        budgetCredits: _asInt(m['budget_credits'], 1200),
        paused: m['paused'] == true || _asInt(m['paused']) == 1,
        previewUrl: m['preview_url']?.toString(),
        videoUrl: m['video_url']?.toString(),
        coverUrl: m['cover_url']?.toString(),
        durationSec: _asDouble(m['duration_sec']),
        creditsCost: _asInt(m['credits_cost']),
        creditsRefunded: _asInt(m['credits_refunded']),
        aiLabel: m['ai_label'] != false,
        queueMode: '${m['queue_mode'] ?? 'normal'}',
        createdAt: '${m['created_at'] ?? ''}',
      );
}

/// mv 列表项（GET /v1/mvs 的 items：成片视角）
class MvSummary {
  MvSummary({
    required this.id,
    this.workId,
    required this.title,
    required this.kind,
    required this.status,
    this.coverUrl,
    this.videoUrl,
    this.durationSec = 0,
    this.aiLabel = true,
    required this.createdAt,
  });

  final String id;
  final String? workId;
  final String title;
  final String kind;
  final String status;
  final String? coverUrl;
  final String? videoUrl;
  final double durationSec;
  final bool aiLabel;
  final String createdAt; // 服务端 ISO 字符串，宽容解析

  factory MvSummary.fromMap(Map m) => MvSummary(
        id: '${m['id'] ?? ''}',
        workId: m['work_id']?.toString(),
        title: '${m['title'] ?? ''}',
        kind: '${m['kind'] ?? 'vocal'}',
        status: '${m['status'] ?? 'drafting'}',
        coverUrl: m['cover_url']?.toString(),
        videoUrl: m['video_url']?.toString(),
        durationSec: _asDouble(m['duration_sec']),
        aiLabel: m['ai_label'] != false,
        createdAt: '${m['created_at'] ?? ''}',
      );
}

/// 定妆视频抽帧评分（契约 v2.3 frames_json：[{url,score,pass}]，机检写入）
class MvFrame {
  MvFrame({required this.url, this.score, this.pass = false});
  final String url;
  final double? score; // facegate 分（机检，只读展示）
  final bool pass; // 过门帧（13 帧格默认预选）

  factory MvFrame.fromMap(Map m) => MvFrame(
        url: '${m['url'] ?? ''}',
        score: m['score'] == null ? null : _asDouble(m['score']),
        pass: m['pass'] == true || _asInt(m['pass']) == 1,
      );
}

/// mv_characters：source upload|ai|reuse；viewRefs 由拍板固化
class MvCharacter {
  MvCharacter({
    required this.id,
    required this.projectId,
    required this.gender,
    this.name,
    required this.source,
    this.portraitUpload,
    this.castImageUrl,
    this.castVideoUrl,
    this.castImages = const [],
    this.frames = const [],
    this.confirmedAt,
  });

  final String id;
  final String projectId;
  final String gender; // m|f
  final String? name;
  final String source; // upload|ai|reuse
  final String? portraitUpload; // uploads.kind='mv_portrait'（72h TTL）
  final String? castImageUrl;
  final String? castVideoUrl;
  final List<String> castImages; // 定妆 3 候选（cast_images_json，机检写入）
  final List<MvFrame> frames; // 定妆视频抽帧评分（frames_json，机检写入）
  final String? confirmedAt;

  bool get confirmed => (confirmedAt ?? '').isNotEmpty;

  factory MvCharacter.fromMap(Map m) => MvCharacter(
        id: '${m['id'] ?? ''}',
        projectId: '${m['project_id'] ?? ''}',
        gender: '${m['gender'] ?? 'f'}',
        name: m['name']?.toString(),
        source: '${m['source'] ?? 'ai'}',
        portraitUpload: m['portrait_upload']?.toString(),
        castImageUrl: m['cast_image_url']?.toString(),
        castVideoUrl: m['cast_video_url']?.toString(),
        castImages: (m['cast_images'] as List? ?? const [])
            .map((e) => '$e')
            .where((e) => e.isNotEmpty)
            .toList(),
        frames: (m['frames'] as List? ?? const [])
            .whereType<Map>()
            .map(MvFrame.fromMap)
            .where((f) => f.url.isNotEmpty)
            .toList(),
        confirmedAt: m['confirmed_at']?.toString(),
      );
}

/// 镜卡「人话」类型（禁词纪律：演唱镜/剧情镜/空镜）
String mvShotKindLabel(String kind) {
  switch (kind) {
    case 'singing':
      return '演唱镜';
    case 'broll':
      return '空镜';
    default:
      return '剧情镜';
  }
}

/// 景别 chips（契约 v2.8.1 景别枚举的用户面；与 camera 字段互转）
const kMvCameraChips = ['远景', '全景', '中景', '近景', '特写'];

/// mv_shots：kind singing|story|broll
class MvShot {
  MvShot({
    required this.id,
    required this.projectId,
    required this.seq,
    required this.kind,
    this.sec = 0,
    this.desc,
    this.camera,
    this.lyricFrom,
    this.lyricTo,
    this.castIds = const [],
    this.storyboardUrl,
    this.firstFrameUrl,
    required this.status,
    this.rerolls = 0,
    this.degraded = const [],
  });

  final String id;
  final String projectId;
  final int seq;
  final String kind;
  final double sec;
  final String? desc;
  final String? camera;
  final int? lyricFrom; // 唱段句窗（歌唱曲，只读展示）
  final int? lyricTo;
  final List<String> castIds;
  final String? storyboardUrl;
  final String? firstFrameUrl;
  final String status;
  final int rerolls;
  final List<String> degraded; // 降级角标（broll_subtitle 等，机检回传才显示）

  bool get singing => kind == 'singing';

  /// 回传 script_json 单镜条目的规范化形状（PATCH 白名单字段）
  Map<String, dynamic> toScriptShot() => {
        // 服务端按稳定 id 同步镜行；调序/删镜后不能再按 seq 或数组下标回绑。
        'id': id,
        'seq': seq,
        'kind': kind,
        'sec': sec,
        if (lyricFrom != null) 'lyric_from': lyricFrom,
        if (lyricTo != null) 'lyric_to': lyricTo,
        'desc': desc ?? '',
        'camera': camera ?? '',
        'cast_ids': castIds,
      };

  MvShot copyWith({
    int? seq,
    String? kind,
    double? sec,
    String? desc,
    String? camera,
    String? status,
    int? rerolls,
  }) =>
      MvShot(
        id: id,
        projectId: projectId,
        seq: seq ?? this.seq,
        kind: kind ?? this.kind,
        sec: sec ?? this.sec,
        desc: desc ?? this.desc,
        camera: camera ?? this.camera,
        lyricFrom: lyricFrom,
        lyricTo: lyricTo,
        castIds: castIds,
        storyboardUrl: storyboardUrl,
        firstFrameUrl: firstFrameUrl,
        status: status ?? this.status,
        rerolls: rerolls ?? this.rerolls,
        degraded: degraded,
      );

  factory MvShot.fromMap(Map m) {
    List<String> flags = const [];
    final raw = m['degraded'] ?? m['flags'];
    if (raw is List)
      flags = raw.map((e) => '$e').where((e) => e.isNotEmpty).toList();
    return MvShot(
      id: '${m['id'] ?? ''}',
      projectId: '${m['project_id'] ?? ''}',
      seq: _asInt(m['seq']),
      kind: '${m['kind'] ?? 'story'}',
      sec: _asDouble(m['sec']),
      desc: m['desc']?.toString(),
      camera: m['camera']?.toString(),
      lyricFrom: m['lyric_from'] == null ? null : _asInt(m['lyric_from']),
      lyricTo: m['lyric_to'] == null ? null : _asInt(m['lyric_to']),
      castIds: (m['cast_ids'] as List? ?? const [])
          .map((e) => '$e')
          .where((e) => e.isNotEmpty)
          .toList(),
      storyboardUrl: m['storyboard_url']?.toString(),
      firstFrameUrl: m['first_frame_url']?.toString(),
      status: '${m['status'] ?? 'draft'}',
      rerolls: _asInt(m['rerolls']),
      degraded: flags,
    );
  }
}

/// 剧本建议草稿（契约 v2.8.2 suggest：挂草稿不 ver++，apply 才落卡）
class MvSuggest {
  MvSuggest({
    required this.id,
    this.note,
    this.summary,
    this.shots = const [],
    this.mode = 'llm',
  });

  final String id;
  final String? note;
  final String? summary;
  final List<Map> shots; // 建议版分镜（预览 diff 用）
  final String mode; // llm（诚实标注）

  factory MvSuggest.fromMap(Map m) {
    final script = (m['script'] as Map?) ?? const {};
    return MvSuggest(
      id: '${m['id'] ?? ''}',
      note: m['note']?.toString(),
      summary: m['summary']?.toString(),
      shots: (script['shots'] as List? ?? const []).whereType<Map>().toList(),
      mode: '${m['mode'] ?? 'llm'}',
    );
  }
}

/// 音画报告（GET /v1/mv/projects/:id/report；STUB 恒 stub:true，诚实呈现）
class MvReport {
  MvReport({
    this.stub = false,
    this.alignReport = const {},
    this.syncDist = const {},
    this.phraseHit = 0,
    this.degradedShots = const [],
  });

  final bool stub;
  final Map alignReport;
  final Map syncDist;
  final double phraseHit;
  final List<String> degradedShots;

  /// STUB 或无任何真实聚合数据 → UI 一律渲染「报告生成中」空态，绝不当真数
  bool get hasRealData =>
      !stub &&
      (_asInt(alignReport['aligned_lines']) > 0 ||
          _asDouble(syncDist['count']) > 0 ||
          phraseHit > 0 ||
          degradedShots.isNotEmpty);

  factory MvReport.fromMap(Map m) => MvReport(
        stub: m['stub'] == true || _asInt(m['stub']) == 1,
        alignReport: (m['align_report'] as Map?) ?? const {},
        syncDist: (m['sync_dist'] as Map?) ?? const {},
        phraseHit: _asDouble(m['phrase_hit']),
        degradedShots: (m['degraded_shots'] as List? ?? const [])
            .map((e) {
              if (e is Map) {
                final seq = e['seq'];
                final lbl = mvHuman('${e['label'] ?? ''}');
                return seq == null ? lbl : '第${_asInt(seq)}镜 · $lbl';
              }
              return mvHuman('$e');
            })
            .where((e) => e.isNotEmpty)
            .toList(),
      );
}

/// 确认票（昂贵动作前置；此处只读展示）
class MvTicket {
  MvTicket({
    required this.id,
    required this.action,
    required this.status,
    this.estCredits = 0,
    this.estMinutes = 0,
    this.hash,
    this.ver,
  });

  final String id;
  final String action;
  final String status; // pending|consumed|expired|denied
  final int estCredits;
  final int estMinutes;
  final String? hash;
  final String? ver;

  factory MvTicket.fromMap(Map m) {
    // 助手发票响应使用 ticket_id + est.{credits,minutes}，且故意不下发
    // ver/hash；GET detail 的 pending tickets 才携带这两个确认凭据。
    final est = m['est'] is Map ? m['est'] as Map : const {};
    return MvTicket(
      id: '${m['ticket_id'] ?? m['id'] ?? ''}',
      action: '${m['action'] ?? ''}',
      status: '${m['status'] ?? 'pending'}',
      estCredits: _asInt(m['est_credits'] ?? est['credits']),
      estMinutes: _asInt(m['est_minutes'] ?? est['minutes']),
      hash: m['hash']?.toString(),
      ver: m['ver']?.toString(),
    );
  }
}

/// 卡审单条结论（契约 v2.21 detail.ai_review.findings / llm_findings）
class MvAiFinding {
  MvAiFinding(
      {required this.rule,
      required this.level,
      required this.message,
      this.shotSeq,
      this.source});
  final String rule;
  final String level; // high|warn
  final String message;
  final int? shotSeq;
  final String? source; // llm（LLM 叠加项）
  bool get isHigh => level == 'high';

  factory MvAiFinding.fromMap(Map m) => MvAiFinding(
        rule: '${m['rule'] ?? ''}',
        level: '${m['level'] ?? 'warn'}',
        message: '${m['message'] ?? ''}',
        shotSeq: m['shot_seq'] == null ? null : _asInt(m['shot_seq']),
        source: m['source']?.toString(),
      );
}

/// 只读卡审结论（source=script_json.ai_review；server 下发，PATCH 不可伪造）
class MvAiReview {
  MvAiReview({
    this.engine,
    this.findings = const [],
    this.llmFindings = const [],
    this.hasScript = false,
    this.blocked = false,
    this.present = false,
  });
  final String? engine; // '规则机检' | 'LLM 审查＋规则机检'
  final List<MvAiFinding> findings;
  final List<MvAiFinding> llmFindings;
  final bool hasScript;
  final bool blocked;
  final bool present; // server 是否下发了 ai_review 段

  bool get hasFindings => findings.isNotEmpty || llmFindings.isNotEmpty;
  bool get llmUsed => llmFindings.isNotEmpty || (engine ?? '').contains('LLM');

  factory MvAiReview.fromMap(Map? m) {
    if (m == null) return MvAiReview();
    List<MvAiFinding> fl(dynamic v) => (v as List? ?? const [])
        .whereType<Map>()
        .map(MvAiFinding.fromMap)
        .toList();
    return MvAiReview(
      present: true,
      engine: m['engine']?.toString(),
      findings: fl(m['findings']),
      llmFindings: fl(m['llm_findings']),
      hasScript: m['has_script'] == true || _asInt(m['has_script']) == 1,
      blocked: m['blocked'] == true || _asInt(m['blocked']) == 1,
    );
  }
}

/// GET /v1/mv/projects/:id → {project, characters[], shots[], tickets[]}
class MvProjectDetail {
  MvProjectDetail({
    required this.project,
    this.characters = const [],
    this.shots = const [],
    this.tickets = const [],
    this.assistantEnabled,
    this.assistantChat = false,
    this.assistantModeHint,
    this.aiReview,
  });

  final MvProject project;
  final List<MvCharacter> characters;
  final List<MvShot> shots;
  final List<MvTicket> tickets;

  /// 制片助手可见性（契约 v2.20）：读 server detail.assistant.enabled；缺省 null=未下发（旧包）
  final bool? assistantEnabled;

  /// 对话版 LLM 增强是否开放（assistant.chat_enabled，按 assistant_chat 灰度）
  final bool assistantChat;

  /// 'rule' | 'chat'（assistant.mode_hint），供 UI 呈现当前助手模式
  final String? assistantModeHint;

  /// 只读卡审结论（契约 v2.21 detail.ai_review；null=未下发）
  final MvAiReview? aiReview;

  MvProjectDetail copyWith({
    MvProject? project,
    List<MvCharacter>? characters,
    List<MvShot>? shots,
    List<MvTicket>? tickets,
    bool? assistantEnabled,
    bool? assistantChat,
    String? assistantModeHint,
    MvAiReview? aiReview,
  }) =>
      MvProjectDetail(
        project: project ?? this.project,
        characters: characters ?? this.characters,
        shots: shots ?? this.shots,
        tickets: tickets ?? this.tickets,
        assistantEnabled: assistantEnabled ?? this.assistantEnabled,
        assistantChat: assistantChat ?? this.assistantChat,
        assistantModeHint: assistantModeHint ?? this.assistantModeHint,
        aiReview: aiReview ?? this.aiReview,
      );

  factory MvProjectDetail.fromMap(Map m) => MvProjectDetail(
        project: MvProject.fromMap((m['project'] as Map?) ?? const {}),
        characters: (m['characters'] as List? ?? const [])
            .whereType<Map>()
            .map(MvCharacter.fromMap)
            .toList(),
        shots: (m['shots'] as List? ?? const [])
            .whereType<Map>()
            .map(MvShot.fromMap)
            .toList(),
        tickets: (m['tickets'] as List? ?? const [])
            .whereType<Map>()
            .map(MvTicket.fromMap)
            .toList(),
        assistantEnabled: _parseAssistantEnabled(m),
        assistantChat: _parseAssistantChat(m),
        assistantModeHint: (m['assistant'] as Map?)?['mode_hint']?.toString(),
        aiReview: MvAiReview.fromMap(m['ai_review'] as Map?),
      );

  /// server 权威：detail.assistant.enabled；兼容旧顶层 assistant_enabled（缺省 null → 由常量兜底）
  static bool? _parseAssistantEnabled(Map m) {
    final a = m['assistant'] as Map?;
    if (a != null && a.containsKey('enabled')) {
      return a['enabled'] == true || _asInt(a['enabled']) == 1;
    }
    if (m['assistant_enabled'] != null) {
      return m['assistant_enabled'] == true ||
          _asInt(m['assistant_enabled']) == 1;
    }
    return null;
  }

  static bool _parseAssistantChat(Map m) {
    final a = m['assistant'] as Map?;
    if (a == null) return false;
    return a['chat_enabled'] == true || _asInt(a['chat_enabled']) == 1;
  }
}

/// 单镜动作报价只读项目详情里的服务端报价快照，不猜价、不回退客户端常数。
/// reshoot 对应「拍摄」行，resync 对应「口型」行；旧包/纯音乐缺行时返回 null，
/// 由 UI 明示「以确认卡为准」。
int? mvShotActionQuote(MvProjectDetail detail, String action) {
  final String item;
  switch (action) {
    case 'reshoot':
      item = '拍摄';
      break;
    case 'resync':
      item = '口型';
      break;
    default:
      return null;
  }
  for (final row in detail.project.est?.breakdown ?? const <MvEstRow>[]) {
    if (row.item == item) return row.credits;
  }
  return null;
}
