import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../shared/widgets/consent.dart';
import '../mv_api_client.dart';
import '../mv_state.dart';

/// 步②选角：双通道硬性并列露出（发起人要求，不分主次）——
/// (a) 拍照 / 上传照片（image_picker + consent 同意 + 「本人或已获授权」必勾）
/// (b) AI 生成歌手（不传真人照，创建角色记录，免人脸）
/// 含真人照片通道：未勾选授权 / 校验不过 → 禁止进入下一步。
class StepCast extends ConsumerStatefulWidget {
  const StepCast({super.key, required this.workId});
  final String? workId;

  @override
  ConsumerState<StepCast> createState() => _StepCastState();
}

class _StepCastState extends ConsumerState<StepCast> {
  bool _picking = false;
  Map<String, dynamic>? _precheck; // 人像预检结果（契约 v2.22；null=未检/清空）
  bool _prechecking = false;

  Future<void> _runPrecheck(String path) async {
    if (path.isEmpty) return;
    setState(() {
      _prechecking = true;
      _precheck = null;
    });
    try {
      final r = await ref.read(mvApiClientProvider).precheck(path);
      if (!mounted) return;
      setState(() {
        _prechecking = false;
        _precheck = Map<String, dynamic>.from(r);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _prechecking = false;
        _precheck = {
          'available': false,
          'checks': const [],
          'msg': '预检暂不可用（不影响上传）'
        };
      });
    }
  }

  Future<void> _pick(ImageSource source) async {
    if (_picking) return;
    // 一期 PIPL 范式：采集前用途限定同意（仅本次生成 / 72h TTL / 不训练）
    if (!await ensureBiometricConsent(context, ref)) return;
    if (!mounted) return;
    setState(() => _picking = true);
    try {
      final x = await ImagePicker().pickImage(
        source: source,
        maxWidth: 1440,
        imageQuality: 88,
      );
      if (x == null) return;
      final err = MvApiClient.validateImage(x.path);
      final n = ref.read(mvWizardProvider(widget.workId).notifier);
      if (err != null) {
        n.pickedImage(x.path); // 仍展示预览，但状态里记错误、卡住门禁
        n.setUploadErrorLocal(err);
        return;
      }
      n.pickedImage(x.path);
      _runPrecheck(x.path); // 选照后自动预检（facegate 离线则如实降级，不阻断）
    } catch (_) {
      ref
          .read(mvWizardProvider(widget.workId).notifier)
          .setUploadErrorLocal('未能取得照片，请重试');
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(mvWizardProvider(widget.workId));
    final n = ref.read(mvWizardProvider(widget.workId).notifier);
    final scheme = Theme.of(context).colorScheme;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      children: [
        const Text('选一位主演（N1 单主演）',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        const Text('两条通道任选：上传真人照片更像你；AI 歌手免人脸、更快。',
            style: TextStyle(fontSize: 12, color: Colors.white38)),
        const SizedBox(height: 12),
        // 性别 m/f
        Row(
          children: [
            const Text('主演性别：',
                style: TextStyle(fontSize: 13, color: Colors.white70)),
            const SizedBox(width: 8),
            _GenderChip(
                label: '女',
                value: 'f',
                selected: state.gender == 'f',
                onTap: () => n.setGender('f')),
            const SizedBox(width: 8),
            _GenderChip(
                label: '男',
                value: 'm',
                selected: state.gender == 'm',
                onTap: () => n.setGender('m')),
          ],
        ),
        const SizedBox(height: 14),
        // 双通道并列
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _ChannelCard(
                selected: state.channel == 'upload',
                title: '拍照 / 上传照片',
                subtitle: '更像你 · 需授权',
                icon: Icons.camera_front_outlined,
                selectedColor: scheme.primary,
                onTap: () => n.setChannel('upload'),
                child: state.channel == 'upload'
                    ? _UploadBody(
                        state: state,
                        picking: _picking,
                        onPick: (src) => _pick(src),
                        onAuthorized: n.setAuthorized,
                        precheck: _precheck,
                        prechecking: _prechecking,
                        onRecheck: (state.imagePath ?? '').isNotEmpty
                            ? () => _runPrecheck(state.imagePath!)
                            : null,
                      )
                    : null,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _ChannelCard(
                selected: state.channel == 'ai',
                title: 'AI 生成歌手',
                subtitle: '免真人照 · 原创形象',
                icon: Icons.auto_awesome,
                selectedColor: scheme.tertiary,
                onTap: () => n.setChannel('ai'),
                child: state.channel == 'ai'
                    ? const Padding(
                        padding: EdgeInsets.only(top: 4),
                        child: Text(
                          '不上传任何真人照片，由剧组原创一位歌手。',
                          style: TextStyle(
                              fontSize: 12,
                              color: Colors.white54,
                              height: 1.4),
                        ),
                      )
                    : null,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if ((state.uploadError ?? '').isNotEmpty)
          _ErrorLine(text: state.uploadError!),
        if ((state.submitError ?? '').isNotEmpty)
          _ErrorLine(text: state.submitError!),
        const SizedBox(height: 8),
        // 确认主演（建项目 + 派定妆照任务；失败如实呈现）
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: state.castReady && !state.submitting
                ? () => n.submitCast()
                : null,
            icon: state.submitting
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.check, size: 18),
            label: Text(state.project != null && (state.imageId ?? '').isNotEmpty
                ? '已确认 · 重新提交'
                : '确认主演，去定妆'),
          ),
        ),
        const SizedBox(height: 6),
        const Text(
          '说明：含真人照片的成片按合规要求标注 AI 生成；照片仅用于本次角色生成，72 小时后自动删除。',
          style: TextStyle(fontSize: 11, color: Colors.white24, height: 1.4),
        ),
      ],
    );
  }
}

class _GenderChip extends StatelessWidget {
  const _GenderChip(
      {required this.label,
      required this.value,
      required this.selected,
      required this.onTap});
  final String label;
  final String value;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      visualDensity: VisualDensity.compact,
      selectedColor: scheme.primaryContainer,
    );
  }
}

class _ChannelCard extends StatelessWidget {
  const _ChannelCard({
    required this.selected,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.selectedColor,
    required this.onTap,
    this.child,
  });

  final bool selected;
  final String title;
  final String subtitle;
  final IconData icon;
  final Color selectedColor;
  final VoidCallback onTap;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          color: selected
              ? selectedColor.withValues(alpha: .12)
              : Colors.white.withValues(alpha: .03),
          border: Border.all(
              color: selected ? selectedColor : Colors.white10, width: 1.2),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon,
                    size: 20,
                    color: selected ? selectedColor : Colors.white38),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w700,
                          color: selected ? Colors.white : Colors.white70)),
                ),
                if (selected)
                  Icon(Icons.check_circle_rounded,
                      size: 16, color: selectedColor),
              ],
            ),
            const SizedBox(height: 2),
            Text(subtitle,
                style:
                    const TextStyle(fontSize: 11, color: Colors.white38)),
            if (child != null) ...[const SizedBox(height: 10), child!],
          ],
        ),
      ),
    );
  }
}

/// 真人通道展开区：拍照/相册按钮 + 预览 + 授权勾选
class _UploadBody extends StatelessWidget {
  const _UploadBody({
    required this.state,
    required this.picking,
    required this.onPick,
    required this.onAuthorized,
    this.precheck,
    this.prechecking = false,
    this.onRecheck,
  });

  final MvWizardState state;
  final bool picking;
  final ValueChanged<ImageSource> onPick;
  final ValueChanged<bool> onAuthorized;
  final Map<String, dynamic>? precheck; // 契约 v2.22 人像预检结果
  final bool prechecking;
  final VoidCallback? onRecheck;

  @override
  Widget build(BuildContext context) {
    final hasImg = (state.imagePath ?? '').isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (hasImg) ...[
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.file(
              File(state.imagePath!),
              height: 120,
              width: double.infinity,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Container(
                height: 80,
                color: Colors.white10,
                child: const Center(
                    child: Text('预览失败',
                        style: TextStyle(color: Colors.white38, fontSize: 11))),
              ),
            ),
          ),
          const SizedBox(height: 6),
        ],
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: picking ? null : () => onPick(ImageSource.camera),
                icon: const Icon(Icons.photo_camera_outlined, size: 16),
                label: const Text('拍照', style: TextStyle(fontSize: 12)),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: picking ? null : () => onPick(ImageSource.gallery),
                icon: const Icon(Icons.photo_library_outlined, size: 16),
                label: const Text('相册', style: TextStyle(fontSize: 12)),
              ),
            ),
          ],
        ),
        if ((state.imagePath ?? '').isNotEmpty) ...[
          _PrecheckCard(
              data: precheck, checking: prechecking, onRecheck: onRecheck),
          const SizedBox(height: 4),
        ],
        const SizedBox(height: 4),
        CheckboxListTile(
          value: state.authorized,
          onChanged: (v) => onAuthorized(v ?? false),
          dense: true,
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          title: const Text(
            '本人或已获授权（真人照片必勾）',
            style: TextStyle(fontSize: 12, height: 1.3),
          ),
        ),
      ],
    );
  }
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          const Icon(Icons.error_outline, size: 15, color: Colors.redAccent),
          const SizedBox(width: 6),
          Expanded(
              child: Text(text,
                  style:
                      const TextStyle(fontSize: 12, color: Colors.redAccent))),
        ],
      ),
    );
  }
}

/// 人像预检卡（契约 v2.22）：辅助非门禁——展示 正脸/光照/遮挡/清晰度 4 项人话反馈；
/// facegate 离线如实「服务未就绪」（pass=null），绝不阻断上传。
class _PrecheckCard extends StatelessWidget {
  const _PrecheckCard(
      {required this.data, required this.checking, this.onRecheck});
  final Map<String, dynamic>? data;
  final bool checking;
  final VoidCallback? onRecheck;

  static const Map<String, String> _keys = {
    'frontal': '正脸',
    'lighting': '光照',
    'occlusion': '遮挡',
    'resolution': '清晰度',
  };

  @override
  Widget build(BuildContext context) {
    if (checking) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2)),
            SizedBox(width: 8),
            Text('人像预检中…',
                style: TextStyle(fontSize: 12, color: Colors.white54)),
          ],
        ),
      );
    }
    final d = data;
    if (d == null) return const SizedBox.shrink();
    final available = d['available'] == true;
    final checks = (d['checks'] as List? ?? const []).whereType<Map>().toList();
    final msg = d['msg']?.toString() ?? '';
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: .03),
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: Colors.white10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.face_retouching_natural_outlined,
                  size: 15, color: available ? Colors.teal : Colors.white38),
              const SizedBox(width: 6),
              const Text('人像预检',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 12.5)),
              const Spacer(),
              Text(available ? '服务已就绪' : '服务未就绪',
                  style: TextStyle(
                      fontSize: 10.5,
                      color: available ? Colors.teal : Colors.white38)),
              if (onRecheck != null) ...[
                const SizedBox(width: 6),
                InkWell(
                    onTap: onRecheck,
                    child: const Icon(Icons.refresh,
                        size: 15, color: Colors.white54)),
              ],
            ],
          ),
          const SizedBox(height: 7),
          if (checks.isEmpty)
            Text(msg.isNotEmpty ? msg : '暂无法预检（不影响上传）。',
                style: const TextStyle(fontSize: 11.5, color: Colors.white54))
          else
            for (final c in checks)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 1.5),
                child: Row(
                  children: [
                    Icon(_passIcon(c['pass']), size: 14, color: _passColor(c['pass'])),
                    const SizedBox(width: 6),
                    SizedBox(
                        width: 52,
                        child: Text(_keys['${c['key']}'] ?? '${c['key']}',
                            style: const TextStyle(
                                fontSize: 11.5, color: Colors.white70))),
                    Expanded(
                        child: Text('${c['msg'] ?? ''}',
                            style: const TextStyle(
                                fontSize: 11.5,
                                color: Colors.white54,
                                height: 1.3))),
                  ],
                ),
              ),
        ],
      ),
    );
  }

  IconData _passIcon(dynamic p) {
    if (p == true) return Icons.check_circle_outline;
    if (p == false) return Icons.cancel_outlined;
    return Icons.help_outline;
  }

  Color _passColor(dynamic p) {
    if (p == true) return Colors.greenAccent;
    if (p == false) return Colors.orangeAccent;
    return Colors.white38;
  }
}
