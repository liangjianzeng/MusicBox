import 'dart:io';

import 'package:dio/dio.dart';

import '../../core/api_client.dart';

/// MV 特性域 API 客户端 —— 本特性所有接口调用集中于此（单一真源文件）。
///
/// 方法与 CONTRACTS.md v2（文档态，见 docs/musicbox-phase2-architecture-design.md §6）
/// 逐条对应：
///   POST /v1/mv/projects                     创建项目（免费；N1 单主演）
///   POST /v1/mv/image                        人像上传 multipart（jpg/png ≤8MB，consent 前置）
///   POST /v1/mv/projects/:id/jobs            派发步骤任务（先扣后派单，幂等）
///   POST /v1/mv/projects/:id/cast/confirm    定妆拍板（固化 viewRefs）
///   GET  /v1/mvs                             我的 MV 列表
///   GET  /v1/mv/projects/:id                 项目详情（project+characters+shots+tickets）
///
/// 诚实纪律：server 侧 MV 路由（src/server/api/mv.js，v2.1）仍在并行施工：
/// `mv_enabled=false` 灰度关闭或端点缺失（如 POST /jobs 派发）时按契约返回
/// {code:"NOT_FOUND"}；这里统一翻译成 MV_NOT_READY 供 UI 呈现「MV 服务待接入」，
/// 绝不伪造响应、绝不回退假数据。
class MvApiClient {
  MvApiClient(this._api);

  final ApiClient _api;

  /// 人像上传硬性校验（契约：jpg/png ≤8MB；服务端另有 sha256+魔数复核）
  static const int imageMaxBytes = 8 * 1024 * 1024;
  static const List<String> imageAllowedExt = ['jpg', 'jpeg', 'png'];

  /// 校验本地待上传人像，返回错误文案（null=通过）
  static String? validateImage(String path) {
    final f = File(path);
    if (!f.existsSync()) return '照片文件不存在，请重新选择';
    final ext = path.toLowerCase().split('.').last;
    if (!imageAllowedExt.contains(ext)) return '仅支持 jpg / png 照片';
    if (f.lengthSync() > imageMaxBytes) return '照片超过 8MB，请换一张或压缩后再传';
    if (f.lengthSync() <= 0) return '照片是空的，请重新选择';
    return null;
  }

  ApiException _pending(ApiException e, {bool pendingOnNotFound = true}) {
    // 端点未部署：404/NOT_FOUND/501 一律如实呈现为「MV 服务待接入」。
    // 少数「404 是业务真意」的端点（如票据确认/详情不存在）传
    // pendingOnNotFound:false，让上层如实呈现「不存在/已失效」。
    if (pendingOnNotFound &&
        (e.code == 'NOT_FOUND' ||
            (e.code == 'INTERNAL' && (e.status == 501 || e.status == 404)))) {
      return ApiException(
          status: e.status,
          code: 'MV_NOT_READY',
          message: 'MV 服务尚未上线（服务端待接入），暂不能提交');
    }
    return e;
  }

  Future<dynamic> _call(Future<Response> Function() f,
      {bool pendingOnNotFound = true}) async {
    try {
      return await _api.send(f);
    } on ApiException catch (e) {
      throw _pending(e, pendingOnNotFound: pendingOnNotFound);
    }
  }

  /// POST /v1/mv/projects
  /// body：{work_id, brief?, character:{gender, source:"upload"|"ai", image_id?, name?}}
  /// → 201 {project}
  Future<Map> createProject({
    required String workId,
    String? brief,
    required Map<String, dynamic> character,
  }) async {
    final body = <String, dynamic>{
      'work_id': workId,
      if (brief != null && brief.trim().isNotEmpty) 'brief': brief.trim(),
      'character': character,
    };
    final d = await _call(() => _api.http.post('/v1/mv/projects', data: body));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/image（multipart field=file + field=consent）→ 200 {image_id}
  /// consent 为服务端硬性前置（PIPL）：UI 未勾选「本人或已获授权」不会走到这里。
  Future<String> uploadImage(String filePath) async {
    final err = validateImage(filePath);
    if (err != null) throw ApiException(code: 'BAD_REQUEST', message: err);
    final name = filePath.split(RegExp(r'[/\\]')).last;
    final fd = FormData();
    fd.fields.add(const MapEntry('consent', 'true'));
    fd.files.add(MapEntry(
        'file', await MultipartFile.fromFile(filePath, filename: name)));
    final d = await _call(() => _api.http.post('/v1/mv/image', data: fd));
    return '${(d as Map?)?['image_id'] ?? ''}';
  }

  /// POST /v1/mv/projects/:id/jobs
  /// body：{type:"cast_image"|"cast_video"|"storyboard"|"preview"|"shoot"|"compose", params?}
  /// → 202 {job_id, credits_charged, idempotent}
  Future<Map> createJob(String projectId, String type,
      [Map<String, dynamic>? params]) async {
    final d = await _call(() => _api.http.post(
        '/v1/mv/projects/$projectId/jobs',
        data: {'type': type, if (params != null) 'params': params}));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/cast/confirm
  /// body：{character_id, cast_image_url, frame_sel:[{url,score,sel}]} → 200 {character}
  /// frame_sel 为镜头级勾选（契约 v2.1 / v2.3 frames），服务端固化为 viewRefs。
  Future<Map> confirmCast({
    required String projectId,
    required String characterId,
    required String castImageUrl,
    required List<Map<String, dynamic>> frameSel,
  }) async {
    final d = await _call(
        () => _api.http.post('/v1/mv/projects/$projectId/cast/confirm', data: {
              'character_id': characterId,
              'cast_image_url': castImageUrl,
              'frame_sel': frameSel,
            }));
    return (d as Map?) ?? const {};
  }

  // ---------- wave-3：剧本编辑 / 派单 / 报价开机 / 返工 / 建议 / 报告 / 助手 ----------

  /// PATCH /v1/mv/projects/:id
  /// body：{title?, brief?, script_json?, queue_mode?, budget_credits?, ver}
  /// → 200 {project}；ver CAS 失配 → 409 STALE（上层 refetch+retry-once）
  Future<Map> patchProject(
    String projectId, {
    required int ver,
    String? title,
    String? brief,
    Map<String, dynamic>? scriptJson,
    String? queueMode,
    int? budgetCredits,
  }) async {
    final body = <String, dynamic>{
      'ver': ver,
      if (title != null) 'title': title,
      if (brief != null) 'brief': brief,
      if (scriptJson != null) 'script_json': scriptJson,
      if (queueMode != null) 'queue_mode': queueMode,
      if (budgetCredits != null) 'budget_credits': budgetCredits,
    };
    final d = await _call(
        () => _api.http.patch('/v1/mv/projects/$projectId', data: body));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/preview → 202 {job_id, credits_charged, idempotent}
  /// 每项目首次免费，重出 5⚡（D9）；前置=已有镜头（服务端硬门）。
  Future<Map> requestPreview(String projectId) async {
    final d =
        await _call(() => _api.http.post('/v1/mv/projects/$projectId/preview'));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/boot {est_ver}
  /// → 202 {jobs:[job_id], credits_charged, idempotent}
  /// 错误：409 NOT_READY（status<previewed / 无报价）、409 EST_STALE（报价 CAS
  /// 失配）、402 BUDGET_EXCEEDED、CREDITS_NOT_ENOUGH —— 原样上抛给 UI 分支。
  Future<Map> bootProject(String projectId, String estVer) async {
    final d = await _call(() => _api.http
        .post('/v1/mv/projects/$projectId/boot', data: {'est_ver': estVer}));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/shots/:id/jobs {type:"reshoot"|"resync", reason?, initiated_by?}
  /// → 202 {job_id, credits_charged, idempotent}（user 计费 / system 恒免费）
  Future<Map> shotJob(
    String shotId, {
    required String type,
    String? reason,
    String initiatedBy = 'user',
  }) async {
    final d =
        await _call(() => _api.http.post('/v1/mv/shots/$shotId/jobs', data: {
              'type': type,
              if (reason != null && reason.isNotEmpty) 'reason': reason,
              'initiated_by': initiatedBy,
            }));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/suggest {note}
  /// → 200 {suggest} | 409 NOT_READY（LLM 离线不装忙，上层退回手动编辑）
  Future<Map> suggestScript(String projectId, String note) async {
    final d = await _call(() => _api.http
        .post('/v1/mv/projects/$projectId/suggest', data: {'note': note}));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/suggest/apply {suggest_id, ver}
  /// → 200 {project} | 409 STALE（上层 refetch+retry-once）| 404（建议失效）
  Future<Map> applySuggest(String projectId, String suggestId, int ver) async {
    final d = await _call(
        () => _api.http.post('/v1/mv/projects/$projectId/suggest/apply',
            data: {'suggest_id': suggestId, 'ver': ver}),
        pendingOnNotFound: false);
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/cancel → 200 {refunded}（未拍镜全额退，账本核算）
  Future<int> cancelProject(String projectId) async {
    final d =
        await _call(() => _api.http.post('/v1/mv/projects/$projectId/cancel'));
    final m = (d as Map?) ?? const {};
    final r = m['refunded'];
    return r is int ? r : (r is num ? r.toInt() : int.tryParse('$r') ?? 0);
  }

  /// GET /v1/mvs/:id → {mv, parent_work}（谱系：母 work 简卡；404 如实返回不存在）
  Future<Map> mvDetail(String mvId) async {
    final d = await _call(() => _api.http.get('/v1/mvs/$mvId'),
        pendingOnNotFound: false);
    return (d as Map?) ?? const {};
  }

  /// GET /v1/mv/projects/:id/report → STUB（stub:true）诚实标注；404 如实返回
  Future<Map> report(String projectId) async {
    final d = await _call(
        () => _api.http.get('/v1/mv/projects/$projectId/report'),
        pendingOnNotFound: false);
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/projects/:id/tone → 200 {tone_suggest:{options}, assist:{mode}}
  /// （契约 v2.22：基调建议，system free，只读不改剧本；LLM 离线 server 词典兜底）
  Future<Map> tone(String projectId) async {
    final d =
        await _call(() => _api.http.post('/v1/mv/projects/$projectId/tone'));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/image/precheck（multipart field=file）→ 200
  /// {available, pass, checks:[{key,pass,msg}], msg}（契约 v2.22：人像预检，
  /// 辅助非门禁；facegate 不可达 server 诚实 available:false，不 500）
  Future<Map> precheck(String filePath) async {
    final err = validateImage(filePath);
    if (err != null) throw ApiException(code: 'BAD_REQUEST', message: err);
    final name = filePath.split(RegExp(r'[/\\]')).last;
    final fd = FormData();
    fd.files.add(MapEntry(
        'file', await MultipartFile.fromFile(filePath, filename: name)));
    final d =
        await _call(() => _api.http.post('/v1/mv/image/precheck', data: fd));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/assistant/messages（架构 §6 草案，server 并行施工中）
  /// body：{session_id?, text, chips:[{type:"project",id}]}
  /// → 200 {session_id, reply} | {ticket} | {intent, clarify}
  /// 端点未上线 → MV_NOT_READY：上层进入「规则助手模式」，绝不伪造回复。
  Future<Map> assistantMessages({
    String? sessionId,
    required String text,
    List<Map<String, dynamic>> chips = const [],
  }) async {
    final d =
        await _call(() => _api.http.post('/v1/mv/assistant/messages', data: {
              if (sessionId != null && sessionId.isNotEmpty)
                'session_id': sessionId,
              'text': text,
              if (chips.isNotEmpty) 'chips': chips,
            }));
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/tickets/:id/confirm {ver, hash} → 200 {executed}
  /// （TTL60s/一票一次/hash+ver CAS；404 如实呈现「票据已失效」）
  Future<Map> confirmTicket(String ticketId,
      {String? ver, String? hash}) async {
    final d = await _call(
        () => _api.http.post('/v1/mv/tickets/$ticketId/confirm', data: {
              if (ver != null) 'ver': ver,
              if (hash != null) 'hash': hash,
            }),
        pendingOnNotFound: false);
    return (d as Map?) ?? const {};
  }

  /// POST /v1/mv/tickets/:id/deny → 200 {ok}
  Future<void> denyTicket(String ticketId) async {
    await _call(() => _api.http.post('/v1/mv/tickets/$ticketId/deny'),
        pendingOnNotFound: false);
  }

  /// GET /v1/mvs?mine=1&cursor → {items:[mv], next_cursor}
  Future<(List<Map>, String?)> listMvs(
      {bool mine = true, String? cursor}) async {
    final d = await _call(() => _api.http.get('/v1/mvs', queryParameters: {
          if (mine) 'mine': '1',
          if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
        }));
    final map = (d as Map?) ?? const {};
    final items = (map['items'] as List? ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .toList();
    return (items, map['next_cursor']?.toString());
  }

  /// GET /v1/mv/projects/:id → {project, characters[], shots[], tickets:[pending]}
  Future<Map> project(String id) async {
    final d = await _call(() => _api.http.get('/v1/mv/projects/$id'));
    return (d as Map?) ?? const {};
  }
}
