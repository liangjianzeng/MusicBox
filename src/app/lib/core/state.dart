import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'config.dart';
import 'connectivity.dart';
import 'db.dart';
import 'models.dart';
import 'ws_client.dart';

// ---------- 单例 Provider（main 中 overrideWithValue 注入） ----------

final prefsProvider = Provider<Prefs>((ref) => throw UnimplementedError());
final localDbProvider = Provider<LocalDb>((ref) => throw UnimplementedError());

// ---------- 配置 ----------

class ConfigNotifier extends StateNotifier<AppConfig> {
  ConfigNotifier(this._prefs) : super(_prefs.loadConfig());
  final Prefs _prefs;

  Future<void> setBaseUrl(String url) async {
    var u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = 'http://$u';
    }
    final changed = u != state.baseUrl;
    state = AppConfig(baseUrl: u);
    await _prefs.saveBaseUrl(u);
    // 换地址**必须**连带清掉旧服务器的令牌：令牌与地址不同源时，离线条的恢复探测
    // （_api.me）会一直 401 被吞掉，横幅永远下不来 —— 明明服务器可达也救不回来。
    if (changed) await _prefs.clearTokens();
    // wsClientProvider watch 了 configProvider，地址变更会自动重建并重连
  }

  /// 恢复打包期注入的默认基址（并清掉地址覆盖与令牌）。
  Future<void> resetBaseUrl() async {
    await _prefs.clearBaseUrl();
    await _prefs.clearTokens();
    state = AppConfig(baseUrl: AppConfig.defaultBaseUrl);
  }
}

// ---------- API ----------

final configProvider = StateNotifierProvider<ConfigNotifier, AppConfig>((ref) {
  return ConfigNotifier(ref.watch(prefsProvider));
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final cfg = ref.watch(configProvider);
  final client = ApiClient(api: cfg, prefs: ref.watch(prefsProvider));
  final conn = ref.read(connectivityProvider.notifier);
  client.onCallSuccess = conn.markOnline;
  client.onNetworkError = () => conn.markOffline();
  client.onAuthExpired = () async {
    // 顺序很重要：**先拿同一条 device_key 去换回原来的号**，成功了才覆盖 token。
    // 旧写法先 clearTokens() 再 mint —— 等于先把自己的身份凭证销毁，再指望服务端认得你；
    // 而当年 mint 又不带锚点，于是每次都是一条全新账号，作品就"没了"。
    await ref.read(sessionProvider.notifier).guestLogin(fromAuthExpired: true);
  };
  return client;
});

// ---------- 远程配置（后端下发的定价/默认走向/可选模型） ----------

class RemoteConfig {
  RemoteConfig(this.data);
  final Map data;

  /// 人格克隆强度默认值：**只能由服务端下发**（唯一真源 = 服务端 config.persona）。
  /// 取不到就返回 null —— UI 必须如实显示"没拿到"，绝不在端侧编一个数当默认，
  /// 否则就有了第二个真源：服务端改默认，App 显示的档位和实际跑出来的就不是一回事。
  double? get personaDefaultCoverStrength {
    final v = (data['persona'] as Map?)?['default_cover_strength'];
    if (v == null) return null;
    final d = double.tryParse('$v');
    if (d == null || !d.isFinite || d < 0 || d > 1) return null;
    return d;
  }

  Map get _music => (data['routing']?['music'] as Map?) ?? const {};
  bool get musicLocked => _music['locked'] == true;
  String get musicDefaultEngine => '${_music['engine'] ?? ''}';
  List<Map> get musicModelOptions =>
      ((data['model_options']?['music'] as List?) ?? const [])
          .whereType<Map>()
          .toList();

  /// 功能开关（服务端已按用户灰度判定，客户端只读结果）
  Map get _features => (data['features'] as Map?) ?? const {};
  bool featureOn(String key) => _features[key] == true;
  bool get mvEnabled => featureOn('mv');
  bool get dspEnabled => _features.containsKey('dsp') ? featureOn('dsp') : true;
  bool get personaEnabled =>
      _features.containsKey('persona') ? featureOn('persona') : true;

  /// 制片助手对话版（契约 v2.20）：仅作 App 侧粗判/文案；权威以 project detail 的
  /// assistant.enabled / chat_enabled 为准（避免灰度判定分散）。
  bool get assistantChat => featureOn('assistant_chat');

  /// 音乐助手（契约 v3.1）：接口总闸（规则模式恒可用）+ 对话版 LLM 灰度。
  /// 服务端下发为权威（音乐域无 project detail 下发位，直接读 features）。
  bool get musicAssistant => featureOn('music_assistant');
  bool get assistantChatMusic => featureOn('assistant_chat_music');
  bool get assistantCore => _features.containsKey('assistant_core')
      ? featureOn('assistant_core')
      : true;

  /// 版本策略：低于 min_supported 时 required=强制 / recommended=引导
  Map get _vp => (data['version_policy'] as Map?) ?? const {};
  String get updateMode => '${_vp['update_mode'] ?? 'none'}';
  String? get minSupported =>
      _vp['min_supported'] == null ? null : '${_vp['min_supported']}';
  String? get recommended =>
      _vp['recommended'] == null ? null : '${_vp['recommended']}';
  String? get downloadUrl =>
      _vp['download_url'] == null ? null : '${_vp['download_url']}';
  bool get forceUpdate =>
      updateMode == 'required' &&
      minSupported != null &&
      _cmpVersion(kAppVersion, minSupported!) < 0;
  bool get suggestUpdate =>
      updateMode != 'none' &&
      recommended != null &&
      _cmpVersion(kAppVersion, recommended!) < 0;

  /// 公告
  Map get _ann => (data['announcement'] as Map?) ?? const {};
  bool get announcementVisible => _ann['visible'] == true;
  String get announcementText => '${_ann['text'] ?? ''}';
  String get announcementStyle => '${_ann['style'] ?? 'notice'}';
}

/// 语义化版本比较：a<b 返回 -1，a>b 返回 1，相等 0
int _cmpVersion(String a, String b) {
  List<int> parse(String v) => v
      .split(RegExp(r'[+\-]'))
      .first
      .split('.')
      .map((e) => int.tryParse(e) ?? 0)
      .toList();
  final x = parse(a), y = parse(b);
  for (var i = 0; i < 3; i++) {
    final l = i < x.length ? x[i] : 0, r = i < y.length ? y[i] : 0;
    if (l != r) return l < r ? -1 : 1;
  }
  return 0;
}

class RemoteConfigNotifier extends StateNotifier<RemoteConfig?> {
  RemoteConfigNotifier(this._ref) : super(null);
  final Ref _ref;

  Future<void> refresh() async {
    try {
      final d = await _ref.read(apiClientProvider).appConfig();
      state = RemoteConfig(d);
    } catch (_) {}
  }
}

final remoteConfigProvider =
    StateNotifierProvider<RemoteConfigNotifier, RemoteConfig?>((ref) {
  return RemoteConfigNotifier(ref);
});

/// 生成模型自选（null = 跟随后台默认）
final musicModelProvider = StateProvider<String?>((ref) {
  return ref.watch(prefsProvider).musicModelId;
});

// ---------- 会话（游客静默登录 / 积分 / 流水） ----------

enum SessionStatus { loading, ready, failed }

class LedgerEntry {
  LedgerEntry(this.time, this.delta, this.balanceAfter, this.note);
  final DateTime time;
  final int delta;
  final int balanceAfter;
  final String note;
}

class SessionState {
  SessionState({
    required this.status,
    this.user,
    this.credits,
    this.error,
    this.ledger = const [],
    this.netOnline = true,
    this.identityReset = false,
  });

  final SessionStatus status;
  final AppUser? user;
  final Credits? credits;
  final String? error;
  final List<LedgerEntry> ledger; // 本次会话积分流水（契约无 ledger 端点，本地记）

  /// 离线兜底进首页时为 false；登录/积分恢复后置回 true
  final bool netOnline;

  /// true = 服务端说"这是新账号"，但本机此前是有身份的（曾拿到过 refresh_token）。
  /// 这就是**内容找不回**的时刻：界面上必须说出来，不许让它看起来像一次正常登录
  /// （2026-11-27 真机 P0，用户原话「重装覆盖不能保存本地内容？？？？？？？？？？」）。
  final bool identityReset;

  SessionState copyWith({
    SessionStatus? status,
    AppUser? user,
    Credits? credits,
    bool? identityReset,
    String? error,
    List<LedgerEntry>? ledger,
    bool? netOnline,
  }) =>
      SessionState(
        status: status ?? this.status,
        user: user ?? this.user,
        credits: credits ?? this.credits,
        error: error,
        ledger: ledger ?? this.ledger,
        netOnline: netOnline ?? this.netOnline,
        // 这一行以前**没插进去**（analyze 不会发现：参数声明了但没人用），结果 identityReset
        // 永远是默认 false，横幅永远出不来 —— 判词必须盯着这种"看着像改了"的错
        identityReset: identityReset ?? this.identityReset,
      );
}

class SessionNotifier extends StateNotifier<SessionState> {
  SessionNotifier(this._ref)
      : _prefs = _ref.read(prefsProvider),
        super(SessionState(status: SessionStatus.loading));

  final Ref _ref;
  final Prefs _prefs;
  bool _bootstrapped = false;
  Timer? _offlineRetry;

  ApiClient get _api => _ref.read(apiClientProvider);

  /// 启动连网兜底：整体最长 10s，单请求 3s × 最多 3 次尝试；
  /// 超时/网络不通则离线进首页（本地能力可用），后台继续重试恢复在线
  static const _bootstrapDeadline = Duration(seconds: 10);
  static const _attemptTimeout = Duration(seconds: 3);
  static const _maxAttempts = 3;

  Future<T> _withTimeout<T>(Future<T> Function() f) =>
      f().timeout(_attemptTimeout);

  /// App 启动：有 token 先验证，无 token 静默游客登录
  Future<void> bootstrap() async {
    if (_bootstrapped) return;
    _bootstrapped = true;
    // 拉取远程配置（定价/默认走向/可选模型）；失败不阻断，用本地缓存/默认
    unawaited(_ref.read(remoteConfigProvider.notifier).refresh());
    final deadline = DateTime.now().add(_bootstrapDeadline);
    if (_prefs.accessToken != null) {
      var fatal = false;
      for (var i = 0;
          i < _maxAttempts && DateTime.now().isBefore(deadline);
          i++) {
        try {
          final me = await _withTimeout(_api.me);
          state = state.copyWith(
              status: SessionStatus.ready, user: me.user, credits: me.credits);
          _connectWs();
          return;
        } on TimeoutException {
          continue; // 超时→重试
        } catch (_) {
          fatal = true; // 服务端明确拒绝→token 失效，转游客登录
          break;
        }
      }
      if (!fatal) {
        _enterOffline();
        return;
      }
      await _prefs.clearTokens();
    }
    await _guestLoginBoot(deadline);
  }

  /// 启动用游客登录：带超时重试与离线兜底
  Future<void> _guestLoginBoot(DateTime deadline) async {
    state = state.copyWith(status: SessionStatus.loading);
    for (var i = 0;
        i < _maxAttempts && DateTime.now().isBefore(deadline);
        i++) {
      try {
        final r = await _withTimeout(_api.guestLogin);
        await _prefs.saveTokens(
            '${r['access_token']}', '${r['refresh_token']}');
        await _finishOnline(AppUser.fromMap((r['user'] as Map?) ?? const {}));
        return;
      } on TimeoutException {
        // 超时→重试
      } on ApiException catch (e) {
        // 网络类错误可重试；业务类错误直接进失败页
        if (e.code != 'NETWORK') {
          state = state.copyWith(
              status: SessionStatus.failed, error: e.zh, netOnline: true);
          return;
        }
      }
    }
    _enterOffline();
  }

  /// 离线兜底：放行到首页（本地能力可用），后台定期重试恢复在线
  void _enterOffline() {
    state = state.copyWith(
        status: SessionStatus.ready, error: null, netOnline: false);
    _offlineRetry?.cancel();
    _offlineRetry = Timer.periodic(const Duration(seconds: 10), (_) async {
      if (!mounted) {
        _offlineRetry?.cancel();
        _offlineRetry = null;
        return;
      }
      if (state.netOnline) {
        _offlineRetry?.cancel();
        _offlineRetry = null;
        return;
      }
      if (await _recoverOnce()) {
        _offlineRetry?.cancel();
        _offlineRetry = null;
      }
    });
  }

  /// 离线恢复探测一次，成功返回 true。
  ///
  /// 这里**故意把所有异常吞掉**（服务器可能只是暂时不通，不该弹错误页）。代价是：
  /// 令牌与服务器地址**必须同源**，否则会静默地永远重试不上来 —— 所以
  /// [ConfigNotifier.setBaseUrl] 在地址变化时连带清令牌，别把这条不变量改回去。
  Future<bool> _recoverOnce() async {
    try {
      if (_prefs.accessToken != null) {
        final me = await _withTimeout(_api.me);
        state = state.copyWith(
            status: SessionStatus.ready,
            user: me.user,
            credits: me.credits,
            netOnline: true);
      } else {
        final r = await _withTimeout(_api.guestLogin);
        await _prefs.saveTokens(
            '${r['access_token']}', '${r['refresh_token']}');
        final u = AppUser.fromMap((r['user'] as Map?) ?? const {});
        Credits? credits;
        try {
          credits = (await _withTimeout(_api.me)).credits;
        } catch (_) {}
        state = state.copyWith(
            status: SessionStatus.ready,
            user: u,
            credits: credits,
            netOnline: true);
        _connectWs();
      }
      _ref.read(connectivityProvider.notifier).markOnline();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 离线横幅上的「重试」：立刻探一次，不用等 10s 定时器；失败则继续后台重试。
  Future<void> retryNow() async {
    if (state.netOnline) return;
    if (await _recoverOnce()) return;
    _enterOffline();
  }

  /// 登录成功后的公共收尾：取积分（尽力而为）、置 ready、连 WSS
  Future<void> _finishOnline(AppUser u,
      {bool netOnline = true, bool? identityReset}) async {
    Credits? credits;
    try {
      credits = (await _withTimeout(_api.me)).credits;
    } catch (_) {}
    state = state.copyWith(
        status: SessionStatus.ready,
        user: u,
        credits: credits,
        netOnline: netOnline,
        identityReset: identityReset);
    _connectWs();
  }

  /// 游客登录（静默）。失败进入 failed 态，由门禁给重试页
  Future<void> guestLogin({bool fromAuthExpired = false}) async {
    state = state.copyWith(status: SessionStatus.loading);
    // 必须在 mint **之前**取证：本机此前是否有过身份。之后服务端回 first_time=true 才说明
    // "我们把自己弄丢了"，而不是"第一次来"。
    final hadIdentityBefore =
        (_prefs.refreshToken ?? '').isNotEmpty || (_prefs.accessToken ?? '').isNotEmpty;
    try {
      final r = await _api.guestLogin();
      final firstTime = r['first_time'] == true;
      await _prefs.saveTokens('${r['access_token']}', '${r['refresh_token']}');
      await _finishOnline(
        AppUser.fromMap((r['user'] as Map?) ?? const {}),
        // 曾有过身份 + 服务端说这是新号 = 内容不可能再出现，必须显式告知
        identityReset: firstTime && hadIdentityBefore,
      );
      if (fromAuthExpired && firstTime && hadIdentityBefore) {
        _lastIdentityResetNotice = true; // 门禁/UI 据此挂横幅
      }
    } catch (e) {
      // 只有真失败才清 token：token 是"我曾经是谁"的最后一份证据，不能在尝试之前就销毁
      await _prefs.clearTokens();
      state = state.copyWith(
          status: SessionStatus.failed,
          error: e is ApiException ? e.zh : '登录失败，请重试');
    }
  }

  /// 本次会话是否发生过"身份被换掉"（供横幅使用；用户确认后清掉）
  bool _lastIdentityResetNotice = false;
  bool get identityResetNotice => _lastIdentityResetNotice;
  void acknowledgeIdentityReset() {
    _lastIdentityResetNotice = false;
    state = state.copyWith(identityReset: false);
  }

  /// 手机号绑定：verify 成功后替换 token
  Future<String?> bindPhone(String phone, String code) async {
    try {
      final r = await _api.verifyPhone(phone, code);
      await _prefs.saveTokens('${r['access_token']}', '${r['refresh_token']}');
      final u = AppUser.fromMap((r['user'] as Map?) ?? const {});
      state = state.copyWith(user: u);
      _connectWs();
      await refreshCredits();
      return null;
    } on ApiException catch (e) {
      return e.zh;
    } catch (_) {
      return '绑定失败，请重试';
    }
  }

  Future<void> refreshCredits() async {
    try {
      final me = await _api.me();
      state =
          state.copyWith(user: me.user, credits: me.credits, netOnline: true);
    } catch (_) {}
  }

  /// WSS credit.delta 实时刷新余额并记流水
  void applyCreditDelta(int delta, int balanceAfter, {String note = ''}) {
    final ledger = [
      ...state.ledger,
      LedgerEntry(DateTime.now(), delta, balanceAfter,
          note.isEmpty ? (delta >= 0 ? '返还/奖励' : '消费') : note),
    ];
    if (ledger.length > 50) ledger.removeAt(0);
    state = state.copyWith(
        credits: Credits(
            balance: balanceAfter,
            dailyQuota: state.credits?.dailyQuota ?? 50,
            dailyUsed: state.credits?.dailyUsed ?? 0));
    state = state.copyWith(ledger: ledger);
  }

  void _connectWs() {
    final c = _ref.read(wsClientProvider);
    c.connect();
  }
}

final sessionProvider =
    StateNotifierProvider<SessionNotifier, SessionState>((ref) {
  return SessionNotifier(ref);
});

// ---------- WSS ----------

final wsClientProvider = Provider<WsClient>((ref) {
  final cfg = ref.watch(configProvider);
  final prefs = ref.watch(prefsProvider);
  final client =
      WsClient(wsUrl: cfg.wsUrl, tokenProvider: () => prefs.accessToken);
  client.statusStream.listen((s) {
    final conn = ref.read(connectivityProvider.notifier);
    if (s == WsStatus.connected) {
      conn.markOnline();
    } else if (s == WsStatus.disconnected) {
      // 常驻连接会自己重连，给足宽限再判离线（别一断就闪红条）
      conn.markOffline(grace: const Duration(seconds: 12));
    }
  });
  client.events.listen((e) {
    if (e is CreditDeltaEvent) {
      ref
          .read(sessionProvider.notifier)
          .applyCreditDelta(e.delta, e.balanceAfter);
    }
  });
  ref.onDispose(client.dispose);
  // 创建时若已有 token 则自动连接
  if (prefs.accessToken != null) client.connect();
  return client;
});

/// WSS 事件流（进度页/意图页监听）
final wsEventsProvider = StreamProvider<WsEvent>((ref) {
  return ref.watch(wsClientProvider).events;
});

// ---------- 人格列表 ----------

class PersonasNotifier extends StateNotifier<List<Persona>> {
  PersonasNotifier(this._ref) : super(const []);
  final Ref _ref;
  bool _loaded = false;

  Future<void> load({bool force = false}) async {
    if (_loaded && !force) return;
    _loaded = true;
    try {
      state = await _ref.read(apiClientProvider).personas();
    } catch (_) {
      _loaded = false;
    }
  }
}

final personasProvider =
    StateNotifierProvider<PersonasNotifier, List<Persona>>((ref) {
  return PersonasNotifier(ref);
});

/// 默认人格（本地选择）
final defaultPersonaProvider = StateProvider<String?>((ref) {
  return ref.watch(prefsProvider).defaultPersonaId;
});
