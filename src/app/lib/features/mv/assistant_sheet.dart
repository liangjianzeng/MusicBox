import 'package:flutter/material.dart';
import '../../core/state.dart';
import '../creation/tier_config.dart';
import '../agent/agent_bootstrap.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/speech/asr_engine.dart';
import '../../core/speech/speech_service.dart';
import '../../core/speech/speech_settings.dart';
import '../assistant/assistant_models.dart';
import '../assistant/assistant_surface.dart';
import '../player/player_provider.dart';
import 'mv_state.dart';
import 'widgets/mv_theme.dart';

/// ⚠ 已废弃（Phase 5 UI 合一 / D-2 薄壳）：入口 `showMvAssistant` 已降级为跳转
/// 统一 surface 的薄壳；下方 `MvAssistantSheet` 为遗留实现（仍被
/// `mv_review_fixes_test.dart` 引用），待 Phase 6 清理。
/// 制片助手 bottom-sheet（mv-plan §5.2 / 架构 §2，N2 灰度 D11）。
/// 治理纪律：
/// · 拍板权在人 —— 助手永不代拍板；昂贵动作只发确认票（票面按钮批准才执行），
///   助手话术永远是「票已发出」而非「已完成」；
/// · MV_NOT_READY / chat 关闭 → 横幅「当前为规则助手模式」+ 快捷指令 chips
///   （基调建议/让它改改/运动改写 → 命中既有 suggest 端点，NOT_READY 如实告知）；
/// · 一切回执过端侧禁词过滤（mvHuman）；绝不伪造回复。
/// 可见性：服务端下发 detail.assistant_enabled 为准；未下发时由本常量灰度
///（默认 false = 隐藏入口，D11 对话版灰度 20% 由服务端放量后打开）。
const bool kMvAssistantEnabled = false;

/// 打开制片助手（入口按钮一律在 assistantOn 判定后调用）
Future<void> showMvAssistant(
  BuildContext context, {
  required String projectId,
  String projectTitle = '',
  String? shotLabel,
  String? shotId,
  bool chatEnabled = false,
  String? modeHint,
}) {
  // D-2 薄壳（Phase 5 UI 合一）：跳转统一 surface 并预绑定 project/shot ref，
  // MV 动作（重排/删镜/重拍等）由统一助手 19 工具覆盖，语音/图片同面可用。
  // 板块小助手（弱层）灰度分流：同音乐侧，命中才换封顶形态，未命中原样转发。
  final ref = ProviderScope.containerOf(context, listen: false);
  return openPanelAssistant(
    context,
    panelId: shotId == null ? 'mv' : 'mv_shot_$shotId',
    cocreateEnabled: cocreateEnabledOf(ref.read(remoteConfigProvider)),
    legacy: () => _showMvGlobalAssistant(context, projectId, projectTitle,
        shotLabel, shotId, chatEnabled, modeHint));
}

/// 原实现原封不动挪到这里 —— 只换了个名字，没改任何行为（灰度关时走的就是它）。
Future<void> _showMvGlobalAssistant(
  BuildContext context,
  String projectId,
  String projectTitle,
  String? shotLabel,
  String? shotId,
  bool chatEnabled,
  String? modeHint,
) {
  return showGlobalAssistant(
      context,
      surface: 'mv',
      refs: [
        AssistantRef('project', projectId),
        if (shotId != null && shotId.isNotEmpty) AssistantRef('shot', shotId),
      ]);
}

class MvAssistantSheet extends ConsumerStatefulWidget {
  const MvAssistantSheet({
    super.key,
    required this.projectId,
    this.projectTitle = '',
    this.shotLabel,
    this.shotId,
    this.chatEnabled = false,
    this.modeHint,
  });

  final String projectId;
  final String projectTitle;
  final String? shotLabel;

  /// 镜级上下文 id（有则可发 {type:'shot',id} 芯片 + 运动改写定位到该镜）
  final String? shotId;

  /// 对话版 LLM 增强是否开放（assistant.chat_enabled）；false=规则助手模式
  final bool chatEnabled;
  final String? modeHint;

  @override
  ConsumerState<MvAssistantSheet> createState() => _MvAssistantSheetState();
}

class _MvAssistantSheetState extends ConsumerState<MvAssistantSheet> {
  final _input = TextEditingController();
  bool _attachProject = true; // 📌 项目上下文芯片（可摘）
  bool _attachShot = true;

  // ---- 语音进出（听=端侧识别；念=端侧声库，失败回落在线朗读） ----
  StreamingAsrSession? _asr;
  SpeechService? _svc; // dispose 里要用，先抓住，避免在 dispose 里读 provider
  bool _listening = false;
  bool _speaking = false;
  String? _talkError;
  int _talkGeneration = 0;

  @override
  void dispose() {
    _talkGeneration++;
    _asr?.cancel();
    _svc?.stopSpeak();
    _input.dispose();
    super.dispose();
  }

  /// 播报时暂停歌曲、播完恢复（只在播报前确实在播才恢复）
  SpeechCoordination get _coord => SpeechCoordination(
        isPlaying: () => ref.read(playerProvider).playing,
        pause: () => ref.read(playerProvider.notifier).audio.pause(),
        resume: () => ref.read(playerProvider.notifier).audio.play(),
      );

  Future<void> _startTalk() async {
    if (_listening) return;
    final generation = ++_talkGeneration;
    final svc = ref.read(speechServiceProvider);
    _svc = svc;
    setState(() {
      _listening = true;
      _talkError = null;
    });
    try {
      final s = await svc.createSession();
      if (!mounted || generation != _talkGeneration) {
        // 页面可能已关闭，或用户已松手/取消；迟到的会话必须归还麦克风资源，
        // 不能擅自再次 start。
        await s?.cancel();
        return;
      }
      if (s == null) {
        // 档位是服务端：助手对话没有服务端听写这条路，给明确出路而不是空转
        setState(() {
          _listening = false;
          _talkError = '语音输入用的是本机识别，请先到「我的 · 语音能力」下载模型，或直接用打字';
        });
        return;
      }
      _asr = s;
      s.partialText.listen((t) {
        if (mounted) _input.text = t;
      });
      await s.start();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _listening = false;
        _talkError = '听不了：$e';
      });
    }
  }

  Future<void> _stopTalk() async {
    _talkGeneration++;
    final s = _asr;
    _asr = null;
    if (s == null) {
      if (mounted) setState(() => _listening = false);
      return;
    }
    AsrOutcome o;
    try {
      o = await s.stop();
    } catch (e) {
      o = AsrOutcome.empty.copyWith(error: e.toString());
    }
    if (!mounted) return;
    setState(() {
      _listening = false;
      if (o.hasText) {
        _input.text = o.text;
        _input.selection = TextSelection.collapsed(offset: o.text.length);
      } else {
        _talkError = o.error ?? '没听清，再说一遍';
      }
    });
  }

  Future<void> _speak(String text) async {
    final t = text.trim();
    if (t.isEmpty || _speaking) return;
    final svc = ref.read(speechServiceProvider);
    _svc = svc;
    setState(() => _speaking = true);
    final err = await svc.speak(t, coordination: _coord);
    if (!mounted) return;
    setState(() => _speaking = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  Future<void> _send() async {
    final t = _input.text.trim();
    if (t.isEmpty) return;
    _input.clear();
    // 上下文芯片：项目可摘；镜上下文带 {type:'shot',id}（facade 支持镜级工具）
    final chips = <Map<String, dynamic>>[
      if (_attachProject) {'type': 'project', 'id': widget.projectId},
      if (_attachShot && (widget.shotId ?? '').isNotEmpty)
        {'type': 'shot', 'id': widget.shotId},
    ];
    var text = t;
    if (_attachShot && (widget.shotLabel ?? '').isNotEmpty) {
      text = '【${widget.shotLabel}】$t';
    }
    await ref
        .read(mvAssistantProvider(widget.projectId).notifier)
        .send(text, chips: chips);
    if (!mounted) return;
    // 自动朗读：只念助手/系统给的话，念的是端侧过滤后的文案（与屏显同源）
    if (ref.read(speechSettingsProvider).autoSpeak) {
      final replies = ref
          .read(mvAssistantProvider(widget.projectId))
          .messages
          .where((m) => m.role != 'user')
          .toList();
      if (replies.isNotEmpty)
        await _speak(mvUserVisibleText(replies.last.text));
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mvAssistantProvider(widget.projectId));
    final n = ref.read(mvAssistantProvider(widget.projectId).notifier);
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

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
              // 头部 + 上下文芯片
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 12, 4),
                child: Row(
                  children: [
                    Icon(Icons.smart_toy_outlined,
                        size: 18, color: context.mvInfo),
                    SizedBox(width: 6),
                    Text('制片助手',
                        style: TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 15)),
                    SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: (widget.chatEnabled
                                ? context.mvInfo
                                : context.mvTextMuted)
                            .withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        (widget.chatEnabled ? '对话助手' : '规则助手'),
                        style: TextStyle(
                            fontSize: 10,
                            color: widget.chatEnabled
                                ? context.mvInfo
                                : context.mvTextMuted,
                            fontWeight: FontWeight.w700),
                      ),
                    ),
                    const Spacer(),
                    if (_attachProject)
                      _ContextChip(
                        icon: Icons.push_pin,
                        label: widget.projectTitle.isEmpty
                            ? '本 MV'
                            : '《${widget.projectTitle}》',
                        onDetach: () => setState(() => _attachProject = false),
                      ),
                    if (widget.shotLabel != null && _attachShot) ...[
                      SizedBox(width: 6),
                      _ContextChip(
                        icon: Icons.movie_outlined,
                        label: widget.shotLabel!,
                        onDetach: () => setState(() => _attachShot = false),
                      ),
                    ],
                    if (!_attachProject && widget.shotLabel == null)
                      TextButton.icon(
                        onPressed: () => setState(() => _attachProject = true),
                        icon: Icon(Icons.push_pin_outlined, size: 14),
                        label: Text('挂回项目', style: TextStyle(fontSize: 11)),
                      ),
                  ],
                ),
              ),
              // 规则模式横幅（诚实标注：LLM/对话未启用，不装忙）
              if (st.rulesMode)
                Container(
                  margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: context.mvWarning.withValues(alpha: .07),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                        color: context.mvWarning.withValues(alpha: .3)),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.info_outline,
                          size: 14, color: context.mvWarning),
                      SizedBox(width: 6),
                      Expanded(
                        child: Text(
                            '当前为规则助手模式 —— AI 对话未启用，'
                            '可用下方快捷指令，主流程不受影响。',
                            style: TextStyle(
                                fontSize: 11,
                                color: context.mvWarning,
                                height: 1.35)),
                      ),
                    ],
                  ),
                ),
              // 消息列表
              Flexible(
                child: st.messages.isEmpty
                    ? Padding(
                        padding: EdgeInsets.symmetric(vertical: 26),
                        child: Text(
                          '有什么要剧组办的，说一声。\n查进度、让编剧改改都行 —— '
                          '需要执行的操作一律先给你确认票，拍板权在你。',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              fontSize: 12,
                              color: context.mvTextMuted,
                              height: 1.6),
                        ),
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                        itemCount: st.messages.length,
                        itemBuilder: (_, i) {
                          final m = st.messages[i];
                          return _Bubble(
                            msg: m,
                            notifier: n,
                            // 助手/系统说的话才可念；用户自己说的话不念
                            onSpeak: m.role == 'user' ? null : _speak,
                          );
                        },
                      ),
              ),
              if (st.sending)
                Padding(
                  padding: EdgeInsets.symmetric(vertical: 4),
                  child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2)),
                ),
              // 快捷指令 chips（规则兜底，永远可用）
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    _QuickChip(
                        label: '基调建议',
                        onTap: st.sending ? null : () => n.quickTone()),
                    _QuickChip(
                        label: '让它改改',
                        onTap: st.sending
                            ? null
                            : () => n.quickSuggest(
                                '整体润色这版分镜：强化情绪连贯与画面记忆点', '让它改改')),
                    _QuickChip(
                        label: '运动改写',
                        onTap: st.sending
                            ? null
                            : () => n.quickMotion(widget.shotId)),
                  ],
                ),
              ),
              // 语音输入失败的原因（不静默，给活路）
              if (_talkError != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
                  child: Text(_talkError!,
                      style: TextStyle(
                          fontSize: 11.5,
                          color: Theme.of(context).colorScheme.error,
                          height: 1.35)),
                ),
              // 输入行：麦克风=按住说话（端侧识别，实时回显到输入框）｜打字｜发送｜自动朗读
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
                child: Row(
                  children: [
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onLongPressStart: (_) => _startTalk(),
                      onLongPressEnd: (_) => _stopTalk(),
                      onLongPressCancel: () => _stopTalk(),
                      child: Container(
                        width: 44,
                        height: 44,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: _listening
                              ? Theme.of(context).colorScheme.errorContainer
                              : context.mvSurfaceRaised.withValues(alpha: .08),
                        ),
                        child: Icon(
                            _listening
                                ? Icons.graphic_eq_rounded
                                : Icons.mic_rounded,
                            size: 20,
                            color: context.mvTextPrimary),
                      ),
                    ),
                    SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: _input,
                        minLines: 1,
                        maxLines: 3,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => _send(),
                        decoration: InputDecoration(
                          hintText: _listening ? '我在听…' : '和助手说…（它只引路，拍板在你）',
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 10),
                          border: const OutlineInputBorder(
                              borderRadius:
                                  BorderRadius.all(Radius.circular(12))),
                        ),
                      ),
                    ),
                    SizedBox(width: 8),
                    IconButton(
                      tooltip: ref.watch(speechSettingsProvider).autoSpeak
                          ? '回复自动朗读：开'
                          : '回复自动朗读：关',
                      onPressed: () => ref
                          .read(speechSettingsProvider.notifier)
                          .setAutoSpeak(
                              !ref.read(speechSettingsProvider).autoSpeak),
                      icon: Icon(
                          ref.watch(speechSettingsProvider).autoSpeak
                              ? Icons.volume_up_rounded
                              : Icons.volume_off_rounded,
                          size: 20),
                    ),
                    SizedBox(width: 4),
                    FilledButton(
                      onPressed: st.sending ? null : _send,
                      style: FilledButton.styleFrom(
                          minimumSize: const Size(44, 40),
                          padding: EdgeInsets.zero),
                      child: Icon(Icons.send, size: 18),
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
          color: context.mvInfo.withValues(alpha: .12),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: context.mvInfo.withValues(alpha: .4)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 12, color: context.mvInfo),
            SizedBox(width: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 130),
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: context.mvInfo)),
            ),
            SizedBox(width: 3),
            Icon(Icons.close, size: 11, color: context.mvInfo),
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
      label: Text(label, style: TextStyle(fontSize: 11.5)),
      visualDensity: VisualDensity.compact,
      onPressed: onTap,
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.msg, required this.notifier, this.onSpeak});
  final MvChatMsg msg;
  final MvAssistantNotifier notifier;

  /// 朗读本条（助手/系统的话才给；用户自己说的话不念回去）
  final Future<void> Function(String)? onSpeak;

  @override
  Widget build(BuildContext context) {
    if (msg.role == 'sys') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Center(
          child: Text(mvUserVisibleText(msg.text),
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 11, color: context.mvTextMuted, height: 1.4)),
        ),
      );
    }
    final me = msg.role == 'user';
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
              : context.mvSurfaceRaised.withValues(alpha: .06),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment:
              me ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Text(mvUserVisibleText(msg.text),
                style: TextStyle(
                    fontSize: 13, color: context.mvTextPrimary, height: 1.45)),
            if (onSpeak != null)
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => onSpeak!(mvUserVisibleText(msg.text)),
                  child: Tooltip(
                    message: '念给我听',
                    child: Padding(
                      padding: EdgeInsets.all(3),
                      child: Icon(Icons.volume_up_rounded,
                          size: 15, color: context.mvTextMuted),
                    ),
                  ),
                ),
              ),
            // 建议草稿挂「采纳」（拍板权在人：采纳才 ver++ 落盘）
            if ((msg.adoptableSuggestId ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: OutlinedButton(
                  onPressed: () =>
                      notifier.adoptSuggest(msg.adoptableSuggestId!),
                  style: OutlinedButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 4)),
                  child: Text('采纳这版', style: TextStyle(fontSize: 11.5)),
                ),
              ),
            // 确认票（批准/拒绝；一票一次防重复）
            if (msg.ticket != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Container(
                  padding: const EdgeInsets.all(10),
                  width: 240,
                  decoration: BoxDecoration(
                    color: context.mvWarning.withValues(alpha: .06),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                        color: context.mvWarning.withValues(alpha: .35)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('确认票 · ${mvUserVisibleText(msg.ticket!.action)}',
                          style: TextStyle(
                              fontSize: 12, fontWeight: FontWeight.w700)),
                      SizedBox(height: 2),
                      Text('${msg.ticket!.estMinutes} 分钟 · 60 秒内有效',
                          style: TextStyle(
                              fontSize: 11, color: context.mvTextSecondary)),
                      SizedBox(height: 6),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: msg.ticketHandled
                                ? null
                                : () => notifier.denyTicket(msg),
                            style: TextButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 10)),
                            child: Text('拒绝',
                                style: TextStyle(
                                    fontSize: 12,
                                    color: context.mvTextSecondary)),
                          ),
                          SizedBox(width: 6),
                          FilledButton(
                            onPressed: msg.ticketHandled
                                ? null
                                : () => notifier.approveTicket(msg),
                            style: FilledButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 12)),
                            child: Text(msg.ticketHandled ? '已处理' : '批准',
                                style: TextStyle(fontSize: 12)),
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
}
