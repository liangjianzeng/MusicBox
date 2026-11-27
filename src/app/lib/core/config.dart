import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// 应用版本（与 pubspec.yaml version 保持一致；后台版本策略据此判断升级）
const String kAppVersion = '0.1.0';

/// 应用配置：服务器地址可在“我的”页修改并持久化
class AppConfig {
  AppConfig({required this.baseUrl});

  /// 发布默认服务器 origin：打包期经 `--dart-define=MUSICBOX_BASE_URL=<url>` 注入。
  /// 未注入时回退到 DGX 的 Tailscale 地址；App 内「服务器设置」保留为调试后门。
  static const defaultBaseUrl = String.fromEnvironment(
    'MUSICBOX_BASE_URL',
    defaultValue: 'http://100.81.83.59:7900',
  );

  String baseUrl;

  /// REST 根地址，无尾斜杠
  String get apiRoot {
    var b = baseUrl.trim();
    while (b.endsWith('/')) {
      b = b.substring(0, b.length - 1);
    }
    return b;
  }

  /// WSS 地址（/ws?token= 由 ws_client 拼接）
  String get wsUrl {
    final u = Uri.parse(apiRoot);
    final scheme = u.scheme == 'https' ? 'wss' : 'ws';
    final port = u.hasPort ? ':${u.port}' : '';
    return '$scheme://${u.host}$port/ws';
  }
}

/// SharedPreferences 封装：token / 配置 / 同意标记 / 默认人格
class Prefs {
  Prefs(this._sp);

  final SharedPreferences _sp;

  static const _kBaseUrl = 'cfg_base_url';
  static const _kAccess = 'auth_access';
  static const _kRefresh = 'auth_refresh';
  static const _kConsent = 'consent_biometric';
  static const _kPersona = 'default_persona_id';
  static const _kTier = 'create_tier';
  static const _kMusicModel = 'create_music_model';
  static const _kDeviceKey = 'identity_device_key';

  AppConfig loadConfig() =>
      AppConfig(baseUrl: _sp.getString(_kBaseUrl) ?? AppConfig.defaultBaseUrl);

  Future<void> saveBaseUrl(String v) => _sp.setString(_kBaseUrl, v);

  /// 清掉「应用内改过服务器地址」这份持久化覆盖，让打包期 dart-define 重新生效。
  /// 没有这条路的话，install -r 保留了旧数据 → 残留地址静默压过新包的默认基址，
  /// 现场表现就是「服务器未连接」但没人知道它在连哪个地址（2026-11-27 真机踩过 40 分钟）。
  Future<void> clearBaseUrl() => _sp.remove(_kBaseUrl);

  /// 设备身份种子：**这是游客身份唯一可恢复的锚点**（契约 POST /v1/auth/guest 的 device_key）。
  ///
  /// 2026-11-27 真机 P0：客户端以前**根本不送** device_key，服务端 `if (!user) INSERT` 于是
  /// 每次 mint 都建一条全新账号并返回 200 —— 重装/清数据/刷新失败后用户看到的就是
  /// "我的歌全没了"，而且界面没有任何一处说明发生了什么（用户原话：重装覆盖不能保存本地内容？？？）。
  /// 规矩：只生成一次、只增不改；清 token 也不许清它（清 token 是登出，不是丢身份）。
  String? get deviceKey => _sp.getString(_kDeviceKey);

  /// 幂等：已有就原样返回，绝不重新生成（重新生成 = 换人 = 作品找不回）
  Future<String> ensureDeviceKey() async {
    final cur = _sp.getString(_kDeviceKey);
    if (cur != null && cur.length >= 32) return cur;
    final rnd = Random.secure();
    final k = List.generate(32, (_) => rnd.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    await _sp.setString(_kDeviceKey, k);
    return k;
  }

  String? get accessToken => _sp.getString(_kAccess);
  String? get refreshToken => _sp.getString(_kRefresh);

  Future<void> saveTokens(String access, String refresh) async {
    await _sp.setString(_kAccess, access);
    await _sp.setString(_kRefresh, refresh);
  }

  Future<void> clearTokens() async {
    await _sp.remove(_kAccess);
    await _sp.remove(_kRefresh);
  }

  /// 语音/图像采集的隐私同意（首次采集前弹窗）
  bool get biometricConsented => _sp.getBool(_kConsent) ?? false;
  Future<void> setBiometricConsented(bool v) => _sp.setBool(_kConsent, v);

  String? get defaultPersonaId => _sp.getString(_kPersona);
  Future<void> setDefaultPersonaId(String? v) async {
    if (v == null) {
      await _sp.remove(_kPersona);
    } else {
      await _sp.setString(_kPersona, v);
    }
  }

  /// 创作档位记忆：0 简约 / 1 标准 / 2 深度
  int get createTier => _sp.getInt(_kTier) ?? 0;
  Future<void> setCreateTier(int v) => _sp.setInt(_kTier, v);

  /// 生成模型自选（APK 覆盖后端默认；null = 跟随后台默认）
  String? get musicModelId => _sp.getString(_kMusicModel);
  Future<void> setMusicModelId(String? v) async {
    if (v == null || v.isEmpty) {
      await _sp.remove(_kMusicModel);
    } else {
      await _sp.setString(_kMusicModel, v);
    }
  }
}
