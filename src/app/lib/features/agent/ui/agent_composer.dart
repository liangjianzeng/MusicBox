import 'package:flutter/material.dart';

import '../../assistant/assistant_voice.dart';
import '../../create/creation_ui.dart';
import 'agent_view_model.dart';

/// 伴创输入区：打字 + 语音发送 + 显式「交给小助手」。
///
/// 语音复用 [AssistantVoiceButton]（`assistant_voice.dart:144`，此前全仓 0 调用方，
/// 在这里落地）：长按=本机识别、松手=出字，识别不了会给明确出路而不是空转。
/// 「交给小助手」是**显式**入口——不把用户困在总助手这一层：面板里那个只答本面板
/// 问题的小助手，得有个明说得出的门进去（方案 §2.1 两层助手）。
class AgentComposer extends StatefulWidget {
  const AgentComposer({
    super.key,
    required this.controller,
    this.input,
    this.voice,
    this.hintText = '想要什么样的歌，说人话就行…',
    this.autofocus = false,
  });

  final AgentUiController controller;

  /// 由宿主传入（语音识别的字要写回同一个输入框）；不传则自建。
  final TextEditingController? input;

  /// 为空则不出麦克风按钮（例如宿主没有语音能力时）。
  final AssistantVoiceController? voice;

  final String hintText;
  final bool autofocus;

  @override
  State<AgentComposer> createState() => _AgentComposerState();
}

class _AgentComposerState extends State<AgentComposer> {
  TextEditingController? _ownInput;
  final _focus = FocusNode();

  TextEditingController get _input =>
      widget.input ?? (_ownInput ??= TextEditingController());

  @override
  void dispose() {
    _ownInput?.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final t = _input.text.trim();
    if (t.isEmpty) return;
    _input.clear();
    await widget.controller.send(t);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller.listenable,
      builder: (context, _) => _body(context, widget.controller.snapshot),
    );
  }

  Widget _body(BuildContext context, AgentUiState state) {
    final v = widget.voice;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if ((state.error ?? '').isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 6, left: 2),
            child: Row(
              children: [
                const Icon(Icons.error_outline_rounded,
                    size: 14, color: CreationPalette.amber),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    state.error!,
                    style: const TextStyle(
                      color: CreationPalette.amber,
                      fontSize: 11.5,
                      height: 1.35,
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (v != null)
          ListenableBuilder(
            listenable: v,
            builder: (context, _) {
              final err = v.talkError;
              if (err == null) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(bottom: 6, left: 2),
                child: Text(
                  err,
                  style: const TextStyle(
                    color: CreationPalette.muted,
                    fontSize: 11.5,
                    height: 1.35,
                  ),
                ),
              );
            },
          ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: _input,
                focusNode: _focus,
                autofocus: widget.autofocus,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _send(),
                style: const TextStyle(
                  fontSize: 14,
                  color: CreationPalette.text,
                  height: 1.4,
                ),
                decoration: creationFieldDecoration(
                  hint: widget.hintText,
                  dense: true,
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (v != null) ...[
              AssistantVoiceButton(controller: v),
              const SizedBox(width: 6),
            ],
            _SendButton(state: state, onTap: _send),
          ],
        ),
      ],
    );
  }
}

class _SendButton extends StatelessWidget {
  const _SendButton({required this.state, required this.onTap});
  final AgentUiState state;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = !state.busy;
    return Semantics(
      button: true,
      enabled: enabled,
      hint: enabled ? null : '助手正在说话，等它说完再发',
      label: '发送',
      child: Opacity(
        opacity: enabled ? 1 : .45,
        child: Material(
          color: CreationPalette.violet.withValues(alpha: .16),
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: enabled ? onTap : null,
            child: const SizedBox(
              width: 42,
              height: 42,
              child: Icon(Icons.send_rounded,
                  size: 19, color: CreationPalette.violetBright),
            ),
          ),
        ),
      ),
    );
  }
}
