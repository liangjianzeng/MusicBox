import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import 'credit_guard.dart';
import 'intent_flow_page.dart';
import 'progress_page.dart';
import 'shelf_store.dart';
import 'transcript_confirm_page.dart';
import 'voice_capture.dart';

/// 简约级「灵感拍立得」：大按钮按住说话(≤60s) / 拍一张 / 一句话 → intent 流
class ShellEasy extends ConsumerStatefulWidget {
  const ShellEasy({super.key});

  @override
  ConsumerState<ShellEasy> createState() => _ShellEasyState();
}

class _ShellEasyState extends ConsumerState<ShellEasy> {
  bool _busy = false;
  final TextEditingController _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  /// 语音 → 「你说的话」确认页 →（确认或改字后）意图流
  Future<void> _onVoice(VoiceCaptureResult cap) async {
    if (!cap.hasAnything) {
      _toast(cap.local?.error ?? '没听清，再说一遍');
      return;
    }
    if (!mounted) return;
    final exit = await Navigator.of(context).push<ConfirmExit>(
      MaterialPageRoute(builder: (_) => TranscriptConfirmPage(capture: cap, easy: true)),
    );
    if (!mounted) return;
    if (exit?.kind == kConfirmTyped && exit!.text.isNotEmpty) {
      _text.text = exit.text;
      _toast('已填进「一句话」，可以直接改');
    } else if (exit?.kind == kConfirmRedo) {
      _toast('好，再按住说一次');
    }
  }

  Future<void> _onPhoto() async {
    setState(() => _busy = true);
    final id = await capturePhotoAndIntent(context, ref);
    if (mounted) setState(() => _busy = false);
    if (id != null && mounted) {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => IntentFlowPage(intentId: id, easy: true),
      ));
    }
  }

  /// 一句话 → 直接文本生成（契约无文本意图端点，走 simple 生成线）
  Future<void> _onText() async {
    final prompt = _text.text.trim();
    if (prompt.isEmpty) return;
    if (!await ensureCredits(context, ref, kCreditGenerateEach * 3,
        action: '一键出歌')) {
      return;
    }
    setState(() => _busy = true);
    try {
      final body = <String, dynamic>{
        'mode': 'simple',
        'prompt': prompt,
        'count': 3,
      };
      final model = ref.read(musicModelProvider);
      final r = await ref.read(apiClientProvider).generate(body, model: model);
      if (!mounted) return;
      _text.clear();
      ProgressPage.push(
        context,
        '${r['job_id']}',
        brief: const TaskBrief(
            action: '生成', tierLabel: '简约', sourceLabel: '一句话', count: 3)
            .copyLike(prompt: prompt),
        plannedCount: 3,
        onRetry: () async {
          try {
            final rr = await ref
                .read(apiClientProvider)
                .generate(body, model: model);
            return '${rr['job_id']}';
          } catch (_) {
            return null;
          }
        },
      );
    } on ApiException catch (e) {
      _toast(e.zh);
    } catch (_) {
      _toast('提交失败，请重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 32),
      children: [
        const SizedBox(height: 8),
        const Text('说出你的灵感，即刻成曲',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text('按住说话 · 拍一张 · 打一句话，AI 帮你写成歌',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white38, fontSize: 13)),
        const SizedBox(height: 28),
        Center(
          child: _busy
              ? const SizedBox(
                  width: 150,
                  height: 150,
                  child: Center(
                      child: CircularProgressIndicator(strokeWidth: 3)))
              : HoldToTalkButton(onResult: _onVoice),
        ),
        const SizedBox(height: 28),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 52),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16)),
                ),
                onPressed: _busy ? null : _onPhoto,
                icon: const Icon(Icons.photo_camera_rounded),
                label: const Text('拍一张'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _text,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _onText(),
                decoration: InputDecoration(
                  hintText: '或打一句话，如“雨天咖啡馆的爵士”',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            SizedBox(
              width: 92,
              child: PrimaryButton(
                text: '出歌',
                icon: Icons.auto_awesome,
                loading: _busy,
                onPressed: _busy ? null : _onText,
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        const Center(
          child: Text('每次生成 3 首候选 · 约 45 积分 · 失败自动返还',
              style: TextStyle(color: Colors.white24, fontSize: 12)),
        ),
      ],
    );
  }
}
