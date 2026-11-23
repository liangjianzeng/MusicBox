import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/consent.dart';
import 'creation_state.dart';

/// 傻瓜级大按钮：按住说话（≤60s），松开即上传走 intent 流
class HoldToTalkButton extends ConsumerStatefulWidget {
  const HoldToTalkButton({
    super.key,
    required this.onResult,
    this.maxSeconds = 60,
    this.compact = false,
  });

  /// 返回录音文件路径（m4a）
  final ValueChanged<String> onResult;
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

  @override
  void dispose() {
    _tick?.cancel();
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
    if (!await _rec.hasPermission()) {
      _toast('没有麦克风权限，请在系统设置中允许录音');
      return;
    }
    try {
      final dir = await getTemporaryDirectory();
      _path = '${dir.path}/voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _rec.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 96000,
          sampleRate: 44100,
          numChannels: 1,
        ),
        path: _path!,
      );
      setState(() {
        _recording = true;
        _elapsed = 0;
      });
      _tick = Timer.periodic(const Duration(seconds: 1), (t) {
        setState(() => _elapsed++);
        if (_elapsed >= widget.maxSeconds) {
          _stop();
        }
      });
    } catch (_) {
      _toast('录音启动失败，请重试');
    }
  }

  Future<void> _stop() async {
    if (!_recording) return;
    _tick?.cancel();
    setState(() {
      _recording = false;
      _busy = true;
    });
    String? path;
    try {
      path = await _rec.stop();
    } catch (_) {
      path = null;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    if (path == null || path.isEmpty) {
      _toast('没录到声音，再试一次');
      return;
    }
    if (_elapsed < 1) {
      _toast('说得太短啦，按住多说几个字');
      return;
    }
    widget.onResult(path);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final size = widget.compact ? 72.0 : 150.0;
    return Semantics(
      button: true,
      child: GestureDetector(
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
