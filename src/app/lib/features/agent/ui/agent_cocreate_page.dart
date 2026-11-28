import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/state.dart';
import '../../../core/speech/speech_service.dart';
import '../../assistant/assistant_voice.dart';
import '../../create/creation_ui.dart';
import '../../creation/tier_config.dart';
import '../../player/player_provider.dart';
import 'agent_composer.dart';
import 'agent_step_tile.dart';
import 'agent_view_model.dart';
import 'ask_card.dart';
import 'brief_card.dart';

/// 伴创主页（底部第 4 个 tab 的内容；方案 §2.4 / §6.1 / §6.6）。
///
/// 版面纪律（写死在这里，别改回弹层）：
/// · **上半 = 聊天流**：助手说的话 + 它在办的事（步骤流）；
/// · **下半 = 主动提问卡片区**：至多 3 题、选择式、与聊天**同屏**——开场一次问齐，
///   不做分步向导、不做弹层（分步 = 用户不知道还要答几题）；
/// · 出曲前只有简报卡这**一次**总确认，按钮永远站在「待你确认」这一侧；
/// · 底部输入区 = 打字 + 语音（[AssistantVoiceButton]）+ 显式「交给小助手」。
///
/// 接线（lead 只要这两处，其余都不用碰）：
/// ```dart
/// // ① ProviderScope（main.dart / root_shell）：
/// agentSessionProvider.overrideWithValue(engineSession),        // 引擎同事的 AgentSession
/// agentTicketGatewayProvider.overrideWithValue(assistantTicketGateway), // 可选：票面通道
/// // ② tab 列表按 CreationTiers.visible(cocreateEnabled: …) 数据驱动，
/// //    第 4 槽（顶掉「人格」）放：
/// AgentCocreatePage()   // 没有「交给小助手」的下沉入口：层级只能向上交，老大不把难题推回本页小助理
/// ```
/// 灰度关闭时**整页不该被挂上**（`CreationTiers.visible()` 里没有它）；万一被挂上，
/// 页面自己退化成"这里还没开放"的说明，而不是白屏或假可用。
class AgentCocreatePage extends ConsumerStatefulWidget {
  const AgentCocreatePage({
    super.key,
    this.controller,
    this.enableVoice = true,
    this.initialPrompt,
    this.tierLabel,
  });

  /// 不传则读 [agentUiProvider]（接线方 override `agentSessionProvider` 即可）。
  final AgentUiController? controller;
  final bool enableVoice;

  final String? initialPrompt;

  /// 顶部显示的档位名（来自 [CreationTiers]，缺省「伴创」）。
  final String? tierLabel;

  @override
  ConsumerState<AgentCocreatePage> createState() => _AgentCocreatePageState();
}

class _AgentCocreatePageState extends ConsumerState<AgentCocreatePage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _askScroll = ScrollController();
  AssistantVoiceController? _voice;
  int _lastEntryCount = -1;

  AgentUiController get _controller =>
      widget.controller ?? ref.read(agentUiProvider.notifier);

  @override
  void initState() {
    super.initState();
    if (widget.enableVoice) {
      _voice = AssistantVoiceController(
        service: ref.read(speechServiceProvider),
        inputController: _input,
        coordination: SpeechCoordination(
          isPlaying: () => ref.read(playerProvider).playing,
          pause: () => ref.read(playerProvider.notifier).audio.pause(),
          resume: () => ref.read(playerProvider.notifier).audio.play(),
        ),
      );
    }
    final p = widget.initialPrompt?.trim();
    if (p != null && p.isNotEmpty) _input.text = p;
    // 这里**不再去读价格**（2026-11-28 产品拍板）：智能体页不呈现计费，
    // 也就没有一进页面就打 `/v1/credits` 的理由 —— 少一次无谓请求，也少一处能红的地方。
  }

  @override
  void dispose() {
    _voice?.dispose();
    _input.dispose();
    _scroll.dispose();
    _askScroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final rc = ref.watch(remoteConfigProvider);
    final AgentUiController ctrl =
        widget.controller ?? ref.watch(agentUiProvider.notifier);
    return ListenableBuilder(
      listenable: ctrl.listenable,
      builder: (context, _) => _scaffold(context, ctrl.snapshot, rc),
    );
  }

  Widget _scaffold(BuildContext context, AgentUiState state, RemoteConfig? rc) {
    final open = cocreateEnabledOf(rc) || widget.controller != null;
    if (_lastEntryCount != state.entries.length) {
      _lastEntryCount = state.entries.length;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.animateTo(0,
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOut);
        }
      });
    }
    return Scaffold(
      backgroundColor: CreationPalette.background,
      body: Stack(
        children: [
          const Positioned.fill(child: CreationBackdrop()),
          SafeArea(
            bottom: false,
            child: Column(
              children: [
                _header(state, open),
                if (!open) _closedHint() else ..._body(state),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _body(AgentUiState state) => [
        Expanded(child: _chatStream(state)),
        if (state.questions.isNotEmpty || state.showBrief) _lowerArea(state),
        CreationDock(
          child: AgentComposer(
            controller: _controller,
            input: _input,
            voice: _voice,
          ),
        ),
      ];

  Widget _header(AgentUiState state, bool open) {
    final tierName =
        widget.tierLabel ?? CreationTiers.labelOf(CreationTiers.tierCocreate);
    return Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: CreationPalette.border)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 10, 12, 9),
      child: Row(
        children: [
          const Icon(Icons.support_agent_rounded,
              size: 17, color: CreationPalette.violetBright),
          const SizedBox(width: 7),
          Text(
            tierName,
            style: const TextStyle(
              color: CreationPalette.text,
              fontSize: 15,
              fontWeight: FontWeight.w900,
              letterSpacing: .3,
            ),
          ),
          const SizedBox(width: 7),
          if (state.mode != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: CreationPalette.cyan.withValues(alpha: .1),
                borderRadius: BorderRadius.circular(999),
                border:
                    Border.all(color: CreationPalette.cyan.withValues(alpha: .3)),
              ),
              child: Text(
                state.mode!,
                style:
                    const TextStyle(fontSize: 10.5, color: CreationPalette.cyan),
              ),
            ),
          const Spacer(),
          if (!open)
            const Text(
              '还没对你开放',
              style: TextStyle(fontSize: 11, color: CreationPalette.faint),
            ),
        ],
      ),
    );
  }

  /// 灰度没命中却被人挂上来了：说清楚，并给一条出路，不白屏、不假可用。
  Widget _closedHint() {
    return const Expanded(
      child: Center(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.hourglass_empty_rounded,
                  size: 30, color: CreationPalette.faint),
              SizedBox(height: 10),
              Text(
                '智能体还在小范围试用，还没轮到你这个账号。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: CreationPalette.muted,
                  fontSize: 13,
                  height: 1.5,
                ),
              ),
              SizedBox(height: 6),
              Text(
                '想马上做歌，回「创建」那一页照样能用。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: CreationPalette.faint,
                  fontSize: 12,
                  height: 1.5,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 上半：聊天流（最新在上），含步骤流与「助手在想」占位。
  Widget _chatStream(AgentUiState state) {
    final entries = state.entries.reversed.toList(growable: false);
    final empty = entries.isEmpty && state.draft == null && state.steps.isEmpty;
    if (empty) {
      return ListView(
        controller: _scroll,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        children: [AgentChatEmpty(onPrompt: _controller.send)],
      );
    }
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      children: [
        if (state.draft != null && state.draft!.thinking)
          const AgentThinkingTile(label: '助手在想…'),
        if (state.hasDraftText)
          AgentChatBubble(
            entry: AgentChatEntry(
              id: 'draft',
              role: AgentEntryRole.assistant,
              text: state.draft!.content!.trim(),
            ),
          ),
        AgentStepFlow(steps: state.steps),
        for (final e in entries) AgentChatBubble(entry: e),
      ],
    );
  }

  /// 下半：提问卡片区 + 简报卡（与聊天同屏，一起滚，不是弹层）。
  Widget _lowerArea(AgentUiState state) {
    final maxH = MediaQuery.sizeOf(context).height * .55;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxH),
      child: SingleChildScrollView(
        controller: _askScroll,
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AgentAskSection(state: state, controller: _controller),
            if (state.showBrief)
              AgentBriefCard(state: state, controller: _controller),
          ],
        ),
      ),
    );
  }
}

