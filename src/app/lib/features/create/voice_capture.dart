import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/api_client.dart';
import '../../core/speech/asr_engine.dart';
import '../../core/speech/sherpa_asr.dart';
import '../../core/speech/speech_service.dart';
import '../../core/state.dart';
import '../../shared/widgets/consent.dart';
import 'creation_state.dart';
import 'transcript_confirm_page.dart';

/// 简约级大按钮：按住说话（≤60s），松开进「你说的话」确认页。
///
/// 端侧档：`record` 出 16k mono PCM 流喂端侧识别 → **边说边出字**，同时把
/// PCM 攒成 WAV 落盘（松手后交给服务端复核用，不必二次录音）。
/// 服务端档：沿用 m4a 直录直传。
class HoldToTalkButton extends ConsumerStatefulWidget {
  const HoldToTalkButton({
    super.key,
    required this.onResult,
    this.maxSeconds = 60,
    this.compact = false,
  });

  /// 松开后回传本次采集结果（WAV + 端侧识别文本 + 换档说明）
  final ValueChanged<VoiceCaptureResult> onResult;
  final int maxSeconds;
  final bool compact;

  @override
  ConsumerState<HoldToTalkButton> createState() => _HoldToTalkButtonState();
}

class _HoldToTalkButtonState extends ConsumerState<HoldToTalkButton> {
  final AudioRecorder _rec = AudioRecorder();
  Timer? _tick;
  bool _recording = false;
  bool _busy = false;
  int _elapsed = 0;
  String? _path;
  String? _live; // 端侧实时转写（回显用）
  StreamingAsrSession? _session;
  ResolvedEngine? _resolved;

  @override
  void dispose() {
    _tick?.cancel();
    unawaited(_session?.cancel());
    _rec.dispose();
    super.dispose();
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _start() async {
    if (_recording || _busy) return;
    if (!await ensureBiometricConsent(context, ref)) return;
    setState(() {
      _busy = true;
      _live = null;
      _elapsed = 0;
    });
    try {
      final svc = ref.read(speechServiceProvider);
      var resolved = await svc.resolveEngine();
      _resolved = resolved;
      final dir = await getTemporaryDirectory();
      final stamp = DateTime.now().millisecondsSinceEpoch;
      if (resolved.onDevice) {
        final wav = p.join(dir.path, 'voice_$stamp.wav');
        final s = await svc.createSession(saveWavPath: wav);
        if (s == null) {
          // 解析说端侧可用、建会话却失败：如实降级，不假装
          _resolved = const ResolvedEngine(AsrEngineKind.server,
              reason: '本机识别没起来，这次走服务端');
        } else {
          _session = s;
          s.partialText.listen((t) {
            if (mounted) setState(() => _live = t);
          });
          await s.start();
          _path = wav;
        }
      }
      if (_session == null) {
        // 服务端档：直录 m4a
        if (!await _rec.hasPermission()) {
          _toast('没有麦克风权限，请在系统设置中允许录音');
          return;
        }
        _path = p.join(dir.path, 'voice_$stamp.m4a');
        await _rec.start(
          const RecordConfig(
            encoder: AudioEncoder.aacLc,
            bitRate: 96000,
            sampleRate: 44100,
            numChannels: 1,
          ),
          path: _path!,
        );
      }
      if (!mounted) return;
      setState(() {
        _recording = true;
        _busy = false;
      });
      _tick = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted) return;
        setState(() => _elapsed++);
        if (_elapsed >= widget.maxSeconds) _stop();
      });
    } on SpeechPermissionException catch (e) {
      _toast(e.message);
      if (mounted) setState(() => _busy = false);
    } catch (_) {
      await _cleanup();
      _toast('录音启动失败，请重试');
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cleanup() async {
    await _session?.cancel();
    _session = null;
    try {
      await _rec.cancel();
    } catch (_) {}
  }

  Future<void> _stop() async {
    if (!_recording) return;
    _tick?.cancel();
    if (!mounted) return;
    setState(() {
      _recording = false;
      _busy = true;
    });
    final s = _session;
    _session = null;
    VoiceCaptureResult? out;
    if (s != null) {
      AsrOutcome outcome;
      try {
        outcome = await s.stop();
      } catch (e) {
        outcome = AsrOutcome.empty.copyWith(error: e.toString());
      }
      out = VoiceCaptureResult(
        wavPath: _path,
        local: outcome,
        engineNote: _resolved?.reason,
        engine: _resolved?.engine,
      );
    } else {
      String? path;
      try {
        path = await _rec.stop();
      } catch (_) {
        path = null;
      }
      if ((path == null || path.isEmpty) && _path != null) path = _path;
      if (path == null || path.isEmpty) {
        if (!mounted) return;
        setState(() => _busy = false);
        _toast('没录到声音，再试一次');
        return;
      }
      out = VoiceCaptureResult(
          wavPath: path, engineNote: _resolved?.reason, engine: _resolved?.engine);
    }
    if (!mounted) return;
    setState(() => _busy = false);
    if (_elapsed < 1 && !(out.local?.hasText ?? false)) {
      _toast('说得太短啦，按住多说几个字');
      return;
    }
    widget.onResult(out);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final size = widget.compact ? 72.0 : 150.0;
    return Semantics(
      button: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onLongPressStart: (_) => _start(),
            onLongPressEnd: (_) => _stop(),
            onLongPressCancel: () => _stop(),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              width: size,
              height: size,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: _recording
                      ? [scheme.errorContainer, scheme.error]
                      : [scheme.primary, scheme.tertiary],
                ),
                boxShadow: [
                  BoxShadow(
                    color: (recordingColor()).withValues(alpha: _recording ? 0.5 : 0.25),
                    blurRadius: _recording ? 26 : 14,
                    spreadRadius: _recording ? 6 : 0,
                  ),
                ],
              ),
              child: Center(
                child: _busy
                    ? const SizedBox(
                        width: 26,
                        height: 26,
                        child: CircularProgressIndicator(strokeWidth: 2.5))
                    : Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(_recording ? Icons.graphic_eq_rounded : Icons.mic_rounded,
                              size: widget.compact ? 30 : 48, color: Colors.white),
                          if (!widget.compact)
                            Text(
                              _recording
                                  ? '松开发送 · ${_elapsed}s/${widget.maxSeconds}s'
                                  : '按住说话',
                              style: const TextStyle(
                                  color: Colors.white, fontSize: 13),
                            ),
                          if (!widget.compact && !_recording)
                            const Text('说出你的灵感（≤${60}s）',
                                style: TextStyle(color: Colors.white70, fontSize: 11)),
                        ],
                      ),
              ),
            ),
          ),
          // 端侧实时回显：说的字当场跳出来（松手后由「你说的话」页接管复核）
          if (_recording && (_live?.trim().isNotEmpty ?? false))
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                _live!.trim(),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: widget.compact ? 13 : 16,
                  height: 1.35,
                  color: scheme.onSurface,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Color recordingColor() {
    final scheme = Theme.of(context).colorScheme;
    return _recording ? scheme.error : scheme.primary;
  }
}

/// 拍一张：同意 → 相机 → 上传走 image intent 流。返回 intentId 或 null。
Future<String?> capturePhotoAndIntent(
    BuildContext context, WidgetRef ref) async {
  if (!await ensureBiometricConsent(context, ref)) return null;
  try {
    final x = await ImagePicker()
        .pickImage(source: ImageSource.camera, imageQuality: 85, maxWidth: 1600);
    if (x == null) return null;
    final id = await ref.read(apiClientProvider).intentImage(x.path);
    ref.read(creationProvider.notifier).setIntent(id);
    return id;
  } on ApiException catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.zh)));
    }
    return null;
  } catch (_) {
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('拍照上传失败，请重试')));
    }
    return null;
  }
}
