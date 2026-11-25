import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'config.dart';
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
    state = AppConfig(baseUrl: u);
    await _prefs.saveBaseUrl(u);
    // wsClientProvider watch 了 configProvider，地址变更会自动重建并重连
  }
}

// ---------- API ----------

final configProvider =
    StateNotifierProvider<ConfigNotifier, AppConfig>((ref) {
  return ConfigNotifier(ref.watch(prefsProvider));
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final cfg = ref.watch(configProvider);
  final client = ApiClient(api: cfg, prefs: ref.watch(prefsProvider));
  client.onAuthExpired = () async {
    await ref.read(prefsProvider).clearTokens();
    await ref.read(sessionProvider.notifier).guestLogin();
  };
  return client;
});

// ---------- 远程配置（后端下发的定价/默认走向/可选模型） ----------

class RemoteConfig {
  RemoteConfig(this.data);
  final Map data;

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
  List<int> parse(String v) =>
      v.split(RegExp(r'[+\-]')).first.split('.').map((e) => int.tryParse(e) ?? 0).toList();
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
  });

  final SessionStatus status;
  final AppUser? user;
  final Credits? credits;
  final String? error;
  final List<LedgerEntry> ledger; // 本次会话积分流水（契约无 ledger 端点，本地记）

  SessionState copyWith({
    SessionStatus? status,
    AppUser? user,
    Credits? credits,
    String? error,
    List<LedgerEntry>? ledger,
  }) =>
      SessionState(
        status: status ?? this.status,
        user: user ?? this.user,
        credits: credits ?? this.credits,
        error: error,
        ledger: ledger ?? this.ledger,
      );
}

class SessionNotifier extends StateNotifier<SessionState> {
  SessionNotifier(this._ref)
      : _prefs = _ref.read(prefsProvider),
        super(SessionState(status: SessionStatus.loading));

  final Ref _ref;
  final Prefs _prefs;
  bool _bootstrapped = false;

  ApiClient get _api => _ref.read(apiClientProvider);

  /// App 启动：有 token 先验证，无 token 静默游客登录
  Future<void> bootstrap() async {
    if (_bootstrapped) return;
    _bootstrapped = true;
    // 拉取远程配置（定价/默认走向/可选模型）；失败不阻断，用本地缓存/默认
    unawaited(_ref.read(remoteConfigProvider.notifier).refresh());
    if (_prefs.accessToken != null) {
      try {
        final me = await _api.me();
        state = state.copyWith(
            status: SessionStatus.ready, user: me.user, credits: me.credits);
        _connectWs();
        return;
      } catch (_) {
        await _prefs.clearTokens();
      }
    }
    await guestLogin();
  }

  /// 游客登录（静默）。失败进入 failed 态，由门禁给重试页
  Future<void> guestLogin() async {
    state = state.copyWith(status: SessionStatus.loading);
    try {
      final r = await _api.guestLogin();
      await _prefs.saveTokens('${r['access_token']}', '${r['refresh_token']}');
      final u = AppUser.fromMap((r['user'] as Map?) ?? const {});
      Credits? credits;
      try {
        credits = (await _api.me()).credits;
      } catch (_) {}
      state = state.copyWith(
          status: SessionStatus.ready, user: u, credits: credits);
      _connectWs();
    } catch (e) {
      state = state.copyWith(
          status: SessionStatus.failed,
          error: e is ApiException ? e.zh : '登录失败，请重试');
    }
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
      state = state.copyWith(user: me.user, credits: me.credits);
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
  client.events.listen((e) {
    if (e is CreditDeltaEvent) {
      ref.read(sessionProvider.notifier).applyCreditDelta(e.delta, e.balanceAfter);
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
