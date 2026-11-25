import 'package:shared_preferences/shared_preferences.dart';

/// 应用版本（与 pubspec.yaml version 保持一致；后台版本策略据此判断升级）
const String kAppVersion = '0.1.0';

/// 应用配置：服务器地址可在“我的”页修改并持久化
class AppConfig {
  AppConfig({required this.baseUrl});

  /// 发布默认服务器 origin：打包期经 `--dart-define=MUSICBOX_BASE_URL=<url>` 注入（部署参数，非源码写死）。
  /// 未注入时回退到跨网 origin，保证真机首启即达后端、直接进首页；App 内「服务器设置」保留为调试后门。
  static const defaultBaseUrl = String.fromEnvironment(
    'MUSICBOX_BASE_URL',
    defaultValue: 'http://100.100.140.75:7901',
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
