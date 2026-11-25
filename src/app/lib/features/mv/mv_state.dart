import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import 'mv_api_client.dart';
import 'mv_list_state.dart';
import 'mv_models.dart';

export 'mv_list_state.dart';

/// MV 特性域状态：向导草稿 / 项目详情轮询
/// （API 客户端注入与列表侧状态见 mv_list_state.dart，经 export 统一入口）
/// 范式：Riverpod StateNotifier（全 App 统一）

// ---------- 向导草稿（六步 · 本地 StateNotifier，进程内续作） ----------
// 纪律：这是「本地草稿」，不是服务端存档 —— 页面随路由 pop 销毁、同一
// workId 再进向导时从 family 缓存恢复草稿，即「路由级 dispose-and-resume」；
// 杀 App 即清空，UI 不假装「已保存」。

class MvWizardState {
  const MvWizardState({
    required this.step,
    this.workId,
    this.work,
    this.brief,
    this.gender,
    this.channel, // upload|ai（双通道，发起人硬性要求并列露出）
    this.imagePath,
    this.imageName,
    this.imageId, // 上传成功后的服务端 image_id
    this.authorized = false, // 「本人或已获授权」勾选（真人通道必勾）
    this.uploadError,
    this.submitting = false,
    this.submitError,
    this.project, // 提交成功后的项目（步③依赖）
    this.jobNote, // cast_image 派发结果如实记录（失败也不装成功）
    this.lookConfirmed = false, // 步③帧格拍板已固化（门禁依据）
  });

  final int step; // 0..5 ↔ ①选曲 ②选角 ③定妆 ④剧本 ⑤开机 ⑥成片
  final String? workId;
  final Work? work;
  final String? brief; // 一句话创意
  final String? gender; // m|f
  final String? channel;
  final String? imagePath;
  final String? imageName;
  final String? imageId;
  final bool authorized;
  final String? uploadError;
  final bool submitting;
  final String? submitError;
  final MvProject? project;
  final String? jobNote;
  final bool lookConfirmed;

  bool get hasWork => workId != null;

  /// 步②确认门：真人通道 = 本地已选照 + 无校验错误 + 授权勾选 + 性别；
  /// AI 通道 = 性别。上传在提交时发生，imageId 不是进门条件。
  bool get castReady =>
      gender != null &&
      channel != null &&
      (channel == 'ai' ||
          (channel == 'upload' &&
              (imagePath ?? '').isNotEmpty &&
              (uploadError ?? '').isEmpty &&
              authorized));

  MvWizardState copyWith({
    int? step,
    String? workId,
    Work? work,
    String? brief,
    String? gender,
    String? channel,
    String? imagePath,
    String? imageName,
    String? imageId,
    bool? authorized,
    String? uploadError,
    bool clearUploadError = false,
    bool? submitting,
    String? submitError,
    bool clearSubmitError = false,
    MvProject? project,
    String? jobNote,
    bool? lookConfirmed,
  }) =>
      MvWizardState(
        step: step ?? this.step,
        workId: workId ?? this.workId,
        work: work ?? this.work,
        brief: brief ?? this.brief,
        gender: gender ?? this.gender,
        channel: channel ?? this.channel,
        imagePath: imagePath ?? this.imagePath,
        imageName: imageName ?? this.imageName,
        imageId: imageId ?? this.imageId,
        authorized: authorized ?? this.authorized,
        uploadError:
            clearUploadError ? null : (uploadError ?? this.uploadError),
        submitting: submitting ?? this.submitting,
        submitError:
            clearSubmitError ? null : (submitError ?? this.submitError),
        project: project ?? this.project,
        jobNote: jobNote ?? this.jobNote,
        lookConfirmed: lookConfirmed ?? this.lookConfirmed,
      );
}

class MvWizardNotifier extends StateNotifier<MvWizardState> {
  MvWizardNotifier(this._ref, this.workId)
      : super(MvWizardState(
            step: (workId ?? '').isNotEmpty ? 1 : 0,
            // 从曲库/详情进入：带上预选曲目 id（Work 对象在步①选中时补全）
            workId: (workId ?? '').isEmpty ? null : workId));

  final Ref _ref;
  final String? workId;

  MvApiClient get _api => _ref.read(mvApiClientProvider);

  void setWork(Work w) =>
      state = state.copyWith(workId: w.id, work: w, clearSubmitError: true);
  void setBrief(String? v) => state = state.copyWith(brief: v);
  void setGender(String g) => state = state.copyWith(gender: g);

  void setChannel(String? c) {
    // 切换通道：真人通道的草稿照保留在 imagePath，但 imageId 作废需重传
    state = state.copyWith(
      channel: c,
      imageId: null,
      clearUploadError: true,
      clearSubmitError: true,
    );
  }

  void pickedImage(String path) => state = state.copyWith(
        channel: 'upload',
        imagePath: path,
        imageName: path.split(RegExp(r'[/\\]')).last,
        imageId: null,
        clearUploadError: true,
        clearSubmitError: true,
      );

  void setAuthorized(bool v) => state = state.copyWith(authorized: v);

  /// 本地校验错误（照片格式/大小/授权），与提交错误分开呈现
  void setUploadErrorLocal(String? err) => state = err == null
      ? state.copyWith(clearUploadError: true)
      : state.copyWith(uploadError: err);

  void back() => state = state.copyWith(step: (state.step - 1).clamp(0, 5));
  void goTo(int s) => state = state.copyWith(step: s.clamp(0, 5));

  /// 步②「确认主演，去定妆」：校验 →（真人通道）上传人像 → 建项目 → 派发定妆照任务。
  /// 任一步失败：如实呈现错误并停在原地，绝不伪造 project。
  Future<bool> submitCast() async {
    if (state.workId == null) {
      state = state.copyWith(submitError: '先选一首已完成的歌');
      return false;
    }
    if (!state.castReady) {
      state = state.copyWith(
          submitError: state.channel == 'upload'
              ? '请选好照片、勾选「本人或已获授权」并选定性别'
              : '请选择主演性别与通道');
      return false;
    }
    state = state.copyWith(
        submitting: true, clearSubmitError: true, clearUploadError: true);
    try {
      String? imageId = state.imageId;
      if (state.channel == 'upload' && (imageId ?? '').isEmpty) {
        final path = state.imagePath ?? '';
        if (path.isEmpty) {
          state = state.copyWith(submitting: false, submitError: '请先选择照片');
          return false;
        }
        final uploaded = await _api.uploadImage(path);
        if (uploaded.isEmpty) {
          throw ApiException(code: 'INTERNAL', message: '照片上传未返回凭据，请重试');
        }
        imageId = uploaded;
        state = state.copyWith(imageId: uploaded);
      }
      final m = await _api.createProject(
        workId: state.workId!,
        brief: state.brief,
        character: {
          'gender': state.gender,
          'source': state.channel,
          if (imageId != null && imageId.isNotEmpty) 'image_id': imageId,
          if (state.work != null) 'name': state.work!.title,
        },
      );
      final project = MvProject.fromMap(m);
      if (project.id.isEmpty) {
        throw ApiException(code: 'INTERNAL', message: '项目创建异常，请重试');
      }
      state = state.copyWith(submitting: false, project: project, step: 2);
      // 派发定妆照任务（失败不吞：如实记录 jobNote，步③呈现）
      try {
        await _api.createJob(project.id, 'cast_image');
        state = state.copyWith(jobNote: '定妆照任务已提交，等待出图');
      } on ApiException catch (e) {
        state = state.copyWith(jobNote: '定妆照任务提交失败：${e.zh}');
      }
      return true;
    } on ApiException catch (e) {
      state = state.copyWith(submitting: false, submitError: e.zh);
      return false;
    } catch (_) {
      state = state.copyWith(submitting: false, submitError: '提交失败，请稍后重试');
      return false;
    }
  }

  /// 步③帧格拍板固化：frame_sel 为 [{url,score,sel}]（契约 v2.1），
  /// 帧数据来自 GET detail 的 character.frames（executor 抽帧+评分回传）；
  /// 用户挑中的定妆照 url 一并提交（服务端固化为 viewRefs 身份真源）。
  /// 服务端未回帧时 UI 禁用本方法，这里再兜一层空数据，绝不空拍板。
  Future<bool> confirmCastFrames({
    required String castImageUrl,
    required List<Map<String, dynamic>> frameSel,
  }) async {
    final p = state.project;
    if (p == null || frameSel.isEmpty) return false;
    try {
      final d = await _api.project(p.id);
      final detail = MvProjectDetail.fromMap(d);
      if (detail.characters.isEmpty) return false;
      final c = detail.characters.first;
      final url =
          (castImageUrl.isNotEmpty ? castImageUrl : c.castImageUrl) ?? '';
      if (url.isEmpty) return false;
      await _api.confirmCast(
        projectId: p.id,
        characterId: c.id,
        castImageUrl: url,
        frameSel: frameSel,
      );
      state = state.copyWith(lookConfirmed: true);
      // 刷新详情让 confirmedAt 落到门禁判定
      await _ref
          .read(mvProjectDetailProvider(p.id).notifier)
          .refresh(quiet: true);
      return true;
    } on ApiException {
      return false;
    }
  }

  /// 步③「拍定妆视频」派发（cast_video 需已选定妆照 url；失败如实返回错误）
  Future<String?> dispatchCastVideo(String castImageUrl) async {
    final p = state.project;
    if (p == null || castImageUrl.isEmpty) return '请先挑选定妆照';
    try {
      final r = await _api
          .createJob(p.id, 'cast_video', {'cast_image_url': castImageUrl});
      final charged = r['credits_charged'];
      final n = charged is num ? charged.toInt() : 0;
      state = state.copyWith(
          jobNote:
              n > 0 ? '定妆视频任务已提交（扣 $n ⚡），约需 5 分钟' : '定妆视频任务已提交（幂等命中，未重复扣分）');
      return null;
    } on ApiException catch (e) {
      return mvFriendlyError(e);
    }
  }
}

/// family 键 = 起始 workId（从曲库/详情进入带作品；MV tab 进入为 null）
/// 不用 autoDispose：路由 pop 后草稿保留（dispose-and-resume），再进续作。
final mvWizardProvider =
    StateNotifierProvider.family<MvWizardNotifier, MvWizardState, String?>(
        (ref, key) => MvWizardNotifier(ref, key));

// ---------- 项目详情（进度页/定妆页轮询 + WSS mv.progress 加速） ----------

class MvDetailState {
  const MvDetailState({this.detail, this.loading = false, this.error});

  final MvProjectDetail? detail;
  final bool loading;
  final String? error;

  MvDetailState copyWith(
          {MvProjectDetail? detail, bool? loading, String? error}) =>
      MvDetailState(
          detail: detail ?? this.detail,
          loading: loading ?? this.loading,
          error: error ?? this.error);
}

/// 开机（boot）结果分类：UI 按 code 分支呈现诚实对话
class MvBootOutcome {
  MvBootOutcome(this.code, {this.message, this.charged = 0, this.jobs = 0});
  final String
      code; // OK|EST_STALE|NOT_READY|BUDGET_EXCEEDED|CREDITS_NOT_ENOUGH|ERR
  final String? message;
  final int charged;
  final int jobs;
  bool get ok => code == 'OK';
}

class MvProjectDetailNotifier extends StateNotifier<MvDetailState> {
  MvProjectDetailNotifier(this._ref, this.projectId)
      : super(const MvDetailState());
  final Ref _ref;
  final String projectId;

  MvApiClient get _api => _ref.read(mvApiClientProvider);

  /// 静默刷新（轮询用：失败保留旧数据，不打断 UI）
  Future<void> refresh({bool quiet = false}) async {
    if (!quiet) state = state.copyWith(loading: true);
    try {
      final m = await _api.project(projectId);
      state = MvDetailState(detail: MvProjectDetail.fromMap(m));
    } on ApiException catch (e) {
      if (!quiet || state.detail == null) {
        state = state.copyWith(loading: false, error: mvFriendlyError(e));
      }
    }
  }

  // ---------- wave-3 动作（全部经 MvApiClient；错误如实返回，不伪造成功） ----------

  /// 派单（jobs）：cast_image/cast_video/storyboard/preview/shoot/compose
  Future<(bool ok, String? err, int charged)> dispatchJob(String type,
      [Map<String, dynamic>? params]) async {
    try {
      final r = await _api.createJob(projectId, type, params);
      final charged = r['credits_charged'];
      return (true, null, charged is num ? charged.toInt() : 0);
    } on ApiException catch (e) {
      return (false, mvFriendlyError(e), 0);
    }
  }

  /// 免费样片（首免/重出 5⚡，服务端判定）
  Future<(bool ok, String? err, int charged)> requestPreview() async {
    try {
      final r = await _api.requestPreview(projectId);
      final charged = r['credits_charged'];
      return (true, null, charged is num ? charged.toInt() : 0);
    } on ApiException catch (e) {
      return (false, mvFriendlyError(e), 0);
    }
  }

  /// ver CAS 通用：409 STALE → refetch 取新 ver 重试一次，二次失败如实返回
  Future<String?> _casPatch(Future<void> Function(int ver) call) async {
    final ver = state.detail?.project.scriptVer ?? 1;
    try {
      await call(ver);
      return null;
    } on ApiException catch (e) {
      if (e.code != 'STALE') return mvFriendlyError(e);
      try {
        final m = await _api.project(projectId);
        final fresh = MvProjectDetail.fromMap(m);
        state = MvDetailState(detail: fresh);
        await call(fresh.project.scriptVer);
        return null;
      } on ApiException catch (e2) {
        return mvFriendlyError(e2);
      }
    }
  }

  /// 镜卡编辑（步④长按：改词/删镜/调序/景别）→ PATCH script_json（ver CAS）。
  /// 成功后按编辑结果乐观合并本地镜卡（脚本已持久化；服务端镜表回读对齐前
  /// 以用户刚保存的内容呈现，绝不清空）。
  Future<String?> editScript(List<MvShot> edited) async {
    if (edited.isEmpty) return '至少保留一个镜头';
    final scriptJson = <String, dynamic>{
      'shots': edited.map((s) => s.toScriptShot()).toList(),
    };
    final err = await _casPatch((ver) =>
        _api.patchProject(projectId, ver: ver, scriptJson: scriptJson));
    if (err != null) return err;
    final old = state.detail;
    if (old != null) {
      final byId = {for (final s in old.shots) s.id: s};
      final merged = <MvShot>[];
      for (final e in edited) {
        final base = byId[e.id];
        merged.add(base == null
            ? e
            : base.copyWith(
                seq: e.seq,
                kind: e.kind,
                sec: e.sec,
                desc: e.desc,
                camera: e.camera));
      }
      final verBump = old.project.copyWithScriptVer(old.project.scriptVer + 1);
      state = MvDetailState(
          detail: MvProjectDetail(
              project: verBump,
              characters: old.characters,
              shots: merged,
              tickets: old.tickets,
              assistantEnabled: old.assistantEnabled,
              assistantChat: old.assistantChat,
              assistantModeHint: old.assistantModeHint,
              aiReview: old.aiReview));
    }
    return null;
  }

  /// 开机开拍（boot{est_ver}）：错误码原样分类返回，UI 负责诚实对话
  Future<MvBootOutcome> boot(String estVer) async {
    if (estVer.isEmpty) {
      return MvBootOutcome('NOT_READY', message: '报价尚未生成，请先出样片');
    }
    try {
      final r = await _api.bootProject(projectId, estVer);
      final charged = r['credits_charged'];
      final jobs = (r['jobs'] as List? ?? const []);
      await refresh(quiet: true);
      return MvBootOutcome('OK',
          charged: charged is num ? charged.toInt() : 0, jobs: jobs.length);
    } on ApiException catch (e) {
      const known = {
        'EST_STALE',
        'NOT_READY',
        'BUDGET_EXCEEDED',
        'CREDITS_NOT_ENOUGH'
      };
      await refresh(quiet: true); // 状态可能已变（如 paused），如实刷新
      return MvBootOutcome(known.contains(e.code) ? e.code : 'ERR',
          message: e.zh);
    }
  }

  /// 单镜返工（重拍 reshoot / 对口型 resync）；chips 诊断链 reason 过禁词净化
  Future<(bool ok, String? err, int charged)> shotJob(
      String shotId, String type, String? reason) async {
    try {
      final r = await _api.shotJob(shotId,
          type: type, reason: reason == null ? null : mvHuman(reason));
      final charged = r['credits_charged'];
      await refresh(quiet: true);
      return (true, null, charged is num ? charged.toInt() : 0);
    } on ApiException catch (e) {
      return (false, mvFriendlyError(e), 0);
    }
  }

  /// 「让它改改」：409 NOT_READY → notReady=true，UI 退回手动编辑（不装忙）
  Future<(MvSuggest? suggest, String? err, bool notReady)> suggestScript(
      String note) async {
    try {
      final r = await _api.suggestScript(projectId, note);
      final s = (r['suggest'] as Map?);
      if (s == null) {
        return (null, '编剧没给出可用的建议，请稍后再试', false);
      }
      return (MvSuggest.fromMap(s), null, false);
    } on ApiException catch (e) {
      if (e.code == 'NOT_READY') return (null, e.zh, true);
      return (null, mvFriendlyError(e), false);
    }
  }

  /// 采纳建议（suggest/apply，ver CAS + STALE retry-once）
  Future<String?> applySuggest(MvSuggest s) async {
    final err =
        await _casPatch((ver) => _api.applySuggest(projectId, s.id, ver));
    if (err == null) await refresh(quiet: true);
    return err;
  }

  /// 项目取消：返回退款积分（未拍镜全额退，账本核算如实呈现）
  Future<(int? refunded, String? err)> cancel() async {
    try {
      final r = await _api.cancelProject(projectId);
      await refresh(quiet: true);
      return (r, null);
    } on ApiException catch (e) {
      return (null, mvFriendlyError(e));
    }
  }

  /// 确认票拍板（通告板与助手共用）：批准 true / 拒绝 false；404 如实呈现
  Future<String?> resolveTicket(String ticketId, bool approve,
      {String? ver, String? hash}) async {
    try {
      if (approve) {
        await _api.confirmTicket(ticketId, ver: ver, hash: hash);
      } else {
        await _api.denyTicket(ticketId);
      }
      await refresh(quiet: true);
      return null;
    } on ApiException catch (e) {
      if (e.code == 'NOT_FOUND') return '这张票已失效（过期或已处理），未执行任何操作';
      return mvFriendlyError(e);
    }
  }

  /// 人工调高预算（v2.11：paused 唯一恢复通道，ver CAS）
  Future<String?> raiseBudget(int newBudget) async {
    final err = await _casPatch((ver) =>
        _api.patchProject(projectId, ver: ver, budgetCredits: newBudget));
    if (err == null) await refresh(quiet: true);
    return err;
  }
}

final mvProjectDetailProvider = StateNotifierProvider.autoDispose
    .family<MvProjectDetailNotifier, MvDetailState, String>(
        (ref, id) => MvProjectDetailNotifier(ref, id)..refresh());

// ---------- 制片助手（bottom-sheet；D11 灰度：可见性服务端下发优先） ----------
// 治理纪律：拍板权在人 —— 助手只引路；昂贵动作走确认票；LLM 离线/端点未
// 上线（MV_NOT_READY）→ 规则助手模式横幅 + 快捷指令，绝不伪造回复。

class MvChatMsg {
  MvChatMsg({
    required this.role, // user|ai|sys
    required this.text,
    this.ticket,
    this.ticketHandled = false, // 已批准/拒绝（防一票多点）
    this.adoptableSuggestId, // 挂「采纳」按钮的建议草稿 id
    this.adoptableSummary,
  });

  final String role;
  final String text;
  final MvTicket? ticket;
  final bool ticketHandled;
  final String? adoptableSuggestId;
  final String? adoptableSummary;

  MvChatMsg copyWith({bool? ticketHandled}) => MvChatMsg(
        role: role,
        text: text,
        ticket: ticket,
        ticketHandled: ticketHandled ?? this.ticketHandled,
        adoptableSuggestId: adoptableSuggestId,
        adoptableSummary: adoptableSummary,
      );
}

class MvAssistantState {
  const MvAssistantState({
    this.sessionId,
    this.messages = const [],
    this.sending = false,
    this.rulesMode = false, // AI 对话不可用 → 规则助手模式
    this.error,
  });

  final String? sessionId;
  final List<MvChatMsg> messages;
  final bool sending;
  final bool rulesMode;
  final String? error;

  MvAssistantState copyWith({
    String? sessionId,
    List<MvChatMsg>? messages,
    bool? sending,
    bool? rulesMode,
    String? error,
    bool clearError = false,
  }) =>
      MvAssistantState(
        sessionId: sessionId ?? this.sessionId,
        messages: messages ?? this.messages,
        sending: sending ?? this.sending,
        rulesMode: rulesMode ?? this.rulesMode,
        error: clearError ? null : (error ?? this.error),
      );
}

class MvAssistantNotifier extends StateNotifier<MvAssistantState> {
  MvAssistantNotifier(this._ref, this.projectId)
      : super(const MvAssistantState());

  final Ref _ref;
  final String projectId;

  MvApiClient get _api => _ref.read(mvApiClientProvider);

  void _push(MvChatMsg m) =>
      state = state.copyWith(messages: [...state.messages, m]);

  /// 发送对话消息：MV_NOT_READY / chat-off → 规则模式 + 诚实横幅
  Future<void> send(String text, {List<Map<String, dynamic>>? chips}) async {
    final t = text.trim();
    if (t.isEmpty || state.sending) return;
    _push(MvChatMsg(role: 'user', text: t));
    state = state.copyWith(sending: true, clearError: true);
    try {
      final r = await _api.assistantMessages(
        sessionId: state.sessionId,
        text: t,
        chips: chips ??
            [
              {'type': 'project', 'id': projectId},
            ],
      );
      final sid = r['session_id']?.toString();
      if (sid != null && sid.isNotEmpty) {
        state = state.copyWith(sessionId: sid);
      }
      state = state.copyWith(sending: false, rulesMode: false);
      final ticket = (r['ticket'] as Map?);
      if (ticket != null) {
        // 昂贵动作 → 确认票（话术永远是「票已发出」，不是「已完成」）
        _push(MvChatMsg(
            role: 'ai',
            text: mvHuman('${r['reply'] ?? '确认票已发出，请在下方票面拍板。'}'),
            ticket: MvTicket.fromMap(ticket)));
        return;
      }
      final clarify = r['clarify']?.toString();
      final reply = r['reply']?.toString();
      _push(MvChatMsg(
          role: 'ai',
          text: mvHuman((clarify ?? reply ?? '').trim().isEmpty
              ? '（服务端助手未返回内容，请换个说法再试）'
              : (clarify ?? reply)!)));
    } on ApiException catch (e) {
      state = state.copyWith(sending: false);
      if (e.code == 'MV_NOT_READY') {
        if (!state.rulesMode) {
          _push(MvChatMsg(
              role: 'sys',
              text: 'AI 对话助手尚未启用——当前为规则助手模式，可用下方快捷指令，'
                  '主流程不受影响。'));
        }
        state = state.copyWith(rulesMode: true);
        return;
      }
      state = state.copyWith(error: mvFriendlyError(e));
      _push(MvChatMsg(role: 'sys', text: mvFriendlyError(e)));
    }
  }

  /// 规则模式快捷指令：基调建议 / 让它改改 / 运动改写 → 命中既有 suggest 端点
  /// （建议只挂草稿；成功给「采纳」按钮，apply 才 ver++；NOT_READY 如实告知）
  Future<void> quickSuggest(String note, String label) async {
    if (state.sending) return;
    _push(MvChatMsg(role: 'user', text: '【$label】'));
    state = state.copyWith(sending: true, clearError: true);
    try {
      final r = await _api.suggestScript(projectId, note);
      state = state.copyWith(sending: false);
      final s = (r['suggest'] as Map?);
      if (s == null) {
        _push(MvChatMsg(role: 'ai', text: '编剧这次没给出可用建议，可继续手动编辑镜卡。'));
        return;
      }
      final sg = MvSuggest.fromMap(s);
      _push(MvChatMsg(
        role: 'ai',
        text: '【$label】${mvHuman(sg.summary ?? '已按你的诉求改了一版（AI 编剧建议）。')}',
        adoptableSuggestId: sg.id,
        adoptableSummary: sg.summary,
      ));
    } on ApiException catch (e) {
      state = state.copyWith(sending: false);
      _push(MvChatMsg(
          role: 'sys',
          text: e.code == 'NOT_READY'
              ? 'AI 编剧暂不可用（后台未就绪），已退回手动编辑——不装忙。'
              : mvFriendlyError(e)));
    }
  }

  /// 基调建议（契约 v2.22 /tone）：LLM 优先、词典兜底，只读建议、摘要成一句
  Future<void> quickTone() async {
    if (state.sending) return;
    _push(MvChatMsg(role: 'user', text: '【基调建议】'));
    state = state.copyWith(sending: true, clearError: true);
    try {
      final r = await _api.tone(projectId);
      state = state.copyWith(sending: false);
      final ts = (r['tone_suggest'] as Map?);
      final opts =
          (ts?['options'] as List? ?? const []).whereType<Map>().toList();
      final mode = ((r['assist'] as Map?)?['mode'])?.toString();
      if (opts.isEmpty) {
        _push(MvChatMsg(role: 'ai', text: '这次没给出基调建议，稍后再试或手动定基调。'));
        return;
      }
      final lines = opts.map((o) {
        final tags = (o['mood_tags'] as List? ?? const [])
            .map((e) => '$e')
            .where((e) => e.isNotEmpty)
            .join('/');
        final bpm = o['bpm'];
        final key = '${o['key_hint'] ?? ''}';
        final reason = mvHuman('${o['reason'] ?? ''}');
        final parts = <String>[
          if (tags.isNotEmpty) tags,
          if (bpm != null) '$bpm BPM',
          if (key.isNotEmpty) key,
        ];
        return '· ${parts.join(' · ')}'
            '${reason.isNotEmpty ? ' —— $reason' : ''}';
      }).join('\n');
      _push(MvChatMsg(
          role: 'ai',
          text: '画面基调建议（${mode == 'llm' ? 'AI 监制' : '智能推荐'}）：\n$lines'));
    } on ApiException catch (e) {
      state = state.copyWith(sending: false);
      _push(MvChatMsg(role: 'sys', text: mvFriendlyError(e)));
    }
  }

  /// 运动改写（契约 v2.22「动作不对」重拍通道）：server 侧改写运动描述（LLM/词典）
  Future<void> quickMotion(String? shotId) async {
    if (state.sending) return;
    if (shotId == null || shotId.isEmpty) {
      _push(MvChatMsg(role: 'sys', text: '运动改写针对具体某镜：请在镜头清单里长按这镜，选「运动改写」。'));
      return;
    }
    await send('请重拍这镜，原因：动作不对', chips: [
      {'type': 'project', 'id': projectId},
      {'type': 'shot', 'id': shotId},
    ]);
  }

  /// 采纳挂起的建议草稿（ver CAS：失配如实提示后重试，不静默）
  Future<void> adoptSuggest(String suggestId) async {
    if (state.sending) return;
    state = state.copyWith(sending: true);
    final n = _ref.read(mvProjectDetailProvider(projectId).notifier);
    String? err;
    try {
      final r =
          await _api.applySuggest(projectId, suggestId, await _currentVer(n));
      final p = r['project'] as Map?;
      err = p == null ? '采纳未生效，请稍后再试' : null;
    } on ApiException catch (e) {
      if (e.code == 'STALE') {
        // 版本过期：取新 ver 重试一次（与步④同纪律）
        try {
          final fresh = await _api.project(projectId);
          final ver = MvProjectDetail.fromMap(fresh).project.scriptVer;
          final r = await _api.applySuggest(projectId, suggestId, ver);
          err = (r['project'] as Map?) == null ? '采纳未生效，请重试' : null;
        } on ApiException catch (e2) {
          err = mvFriendlyError(e2);
        }
      } else {
        err = mvFriendlyError(e);
      }
    }
    await n.refresh(quiet: true);
    state = state.copyWith(sending: false);
    _push(MvChatMsg(
        role: 'sys', text: err == null ? '已采纳这版建议并同步到剧本。' : '采纳失败：$err'));
  }

  Future<int> _currentVer(MvProjectDetailNotifier n) async {
    final d = n.state.detail;
    if (d != null) return d.project.scriptVer;
    final m = await _api.project(projectId);
    return MvProjectDetail.fromMap(m).project.scriptVer;
  }

  /// 确认票拍板（批准）：TTL/一票一次由服务端硬门，404 如实呈现
  Future<void> approveTicket(MvChatMsg msg) async {
    final t = msg.ticket;
    if (t == null || t.id.isEmpty || t.status != 'pending') return;
    _replaceTicket(msg, msg.copyWith(ticketHandled: true));
    try {
      await _api.confirmTicket(t.id, ver: t.ver, hash: t.hash);
      _push(MvChatMsg(role: 'sys', text: '票已批准，剧组开始执行。'));
    } on ApiException catch (e) {
      _push(MvChatMsg(
          role: 'sys',
          text: e.code == 'NOT_FOUND'
              ? '这张票已失效（过期或已处理），未执行任何操作。'
              : mvFriendlyError(e)));
    }
  }

  /// 确认票拒绝
  Future<void> denyTicket(MvChatMsg msg) async {
    final t = msg.ticket;
    if (t == null || t.id.isEmpty || t.status != 'pending') return;
    _replaceTicket(msg, msg.copyWith(ticketHandled: true));
    try {
      await _api.denyTicket(t.id);
      _push(MvChatMsg(role: 'sys', text: '已拒绝这张票，未执行任何操作。'));
    } on ApiException catch (e) {
      _push(MvChatMsg(role: 'sys', text: mvFriendlyError(e)));
    }
  }

  void _replaceTicket(MvChatMsg old, MvChatMsg next) {
    final list = [...state.messages];
    final i = list.indexOf(old);
    if (i >= 0) list[i] = next;
    state = state.copyWith(messages: list);
  }
}

final mvAssistantProvider = StateNotifierProvider.autoDispose
    .family<MvAssistantNotifier, MvAssistantState, String>(
        (ref, id) => MvAssistantNotifier(ref, id));
