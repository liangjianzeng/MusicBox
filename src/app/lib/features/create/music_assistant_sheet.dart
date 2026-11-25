import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart'; // apiClientProvider

/// 音乐助手 bottom-sheet（契约 v3.1 / 架构 l2，二期跨模块助手）。
/// 治理纪律（对齐 MV 制片助手）：
/// · 拍板权在人 —— 助手永不代拍板；付费动作只发确认票（票面按钮批准才执行），
///   话术永远是「票已发出」而非「已完成」；TTL/一票一次/hash+ver CAS 由服务端硬门。
/// · 规则模式恒可用（music_assistant 开即显示）；对话版 LLM 按 assistant_chat_music 灰度，
///   离线/关闭 → 规则助手模式横幅 + 快捷指令，绝不冒充 LLM、绝不伪造回复。
/// · 一切回执过端侧禁词过滤（_human）；引擎/模型名不外泄。
/// 可见性由服务端下发 features.music_assistant 决定（RemoteConfig.musicAssistant）。

const bool kMusicAssistantForce = false; // 联调强制钩子（生产以 RemoteConfig 为准）

/// 打开音乐助手（入口按钮一律在 musicAssistant 判定后调用）
Future<void> showMusicAssistant(
  BuildContext context, {
  required String subjectType, // 'work' | 'intent'
  required String subjectId,
  String subjectLabel = '',
  bool chatEnabled = false,
  String? modeHint,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFF17181F),
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (_) => MusicAssistantSheet(
      subjectType: subjectType,
      subjectId: subjectId,
      subjectLabel: subjectLabel,
      chatEnabled: chatEnabled,
      modeHint: modeHint,
    ),
  );
}

/// 端侧禁词/引擎名过滤（与 MV mvHuman 同口径的最小集，避免跨域 import）。
String _human(String s) {
  var t = s;
  const pairs = <String, String>{
    'comfyui': '画面引擎',
    'qwen': '大模型',
    'minimax': '生成模型',
    'lipsync': '对口型',
    'facegate': '人脸门禁',
    'ace-step': '编曲模型',
    'sense-voice': '语音识别',
    'seed': '随机种子',
    'prompt': '描述词',
  };
  pairs.forEach((k, v) => t = t.replaceAll(RegExp(k, caseSensitive: false), v));
  return userVisibleText(t);
}

// —— 票面模型（确认面板数据源；服务端已在票响应带 ver/hash）——
enum MusicTicketStatus { pending, processing, success, failed, expired }

enum MusicTicketFailure { approve, deny }

class MusicTicket {
  MusicTicket({
    required this.id,
    required this.action,
    required this.ver,
    required this.hash,
    required this.estCredits,
    required this.estMinutes,
    this.status = MusicTicketStatus.pending,
    this.failure,
  });
  final String id;
  final String action;
  final String ver;
  final String hash;
  final int estCredits;
  final int estMinutes;
  final MusicTicketStatus status;
  final MusicTicketFailure? failure;

  bool get canAct =>
      status == MusicTicketStatus.pending || status == MusicTicketStatus.failed;

  MusicTicket copyWith(
          {MusicTicketStatus? status, MusicTicketFailure? failure}) =>
      MusicTicket(
        id: id,
        action: action,
        ver: ver,
        hash: hash,
        estCredits: estCredits,
        estMinutes: estMinutes,
        status: status ?? this.status,
        failure: failure,
      );

  factory MusicTicket.fromMap(Map m) => MusicTicket(
        id: '${m['ticket_id'] ?? m['id'] ?? ''}',
        action: '${m['action'] ?? ''}',
        ver: '${m['ver'] ?? ''}',
        hash: '${m['hash'] ?? ''}',
        estCredits: (m['est'] is Map ? (m['est']['credits']) : m['est_credits'])
                is num
            ? (m['est'] is Map ? m['est']['credits'] : m['est_credits']).toInt()
            : 0,
        estMinutes: (m['est'] is Map ? (m['est']['minutes']) : m['est_minutes'])
                is num
            ? (m['est'] is Map ? m['est']['minutes'] : m['est_minutes']).toInt()
            : 0,
      );
}

class MusicChatMsg {
  MusicChatMsg({
    required this.role, // user|ai|sys
    required this.text,
    this.ticket,
  });
  final String role;
  final String text;
  final MusicTicket? ticket;

  MusicChatMsg copyWith({MusicTicket? ticket}) => MusicChatMsg(
        role: role,
        text: text,
        ticket: ticket ?? this.ticket,
      );
}

class MusicAssistantState {
  const MusicAssistantState({
    this.sessionId,
    this.messages = const [],
    this.sending = false,
    this.rulesMode = false,
    this.error,
  });
  final String? sessionId;
  final List<MusicChatMsg> messages;
  final bool sending;
  final bool rulesMode;
  final String? error;

  MusicAssistantState copyWith({
    String? sessionId,
    List<MusicChatMsg>? messages,
    bool? sending,
    bool? rulesMode,
    String? error,
    bool clearError = false,
  }) =>
      MusicAssistantState(
        sessionId: sessionId ?? this.sessionId,
        messages: messages ?? this.messages,
        sending: sending ?? this.sending,
        rulesMode: rulesMode ?? this.rulesMode,
        error: clearError ? null : (error ?? this.error),
      );
}

class MusicAssistantNotifier extends StateNotifier<MusicAssistantState> {
  MusicAssistantNotifier(this._ref, this._chips)
      : super(const MusicAssistantState());
  final Ref _ref;
  final List<Map<String, dynamic>> _chips;
  final Set<String> _ticketFlights = {};

  ApiClient get _api => _ref.read(apiClientProvider);

  void _push(MusicChatMsg m) =>
      state = state.copyWith(messages: [...state.messages, m]);

  Future<void> send(String text, {List<Map<String, dynamic>>? chips}) async {
    final t = text.trim();
    if (t.isEmpty || state.sending) return;
    _push(MusicChatMsg(role: 'user', text: t));
    state = state.copyWith(sending: true, clearError: true);
    try {
      final r = await _api.musicAssistantMessages(
        sessionId: state.sessionId,
        text: t,
        chips: chips ?? _chips,
      );
      final sid = r['session_id']?.toString();
      if (sid != null && sid.isNotEmpty) state = state.copyWith(sessionId: sid);
      state = state.copyWith(sending: false, rulesMode: false);
      final ticket = r['ticket'] as Map?;
      if (ticket != null) {
        _push(MusicChatMsg(
            role: 'ai',
            text: _human('${r['reply'] ?? '确认票已发出，请在下方票面拍板。'}'),
            ticket: MusicTicket.fromMap(ticket)));
        return;
      }
      final reply = r['reply']?.toString();
      _push(MusicChatMsg(
          role: 'ai',
          text: _human(
              (reply ?? '').trim().isEmpty ? '（助手没返回内容，换个说法再试）' : reply!)));
    } on ApiException catch (e) {
      state = state.copyWith(sending: false);
      if (e.code == 'NOT_FOUND') {
        // 开关未开（404）→ 规则模式也不可用，如实告知
        _push(MusicChatMsg(role: 'sys', text: '音乐助手当前未开放（灰度未开启）。'));
        return;
      }
      state = state.copyWith(error: _friendly(e));
      _push(MusicChatMsg(role: 'sys', text: _friendly(e)));
    }
  }

  Future<void> approveTicket(MusicChatMsg msg) async {
    final current = _ticketMessage(msg.ticket?.id);
    final t = current?.ticket;
    if (t == null || t.id.isEmpty || !t.canAct || !_beginTicket(t.id)) {
      return;
    }
    _setTicketStatus(t.id, MusicTicketStatus.processing);
    try {
      await _api.musicConfirmTicket(t.id, ver: t.ver, hash: t.hash);
      _setTicketStatus(t.id, MusicTicketStatus.success);
      _push(MusicChatMsg(role: 'sys', text: '已批准，开始执行。'));
    } on ApiException catch (e) {
      final expired = e.code == 'TICKET_UNUSABLE' || e.code == 'NOT_FOUND';
      _setTicketStatus(
          t.id, expired ? MusicTicketStatus.expired : MusicTicketStatus.failed,
          failure: expired ? null : MusicTicketFailure.approve);
      _push(MusicChatMsg(
          role: 'sys',
          text: expired ? '这张票已失效（过期或已处理），未执行任何操作。' : _friendly(e)));
    } catch (_) {
      _setTicketStatus(t.id, MusicTicketStatus.failed,
          failure: MusicTicketFailure.approve);
      _push(MusicChatMsg(role: 'sys', text: '确认失败，请重试。'));
    } finally {
      _ticketFlights.remove(t.id);
    }
  }

  Future<void> denyTicket(MusicChatMsg msg) async {
    final current = _ticketMessage(msg.ticket?.id);
    final t = current?.ticket;
    if (t == null || t.id.isEmpty || !t.canAct || !_beginTicket(t.id)) {
      return;
    }
    _setTicketStatus(t.id, MusicTicketStatus.processing);
    try {
      await _api.musicDenyTicket(t.id);
      _setTicketStatus(t.id, MusicTicketStatus.success);
      _push(MusicChatMsg(role: 'sys', text: '已拒绝这张票，未执行任何操作。'));
    } on ApiException catch (e) {
      final expired = e.code == 'TICKET_UNUSABLE' || e.code == 'NOT_FOUND';
      _setTicketStatus(
          t.id, expired ? MusicTicketStatus.expired : MusicTicketStatus.failed,
          failure: expired ? null : MusicTicketFailure.deny);
      _push(MusicChatMsg(
          role: 'sys', text: expired ? '这张票已失效（过期或已处理）。' : _friendly(e)));
    } catch (_) {
      _setTicketStatus(t.id, MusicTicketStatus.failed,
          failure: MusicTicketFailure.deny);
      _push(MusicChatMsg(role: 'sys', text: '取消失败，请重试。'));
    } finally {
      _ticketFlights.remove(t.id);
    }
  }

  bool _beginTicket(String id) => _ticketFlights.add(id);

  MusicChatMsg? _ticketMessage(String? id) {
    for (final msg in state.messages) {
      if (msg.ticket?.id == id) return msg;
    }
    return null;
  }

  void _setTicketStatus(String id, MusicTicketStatus status,
      {MusicTicketFailure? failure}) {
    final current = _ticketMessage(id);
    final ticket = current?.ticket;
    if (current == null || ticket == null) return;
    final list = [...state.messages];
    final i = list.indexOf(current);
    list[i] = current.copyWith(
        ticket: ticket.copyWith(status: status, failure: failure));
    state = state.copyWith(messages: list);
  }

  static String _friendly(ApiException e) {
    const map = {
      'RATE_LIMITED': '操作太频繁，稍等片刻再试。',
      'BAD_REQUEST': '我还没法这样办，换个说法？',
      'FORBIDDEN': '这个操作不在助手职责范围内。',
      'SESSION_BROKEN': '本次会话暂时不可用，请关闭后重开。',
      'CREDITS_NOT_ENOUGH': '当前无法执行此操作，请稍后重试。',
    };
    return map[e.code] ?? _human(e.message);
  }
}

/// family 键 = 作用域主题（'work:<id>' / 'intent:<id>'），autoDispose 随页面销毁
final musicAssistantProvider = StateNotifierProvider.autoDispose
    .family<MusicAssistantNotifier, MusicAssistantState, String>(
        (ref, key) => MusicAssistantNotifier(ref, _chipsFromKey(key)));

List<Map<String, dynamic>> _chipsFromKey(String key) {
  final i = key.indexOf(':');
  if (i <= 0) return const [];
  return [
    {'type': key.substring(0, i), 'id': key.substring(i + 1)}
  ];
}

class MusicAssistantSheet extends ConsumerStatefulWidget {
  const MusicAssistantSheet({
    super.key,
    required this.subjectType,
    required this.subjectId,
    this.subjectLabel = '',
    this.chatEnabled = false,
    this.modeHint,
  });
  final String subjectType;
  final String subjectId;
  final String subjectLabel;
  final bool chatEnabled;
  final String? modeHint;

  @override
  ConsumerState<MusicAssistantSheet> createState() =>
      _MusicAssistantSheetState();
}

class _MusicAssistantSheetState extends ConsumerState<MusicAssistantSheet> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  bool _attach = true;

  String get _key => '${widget.subjectType}:${widget.subjectId}';

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send(String text) => ref
      .read(musicAssistantProvider(_key).notifier)
      .send(text, chips: _attach ? null : const []);

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  List<String> get _quick => widget.subjectType == 'intent'
      ? ['改成纯音乐', '出 2 首', 'BPM 110', '现在什么状态']
      : ['再欢快一点', '重出一批', '续长一点', '现在什么状态'];

  @override
  Widget build(BuildContext context) {
    final provider = musicAssistantProvider(_key);
    final st = ref.watch(provider);
    ref.listen<MusicAssistantState>(provider, (previous, next) {
      if (previous?.messages.length != next.messages.length) _scrollToBottom();
    });
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    final isWork = widget.subjectType == 'work';

    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(
              maxHeight: MediaQuery.of(context).size.height * 0.78),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 12, 4),
                child: Row(
                  children: [
                    const Icon(Icons.graphic_eq_rounded,
                        size: 18, color: Colors.teal),
                    const SizedBox(width: 6),
                    const Text('音乐助手',
                        style: TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 15)),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color:
                            (widget.chatEnabled ? Colors.teal : Colors.blueGrey)
                                .withValues(alpha: .18),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        widget.chatEnabled ? '对话助手' : '规则助手',
                        style: TextStyle(
                            fontSize: 10,
                            color: widget.chatEnabled
                                ? Colors.teal
                                : Colors.blueGrey,
                            fontWeight: FontWeight.w700),
                      ),
                    ),
                    const Spacer(),
                    if (_attach)
                      _ContextChip(
                        icon:
                            isWork ? Icons.music_note : Icons.lightbulb_outline,
                        label: widget.subjectLabel.isEmpty
                            ? (isWork ? '本作品' : '本灵感卡')
                            : (isWork
                                ? '《${widget.subjectLabel}》'
                                : widget.subjectLabel),
                        onDetach: () => setState(() => _attach = false),
                      ),
                    if (!_attach)
                      TextButton.icon(
                        onPressed: () => setState(() => _attach = true),
                        icon: const Icon(Icons.push_pin_outlined, size: 14),
                        label:
                            const Text('挂回上下文', style: TextStyle(fontSize: 11)),
                      ),
                  ],
                ),
              ),
              if (st.rulesMode || !widget.chatEnabled)
                Container(
                  margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: Colors.amber.withValues(alpha: .07),
                    borderRadius: BorderRadius.circular(10),
                    border:
                        Border.all(color: Colors.amber.withValues(alpha: .3)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.info_outline,
                          size: 14, color: Colors.amberAccent),
                      SizedBox(width: 6),
                      Expanded(
                        child: Text(
                            '当前为规则助手模式 —— AI 对话未启用；'
                            '可用下方快捷指令，需要执行的动作一律先给你确认票。',
                            style: TextStyle(
                                fontSize: 11,
                                color: Colors.amberAccent,
                                height: 1.35)),
                      ),
                    ],
                  ),
                ),
              Flexible(
                child: st.messages.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.symmetric(vertical: 24),
                        child: Text(
                          isWork
                              ? '要我帮你把这首改改？说「再欢快一点」「重出一批」「续长」「用某人格翻自」——\n'
                                  '需要执行的动作一律先给你确认票，拍板权在你。'
                              : '要我帮你调这张灵感卡？说「改成纯音乐」「出 2 首」「BPM 110」。\n'
                                  '点改完可直接照这版出曲。',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              fontSize: 12, color: Colors.white24, height: 1.6),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                        itemCount: st.messages.length,
                        itemBuilder: (_, i) => _Bubble(
                            msg: st.messages[i],
                            notifier: ref
                                .read(musicAssistantProvider(_key).notifier)),
                      ),
              ),
              if (st.sending)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 4),
                  child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2)),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    for (final q in _quick)
                      _QuickChip(
                          label: q, onTap: st.sending ? null : () => _send(q)),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _input,
                        minLines: 1,
                        maxLines: 3,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (v) {
                          _send(v);
                          _input.clear();
                        },
                        decoration: const InputDecoration(
                          hintText: '和助手说…（它只引路，拍板在你）',
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(
                              horizontal: 12, vertical: 10),
                          border: OutlineInputBorder(
                              borderRadius:
                                  BorderRadius.all(Radius.circular(12))),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: st.sending
                          ? null
                          : () {
                              _send(_input.text);
                              _input.clear();
                            },
                      style: FilledButton.styleFrom(
                          minimumSize: const Size(44, 40),
                          padding: EdgeInsets.zero),
                      child: const Icon(Icons.send, size: 18),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ContextChip extends StatelessWidget {
  const _ContextChip(
      {required this.icon, required this.label, required this.onDetach});
  final IconData icon;
  final String label;
  final VoidCallback onDetach;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: onDetach,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Colors.teal.withValues(alpha: .12),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Colors.teal.withValues(alpha: .4)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 12, color: Colors.tealAccent),
            const SizedBox(width: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 130),
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 10.5, color: Colors.tealAccent)),
            ),
            const SizedBox(width: 3),
            const Icon(Icons.close, size: 11, color: Colors.tealAccent),
          ],
        ),
      ),
    );
  }
}

class _QuickChip extends StatelessWidget {
  const _QuickChip({required this.label, this.onTap});
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      label: Text(label, style: const TextStyle(fontSize: 11.5)),
      visualDensity: VisualDensity.compact,
      onPressed: onTap,
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.msg, required this.notifier});
  final MusicChatMsg msg;
  final MusicAssistantNotifier notifier;

  @override
  Widget build(BuildContext context) {
    if (msg.role == 'sys') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Center(
          child: Text(_human(msg.text),
              textAlign: TextAlign.center,
              style: const TextStyle(
                  fontSize: 11, color: Colors.white30, height: 1.4)),
        ),
      );
    }
    final me = msg.role == 'user';
    final ticket = msg.ticket;
    final actionable = ticket?.canAct == true;
    return Align(
      alignment: me ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints:
            BoxConstraints(maxWidth: MediaQuery.of(context).size.width * .8),
        decoration: BoxDecoration(
          color: me
              ? Theme.of(context).colorScheme.primary.withValues(alpha: .28)
              : Colors.white.withValues(alpha: .06),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment:
              me ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Text(_human(msg.text),
                style: const TextStyle(
                    fontSize: 13, color: Colors.white, height: 1.45)),
            if (ticket != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Container(
                  padding: const EdgeInsets.all(10),
                  width: 240,
                  decoration: BoxDecoration(
                    color: Colors.amber.withValues(alpha: .06),
                    borderRadius: BorderRadius.circular(10),
                    border:
                        Border.all(color: Colors.amber.withValues(alpha: .35)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('确认票 · ${_actionLabel(ticket.action)}',
                          style: const TextStyle(
                              fontSize: 12, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Text(
                          ticket.status == MusicTicketStatus.processing
                              ? '处理中，请勿重复操作…'
                              : '${ticket.estMinutes} 分钟 · 60 秒内有效',
                          style: const TextStyle(
                              fontSize: 11, color: Colors.white54)),
                      const SizedBox(height: 6),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: actionable
                                ? () => notifier.denyTicket(msg)
                                : null,
                            style: TextButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 10)),
                            child: Text(
                                ticket.failure == MusicTicketFailure.deny &&
                                        ticket.status ==
                                            MusicTicketStatus.failed
                                    ? '重试拒绝'
                                    : '拒绝',
                                style: const TextStyle(
                                    fontSize: 12, color: Colors.white54)),
                          ),
                          const SizedBox(width: 6),
                          FilledButton(
                            onPressed: actionable
                                ? () => notifier.approveTicket(msg)
                                : null,
                            style: FilledButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 12)),
                            child: Text(_ticketActionLabel(ticket),
                                style: const TextStyle(fontSize: 12)),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _ticketActionLabel(MusicTicket ticket) =>
      switch (ticket.status) {
        MusicTicketStatus.pending => '批准',
        MusicTicketStatus.processing => '处理中',
        MusicTicketStatus.success => '已处理',
        MusicTicketStatus.failed =>
          ticket.failure == MusicTicketFailure.deny ? '改为批准' : '重试批准',
        MusicTicketStatus.expired => '已失效',
      };

  static String _actionLabel(String a) {
    const m = {
      'music.adjust_params': '微调重做',
      'music.regenerate': '重出一批',
      'music.cover': '翻自',
      'music.extend': '续长',
    };
    return m[a] ?? _human(a);
  }
}
