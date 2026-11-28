// 活体探针（默认跳过，`MB_LIVE_PROBE=1 flutter test test/agent_live_llm_test.dart` 才跑）。
//
// 为什么要有它：提问卡与"不提钱"这两条，单元测试用的是脚本化假模型 —— 假模型永远听话。
// 真模型会不会真的去调 `agent.ask_user`（而不是把三题写成正文逼用户打字）、会不会自己又提起
// 账户上的数，只有打真服务端真模型才验得出来。真机截图只能证明"渲染长什么样"，证明不了这条。
//
// 跑之前需要：本机 :7900 有服务端、`assistant_core` 与模型节点在线（`GET /healthz` 通）。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/features/agent/agent_bootstrap.dart' as bootstrap;
import 'package:musicbox/features/agent/agent_config.dart';
import 'package:musicbox/features/agent/engine/agent_events.dart';
import 'package:musicbox/features/agent/engine/agent_transport.dart';
import 'package:musicbox/features/agent/ui/agent_view_model.dart' as ui;

const String kBase = 'http://127.0.0.1:7900';

/// 服务端只讲钱的地方是「我的」页与服务端账本；智能体的话术里不许出现这些。
const List<String> kMoneyWords = [
  '积分', '余额', '额度', '单价', '合计', '价格', '花费', '花钱', '扣费', '付费', '充钱', '充值', '⚡',
];

void main() {
  final live = Platform.environment['MB_LIVE_PROBE'] == '1';

  test('真模型走一遍：澄清走提问卡（不逼用户打字），且助手全程不提钱', () async {
    final requests = <Map<String, dynamic>>[];
    final replies = <Map<String, dynamic>>[];
    final engEvents = <String>[];

    // /v1/agent/llm 要登录态（无 token 直接 401，而 401 会被传输层吞成 transport 收口 ——
    // 我在这儿被坑过一次：探针自己没带 token，却差点判成"模型不会提问"）。
    // 探针自己登一个一次性游客，不碰任何人的账号。
    Future<String> login() async {
      final c = HttpClient();
      try {
        final key = List.generate(64, (i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join();
        final req = await c.postUrl(Uri.parse('$kBase/v1/auth/guest'))
          ..headers.contentType = ContentType.json;
        req.write(jsonEncode({'device_key': key}));
        final resp = await req.close().timeout(const Duration(seconds: 20));
        final body = await resp.transform(utf8.decoder).join();
        if (resp.statusCode != 200) throw StateError('游客登录失败 ${resp.statusCode} $body');
        return (jsonDecode(body) as Map)['access_token'].toString();
      } finally {
        c.close(force: true);
      }
    }

    final token = await login();
    final transport = RemoteAgentTransport(
      timeout: const Duration(seconds: 120),
      maxAttempts: 1,
      post: (path, body) async {
        requests.add(body);
        final c = HttpClient();
        try {
          final req = await c.postUrl(Uri.parse('$kBase$path'))
            ..headers.contentType = ContentType.json
            ..headers.contentLength = utf8.encode(jsonEncode(body)).length;
          req.headers.set('authorization', 'Bearer $token');
          req.write(jsonEncode(body));
          final resp = await req.close().timeout(const Duration(seconds: 120));
          final text = await resp.transform(utf8.decoder).join();
          if (resp.statusCode != 200) {
            // 状态码必须当场喊出来：它一旦被传输层咽下去，只剩"连不上服务"，人就往错的方向查
            // ignore: avoid_print
            print('!! POST $path → ${resp.statusCode} ${text.substring(0, text.length > 300 ? 300 : text.length)}');
            throw StateError('POST $path → ${resp.statusCode}');
          }
          final Map<String, dynamic> decoded = jsonDecode(text) as Map<String, dynamic>;
          replies.add(decoded);
          return decoded;
        } finally {
          c.close(force: true);
        }
      },
    );

    final ctl = StreamController<AgentEvent>();
    final engine = buildAgentEngine(
      transport: transport,
      config: const AgentEngineConfig(),
      onEvent: (e) {
        // 尸检记录：这一轮到底调了哪个工具、以什么理由收的口
        engEvents.add(e is AgentToolStarted
            ? 'ToolStarted(${e.toolName})'
            : e is AgentTurnFinished
                ? 'TurnFinished(${e.stopReason})'
                : e.runtimeType.toString());
        if (!ctl.isClosed) ctl.add(e);
      },
      librarySearch: (_, __) async => const [],
    );
    final session = bootstrap.AgentBridgeSession(engine: engine, events: ctl.stream);

    final uiEvents = <ui.AgentEvent>[];
    final spoken = StringBuffer();
    final sub = session.events.listen((e) {
      uiEvents.add(e);
      if (e is ui.AssistantTextDelta) spoken.write(e.text);
    });

    Future<T> until<T>(T? Function() pick, String what, {int seconds = 150}) async {
      final deadline = DateTime.now().add(Duration(seconds: seconds));
      while (DateTime.now().isBefore(deadline)) {
        final T? v = pick();
        if (v != null) return v;
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
      throw StateError('等不到$what（已发 ${requests.length} 次模型请求；助手原话：「$spoken」）');
    }

    try {
      await session.send('来一首深夜加班听的歌');

      // ① 澄清必须变成**可点选**的提问卡（引擎侧真正的产品要求）
      final ask = await until<ui.NeedsUserAnswer>(
        () => uiEvents.whereType<ui.NeedsUserAnswer>().isEmpty
            ? null
            : uiEvents.whereType<ui.NeedsUserAnswer>().last,
        '提问卡（模型可能把题写成了正文，或没问就往下做）',
      );
      final cards = ask.questions
          .map((q) => Map<String, dynamic>.from(q as Map))
          .toList();
      expect(cards, isNotEmpty, reason: '提问卡一张题都没有');
      for (final c in cards) {
        final opts = (c['options'] as List?) ?? const [];
        expect(opts.length, inInclusiveRange(2, 4),
            reason: '题「${c['q']}」的候选数 ${opts.length} 不在 2–4：用户点不动或整题被界面丢弃');
        for (final o in opts) {
          expect('$o'.trim().isNotEmpty, isTrue, reason: '题「${c['q']}」有空候选');
        }
      }
      // 问完就地收口：提问卡出现之后，这一回合**不许**再向模型发新请求
      // （注意不能拿"总共只发 1 次"当判据 —— 模型在问之前按纪律 load_skill 是合法开销，
      //  真机实录就是 load_skill ×2 之后才 ask_user，共 3 次请求。）
      final atAsk = requests.length;
      final turnDone = await until<bool>(
        () => uiEvents.whereType<ui.TurnFinished>().isNotEmpty ? true : null,
        '提问后的收口（TurnFinished）',
      );
      expect(turnDone, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(requests.length, atAsk, reason: '提问卡已交给界面，却又追着模型发请求 = 自问自答');

      // ② 点选回填 → 必须作为**用户消息**进入下一回合
      for (var i = 0; i < cards.length; i++) {
        await session.answer(i, 0);
      }
      final second = await until<bool>(
        () => requests.length >= 2 ? true : null,
        '答案回填后的第二轮请求（说明选择没有变成用户消息）',
      );
      expect(second, isTrue);
      final lastUser = (requests.last['messages'] as List)
          .whereType<Map>()
          .lastWhere((m) => m['role'] == 'user')['content']
          .toString();
      expect(lastUser, contains('我选：'),
          reason: '回填消息不是"我选：…"这种点选口吻，实际「$lastUser」');

      // 答完还得等它把话说完 —— 当年漏钱正是在"提问之后那一句"里（真机实录过
      // 「这一步会用到你的额度」）。不等到话，"不提钱"就是拿空字符串过的，等于没验。
      final turnsBefore = uiEvents.whereType<ui.TurnFinished>().length;
      await until<bool>(
        () => uiEvents.whereType<ui.TurnFinished>().length > turnsBefore ? true : null,
        '答完题后助手的收口（它没接着说下去）',
      );
      final said = spoken.toString();
      expect(said.trim().isNotEmpty, isTrue,
          reason: '答完题后助手一个字都没说 —— "不提钱"这条不能拿空文本充过');
      for (final w in kMoneyWords) {
        expect(said, isNot(contains(w)), reason: '助手主动提了钱的字样「$w」：$said');
      }

      // ignore: avoid_print
      print('\n──── 活体探针实录（真模型）────');
      // ignore: avoid_print
      print('模型请求 ${requests.length} 次；提问 ${cards.length} 题：');
      for (final c in cards) {
        // ignore: avoid_print
        print('  · ${c['q']} → ${(c['options'] as List).join(' / ')}');
      }
      // ignore: avoid_print
      print('回填的用户消息：$lastUser');
      // ignore: avoid_print
      print('助手原话（${said.length} 字）：$said');

      // ④ 拍板：界面那颗「就用这些，开始做」走的就是 session.send(kAgentConfirmUtterance)。
      // 真机（小米13 2026-11-28）上这一步界面变成"已交给你确认过"之后就**再没有下文**：
      // 服务端 agent_usage 记到两次调用，却既没有作品、也没有任务，界面上连工具卡都没冒 ——
      // 模型调了东西而用户看不见，是最坏的一种沉默。这里把它调了什么、回了什么打出来。
      final beforeConfirm = requests.length;
      await session.send('就用这些，开始做');
      final cTurns = uiEvents.whereType<ui.TurnFinished>().length;
      await until<bool>(
        () => uiEvents.whereType<ui.TurnFinished>().length > cTurns ? true : null,
        '拍板后的收口',
      );
      final confirmCalls = requests.length - beforeConfirm;
      final confirmTools = engEvents.skipWhile((_) => false).toList();
      // ignore: avoid_print
      print('拍板轮：新增模型请求 $confirmCalls 次');
      // ignore: avoid_print
      print('  引擎事件全序列: ${engEvents.join(' → ')}');
      final lastReply = replies.isEmpty ? '（无）' : jsonEncode(replies.last);
      // ignore: avoid_print
      print('  拍板后最后一次回复: ${lastReply.substring(0, lastReply.length > 1100 ? 1100 : lastReply.length)}');
      expect(confirmCalls, greaterThan(0), reason: '拍板后一次模型都没发 —— 按钮是死的');
      // ignore: avoid_print
      print('──────────────────────\n');
    } catch (err) {
      // ignore: avoid_print
      print('\n──── 尸检 ────\n请求 ${requests.length} 次');
      for (final r in requests) {
        // ignore: avoid_print
        print('  请求消息: ${(r['messages'] as List?)?.map((m) => '${m['role']}=${('${m['content'] ?? ''}'.length)}字').join(', ')} | tools=${(r['tools'] as List?)?.length ?? 0}');
      }
      for (final r in replies) {
        // ignore: avoid_print
        print('  回复: ${jsonEncode(r).substring(0, jsonEncode(r).length > 900 ? 900 : jsonEncode(r).length)}');
      }
      // ignore: avoid_print
      print('  引擎事件: ${engEvents.join(' → ')}');
      // ignore: avoid_print
      print('  UI 事件: ${uiEvents.map((e) => e.runtimeType.toString()).join(' → ')}');
      // ignore: avoid_print
      print('────────────\n');
      rethrow;
    } finally {
      await sub.cancel();
      await session.dispose();
      await ctl.close();
    }
  }, timeout: const Timeout(Duration(minutes: 6)), skip: live ? false : '活体探针：需 MB_LIVE_PROBE=1 且本机 :7900 在线');
}
