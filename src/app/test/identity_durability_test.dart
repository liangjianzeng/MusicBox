// 身份耐久（身份/数据耐久 P0 · 2026-11-27 真机）
//
// 现场：App 的 POST /v1/auth/guest 从不送 device_key，服务端 `if (!user) INSERT` 于是每次 mint
// 都建一条全新账号并返回 200；再加上 401→刷新失败→**先 clearTokens 再静默 mint**，
// 用户看到的就是"我的歌全没了"，界面零提示（真实原话「重装覆盖不能保存本地内容？？？？？？？？？？」）。
// 这里锁住端侧的四条纪律：锚点只生成一次、清 token 不许清锚点、新账号必须可告知、失败才销毁凭证。
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/models.dart';
import 'package:musicbox/core/state.dart';
import 'package:musicbox/core/ws_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 只覆盖用到的方法：me() 抛错是故意的 —— _finishOnline 对它是 try/catch 兜住的，
/// 说明"积分拉不到也要让用户进得去"这条设计不该被本测试意外绑住。
class _FakeApi extends Fake implements ApiClient {
  Map<String, dynamic> guestResponse = const {
    'access_token': 'at-1',
    'refresh_token': 'rt-1',
    'first_time': true,
    'user': {'id': 'u_1', 'nickname': '音乐旅人1234', 'is_guest': true},
  };
  int guestCalls = 0;

  @override
  Future<Map> guestLogin() async {
    guestCalls++;
    return guestResponse;
  }

  @override
  Future<MeInfo> me() async => throw StateError('离线：积分拉不到');
}

class _FakeWs extends Fake implements WsClient {
  @override
  void connect() {} // _connectWs 会调它；Fake 默认抛 UnimplementedError 会把登录路径打成 failed

  @override
  void dispose() {}
}

Future<Prefs> _prefs(Map<String, Object> seed) async {
  SharedPreferences.setMockInitialValues(seed);
  return Prefs(await SharedPreferences.getInstance());
}

ProviderContainer _container(Prefs prefs, ApiClient api) {
  final c = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(prefs),
    apiClientProvider.overrideWithValue(api),
    wsClientProvider.overrideWithValue(_FakeWs()),
  ]);
  addTearDown(c.dispose);
  return c;
}

void main() {
  group('设备身份锚点（device_key）', () {
    test('只生成一次：重复调用返回同一个值', () async {
      final p = await _prefs({});
      expect(p.deviceKey, isNull, reason: '首启前不该有锚点');
      final a = await p.ensureDeviceKey();
      final b = await p.ensureDeviceKey();
      expect(a, b, reason: '锚点若每次重生成 = 每次都是新的人 = 作品找不回');
      expect(a.length, greaterThanOrEqualTo(32));
      expect(RegExp(r'^[0-9a-f]+$').hasMatch(a), isTrue, reason: '锚点应是 hex（Random.secure 32 字节）');
    });

    test('已存在的锚点必须原样保留（哪怕看起来不合格也不许覆盖）', () async {
      final fixed = 'ab' * 32;
      final p = await _prefs({'identity_device_key': fixed});
      expect(await p.ensureDeviceKey(), fixed);
    });

    test('清 token（登出/刷新失败）不得把锚点一起清掉', () async {
      final p = await _prefs({});
      final key = await p.ensureDeviceKey();
      await p.saveTokens('at', 'rt');
      await p.clearTokens();
      expect(p.accessToken, isNull);
      expect(p.refreshToken, isNull);
      expect(p.deviceKey, key, reason: '清 token 是登出，不是丢身份；丢了锚点就再也换不回原来的号');
    });
  });

  group('身份被换掉必须可告知（identityReset）', () {
    test('本机原有身份 + 服务端说是新账号 → identityReset=true', () async {
      final prefs = await _prefs({'auth_access': 'old-at', 'auth_refresh': 'old-rt'});
      final api = _FakeApi();
      final c = _container(prefs, api);
      await c.read(sessionProvider.notifier).guestLogin(fromAuthExpired: true);

      expect(c.read(sessionProvider).identityReset, isTrue,
          reason: '曾有过身份而服务端当新号 = 内容不可能再出现，界面必须说出来');
      expect(c.read(sessionProvider.notifier).identityResetNotice, isTrue);
    });

    test('真·首次启动（本机没有过 token）→ 不算身份丢失', () async {
      final prefs = await _prefs({});
      final api = _FakeApi();
      final c = _container(prefs, api);
      await c.read(sessionProvider.notifier).guestLogin();

      expect(c.read(sessionProvider).identityReset, isFalse,
          reason: '第一次来就是新账号，吓用户就是狼来了');
    });

    test('同锚点恢复（first_time=false）→ 不报警，且 token 换新', () async {
      final prefs = await _prefs({'auth_access': 'old-at', 'auth_refresh': 'old-rt'});
      final api = _FakeApi()
        ..guestResponse = const {
          'access_token': 'at-new',
          'refresh_token': 'rt-new',
          'first_time': false,
          'user': {'id': 'u_1', 'nickname': '音乐旅人1234', 'is_guest': true},
        };
      final c = _container(prefs, api);
      await c.read(sessionProvider.notifier).guestLogin(fromAuthExpired: true);

      expect(c.read(sessionProvider).identityReset, isFalse);
      expect(c.read(sessionProvider).status, SessionStatus.ready);
      expect(prefs.accessToken, 'at-new', reason: '401 后应换回新 token 而不是停在旧 token 上');
    });

    test('mint 失败才销毁 token；成功路径不许提前清', () async {
      // 种一个锚点：不种的话下面那条"锚点必须还在"就是空断言（我第一版就是这么写的，测了个寂寞）
      final prefs = await _prefs({
        'auth_access': 'old-at',
        'auth_refresh': 'old-rt',
        'identity_device_key': 'cd' * 32,
      });
      final api = _FakeApi();
      // guestLogin 抛错 = 服务端明确拒绝（例如后端还没升到 v5.3.0 的锚点契约）
      final c = _container(prefs, _ThrowingApi());
      await c.read(sessionProvider.notifier).guestLogin(fromAuthExpired: true);

      expect(c.read(sessionProvider).status, SessionStatus.failed);
      expect(prefs.accessToken, isNull, reason: '确认失败后清 token 才有意义');
      expect(prefs.deviceKey, isNotNull, reason: '任何情况下锚点都得留着，那是找回身份的唯一线索');
      expect(api.guestCalls, 0);
    });

    test('「我知道了」能把横幅收起来（不让它变成关不掉的恐吓）', () async {
      final prefs = await _prefs({'auth_access': 'old-at', 'auth_refresh': 'old-rt'});
      final c = _container(prefs, _FakeApi());
      await c.read(sessionProvider.notifier).guestLogin(fromAuthExpired: true);

      expect(c.read(sessionProvider).identityReset, isTrue);
      c.read(sessionProvider.notifier).acknowledgeIdentityReset();
      expect(c.read(sessionProvider).identityReset, isFalse);
      expect(c.read(sessionProvider.notifier).identityResetNotice, isFalse);
    });
  });
}

class _ThrowingApi extends _FakeApi {
  @override
  Future<Map> guestLogin() async => throw StateError('服务端拒绝：缺少设备标识');
}
