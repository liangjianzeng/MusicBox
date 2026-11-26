import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/speech/asr_engine.dart';
import '../../core/speech/speech_service.dart';

/// 统一助手语音进出（听=端侧识别；念=端侧 VITS，失败回落在线朗读）。
///
/// 从 mv/assistant_sheet.dart 的语音层抽取，让统一 surface 也能「听-说」；
/// 音乐 / MV / 曲库各 surface 的语音都走这一条（D-2）。
///
/// 纪律（与 MV sheet 同源）：
/// · 降级要看得见：模型没就位时给明确出路，不空转；
/// · 失败要能说清：识别/播报失败都落到 [talkError]，UI 上屏；
/// · 麦克风必须归还：松手 / 取消 / dispose 都取消会话。
class AssistantVoiceController extends ChangeNotifier {
  AssistantVoiceController({
    required SpeechService service,
    required TextEditingController inputController,
    required SpeechCoordination coordination,
  })  : _svc = service,
        _input = inputController,
        _coordination = coordination;

  final SpeechService _svc;
  final TextEditingController _input;
  final SpeechCoordination _coordination;

  StreamingAsrSession? _asr;
  bool _listening = false;
  bool _speaking = false;
  String? _talkError;
  int _talkGeneration = 0;
  bool _disposed = false;

  bool get listening => _listening;
  bool get speaking => _speaking;
  String? get talkError => _talkError;

  /// 按住说话：端侧识别，实时回显到输入框。
  Future<void> startTalk() async {
    if (_listening) return;
    final generation = ++_talkGeneration;
    _listening = true;
    _talkError = null;
    notifyListeners();
    try {
      final s = await _svc.createSession();
      if (generation != _talkGeneration) {
        // 用户已松手/取消，或本实例已 dispose；迟到的会话必须归还麦克风资源，
        // 不能擅自再次 start。
        await s?.cancel();
        return;
      }
      if (s == null) {
        // 档位是服务端：助手对话没有服务端听写这条路，给明确出路而不是空转
        _listening = false;
        _talkError =
            '语音输入用的是本机识别，请先到「我的 · 语音能力」下载模型，或直接用打字';
        notifyListeners();
        return;
      }
      _asr = s;
      s.partialText.listen((t) {
        if (!_disposed) _input.text = t;
      });
      await s.start();
    } catch (e) {
      _listening = false;
      _talkError = '听不了：$e';
      notifyListeners();
    }
  }

  /// 松手：结束识别，把终稿写回输入框（或给没听清的原因）。
  Future<void> stopTalk() async {
    _talkGeneration++;
    final s = _asr;
    _asr = null;
    if (s == null) {
      if (!_disposed) {
        _listening = false;
        notifyListeners();
      }
      return;
    }
    AsrOutcome o;
    try {
      o = await s.stop();
    } catch (e) {
      o = AsrOutcome.empty.copyWith(error: e.toString());
    }
    if (_disposed) return;
    _listening = false;
    if (o.hasText) {
      _input.text = o.text;
      _input.selection = TextSelection.collapsed(offset: o.text.length);
    } else {
      _talkError = o.error ?? '没听清，再说一遍';
    }
    notifyListeners();
  }

  /// 放弃本次会话（切页/取消时调用，不处理结果、只归还麦克风）。
  void cancelTalk() {
    _talkGeneration++;
    final s = _asr;
    _asr = null;
    if (s != null) unawaited(s.cancel());
    if (!_disposed) {
      _listening = false;
      notifyListeners();
    }
  }

  /// 念一段话：端侧 VITS 优先，失败回落在线朗读；失败原因落到 [talkError]。
  Future<void> speak(String text) async {
    final t = text.trim();
    if (t.isEmpty || _speaking || _disposed) return;
    _speaking = true;
    notifyListeners();
    final err = await _svc.speak(t, coordination: _coordination);
    if (_disposed) return;
    _speaking = false;
    if (err != null) {
      _talkError = err;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _talkGeneration++;
    _asr?.cancel();
    _svc.stopSpeak();
    super.dispose();
  }
}

/// 麦克风按钮（统一助手输入行左侧）：长按=说话，松开=停止。
/// 监听 [AssistantVoiceController]，监听中图标与底色会变。
class AssistantVoiceButton extends StatelessWidget {
  const AssistantVoiceButton({super.key, required this.controller});

  final AssistantVoiceController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final listening = controller.listening;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onLongPressStart: (_) => controller.startTalk(),
          onLongPressEnd: (_) => controller.stopTalk(),
          onLongPressCancel: () => controller.stopTalk(),
          child: Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: listening
                  ? Theme.of(context).colorScheme.errorContainer
                  : const Color(0xFF17181F).withValues(alpha: .12),
            ),
            child: Icon(
                listening ? Icons.graphic_eq_rounded : Icons.mic_rounded,
                size: 20,
                color: Theme.of(context).colorScheme.onSurface),
          ),
        );
      },
    );
  }
}
