import 'dart:async';

import 'package:dio/dio.dart';

import 'config.dart';
import 'models.dart';

/// 业务异常：统一携带 code + 中文文案
class ApiException implements Exception {
  ApiException({this.status, required this.code, required this.message});

  final int? status;
  final String code;
  final String message;

  String get zh => zhForCode(code, message);

  @override
  String toString() => zh;
}

/// 错误码 → 中文文案（契约 §0 常用 code）
String zhForCode(String code, [String? detail]) {
  final d = (detail ?? '').trim();
  switch (code) {
    case 'UNAUTHORIZED':
      return '登录已过期，请重试';
    case 'FORBIDDEN':
      return '没有权限执行此操作';
    case 'NOT_FOUND':
      return '内容不存在或已被删除';
    case 'BAD_REQUEST':
      return d.isEmpty ? '请求有误，请检查输入' : '请求有误：$d';
    case 'RATE_LIMITED':
      return '操作太频繁，请稍后再试';
    case 'CREDITS_NOT_ENOUGH':
      return '当前无法执行此操作，请稍后重试';
    case 'MODERATION_BLOCK':
      return '内容未通过安全审核，请换个描述试试';
    case 'NETWORK':
      return d.isEmpty ? '网络连接失败，请检查网络或服务器地址' : d;
    case 'INTERNAL':
      return '服务开小差了，请稍后重试';
    default:
      return d.isEmpty ? '服务异常，请稍后重试' : d;
  }
}

/// 用户可见文案：直接返回原文（计费信息不敏感，正常显示）。
/// 历史实现会把含计费词的整条文案替换成报错，导致助手正常回复被吞掉，已去掉。
String userVisibleText(String? raw) => raw?.trim() ?? '';

/// REST 客户端：Bearer 注入 / 401→refresh 单飞重试 / 错误码→中文
class ApiClient {
  ApiClient({required this.api, required this.prefs});

  final AppConfig api;
  final Prefs prefs;

  /// token 刷新失败时回调（由 session 处理：清 token 回游客）
  Future<void> Function()? onAuthExpired;

  /// 可达性回调（由 connectivityProvider 接线）：**任何**一次真实流量的结果都算数。
  /// 只有"连不上/超时"这类才算离线信号；4xx/5xx 说明服务器活着，不该拉红条。
  void Function()? onNetworkError;
  void Function()? onCallSuccess;

  /// 与 [_toApiException] 同一口径：哪些算"根本没连上"
  static bool isUnreachable(DioException e) =>
      e.type == DioExceptionType.connectionTimeout ||
      e.type == DioExceptionType.receiveTimeout ||
      e.type == DioExceptionType.sendTimeout ||
      e.type == DioExceptionType.connectionError;

  late final Dio _dio = _build();
  final Dio _raw = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 30),
  ));

  Completer<bool>? _refreshFlight;

  Dio _build() {
    final d = Dio(BaseOptions(
      baseUrl: api.apiRoot,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      headers: const {'Content-Type': 'application/json'},
      validateStatus: (s) => s != null && s < 400,
    ));
    d.interceptors.add(InterceptorsWrapper(
      onResponse: (r, i) {
        onCallSuccess?.call(); // 有响应 = 服务器活着
        i.next(r);
      },
      onRequest: (o, i) {
        final t = prefs.accessToken;
        if (t != null && t.isNotEmpty) {
          o.headers['Authorization'] = 'Bearer $t';
        }
        i.next(o);
      },
      onError: (e, i) async {
        if (isUnreachable(e)) onNetworkError?.call(); // 连不上 → 让横幅该出来就出来
        final opts = e.requestOptions;
        final isAuthPath = opts.path.contains('/auth/');
        if (e.response?.statusCode == 401 &&
            !isAuthPath &&
            opts.extra['_retried'] != true &&
            prefs.refreshToken != null) {
          opts.extra['_retried'] = true;
          final ok = await _tryRefresh();
          if (ok) {
            opts.headers['Authorization'] = 'Bearer ${prefs.accessToken}';
            try {
              final r = await _dio.fetch(opts);
              return i.resolve(r);
            } on DioException catch (e2) {
              return i.reject(e2);
            }
          }
          await onAuthExpired?.call();
        }
        return i.reject(e);
      },
    ));
    return d;
  }

  /// 并发安全的 token 刷新（单飞）
  Future<bool> _tryRefresh() async {
    final rt = prefs.refreshToken;
    if (rt == null || rt.isEmpty) return false;
    final flight = _refreshFlight;
    if (flight != null) return flight.future;
    final c = Completer<bool>();
    _refreshFlight = c;
    try {
      final r = await Dio(BaseOptions(
        baseUrl: api.apiRoot,
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 8),
      )).post('/v1/auth/refresh', data: {'refresh_token': rt});
      final d = r.data as Map;
      await prefs.saveTokens('${d['access_token']}', '${d['refresh_token']}');
      c.complete(true);
    } catch (_) {
      c.complete(false);
    } finally {
      _refreshFlight = null;
    }
    return c.future;
  }

  ApiException _toApiEx(DioException e) {
    final data = e.response?.data;
    if (data is Map && data['code'] != null) {
      return ApiException(
        status: e.response?.statusCode,
        code: '${data['code']}',
        message: '${data['message'] ?? ''}',
      );
    }
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.sendTimeout ||
        e.type == DioExceptionType.connectionError) {
      return ApiException(code: 'NETWORK', message: '');
    }
    if (e.response != null) {
      return ApiException(
          status: e.response?.statusCode,
          code: 'INTERNAL',
          message: '服务异常(${e.response?.statusCode})');
    }
    return ApiException(code: 'NETWORK', message: '');
  }

  Future<dynamic> _do(Future<Response> Function() f) async {
    try {
      final r = await f();
      return r.data;
    } on DioException catch (e) {
      throw _toApiEx(e);
    }
  }

  // ---------- 特性域 API 客户端复用入口 ----------
  // 说明：MV 等特性域接口集中在各自特性目录的 api client（如
  // features/mv/mv_api_client.dart），这里只暴露共享的 Dio（Bearer
  // 注入/401 单飞刷新）与统一错误映射，具体路径一律不进 core。

  /// 共享 Dio（已带鉴权拦截器与刷新单飞）
  Dio get http => _dio;

  /// 统一调用：DioException → ApiException（中文文案），返回值即响应体
  Future<dynamic> send(Future<Response> Function() f) => _do(f);

  // ---------- 认证与账户 ----------

  /// 游客登录。**必须带 device_key**（契约：服务端据此复用同一游客号；不带就是每次新建身份）。
  Future<Map> guestLogin() async {
    final key = await prefs.ensureDeviceKey(); // 先取锚点，再进 _do（_do 里不许藏 await）
    return await _do(() => _dio.post('/v1/auth/guest', data: {'device_key': key})) as Map;
  }

  /// 换机/重装后用备份码认领自己的老身份（契约 v5.6.0）。
  /// 成功后本机的 device_key 就成为该身份的锚点，服务端会作废旧设备的全部会话。
  Future<Map> claimIdentity(String recoveryCode) async {
    final key = await prefs.ensureDeviceKey(); // 同 guestLogin：锚点必须在进 _do 之前取好
    return await _do(() => _dio.post('/v1/auth/claim',
        data: {'device_key': key, 'recovery_code': recoveryCode})) as Map;
  }

  /// 重新生成备份码（旧码当场失效）。服务端只回显这一次，库里只存 sha256，
  /// 所以端侧**绝不许把这个码存进 prefs** —— 让用户当场抄下来/截图。
  Future<String> rotateRecoveryCode() async {
    final r = await _do(() => _dio.post('/v1/auth/recovery/rotate')) as Map;
    return '${r['recovery_code'] ?? ''}';
  }

  Future<void> requestCode(String phone) async {
    await _do(() => _dio.post('/v1/auth/phone/request-code',
        data: {'phone': phone}));
  }

  Future<Map> verifyPhone(String phone, String code) async =>
      await _do(() => _dio.post('/v1/auth/phone/verify',
          data: {'phone': phone, 'code': code})) as Map;

  Future<MeInfo> me() async =>
      MeInfo.fromMap(await _do(() => _dio.get('/v1/me')) as Map);

  /// 积分与配额（GET /v1/credits）。伴创简报卡必须在**出曲之前**把"这一单花多少、还剩多少"摊开，
  /// 而 App 此前从没调过这个端点 —— 余额只藏在计费响应里，等于让用户在看不见家底的情况下拍板。
  Future<Map> credits() async => await _do(() => _dio.get('/v1/credits')) as Map;

  // ---------- 文本创作线 ----------

  /// mode: simple|custom；返回 {job_id, credits_charged, idempotent}
  /// model：可选，APK 自选生成模型节点 id（后端未锁定时生效；未设置则由后端指定）
  Future<Map> generate(Map<String, dynamic> body, {String? model}) async {
    final data = Map<String, dynamic>.from(body);
    if (model != null && model.isNotEmpty) data['model'] = model;
    return await _do(() => _dio.post('/v1/works/generate', data: data)) as Map;
  }

  /// 远程配置（定价/默认走向/可选模型/版本策略/公告；无鉴权）
  Future<Map> appConfig() async =>
      await _do(() => _dio.get('/v1/app/config')) as Map;

  Future<Job> job(String id) async =>
      Job.fromMap(await _do(() => _dio.get('/v1/jobs/$id')) as Map);

  Future<Work> adopt(String workId, String candidateId) async => Work.fromMap(
      await _do(() => _dio.post('/v1/works/$workId/adopt',
          data: {'candidate_id': candidateId})) as Map);

  Future<(List<Work>, String?)> works({
    bool mine = true,
    String? genre,
    String? mood,
    int? bpmMin,
    int? bpmMax,
    String? q,
    String? cursor,
  }) async {
    final query = <String, dynamic>{
      if (mine) 'mine': '1' else 'public': '1',
      if (genre != null && genre.isNotEmpty) 'genre': genre,
      if (mood != null && mood.isNotEmpty) 'mood': mood,
      if (bpmMin != null) 'bpm_min': '$bpmMin',
      if (bpmMax != null) 'bpm_max': '$bpmMax',
      if (q != null && q.isNotEmpty) 'q': q,
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
    };
    final d = await _do(() => _dio.get('/v1/works', queryParameters: query)) as Map;
    final items = (d['items'] as List? ?? const [])
        .whereType<Map>()
        .map(Work.fromMap)
        .toList();
    return (items, d['next_cursor']?.toString());
  }

  Future<WorkDetail> work(String id) async => WorkDetail.fromMap(
      await _do(() => _dio.get('/v1/works/$id')) as Map);

  Future<Work> patchWork(String id, Map<String, dynamic> patch) async =>
      Work.fromMap(
          await _do(() => _dio.patch('/v1/works/$id', data: patch)) as Map);

  // ---------- 多模态意图线 ----------

  /// 上传语音建意图草稿卡并派单。文件名按真实扩展名带上——服务端是按
  /// multipart 文件名后缀 + 魔数双重校验格式的（写死 .m4a 会拒掉端侧录的 wav）。
  Future<String> intentVoice(String filePath, {String? filename}) async {
    final fd = FormData();
    fd.files.add(MapEntry(
        'file',
        await MultipartFile.fromFile(filePath,
            filename: filename ??
                (filePath.toLowerCase().endsWith('.wav') ? 'voice.wav' : 'voice.m4a'))));
    final d = await _do(() => _dio.post('/v1/intent/voice', data: fd)) as Map;
    return '${d['intent_id']}';
  }

  /// 文本意图线（契约 v3.3 POST /v1/intent/text）：端侧识别出的逐字、或在
  /// 「你说的话」确认页改过的字，直接进理解链（不再过 ASR）。
  /// 带 [intentId] 时原地重编译——改字即重新理解，不用重录。
  Future<String> intentText(String text, {String? intentId, String? hint}) async {
    final d = await _do(() => _dio.post('/v1/intent/text', data: {
          'text': text,
          if (intentId != null) 'intent_id': intentId,
          if (hint != null && hint.isNotEmpty) 'hint': hint,
        })) as Map;
    return '${d['intent_id']}';
  }

  Future<String> intentImage(String filePath) async {
    final fd = FormData();
    fd.files.add(MapEntry(
        'file',
        await MultipartFile.fromFile(filePath, filename: 'photo.jpg')));
    final d = await _do(() => _dio.post('/v1/intent/image', data: fd)) as Map;
    return '${d['intent_id']}';
  }

  /// 语音能力自检（契约 v3.3 GET /v1/health/speech）：服务端识别服务在不在、
  /// 为什么不在。原样回传 Map，由设置页诚实呈现，这里不下结论。
  Future<Map<String, dynamic>> speechHealth() async {
    final d = await _do(() => _dio.get('/v1/health/speech')) as Map;
    return Map<String, dynamic>.from(d);
  }

  Future<Intent> intent(String id) async =>
      Intent.fromMap(await _do(() => _dio.get('/v1/intent/$id')) as Map);

  Future<Intent> intentAnswer(String id, List<IntentAnswer> answers) async {
    final d = await _do(() => _dio.post('/v1/intent/$id/answer',
        data: {
          'answers': answers.map((a) => a.toJson()).toList()
        })) as Map;
    return Intent.fromMap(d);
  }

  /// 卡面「点改」落库（契约 v2.19 PATCH /v1/intent/:id）：只提交改动的键，
  /// 返回最新 intent（服务端裁剪后为准）。可改键：
  /// mood / vocal / genre_hypotheses / scene_desc / sec / bpm / count
  Future<Intent> intentPatch(String id, Map<String, dynamic> patch) async {
    final d = await _do(() => _dio.patch('/v1/intent/$id', data: patch)) as Map;
    return Intent.fromMap(d);
  }

  /// 返回 job_id（仅 status=ready 可调）
  Future<String> intentGenerate(String id) async {
    final d = await _do(() => _dio.post('/v1/intent/$id/generate')) as Map;
    return '${d['job_id']}';
  }

  // ---------- 复刻线（契约 v5.7）----------

  /// 上传参考曲（mp3/wav/m4a ≤20MB，服务端魔数+sha256 去重+72h TTL）。
  /// 同一文件重复上传吃幂等，返回同一个 upload_id。
  Future<String> replicaUpload(String filePath, {String? filename}) async {
    final fd = FormData();
    fd.files.add(MapEntry(
        'file',
        await MultipartFile.fromFile(filePath,
            filename: filename ?? 'reference.wav')));
    final d =
        await _do(() => _dio.post('/v1/replica/source/upload', data: fd)) as Map;
    return '${d['upload_id']}';
  }

  /// 发起风格分析。work/upload → {job_id}（异步，轮询 job 后按 job_id 反查谱）；
  /// web → {ok:true, profile} | {ok:false, reason, artist_blocked?}（同步，永不下载音频）。
  Future<Map> replicaAnalyze(
      {required String kind, String? ref, String? query, String? title}) async {
    return await _do(() => _dio.post('/v1/replica/analyze', data: {
          'source': {
            'kind': kind,
            if (ref != null && ref.isNotEmpty) 'ref': ref,
            if (query != null && query.isNotEmpty) 'query': query,
            if (title != null && title.isNotEmpty) 'title': title,
          },
        })) as Map;
  }

  /// 本人复刻谱列表；[jobId] 用于分析 job 完成后反查自己的谱（列表端点上的查询串）。
  Future<List<ReplicaProfile>> replicaProfiles({String? jobId}) async {
    final d = await _do(() => _dio.get('/v1/replica/profiles',
            queryParameters:
                jobId == null || jobId.isEmpty ? null : {'job_id': jobId}))
        as Map;
    return (d['items'] as List? ?? const [])
        .whereType<Map>()
        .map(ReplicaProfile.fromMap)
        .toList();
  }

  /// 删谱不删作品（作品上的复刻标注保留，契约 v5.7.9）。
  Future<void> replicaProfileDelete(String id) async {
    await _do(() => _dio.delete('/v1/replica/profiles/$id'));
  }

  /// 自由反馈 + 谱 → 服务端预填意图卡并出 ≤3 道收敛题。返回 intent_id，
  /// 之后 answer/patch/generate 全走既有意图卡链（事务/限流/审核零豁免）。
  Future<String> replicaFeedback(String profileId, String text) async {
    final d = await _do(() => _dio.post(
            '/v1/replica/profiles/$profileId/feedback',
            data: {'text': text}))
        as Map;
    return '${d['intent_id']}';
  }

  /// 微调：{understood:true, job_id} | {understood:false, clarify}
  Future<Map> adjust(String workId, String text) async =>
      await _do(() => _dio.post('/v1/works/$workId/adjust',
          data: {'text': text})) as Map;

  // ---------- 音乐助手（契约 v3.1：治理门面，跨模块复用 MV 范式）----------
  // body：{session_id?, text, chips:[{type:'work'|'intent'|'job'|'candidate'|'persona', id}]}
  // → 200 {session_id, reply, meta:{mode,intent,rejected?,fused?}, ticket?{...est}}；异常经 _do 抛 ApiException。
  Future<Map> musicAssistantMessages({
    String? sessionId,
    required String text,
    List<Map<String, dynamic>> chips = const [],
  }) async {
    final d = await _do(() => _dio.post('/v1/music/assistant/messages',
        data: {
          if (sessionId != null && sessionId.isNotEmpty) 'session_id': sessionId,
          'text': text,
          if (chips.isNotEmpty) 'chips': chips,
        })) as Map;
    return d;
  }

  /// POST /v1/music/tickets/:id/confirm {ver, hash} → 200 {ok, action, job_id, credits_charged}
  Future<Map> musicConfirmTicket(String ticketId,
      {String? ver, String? hash}) async =>
      await _do(() => _dio.post('/v1/music/tickets/$ticketId/confirm',
          data: {
            if (ver != null) 'ver': ver,
            if (hash != null) 'hash': hash,
          })) as Map;

  /// POST /v1/music/tickets/:id/deny → 200 {ok:true}
  Future<void> musicDenyTicket(String ticketId) async {
    await _do(() => _dio.post('/v1/music/tickets/$ticketId/deny'));
  }

  // ---------- 人格 / 谱系 / DSP / 分享 ----------

  Future<List<Persona>> personas() async {
    final d = await _do(() => _dio.get('/v1/personas')) as Map;
    return (d['items'] as List? ?? const [])
        .whereType<Map>()
        .map(Persona.fromMap)
        .toList();
  }

  Future<Persona> createPersona(String name, String filePath) async {
    final fd = FormData();
    fd.fields.add(MapEntry('name', name));
    fd.files.add(MapEntry(
        'file',
        await MultipartFile.fromFile(filePath, filename: 'persona.m4a')));
    return Persona.fromMap(
        await _do(() => _dio.post('/v1/personas', data: fd)) as Map);
  }

  Future<Persona> workToPersona(String workId, String name, {int? startSec, int? seconds}) async =>
      Persona.fromMap(await _do(() => _dio
              .post('/v1/works/$workId/to-persona', data: {
                    'name': name,
                    // 取样窗口：4 分钟的歌只能从 0 秒裁的话，切到的必然是前奏器乐段，
                    // 声纹参考里没有人声 = cover 变声永远锁不住音色（2026-11-27）
                    if (startSec != null) 'start_sec': startSec,
                    if (seconds != null) 'seconds': seconds,
                  }))
          as Map);

  Future<String> extend(String workId, int sec) async {
    final d = await _do(
        () => _dio.post('/v1/works/$workId/extend', data: {'sec': sec})) as Map;
    return '${d['job_id']}';
  }

  Future<String> cover(String workId, String personaId) async {
    final d = await _do(() =>
            _dio.post('/v1/works/$workId/cover', data: {'persona_id': personaId}))
        as Map;
    return '${d['job_id']}';
  }

  Future<String> variation(String workId, Map<String, dynamic> delta) async {
    final d = await _do(() =>
            _dio.post('/v1/works/$workId/variation', data: {'delta': delta}))
        as Map;
    return '${d['job_id']}';
  }

  Future<String> dsp(String workId, String op, Map<String, dynamic> params) async {
    final d = await _do(() =>
            _dio.post('/v1/works/$workId/dsp', data: {'op': op, 'params': params}))
        as Map;
    return '${d['job_id']}';
  }

  Future<SeedPack> seedPack(String workId) async {
    final d = await _do(() => _dio.get('/v1/works/$workId/seed-pack')) as Map;
    return SeedPack.fromMap((d['seed_pack'] as Map?) ?? const {});
  }

  Future<void> report(String workId, String reason) async {
    await _do(() =>
        _dio.post('/v1/works/$workId/report', data: {'reason': reason}));
  }

  // ---------- 公共静态读（无鉴权） ----------

  /// 拉取 peaks 波形 json（/f/* 公共读）
  Future<List<double>?> fetchPeaks(String url) async {
    try {
      final r = await _raw.get<dynamic>(url);
      final data = r.data;
      if (data is List) {
        return data.map<double>((e) => (e as num).toDouble()).toList();
      }
      if (data is Map && data['peaks'] is List) {
        return (data['peaks'] as List)
            .map<double>((e) => (e as num).toDouble())
            .toList();
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 导出下载音频，返回本地保存路径
  Future<String> download(String url, String savePath) async {
    try {
      await _raw.download(url, savePath, deleteOnError: true);
      return savePath;
    } on DioException catch (e) {
      throw _toApiEx(e);
    }
  }
}
