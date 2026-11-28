import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';
import '../create/creation_state.dart';
import '../create/creation_ui.dart';
import '../create/shell_replica.dart';
import 'tier_config.dart';

/// 我的 → 复刻偏好（契约 v5.7.9 主权条目）：谱列表可见可删，「用这个风格再写一首」
/// 把谱塞进 [replicaPresetProvider] + 请求跳回创建页复刻档 —— 跳转走请求位
/// （[replicaJumpRequestProvider]），不开放任意 tab 索引（与伴创跳转同一纪律）。
class ReplicaProfilesPage extends ConsumerStatefulWidget {
  const ReplicaProfilesPage({super.key});

  @override
  ConsumerState<ReplicaProfilesPage> createState() =>
      _ReplicaProfilesPageState();
}

class _ReplicaProfilesPageState extends ConsumerState<ReplicaProfilesPage> {
  List<ReplicaProfile>? _items;
  String? _error;
  String? _deleting;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _error = null;
    });
    try {
      final items = await ref.read(apiClientProvider).replicaProfiles();
      if (!mounted) return;
      setState(() => _items = items);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _delete(ReplicaProfile p) async {
    setState(() => _deleting = p.id);
    try {
      await ref.read(apiClientProvider).replicaProfileDelete(p.id);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('删不掉：$e')));
    } finally {
      if (mounted) setState(() => _deleting = null);
    }
  }

  void _reuse(ReplicaProfile p) {
    // 删谱不删作品（v5.7.9）；复用谱是纯端侧动作：预置 + 跳档。
    ref.read(replicaPresetProvider.notifier).state = p;
    ref.read(creationProvider.notifier).setTier(CreationTiers.tierReplica);
    ref.read(replicaJumpRequestProvider.notifier).state++;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: CreationPalette.background,
      appBar: AppBar(
        backgroundColor: CreationPalette.background,
        foregroundColor: CreationPalette.text,
        elevation: 0,
        title: const Text('复刻偏好',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
      ),
      body: RefreshIndicator(
        color: CreationPalette.cyan,
        onRefresh: _load,
        child: items == null && _error == null
            ? const Center(
                child: CircularProgressIndicator(strokeWidth: 2.4))
            : ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(20),
                children: [
                  if (_error != null)
                    Text('列表打不开：$_error',
                        style: const TextStyle(
                            color: CreationPalette.amber, fontSize: 12.5)),
                  if (items != null && items.isEmpty) ...[
                    const SizedBox(height: 40),
                    const Icon(Icons.content_copy_rounded,
                        color: CreationPalette.faint, size: 40),
                    const SizedBox(height: 12),
                    const Center(
                      child: Text(
                        '还没有复刻谱。去创建页的「复刻」档，挑一首喜欢的歌，'
                        '它会把风格学成一份画像存在这里。',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            color: CreationPalette.muted,
                            fontSize: 13,
                            height: 1.6),
                      ),
                    ),
                    const SizedBox(height: 20),
                    Center(
                      child: Semantics(
                        button: true,
                        label: '去创建页复刻档新建画像',
                        child: PrimaryButton(
                          text: '去新建一份',
                          big: false,
                          gradient: true,
                          onPressed: () {
                            ref
                                .read(creationProvider.notifier)
                                .setTier(CreationTiers.tierReplica);
                            ref
                                .read(replicaJumpRequestProvider.notifier)
                                .state++;
                            Navigator.of(context).pop();
                          },
                        ),
                      ),
                    ),
                  ],
                  for (final p in (items ?? const <ReplicaProfile>[]))
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: _ProfileTile(
                        profile: p,
                        deleting: _deleting == p.id,
                        onDelete: () => _delete(p),
                        onReuse: () => _reuse(p),
                      ),
                    ),
                  if (items != null && items.isNotEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text(
                        '删除画像不会影响已经写出来的歌（歌上的「复刻自」标注保留）。',
                        style: TextStyle(
                            color: CreationPalette.faint,
                            fontSize: 11.5,
                            height: 1.5),
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}

class _ProfileTile extends StatelessWidget {
  const _ProfileTile({
    required this.profile,
    required this.deleting,
    required this.onDelete,
    required this.onReuse,
  });

  final ReplicaProfile profile;
  final bool deleting;
  final VoidCallback onDelete;
  final VoidCallback onReuse;

  @override
  Widget build(BuildContext context) {
    final p = profile;
    final words = [...p.moods, ...p.genres, ...p.styleWords, ...p.voice];
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: CreationPalette.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: CreationPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  p.title.isEmpty ? '未命名画像' : p.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: CreationPalette.text,
                      fontSize: 14,
                      fontWeight: FontWeight.w800),
                ),
              ),
              if (p.degraded)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: CreationPalette.field,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(
                        color: CreationPalette.amber.withValues(alpha: .4)),
                  ),
                  child: const Text('降级归纳',
                      style: TextStyle(
                          color: CreationPalette.amber, fontSize: 10)),
                ),
              const SizedBox(width: 6),
              Semantics(
                button: true,
                label: '删除画像 ${p.title}',
                child: SizedBox(
                  width: 32,
                  height: 32,
                  child: deleting
                      ? const Padding(
                          padding: EdgeInsets.all(8),
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : IconButton(
                          padding: EdgeInsets.zero,
                          iconSize: 18,
                          onPressed: onDelete,
                          icon: const Icon(Icons.delete_outline_rounded,
                              color: CreationPalette.faint),
                        ),
                ),
              ),
            ],
          ),
          if (words.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final w in words.take(8))
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: CreationPalette.field,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(w,
                        style: const TextStyle(
                            color: CreationPalette.muted, fontSize: 11.5)),
                  ),
                if (p.bpmEst != null)
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: CreationPalette.field,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text('BPM 约 ${p.bpmEst}（估）',
                        style: const TextStyle(
                            color: CreationPalette.muted, fontSize: 11.5)),
                  ),
              ],
            ),
          ],
          if (p.summary.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(p.summary,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    color: CreationPalette.faint,
                    fontSize: 11.5,
                    height: 1.5)),
          ],
          const SizedBox(height: 10),
          SizedBox(
            height: 34,
            child: Semantics(
              button: true,
              label: '用这个风格再写一首',
              child: PrimaryButton(
                text: '用这个风格再写一首',
                big: false,
                expand: true,
                onPressed: onReuse,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
