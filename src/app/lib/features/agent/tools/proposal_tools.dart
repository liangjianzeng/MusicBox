/// 「建议票」工具（纯 Dart —— 端侧**没有**写工具）。
///
/// 方案 §3.3 / §4.5 / §6.5：所有副作用都在服务端，走「服务端发票 → 用户拍板 →
/// 服务端验票执行」。端侧这些工具的执行体**只做一件事**：把结构化建议交给宿主
/// （[AgentProposalHandler]），由宿主送服务端出确认票。
///
/// 于是模型看得见「有这条路」，但这条路**在端侧物理上写不了东西** ——
/// 权限靠限制能力，不靠 prompt 承诺（方案 §3.5）。
/// 板块小助手的封顶形态用 `restrictUser(allow: readOnlyNames())` 把它们整层摘掉。
library;

import '../engine/agent_tool.dart';

const String kProposeCardPatchToolName = 'music.propose_card_patch';
const String kProposeGenerateToolName = 'music.propose_generate';
const String kProposeMvShotReworkToolName = 'mv.propose_shot_rework';

/// 一条待确认的建议（宿主收到后送服务端换确认票，不在端侧执行）。
class AgentProposal {
  const AgentProposal({
    required this.action,
    required this.payload,
    required this.reason,
    this.sessionId,
    this.turnIndex = 0,
  });

  final String action;
  final Map<String, dynamic> payload;

  /// 智能体会话 id。服务端还没建会话时为 null —— **不强造**：
  /// 宿主照常把草稿送去出票，同时在审计里记一次「无会话归因」的降级。
  final String? sessionId;

  /// 给用户看的一句话理由（宿主负责过禁词表）。
  final String reason;

  /// 产生这条建议的那一回合。宿主据此判断"这是不是用户刚拍过板的那一轮"
  /// （见 ui 层 `AgentBriefApproval`）：**这条只能由会话层盖章**，
  /// 模型没有任何途径把它写成"已拍板" —— 工具入参里根本没有这个字段。
  final int turnIndex;

  Map<String, dynamic> toJson() => {
        'status': 'proposal',
        'requires_confirmation': true,
        'action': action,
        'payload': payload,
        'reason': reason,
        if (sessionId != null) 'session_id': sessionId,
      };
}

/// 宿主把草稿送去出票之后的回单（**参数以这张回单为准**）。
///
/// 为什么必须有它：真机上简报卡说「3 首挑着听」、模型嘴里说「候选条数：1 条」——
/// 因为条数由模型自己填的工具默认值决定，而界面由平台默认值决定，两边各说各话。
/// 现在条数/时长由服务端定并随回单带回来，工具把它写进给模型的那段话里，
/// 屏幕上念的数、模型嘴里念的数、服务端真正派单的数就是同一个数。
class AgentProposalReceipt {
  const AgentProposalReceipt({
    this.status = AgentProposalStatus.none,
    this.ticketId,
    this.jobId,
    this.intentId,
    this.count,
    this.sec,
    this.diff,
    this.minutes,
    this.error,
  });

  final AgentProposalStatus status;
  final String? ticketId;
  final String? jobId;

  /// 服务端落地的任务单编号。模型之后要改这张单、要查它，**只能用这个**，不许自己编。
  final String? intentId;
  final int? count;
  final int? sec;
  final String? diff;
  final int? minutes;

  /// 没交上去时给用户看的原话（宿主/服务端的，已过禁词表）。
  final String? error;

  bool get executed => status == AgentProposalStatus.executed;
  bool get pending => status == AgentProposalStatus.pending;
  bool get failed => status == AgentProposalStatus.failed;
}

enum AgentProposalStatus {
  /// 宿主没接出票通道（装配缺件）—— 必须如实说"没交上去"，不许演成"在等用户确认"。
  none,

  /// 票已挂在界面上，等用户点「就按这张票办」。
  pending,

  /// 用户已拍板、服务端已验票开工（任务已建出）。
  executed,

  /// 送上去被拒（参数不合格 / 还没定下要做什么 / 服务端拒绝）。
  failed,
}

typedef AgentProposalHandler = Future<AgentProposalReceipt?> Function(AgentProposal proposal);

/// 无会话归因时的降级说明（**不崩、不假装归因成功**，只记一次可归因告警）。
const String kNoSessionDegradation =
    '这次还没有智能体会话可归因（服务端尚未返回 session_id），'
    '草稿照常交给界面出确认票，但这条动作暂时挂不上会话';

String? _degradationOf(String? sessionId) =>
    (sessionId == null || sessionId.trim().isEmpty) ? kNoSessionDegradation : null;

/// 建议类工具共用的话术：**不得**说「已完成」（CONTRACTS.md:828），也不许演假动作。
///
/// 三种收尾各说各的实话 —— 真机上坏就坏在"票根本没发出去，却照着'等用户确认'的话术念"，
/// 用户点完了所有能点的，活没开始。
String _proposalNote(String action, AgentProposalReceipt? r) {
  if (r == null || r.status == AgentProposalStatus.none) {
    return '这条建议（$action）**没有交上去**：这个 App 这一版没把出确认票的通道接上，'
        '端侧没有改动任何数据、也没有任何写权限。如实告诉用户这次没交上去，并给出下一步'
        '（例如让他回标准创作流程里点开始做）；不要说已经提交、更不要说做完了。';
  }
  if (r.failed) {
    final why = (r.error ?? '').trim();
    return '这条建议（$action）被服务端退回：${why.isEmpty ? '条件还没齐' : why}。'
        '把这句话照原样告诉用户，并按它说的补一步再来一次；不要说已经提交，也不要说做完了。';
  }
  final n = r.count == null ? '' : '这次实际出 ${r.count} 条候选';
  final idHint = r.intentId == null
      ? ''
      : '任务单编号是 ${r.intentId}，之后要改它或查它都用这个编号，不要自己写编号。';
  if (r.executed) {
    return '用户已经拍过板，服务端已验票开工（$action${n.isEmpty ? '，' : '，'}$n）。'
        '${r.jobId == null ? '' : '任务编号 ${r.jobId}。'}$idHint'
        '现在告诉用户「已经开始排队」并说清出几条；进度只说「已开始排队 / 正在办」，'
        '不许说「已完成 / 已经出好了」。';
  }
  return '这条建议（$action）已经交给界面，界面上会长出一颗「就按这张票办」的按钮。'
        '${n.isEmpty ? '' : '这次会出 ${r.count} 条候选。'}$idHint'
        '你现在要告诉用户：去点那张票，点了我才真开始做；'
        '在他点之前不要说已经开始做，也不要说已经提交。';
}

/// 只把**模型真的填了**的参数带上去。
///
/// 原来这里写 `ctx.intArg('count', fallback: 1)` —— 参数没填也会落成 1 条，
/// 于是"模型没说过条数"被服务端当成"用户要 1 条"，与简报卡上的默认 3 条互相打架。
Map<String, dynamic> _optionalCounts(AgentToolCallContext ctx) {
  final out = <String, dynamic>{};
  final rawCount = ctx.args['count'];
  if (rawCount != null && '$rawCount'.trim().isNotEmpty) out['count'] = ctx.intArg('count');
  final secKey = ctx.args.containsKey('duration_sec') ? 'duration_sec' : 'sec';
  final rawSec = ctx.args[secKey];
  if (rawSec != null && '$rawSec'.trim().isNotEmpty) out['sec'] = ctx.intArg(secKey);
  return out;
}

AgentTool buildProposeCardPatchTool({AgentProposalHandler? onProposal, int rank = 90}) {
  return AgentTool(
    name: kProposeCardPatchToolName,
    activityLabel: '我把这张任务单整理好了',
    rank: rank,
    kind: AgentToolKind.propose,
    description: '把一张创作任务单想改的内容整理成**待确认草稿**。'
        '本工具不会改动任何东西：它只把草稿交给界面等用户确认。'
        '只有在任务单属于当前用户、且还没开始产出时才用它。'
        '能改的就这些项（其余的这里改不动，别答应用户）：灵感描述、情绪、曲风、要不要人声、谁来唱、时长、快慢、候选条数。'
        '编号用上一条结果里服务端给你的那个，不要自己写。',
    parameters: const {
      'type': 'object',
      'properties': {
        'intent_id': {'type': 'string', 'description': '任务单编号（用上一条结果回给你的那个）'},
        'scene_desc': {'type': 'string', 'description': '这次要做成什么样的一句话（尽量用用户原话）'},
        'mood': {'type': 'string', 'description': '情绪词，多个用逗号分隔（须来自可用词条）'},
        'genre_hypotheses': {
          'type': 'string',
          'description': '曲风词，多个用逗号分隔（须来自可用词条）',
        },
        'vocal': {
          'type': 'string',
          'enum': ['song', 'instrumental', 'unknown'],
          'description': '要不要人声：song 有人唱 / instrumental 纯音乐 / unknown 还没定',
        },
        'voice': {'type': 'string', 'description': '谁来唱（一句话描述，不写具体某个人的名字）'},
        'sec': {'type': 'integer', 'description': '期望时长（秒），只填能真正交付的值'},
        'bpm': {'type': 'integer', 'description': '快慢，40-200'},
        'count': {'type': 'integer', 'description': '候选条数。**只在用户明说过几条时才填**，没说过就留空'},
        'reason': {'type': 'string', 'description': '给用户看的一句话说明为什么这么改'},
      },
      'required': ['intent_id', 'reason'],
    },
    isConcurrencySafe: (_) => false,
    execute: (ctx) async {
      final payload = <String, dynamic>{
        'intent_id': ctx.stringArg('intent_id'),
        for (final k in const ['scene_desc', 'mood', 'genre_hypotheses', 'vocal', 'voice', 'bpm'])
          if (ctx.stringArg(k).isNotEmpty) k: ctx.args[k],
        ..._optionalCounts(ctx),
      };
      if (payload['intent_id'] == '') {
        return ToolResult.error('没写要改哪一张任务单（intent_id 必填）');
      }
      final proposal = AgentProposal(
        action: kProposeCardPatchToolName,
        payload: payload,
        sessionId: ctx.sessionId,
        reason: ctx.stringArg('reason'),
        turnIndex: ctx.turnIndex,
      );
      final receipt = await onProposal?.call(proposal);
      return ToolResult.json(
        Map<String, dynamic>.from(proposal.toJson())
          ..['intent_id'] = receipt?.intentId ?? proposal.payload['intent_id'],
        note: _proposalNote('改任务单', receipt),
        degradation: _degradationOf(ctx.sessionId),
      );
    },
  );
}

AgentTool buildProposeGenerateTool({AgentProposalHandler? onProposal, int rank = 85}) {
  return AgentTool(
    name: kProposeGenerateToolName,
    activityLabel: '我把这次要做的事列成清单了',
    rank: rank,
    kind: AgentToolKind.propose,
    description: '把「准备产出这首歌」的全部参数整理成**待确认草稿**（这是真开始做的那一步，'
        '所以永远先出草稿等用户拍板；本工具自己不产出任何东西）。'
        '条数与时长由服务端定，回单会告诉你实际是几条 —— 向用户念数就念回单里那个数，不要自己另报一个。',
    parameters: const {
      'type': 'object',
      'properties': {
        'intent_id': {'type': 'string', 'description': '任务单编号（用上一条结果回给你的那个）'},
        'scene_desc': {'type': 'string', 'description': '这次要做成什么样的一句话（尽量用用户原话）'},
        'count': {'type': 'integer', 'description': '候选条数。**只在用户明说过几条时才填**，没说过就留空'},
        'duration_sec': {'type': 'integer', 'description': '期望时长（秒），只填能真正交付的值'},
        'reason': {'type': 'string', 'description': '给用户看的一句话说明'},
      },
      'required': ['intent_id', 'reason'],
    },
    isConcurrencySafe: (_) => false,
    execute: (ctx) async {
      final proposal = AgentProposal(
        action: kProposeGenerateToolName,
        payload: {
          'intent_id': ctx.stringArg('intent_id'),
          if (ctx.stringArg('scene_desc').isNotEmpty) 'scene_desc': ctx.stringArg('scene_desc'),
          ..._optionalCounts(ctx),
        },
        sessionId: ctx.sessionId,
        reason: ctx.stringArg('reason'),
        turnIndex: ctx.turnIndex,
      );
      final receipt = await onProposal?.call(proposal);
      return ToolResult.json(
        Map<String, dynamic>.from(proposal.toJson())
          ..['intent_id'] = receipt?.intentId ?? proposal.payload['intent_id']
          ..['plan'] = {
            if (receipt?.count != null) 'count': receipt!.count,
            if (receipt?.sec != null) 'sec': receipt!.sec,
            if (receipt?.jobId != null) 'job_id': receipt!.jobId,
          },
        note: _proposalNote('准备产出', receipt),
        degradation: _degradationOf(ctx.sessionId),
      );
    },
  );
}

AgentTool buildProposeMvShotReworkTool(
    {AgentProposalHandler? onProposal, int rank = 80}) {
  return AgentTool(
    name: kProposeMvShotReworkToolName,
    activityLabel: '我把这个镜头要改的地方写好了',
    rank: rank,
    kind: AgentToolKind.propose,
    description: '把 MV 某个镜头要重做的要求整理成**待确认草稿**（重拍这一镜是真重做，'
        '本工具自己不重拍）。这一条目前不在智能体这边开工：'
        '服务端会回一句"去哪儿点"，把那句原样转告用户，不要替他保证已经重拍。',
    parameters: const {
      'type': 'object',
      'properties': {
        'mv_id': {'type': 'string', 'description': 'MV 编号（来自界面上下文）'},
        'shot_ids': {'type': 'array', 'description': '要重做的镜头编号列表'},
        'instruction': {'type': 'string', 'description': '这个镜头要怎么改（一句话说清）'},
        'reason': {'type': 'string', 'description': '给用户看的一句话说明'},
      },
      'required': ['mv_id', 'instruction', 'reason'],
    },
    isConcurrencySafe: (_) => false,
    execute: (ctx) async {
      final proposal = AgentProposal(
        action: kProposeMvShotReworkToolName,
        payload: {
          'mv_id': ctx.stringArg('mv_id'),
          'shot_ids': ctx.args['shot_ids'] ?? const [],
          'instruction': ctx.stringArg('instruction'),
        },
        sessionId: ctx.sessionId,
        reason: ctx.stringArg('reason'),
        turnIndex: ctx.turnIndex,
      );
      final receipt = await onProposal?.call(proposal);
      return ToolResult.json(proposal.toJson(),
          note: _proposalNote('镜头重拍', receipt),
          degradation: _degradationOf(ctx.sessionId));
    },
  );
}
