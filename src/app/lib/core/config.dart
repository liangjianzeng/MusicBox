import 'package:shared_preferences/shared_preferences.dart';

/// 应用配置：服务器地址可在“我的”页修改并持久化
class AppConfig {
  AppConfig({required this.baseUrl});

  /// 模拟器访问宿主机默认地址（Android 模拟器 → 宿主 127.0.0.1）
  static const defaultBaseUrl = 'http://10.0.2.2:7900';

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

  AppConfig loadConfig() =>
      AppConfig(baseUrl: _sp.getString(_kBaseUrl) ?? AppConfig.defaultBaseUrl);

  Future<void> saveBaseUrl(String v) => _sp.setString(_kBaseUrl, v);

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

  /// 创作档位记忆：0 傻瓜 / 1 标准 / 2 深度
  int get createTier => _sp.getInt(_kTier) ?? 0;
  Future<void> setCreateTier(int v) => _sp.setInt(_kTier, v);
}
