import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import 'creation_ui.dart';
import 'intent_flow_page.dart';

/// 「我的 → 复刻偏好 → 用这个风格再写一首」的预置位：偏好页把谱塞进来，
/// 本档 initState 时直接进谱面阶段（跳过来源选择），不让用户重走一遍。
final replicaPresetProvider = StateProvider<ReplicaProfile?>((ref) => null);

/// 复刻档（tier=4，契约 v5.7）：来源 → 分析 → 复刻谱卡 → 自由反馈 → 意图卡收敛 → 出歌。
///
/// 纪律：
///  ① 谱面特征词全部来自服务端 catalog 下发，端侧不造词（v5.7.5/6 的端侧镜像）；
///  ② `bpmEst` 是推断值，UI 恒标「估」；`degraded=true` 必须明说走了降级归纳（v5.7.10）；
///  ③ 收敛与出歌复用 [IntentFlowPanel] 全链 —— 本档不自带第二套确认/派单 UI（v5.7.7）；
///  ④ 联网搜索只交歌名给服务端，App 从不直连外部引擎（架构红线）；web 返回的
///     `artist_blocked` 话术原样展示，端侧不改写（v5.5.6 同口径）。
class ShellReplica extends ConsumerStatefulWidget {
  const ShellReplica({super.key, this.keyboardOpen});

  final bool? keyboardOpen;

  @override
  ConsumerState<ShellReplica> createState() => _ShellReplicaState();
}

class _ShellReplicaState extends ConsumerState<ShellReplica> {
  String _phase = 'source'; // source | analyzing | profile | converge
  bool _busy = false;
  String? _error;
  final _queryCtrl = TextEditingController();
  final _feedbackCtrl = TextEditingController();
  String? _jobId;
  Timer? _poll;
  int _pollTries = 0;
  ReplicaProfile? _profile;
  String? _intentId;

  @override
  void initState() {
    super.initState();
    final preset = ref.read(replicaPresetProvider);
    if (preset != null) {
      _profile = preset;
      _phase = 'profile';
      // 清预置位必须在 postFrame：initState 期间改 provider 会被 Riverpod 拒绝
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(replicaPresetProvider.notifier).state = null;
      });
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    _queryCtrl.dispose();
    _feedbackCtrl.dispose();
    super.dispose();
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _phase = _jobId == null ? 'source' : 'analyzing';
      _error = msg;
    });
  }

  // —— 来源①：曲库选歌（work 源仅本人作品，服务端 ownWork 校验）——
  Future<void> _pickFromLibrary() async {
    setState(() {
      _error = null;
      _busy = true;
    });
    try {
      final work = await _pickWorkSheet();
      if (!mounted) return;
      if (work == null) {
        setState(() => _busy = false);
        return;
      }
      final resp = await ref
          .read(apiClientProvider)
          .replicaAnalyze(kind: 'work', ref: work.id, title: work.title);
      _startPolling('${resp['job_id']}');
    } catch (e) {
      _fail(e.toString());
    }
  }

  // —— 来源②：联网搜歌名（web 源同步归纳；服务端只搜文字，永不下载音频）——
  Future<void> _analyzeWeb() async {
    final q = _queryCtrl.text.trim();
    if (q.isEmpty) {
      setState(() => _error = '先填一个歌名或一句描述');
      return;
    }
    setState(() {
      _error = null;
      _busy = true;
    });
    try {
      final resp = await ref
          .read(apiClientProvider)
          .replicaAnalyze(kind: 'web', query: q, title: q);
      final profile = resp['profile'];
      if (profile is Map) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _profile = ReplicaProfile.fromMap(profile);
          _phase = 'profile';
        });
        return;
      }
      // ok:false：无源 / 没搜到 / 歌手名拦截 —— reason 都是人话，原样给出路
      _fail('${resp['reason'] ?? '这次没能归纳出可用的风格特征'}');
    } catch (e) {
      _fail(e.toString());
    }
  }

  // —— 分析轮询：done → 按 job_id 反查谱；failed → 如实给原因 ——
  void _startPolling(String jobId) {
    setState(() {
      _busy = false;
      _phase = 'analyzing';
      _jobId = jobId;
      _pollTries = 0;
      _error = null;
    });
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(milliseconds: 1200), (t) async {
      _pollTries++;
      if (_pollTries > 260) {
        t.cancel();
        _fail('分析超时了，请稍后重试');
        return;
      }
      try {
        final job = await ref.read(apiClientProvider).job(jobId);
        if (job.isDone) {
          t.cancel();
          final items =
              await ref.read(apiClientProvider).replicaProfiles(jobId: jobId);
          if (!mounted) return;
          if (items.isEmpty) {
            _fail(job.note?.isNotEmpty == true
                ? job.note!
                : '没能从参考内容归纳出风格特征');
            return;
          }
          setState(() {
            _profile = items.first;
            _phase = 'profile';
            _error = null;
          });
        } else if (job.isFailed) {
          t.cancel();
          _fail(job.note?.isNotEmpty == true
              ? job.note!
              : '分析失败了，请换一个来源重试');
        }
      } catch (_) {
        // 网络抖动：继续等，超时上限兜底
      }
    });
  }

  // —— 反馈 → 预填意图卡 → 收敛（复用 IntentFlowPanel 全链）——
  Future<void> _startCreate() async {
    final profile = _profile;
    if (profile == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final text =
          _feedbackCtrl.text.trim().isEmpty ? '照这份风格画像创作' : _feedbackCtrl.text.trim();
      final iid =
          await ref.read(apiClientProvider).replicaFeedback(profile.id, text);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _intentId = iid;
        _phase = 'converge';
      });
    } catch (e) {
      _fail(e.toString());
    }
  }

  void _backToSource() {
    _poll?.cancel();
    setState(() {
      _phase = 'source';
      _jobId = null;
      _profile = null;
      _intentId = null;
      _error = null;
    });
  }

  Future<Work?> _pickWorkSheet() async {
    final api = ref.read(apiClientProvider);
    List<Work>? works;
    String? loadError;
    try {
      (works, _) = await api.works(mine: true);
    } catch (e) {
      loadError = e.toString();
    }
    if (!mounted) return null;
    return showModalBottomSheet<Work>(
      context: context,
      backgroundColor: CreationPalette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => SafeArea(
        child: works == null
            ? Padding(
                padding: const EdgeInsets.all(20),
                child: Text('曲库暂时打不开（$loadError）',
                    style: const TextStyle(color: CreationPalette.muted)),
              )
            : ListView(
                shrinkWrap: true,
                children: [
                  const Padding(
                    padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
                    child: Text('选一首你自己的作品',
                        style: TextStyle(
                            color: CreationPalette.text,
                            fontSize: 15,
                            fontWeight: FontWeight.w800)),
                  ),
                  if (works.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(20),
                      child: Text(
                          '曲库还是空的 —— 先用别的档位写一首，或者用下面的「搜歌名」分析喜欢的歌。',
                          style: TextStyle(
                              color: CreationPalette.muted, height: 1.5)),
                    )
                  else
                    for (final w in works)
                      ListTile(
                        leading: const Icon(Icons.music_note_rounded,
                            color: CreationPalette.cyan, size: 20),
                        title: Text(w.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: CreationPalette.text, fontSize: 14)),
                        subtitle: w.durationSec > 0
                            ? Text('${w.durationSec.round()}s',
                                style: const TextStyle(
                                    color: CreationPalette.faint,
                                    fontSize: 11))
                            : null,
                        onTap: () => Navigator.pop(ctx, w),
                      ),
                  const SizedBox(height: 8),
                ],
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 12),
      child: switch (_phase) {
        'analyzing' => _AnalyzingView(
            note: '正在分析这首歌的风格…',
            onCancel: _backToSource,
          ),
        'profile' => _ProfileView(
            profile: _profile!,
            feedbackCtrl: _feedbackCtrl,
            busy: _busy,
            error: _error,
            onStart: _startCreate,
            onChangeSource: _backToSource,
          ),
        'converge' => IntentFlowPanel(
            intentId: _intentId!,
            easy: false,
          ),
        _ => _SourceView(
            queryCtrl: _queryCtrl,
            busy: _busy,
            error: _error,
            onPickLibrary: _pickFromLibrary,
            onSearch: _analyzeWeb,
          ),
      },
    );
  }
}

// ———————— 来源选择 ————————
class _SourceView extends StatelessWidget {
  const _SourceView({
    required this.queryCtrl,
    required this.busy,
    required this.error,
    required this.onPickLibrary,
    required this.onSearch,
  });

  final TextEditingController queryCtrl;
  final bool busy;
  final String? error;
  final VoidCallback onPickLibrary;
  final VoidCallback onSearch;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      children: [
        const CreationSectionLabel('选一首你喜欢的歌'),
        _SourceCard(
          icon: Icons.library_music_rounded,
          color: CreationPalette.cyan,
          title: '从曲库选',
          subtitle: '用你自己的作品做风格参考，分析最快最准',
          enabled: !busy,
          onTap: onPickLibrary,
        ),
        const SizedBox(height: 10),
        _SourceCard(
          icon: Icons.travel_explore_rounded,
          color: CreationPalette.blue,
          title: '搜歌名',
          subtitle: '按公开资料归纳风格特征（不下载、不使用音频本身）',
          enabled: !busy,
          onTap: onSearch,
        ),
        const SizedBox(height: 10),
        TextField(
          controller: queryCtrl,
          maxLines: 1,
          maxLength: 120,
          style: const TextStyle(color: CreationPalette.text, fontSize: 14),
          decoration: creationFieldDecoration(
              hint: '歌名或一句话描述，例如：90 年代的 city pop'),
          onSubmitted: (_) => onSearch(),
        ),
        if (error != null) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: CreationPalette.field,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: CreationPalette.amber.withValues(alpha: .4)),
            ),
            child: Text(
              error!,
              style: const TextStyle(
                  color: CreationPalette.muted, fontSize: 12.5, height: 1.5),
            ),
          ),
        ],
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: CreationPalette.field,
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Text(
            '只学风格，不学身份：我不会提取任何歌手的声纹，也不会复制原曲的旋律和歌词 —— '
            '出来的是一首全新的歌，带着它那个味儿。',
            style: TextStyle(
                color: CreationPalette.faint, fontSize: 11.5, height: 1.6),
          ),
        ),
      ],
    );
  }
}

class _SourceCard extends StatelessWidget {
  const _SourceCard({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.enabled,
    required this.onTap,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: enabled,
      hint: enabled ? null : '正在分析中，请稍等',
      label: '$title：$subtitle',
      child: Opacity(
        opacity: enabled ? 1 : .55,
        child: Material(
          color: CreationPalette.surface,
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: enabled ? onTap : null,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: .14),
                      border: Border.all(color: color.withValues(alpha: .3)),
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: Icon(icon, color: color, size: 20),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title,
                            style: const TextStyle(
                                color: CreationPalette.text,
                                fontSize: 14.5,
                                fontWeight: FontWeight.w800)),
                        const SizedBox(height: 3),
                        Text(subtitle,
                            style: const TextStyle(
                                color: CreationPalette.faint,
                                fontSize: 11.5,
                                height: 1.4)),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right_rounded,
                      color: CreationPalette.faint, size: 20),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ———————— 分析中 ————————
class _AnalyzingView extends StatelessWidget {
  const _AnalyzingView({required this.note, required this.onCancel});

  final String note;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 40,
            height: 40,
            child: CircularProgressIndicator(strokeWidth: 2.4),
          ),
          const SizedBox(height: 16),
          Text(note,
              style: const TextStyle(
                  color: CreationPalette.muted, fontSize: 13)),
          const SizedBox(height: 6),
          const Text('整首歌的分析会花上一点时间',
              style: TextStyle(color: CreationPalette.faint, fontSize: 11.5)),
          const SizedBox(height: 16),
          Semantics(
            button: true,
            label: '取消分析，换一个来源',
            child: TextButton(
              onPressed: onCancel,
              child: const Text('换一个来源',
                  style: TextStyle(color: CreationPalette.faint)),
            ),
          ),
        ],
      ),
    );
  }
}

// ———————— 复刻谱卡 + 反馈 ————————
class _ProfileView extends StatelessWidget {
  const _ProfileView({
    required this.profile,
    required this.feedbackCtrl,
    required this.busy,
    required this.error,
    required this.onStart,
    required this.onChangeSource,
  });

  final ReplicaProfile profile;
  final TextEditingController feedbackCtrl;
  final bool busy;
  final String? error;
  final VoidCallback onStart;
  final VoidCallback onChangeSource;

  String get _sourceLine => switch (profile.sourceKind) {
        'work' => '来自你的作品《${profile.title}》',
        'web' => '来自对「${profile.title}」的公开资料分析',
        _ => '来自上传的参考曲《${profile.title}》',
      };

  @override
  Widget build(BuildContext context) {
    final p = profile;
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      children: [
        CreationSectionLabel('风格画像', trailing: '把握 ${(p.confidence * 100).round()}%'),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: CreationPalette.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: CreationPalette.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_sourceLine,
                  style: const TextStyle(
                      color: CreationPalette.faint, fontSize: 11.5)),
              const SizedBox(height: 10),
              if (p.degraded)
                Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: CreationPalette.field,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                        color: CreationPalette.amber.withValues(alpha: .4)),
                  ),
                  child: const Text(
                    '这次走的是降级归纳（理解服务没走通），特征来自元数据与词典 —— 结果照常能用，但可能不如平时准。',
                    style: TextStyle(
                        color: CreationPalette.muted,
                        fontSize: 11.5,
                        height: 1.5),
                  ),
                ),
              if (!p.hasFeatures && p.summary.isEmpty)
                const Text('这份画像没有可展示的特征 —— 回去换一个来源吧。',
                    style: TextStyle(
                        color: CreationPalette.muted, fontSize: 12.5)),
              if (p.moods.isNotEmpty)
                _featureRow('心情', p.moods, CreationPalette.amber),
              if (p.genres.isNotEmpty)
                _featureRow('曲风', p.genres, CreationPalette.green),
              if (p.styleWords.isNotEmpty)
                _featureRow('质感', p.styleWords, CreationPalette.blue),
              if (p.voice.isNotEmpty)
                _featureRow('谁来唱', p.voice, CreationPalette.violetBright),
              if (p.bpmEst != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'BPM 约 ${p.bpmEst}（估）—— 生成前可以改',
                    style: const TextStyle(
                        color: CreationPalette.faint, fontSize: 11.5),
                  ),
                ),
              if (p.summary.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(p.summary,
                    style: const TextStyle(
                        color: CreationPalette.muted,
                        fontSize: 12.5,
                        height: 1.55)),
              ],
            ],
          ),
        ),
        const SizedBox(height: 14),
        const CreationSectionLabel('想改什么，直接说'),
        TextField(
          controller: feedbackCtrl,
          maxLines: 2,
          maxLength: 500,
          style: const TextStyle(color: CreationPalette.text, fontSize: 14),
          decoration: creationFieldDecoration(
              hint: '可不填。例如：副歌别太吵，人声再近一点',
              dense: true),
        ),
        if (error != null) ...[
          const SizedBox(height: 10),
          Text(error!,
              style: const TextStyle(
                  color: CreationPalette.amber, fontSize: 12, height: 1.5)),
        ],
        const SizedBox(height: 14),
        Semantics(
          button: true,
          label: '按这份风格画像开始创作',
          child: PrimaryButton(
            text: '按这个风格写一首新的',
            big: true,
            gradient: true,
            icon: Icons.auto_awesome_rounded,
            loading: busy,
            onPressed: busy ? null : onStart,
          ),
        ),
        const SizedBox(height: 8),
        Center(
          child: Semantics(
            button: true,
            label: '换一首参考歌',
            child: TextButton(
              onPressed: onChangeSource,
              child: const Text('换一首参考歌',
                  style: TextStyle(color: CreationPalette.faint)),
            ),
          ),
        ),
        const SizedBox(height: 12),
      ],
    );
  }

  Widget _featureRow(String label, List<String> words, Color color) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 52,
            child: Text(label,
                style: const TextStyle(
                    color: CreationPalette.faint, fontSize: 11.5)),
          ),
          Expanded(
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final w in words)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: .12),
                      border: Border.all(color: color.withValues(alpha: .3)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(w,
                        style: TextStyle(
                            color: color,
                            fontSize: 12,
                            fontWeight: FontWeight.w700)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
