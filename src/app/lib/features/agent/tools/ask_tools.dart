/// 「问用户」工具（纯 Dart —— 端侧**不产出**任何东西）。
///
/// 为什么要有它：真机 K90 实测到模型把「1. 情绪基调 / 2. 谁来唱 / 3. 曲风」连候选项
/// 一起写成**一段正文**，底下没有任何可点选项，用户只能打字。把「问」做成一条**能力**，
/// 题面就有了结构化落点（宿主渲染成可点选卡片），而不是靠 prompt 求它别写成正文
/// —— 权限与行为靠限制能力，不靠承诺（方案 §3.5）。
///
/// 形状照 [proposal_tools]：执行体只做「交给宿主」这一件事（[AgentAskHandler]），
/// 不打网络、不落盘、不产正文，所以它是 [AgentToolKind.readOnly]（无副作用）。
/// 真正的「回答」走**下一条用户消息**（宿主把点选拼成一句话喂回同一会话），
/// 于是主循环在问完处收口 —— 见 `agent_runner.dart` 的 [AgentRunner.askUserToolName]。
///
/// 封顶形态（板块小助手 `AgentEngineConfig.panelAssistant`，契约 v5.8.3 单轮 0 题）
/// **不许**注册它：它恰好是 readOnly，装配期那句 `restrictUser(allow: readOnlyNames())`
/// 会把当时在册的只读工具全数放行 —— 早注册一步就等于给小助手开了问三题的路。
/// 注册点因此放在宿主侧（`agent_bootstrap.dart`），并带 `isCapped` 判据。
library;

import '../engine/agent_tool.dart';

const String kAskUserToolName = 'agent.ask_user';

/// 一次问齐的题数上限。与界面侧 `kAgentAskBudget`（ui/agent_view_model.dart）同值：
/// 界面只渲染前 3 题，多问的那题在卡片上根本不存在 —— 问了等于丢，所以在这里就拦死。
const int kAskUserMaxQuestions = 3;

/// 每题候选数区间。下限 2：只给一个候选不叫提问，照它做就行（别占用户一轮）。
/// 上限 6：再多就是一屏列表，没人读完（界面实际只装得下前 4 项，多余的由宿主裁掉）。
const int kAskUserMinOptions = 2;
// 上限必须是 **4**，不是 6：界面按契约 v1「每题 2–4 项」渲染按钮（agent_view_model 里
// `options.length > 4` 会**整题丢弃**）。工具收到 6 个再靠防腐层裁掉 2 个，等于悄悄吞掉
// 用户看得见的选项 —— 宁可在这里退回给模型自己合并，也不让用户以为助手少问了一件事。
const int kAskUserMaxOptions = 4;

/// 单个候选的字数上限。卡片上是**按钮**不是句子：超长的候选会把一屏撑散，
/// 用户也就不点了。放宽到 20 字只为容忍「安静专注的钢琴曲」这类说法。
const int kAskUserMaxOptionChars = 20;

/// 题面/候选交出去之后回填给模型的那句话。
///
/// 它同时是**行为约束位**：模型看到工具成功就会习惯性接着说下一句，
/// 这一轮真正该发生的事是「停下来等用户点」，所以必须在这里说明白。
const String kAskUserStoppedNote =
    '问题已交给界面，用户会点选。本轮请停在这里：不要自问自答，不要代替用户选，也不要继续产出。';

/// 一道待用户点选的题。
class AgentAskDraft {
  const AgentAskDraft({
    required this.q,
    required this.options,
    this.multi = false,
  });

  /// 要用户定哪件事（一句话说清，卡片标题）。
  final String q;

  /// 可点选的候选（2–4 个短词，与界面按钮位一致）。
  final List<String> options;

  /// 是否允许多选。
  ///
  /// ⚠️ 当前界面一题只落**一个**选择（`AgentUiState.answers` 是 `Map<int,int>`），
  /// 所以这个标记只到宿主为止、不进卡片形状：让卡片长得像能多选、实际只记一个，
  /// 比明说「一题一个」更容易被用户当成 bug。
  final bool multi;
}

/// 一次提问（1–3 题 + 题目上方给用户看的一句话）。
class AgentAskRequest {
  const AgentAskRequest({required this.questions, this.lead});

  final List<AgentAskDraft> questions;

  /// 助手在题目上方想说的一句话（可空）。
  final String? lead;
}

/// 宿主出口：把题面挂成可点选的提问卡（渲染与作答都归界面，端侧不掺和）。
typedef AgentAskHandler = Future<void> Function(AgentAskRequest request);

/// 提问卡工具。见文件头「为什么要它」。
AgentTool buildAskUserTool({AgentAskHandler? onAsk, int rank = 95}) {
  return AgentTool(
    name: kAskUserToolName,
    activityLabel: '我把要问你的事列成了选项',
    rank: rank,
    kind: AgentToolKind.readOnly,
    description: '要用户定夺时**必须**用这个工具，把问题做成可点选的卡片：'
        '一次问齐 1–3 件最影响做法的事，每件给 $_kAskUserRangeText 个候选，'
        '让用户点一下就答完。**不许**把问题和候选写成一段正文让用户打字。'
        '能按常规做法定下来的自己定，别拿这个工具凑数。'
        '调用之后本轮就地结束：等用户点选，不要自问自答，也不要替他选。',
    parameters: const {
      'type': 'object',
      'properties': {
        'lead': {
          'type': 'string',
          'description': '题目上方对用户说的一句话（可留空，别在这儿复述题目）',
        },
        'questions': {
          'type': 'array',
          'description': '要一次问齐的事，1–3 条；每条形如 '
              '{"q":"想要什么情绪？","options":["安静专注","热血激昂"],"multi":false}',
          'items': {
            'type': 'object',
            'properties': {
              'q': {'type': 'string', 'description': '要用户定的一件事，一句话'},
              'options': {
                'type': 'array',
                'description': '可点选的候选，2–4 个短词（每个 ≤20 字，多了请合并同义项），'
                    '彼此要一眼能区分',
              },
              'multi': {
                'type': 'boolean',
                'description': '是否允许同时选多个（默认 false）',
              },
            },
            'required': ['q', 'options'],
          },
        },
      },
      'required': ['questions'],
    },
    // 问完就收口，不跟别的调用挤一批：批里排在它后面的调用这一轮注定白跑。
    isConcurrencySafe: (_) => false,
    execute: (ctx) async {
      final parsed = _parseAsk(ctx.args);
      final why = parsed.error;
      if (why != null) {
        // 不抛异常：回填一句能照着改对的话，由下一步模型重发（护栏那边已按一次失败计入熔断）。
        // 也**不带**降级留痕 —— 这是模型自己写歪了、马上会改，不是少做了某件事，
        // 把它报到界面上只是给用户看一条他看不懂也没法办的提示。
        return ToolResult.error(why);
      }
      final handler = onAsk;
      if (handler == null) {
        // 挂不出卡片 = 这条路此刻不存在。如实说，并给两条能走的路；
        // 绝不退化成「把题目写成正文让用户打字」，也绝不假装题已经问出去了。
        return ToolResult.error(
          '这会儿挂不出可点选的提问卡（界面没接上提问通道）。'
          '别把题目写成正文让用户打字，也不要替他选：'
          '要么按常规做法直接往下做，要么把还缺的那一件事用一句话说清楚。',
          degradation: '没有可用的提问通道，这次没能出可点选的提问卡',
        );
      }
      await handler(parsed.request!);
      return const ToolResult(content: kAskUserStoppedNote);
    },
  );
}

String get _kAskUserRangeText => '$kAskUserMinOptions–$kAskUserMaxOptions';

// ───────────────────────────────────── 入参校验（可读、能指导模型一次改对）

/// 校验结果：要么拿到规整好的 [AgentAskRequest]，要么拿到一句照着就能改对的说明。
class _AskParse {
  const _AskParse.ok(this.request) : error = null;
  const _AskParse.bad(this.error) : request = null;

  final AgentAskRequest? request;
  final String? error;
}

_AskParse _parseAsk(Map<String, dynamic> args) {
  final raw = args['questions'];
  if (raw == null) {
    return const _AskParse.bad(
        '没写要问用户什么：questions 必填，形如 '
        '[{"q":"想要什么情绪？","options":["安静专注","热血激昂"]}]，1–3 条。');
  }
  if (raw is! List) {
    return const _AskParse.bad(
        'questions 要写成数组（[{"q":"…","options":["…","…"]}]），不要写成一段话或一个对象。');
  }
  if (raw.isEmpty) {
    return _AskParse.bad('questions 是空的：要么别问（按常规做法自己定），'
        '要么至少写一条题、每题 $_kAskUserRangeText 个候选。');
  }
  if (raw.length > kAskUserMaxQuestions) {
    return _AskParse.bad(
        '一次最多问 $kAskUserMaxQuestions 件事（现在 ${raw.length} 条）：'
        '挑最影响做法的三件问，其余按常规做法自己定。');
  }

  final questions = <AgentAskDraft>[];
  for (var i = 0; i < raw.length; i++) {
    final tag = '第 ${i + 1} 条';
    final item = raw[i];
    if (item is! Map) {
      return _AskParse.bad('$tag 不是对象：写成 {"q":"想问什么","options":["候选一","候选二"]}。');
    }
    final title = '${item['q'] ?? ''}'.trim();
    if (title.isEmpty) {
      return _AskParse.bad('$tag 没写问题（q 必填，一句话说清要用户定哪件事）。');
    }
    final rawOptions = item['options'];
    if (rawOptions == null || rawOptions is! List) {
      return _AskParse.bad('$tag「$title」没给出可点候选：options 必填，'
          '$_kAskUserRangeText 个短词组成的数组，例如 ["安静专注","热血激昂"] —— '
          '用户点一下就答完，别让他打字。');
    }
    final options = <String>[];
    for (var k = 0; k < rawOptions.length; k++) {
      final option = _optionText(rawOptions[k]);
      if (option == null) {
        return _AskParse.bad('$tag「$title」第 ${k + 1} 个候选是空的或没写成短词：'
            '每个候选就是一个字符串（如「安静专注」），不要写对象、也不要留空。');
      }
      if (option.length > kAskUserMaxOptionChars) {
        return _AskParse.bad('$tag「$title」的候选「${_clip(option)}」太长（最多 '
            '$kAskUserMaxOptionChars 字）：候选是让用户点的按钮，把补充说明写进题目里。');
      }
      if (options.contains(option)) {
        return _AskParse.bad('$tag「$title」有重复候选「$option」：候选之间要能一眼区分。');
      }
      options.add(option);
    }
    if (options.length < kAskUserMinOptions) {
      return _AskParse.bad('$tag「$title」只有 ${options.length} 个候选：'
          '至少 $kAskUserMinOptions 个才叫提问；只有一个就照它做，不用问。');
    }
    if (options.length > kAskUserMaxOptions) {
      return _AskParse.bad('$tag「$title」给了 ${options.length} 个候选，最多 '
          '$kAskUserMaxOptions 个：把相近的合并，留下最不一样的几个。');
    }
    final multi = item['multi'];
    if (multi != null && multi is! bool) {
      return _AskParse.bad('$tag 的 multi 要写成 true / false（要不要允许同时选多个）。');
    }
    questions.add(
        AgentAskDraft(q: title, options: options, multi: multi == true));
  }

  // lead 只是题目上方的一句话，缺了不影响答题 → 宽容收下，不为一行装饰性文案弹回模型一次。
  // 但它会**直接上屏**，所以宁可丢掉也不把 `{"x":"…"}` 这种字典字面甩给用户看。
  final lead = _leadOf(args['lead']);
  return _AskParse.ok(AgentAskRequest(questions: questions, lead: lead));
}

/// 引导语取字面：字符串直接用；写成对象时取里面的文字字段，取不到就当没写。
String? _leadOf(Object? v) {
  if (v == null) return null;
  if (v is Map) {
    for (final key in const ['text', 'lead', 'label', 'title']) {
      final s = _textOf(v[key]);
      if (s != null) return s;
    }
    return null;
  }
  return _textOf(v);
}

/// 候选取字面：模型偶尔把候选写成 `{"label":"安静专注"}`，那种情况取它的文字，
/// 取不到文字才算不合格（直接拒整次调用会把模型逼成绕开这个工具）。
String? _optionText(Object? v) {
  if (v is Map) {
    for (final key in const ['label', 'text', 'title', 'name']) {
      final s = _textOf(v[key]);
      if (s != null) return s;
    }
    return null;
  }
  if (v is List) return null;
  return _textOf(v);
}

String? _textOf(Object? v) {
  if (v == null) return null;
  final s = '$v'.trim();
  return s.isEmpty ? null : s;
}

String _clip(String s, {int n = 12}) =>
    s.length <= n ? s : '${s.substring(0, n)}…';
