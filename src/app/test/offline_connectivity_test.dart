import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/core/api_client.dart';
import 'package:musicbox/core/config.dart';
import 'package:musicbox/core/connectivity.dart';
import 'package:musicbox/core/state.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 离线口径的三条不变量（2026-11-27 真机现场：横幅"该出不来、不该出却一路挂着"）：
///  ① 在线状态由真实流量决定，且离线判定带宽限、可被成功流量当场撤销；
///  ② 只有"连不上/超时"算离线信号，4xx/5xx 说明服务器活着，不许拉红条；
///  ③ 换服务器地址必须连带清掉旧令牌，否则恢复探测拿旧令牌打新服务器 → 永远离线。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('在线状态真源', () {
    test('连接类失败宽限后判离线；期间一次成功流量就当场撤回', () async {
      final c = ConnectivityNotifier();
      addTearDown(c.dispose);
      c.markOffline(grace: const Duration(milliseconds: 60));
      expect(c.state, isTrue, reason: '宽限期内不该闪横幅');
      c.markOnline(); // 一次成功请求 = 服务器活着
      await Future.delayed(const Duration(milliseconds: 140));
      expect(c.state, isTrue, reason: '宽限被成功流量撤销，横幅不该出现');

      c.markOffline(grace: const Duration(milliseconds: 40));
      await Future.delayed(const Duration(milliseconds: 120));
      expect(c.state, isFalse, reason: '一直连不上就该报离线');
    });

    test('markOfflineNow 不等宽限', () async {
      final c = ConnectivityNotifier();
      addTearDown(c.dispose);
      c.markOfflineNow();
      expect(c.state, isFalse);
    });
  });

  group('哪些失败算"连不上"', () {
    test('连接错误/超时算离线信号', () {
      for (final t in [
        DioExceptionType.connectionError,
        DioExceptionType.connectionTimeout,
        DioExceptionType.receiveTimeout,
        DioExceptionType.sendTimeout,
      ]) {
        expect(
            ApiClient.isUnreachable(DioException(
                type: t, requestOptions: RequestOptions(path: '/v1/x'))),
            isTrue,
            reason: '$t 必须算连不上');
      }
    });

    test('有响应（哪怕 500）说明服务器活着，不算离线', () {
      final opts = RequestOptions(path: '/v1/x');
      final r = Response<dynamic>(requestOptions: opts, statusCode: 500);
      expect(
          ApiClient.isUnreachable(DioException(
              type: DioExceptionType.badResponse,
              response: r,
              requestOptions: opts)),
          isFalse);
      expect(
          ApiClient.isUnreachable(DioException(
              type: DioExceptionType.badCertificate, requestOptions: opts)),
          isFalse,
          reason: '证书问题不是"连不上"，别把用户引去改地址');
    });
  });

  group('服务器地址与令牌同源', () {
    test('换地址连带清令牌；恢复默认让打包基址重新生效', () async {
      SharedPreferences.setMockInitialValues({
        'cfg_base_url': 'http://10.99.99.99:7900', // 模拟 install -r 留下的陈旧覆盖
        'auth_access': 'old-server-token',
        'auth_refresh': 'old-server-refresh',
      });
      final prefs = Prefs(await SharedPreferences.getInstance());
      final cfg = ConfigNotifier(prefs);
      expect(cfg.state.baseUrl, 'http://10.99.99.99:7900',
          reason: '持久化覆盖必须压过打包默认（这正是现场被坑的地方）');
      expect(prefs.accessToken, 'old-server-token');

      await cfg.setBaseUrl('http://100.81.83.59:7900');
      expect(cfg.state.baseUrl, 'http://100.81.83.59:7900');
      expect(prefs.accessToken, isNull,
          reason: '令牌与地址不同源会让恢复探测一直 401 被吞，横幅永远下不来');
      expect(prefs.refreshToken, isNull);

      await cfg.resetBaseUrl();
      expect(cfg.state.baseUrl, AppConfig.defaultBaseUrl,
          reason: '「恢复默认」= 清掉覆盖，让 --dart-define 重新生效');
      final sp = await SharedPreferences.getInstance();
      expect(sp.getString('cfg_base_url'), isNull,
          reason: '覆盖没清干净的话，下次启动又被陈旧地址劫持');
    });

    test('地址没变就不该误清令牌', () async {
      SharedPreferences.setMockInitialValues({
        'cfg_base_url': 'http://100.81.83.59:7900',
        'auth_access': 'tok',
        'auth_refresh': 'ref',
      });
      final prefs = Prefs(await SharedPreferences.getInstance());
      final cfg = ConfigNotifier(prefs);
      await cfg.setBaseUrl('http://100.81.83.59:7900');
      expect(prefs.accessToken, 'tok', reason: '同地址重复保存不该把人踢成游客');
    });
  });
}
