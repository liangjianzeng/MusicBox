import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../persona/persona_page.dart';
import '../creation/replica_profiles_page.dart';
import '../creation/tier_config.dart';

import '../../core/api_client.dart';
import '../../core/server_url_editor.dart';
import '../../core/state.dart';
import '../../shared/widgets/consent.dart';
import '../assistant/assistant_models.dart';
import '../assistant/assistant_state.dart';
import '../assistant/assistant_surface.dart';
import '../auth/bind_phone_page.dart';
import 'speech_settings_page.dart';

/// 我的：积分余额+每日额度 / 流水 / 服务器地址 / 清缓存 / 关于+隐私条款
class MePage extends ConsumerWidget {
  const MePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final cfg = ref.watch(configProvider);
    final assistant = ref.watch(assistantProvider);
    final rc = ref.watch(remoteConfigProvider);
    final assistantVisible = rc?.assistantCore != false && assistant.available;
    final user = session.user;
    final credits = session.credits;
    final quota = credits?.dailyQuota ?? 50;
    final used = credits?.dailyUsed ?? 0;
    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // 身份被换掉的告知横幅（2026-11-27 真机 P0）。
          // 规矩：登录态失效后若服务器把本机当"新账号"，必须**说人话告诉用户**：
          // 内容不是被删了，是不在当前账号下 —— 沉默地展示一个空曲库，
          // 用户只会以为产品把他的东西弄丢了（真实原话「重装覆盖不能保存本地内容？？？？？？？？？？」）。
          // 不在界面上显示 device_key：它是恢复凭证，截图外传等于把账号交出去。
          if (session.identityReset)
            Card(
              margin: const EdgeInsets.only(bottom: 12),
              color: Theme.of(context).colorScheme.errorContainer,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Row(children: [
                      Icon(Icons.error_outline, size: 18),
                      SizedBox(width: 6),
                      Text('本机内容属于另一个身份，未能恢复',
                          style: TextStyle(fontWeight: FontWeight.w700)),
                    ]),
                    const SizedBox(height: 6),
                    Text(
                      '登录状态失效后，服务器没有认回这台设备原来的账号，而是当成了新账号。'
                      '之前的作品没有被删除，只是不在当前账号下。'
                      '先别在这个号上生成重要内容；可重试登录，或绑定手机号让身份不再依赖本机。',
                      style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(context).colorScheme.onErrorContainer),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        TextButton(
                          onPressed: () => ref
                              .read(sessionProvider.notifier)
                              .guestLogin(),
                          child: const Text('重试登录'),
                        ),
                        TextButton(
                          onPressed: () => ref
                              .read(sessionProvider.notifier)
                              .acknowledgeIdentityReset(),
                          child: const Text('我知道了'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          // 身份备份 / 恢复（契约 v5.6.0）：游客号必须能被**本人**恢复，
          // 而不是重装后靠运维手工 UPDATE guest_key（2026-11-27 真机就是这么救回来的）。
          const _IdentityBackupCard(),
          // 用户卡片
          Card(
            margin: EdgeInsets.zero,
            child: ListTile(
              leading: CircleAvatar(
                radius: 22,
                backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                child: Text((user?.nickname ?? '旅').characters.first,
                    style: TextStyle(
                        fontSize: 18,
                        color:
                            Theme.of(context).colorScheme.onPrimaryContainer)),
              ),
              title: Text(user?.nickname ?? '…'),
              subtitle: Text(user == null
                  ? ''
                  : (user.isGuest
                      ? '游客（手机号绑定后可换设备使用）'
                      : '已登录 ${user.phoneMasked ?? ''}')),
              trailing: (user?.isGuest ?? false)
                  ? TextButton(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute(
                            builder: (_) => const BindPhonePage()),
                      ),
                      child: const Text('绑定手机'),
                    )
                  : null,
            ),
          ),
          const SizedBox(height: 12),
          // 积分
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('积分',
                      style: TextStyle(
                          fontWeight: FontWeight.w700, color: Colors.white70)),
                  const SizedBox(height: 6),
                  Text('${credits?.balance ?? '--'}',
                      style: const TextStyle(
                          fontSize: 36, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text('每日免费额度 $quota · 今日已用 $used',
                      style:
                          const TextStyle(fontSize: 12, color: Colors.white54)),
                  const SizedBox(height: 8),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                        value: quota == 0 ? 0 : (used / quota).clamp(0, 1),
                        minHeight: 6),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: () =>
                          ref.read(sessionProvider.notifier).refreshCredits(),
                      child: const Text('刷新'),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          // 流水（本次会话，由 WSS credit.delta 实时记录）
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('积分流水（本次会话）',
                      style: TextStyle(
                          fontWeight: FontWeight.w700, color: Colors.white70)),
                  const SizedBox(height: 8),
                  if (session.ledger.isEmpty)
                    const Text('暂无记录，去生成一首歌试试',
                        style: TextStyle(fontSize: 12, color: Colors.white38))
                  else
                    ...session.ledger.reversed.map((e) => Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              Text(
                                  '${e.time.hour.toString().padLeft(2, '0')}:${e.time.minute.toString().padLeft(2, '0')}',
                                  style: const TextStyle(
                                      fontSize: 11, color: Colors.white38)),
                              const SizedBox(width: 10),
                              Expanded(
                                  child: Text(e.note,
                                      style: const TextStyle(fontSize: 13))),
                              Text(
                                '${e.delta >= 0 ? '+' : ''}${e.delta}',
                                style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w700,
                                    color: e.delta >= 0
                                        ? Colors.greenAccent
                                        : Colors.orangeAccent),
                              ),
                              const SizedBox(width: 8),
                              Text('余额 ${e.balanceAfter}',
                                  style: const TextStyle(
                                      fontSize: 11, color: Colors.white38)),
                            ],
                          ),
                        )),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          // 设置项
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                if (assistantVisible) ...[
                  ListTile(
                    leading: const Icon(Icons.auto_awesome_outlined),
                    title: const Text('创作助手'),
                    subtitle: const Text('带着当前页面上下文对话',
                        style: TextStyle(fontSize: 12)),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => _openAssistant(context, ref),
                  ),
                  ListTile(
                    leading: const Icon(Icons.fact_check_outlined),
                    title: const Text('任务与确认'),
                    subtitle: const Text('查看创作任务和待确认操作',
                        style: TextStyle(fontSize: 12)),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => _openAssistant(context, ref, tasks: true),
                  ),
                ],
                ListTile(
                  leading: const Icon(Icons.dns_outlined),
                  title: const Text('服务器地址'),
                  subtitle: Text(cfg.baseUrl,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _editServer(context, ref),
                ),
                ListTile(
                  leading: const Icon(Icons.record_voice_over_outlined),
                  title: const Text('声音与人格'),
                  subtitle: const Text('我的声音人格与试听，翻唱用的声线在这里管理',
                      style: TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right),
                  // 伴创灰度命中时底部第 4 槽位由「人格」换成「伴创」（D-3，恒 5 tab）。
                  // 人格必须在这里留一个入口 —— 只换 tab 不在这里补入口，人格页就成了进不去的孤儿页。
                  // 这两处必须同批发布。
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => const PersonaPage())),
                ),
                ListTile(
                  leading: const Icon(Icons.content_copy_rounded),
                  title: const Text('复刻偏好'),
                  subtitle: const Text('学过的风格画像都在这里，可删、可随时再用',
                      style: TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right),
                  // 契约 v5.7.9：复刻谱主权页。灰度未开时入口也收起来 ——
                  // 否则点进去只会看到「列表打不开」，比没有还差。
                  onTap: replicaEnabledOf(ref.watch(remoteConfigProvider))
                      ? () => Navigator.of(context).push(MaterialPageRoute(
                          builder: (_) => const ReplicaProfilesPage()))
                      : null,
                ),
                ListTile(
                  leading: const Icon(Icons.memory_outlined),
                  title: const Text('创作模型'),
                  subtitle: Text(_musicModelLabel(ref),
                      style: const TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _chooseMusicModel(context, ref),
                ),
                ListTile(
                  leading: const Icon(Icons.mic_external_on_outlined),
                  title: const Text('语音能力'),
                  subtitle: const Text('本机识别 / 朗读、模型下载与自检',
                      style: TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => const SpeechSettingsPage()),
                  ),
                ),
                ListTile(
                  leading: const Icon(Icons.cleaning_services_outlined),
                  title: const Text('清除缓存'),
                  subtitle: const Text('清理作品离线缓存（不影响云端作品）',
                      style: TextStyle(fontSize: 12)),
                  onTap: () async {
                    await ref.read(localDbProvider).clearCache();
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context)
                        .showSnackBar(const SnackBar(content: Text('缓存已清除')));
                  },
                ),
                ListTile(
                  leading: const Icon(Icons.info_outline),
                  title: const Text('关于与隐私'),
                  subtitle: const Text('语音/图像用途限定：仅本次生成使用，72h 自动删除，不用于训练',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12)),
                  onTap: () => showDialog<void>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: const Text('关于 MusicBox'),
                      content: const SingleChildScrollView(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('MusicBox v0.1.0（M0/M1）',
                                style: TextStyle(fontWeight: FontWeight.w700)),
                            SizedBox(height: 8),
                            Text('云端 AI 音乐生成 · 灵感一拍即合'),
                            SizedBox(height: 12),
                            Text('隐私条款（语音/图像）',
                                style: TextStyle(fontWeight: FontWeight.w700)),
                            SizedBox(height: 4),
                            Text(kBiometricPrivacyText),
                            SizedBox(height: 8),
                            Text('AI 生成内容均带“AI 生成”标注；情绪与意图为 AI 推测，可在意图卡点改。'),
                          ],
                        ),
                      ),
                      actions: [
                        FilledButton(
                            onPressed: () => Navigator.pop(ctx),
                            child: const Text('知道了')),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          const Center(
              child: Text('MusicBox · 云端生成',
                  style: TextStyle(color: Colors.white24, fontSize: 11))),
        ],
      ),
    );
  }

  void _openAssistant(BuildContext context, WidgetRef ref,
      {bool tasks = false}) {
    ref.read(assistantContextProvider.notifier).state =
        const AssistantContext(surface: 'settings');
    if (tasks) {
      showAssistantCenter(context);
    } else {
      showGlobalAssistant(context);
    }
  }

  Future<void> _editServer(BuildContext context, WidgetRef ref) =>
      editServerUrl(context, ref);

  String _musicModelLabel(WidgetRef ref) {
    final sel = ref.watch(musicModelProvider);
    final rc = ref.watch(remoteConfigProvider);
    if (rc == null) return '跟随后台默认';
    if (rc.musicLocked) return '后台指定（已锁定）';
    if (sel == null || sel.isEmpty) return '跟随后台默认';
    final hit = rc.musicModelOptions.where((o) => '${o['id']}' == sel).toList();
    return hit.isNotEmpty ? '${hit.first['label']}' : '跟随后台默认';
  }

  Future<void> _chooseMusicModel(BuildContext context, WidgetRef ref) async {
    final rc = ref.read(remoteConfigProvider);
    if (rc == null) {
      await ref.read(remoteConfigProvider.notifier).refresh();
    }
    if (!context.mounted) return;
    final cur = ref.read(remoteConfigProvider);
    if (cur != null && cur.musicLocked) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('模型已由后台统一指定，暂不可自选')));
      return;
    }
    final options = (cur?.musicModelOptions ?? const []).toList();
    final sel = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('创作模型'),
        children: [
          RadioListTile<String>(
            title: const Text('跟随后台默认'),
            value: '',
            groupValue: ref.read(musicModelProvider) ?? '',
            onChanged: (v) => Navigator.pop(ctx, v),
          ),
          ...options.map((o) => RadioListTile<String>(
                title: Text('${o['label']}'),
                value: '${o['id']}',
                groupValue: ref.read(musicModelProvider) ?? '',
                onChanged: (v) => Navigator.pop(ctx, v),
              )),
        ],
      ),
    );
    if (sel == null) return;
    await ref.read(prefsProvider).setMusicModelId(sel.isEmpty ? null : sel);
    ref.read(musicModelProvider.notifier).state = sel.isEmpty ? null : sel;
  }
}

/// 身份备份 / 恢复（契约 v5.6.0）。
///
/// 为什么要有这张卡：游客号是匿名身份，重装/换机后用户没有任何自助办法证明"那些歌是我的"
/// —— 2026-11-27 那次是运维手工 `UPDATE users SET guest_key=…` 救回来的，那不该是产品机制。
/// 备份码等同账号凭证：**只在生成那一刻显示一次**，端侧绝不落盘（存进 prefs 等于把账号写进明文文件）。
class _IdentityBackupCard extends ConsumerStatefulWidget {
  const _IdentityBackupCard();

  @override
  ConsumerState<_IdentityBackupCard> createState() => _IdentityBackupCardState();
}

class _IdentityBackupCardState extends ConsumerState<_IdentityBackupCard> {
  final _codeCtl = TextEditingController();
  String? _issued; // 只活在本次页面会话里，离开即随 widget 销毁
  bool _busy = false;

  @override
  void dispose() {
    _codeCtl.dispose();
    super.dispose();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _rotate() async {
    setState(() => _busy = true);
    try {
      final code = await ref.read(apiClientProvider).rotateRecoveryCode();
      if (!mounted) return;
      setState(() => _issued = code);
      _toast('备份码已生成，请立刻抄下来：它只显示这一次');
    } on ApiException catch (e) {
      _toast(e.zh);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _claim() async {
    final code = _codeCtl.text.trim();
    if (code.isEmpty) {
      _toast('先输入备份码');
      return;
    }
    setState(() => _busy = true);
    try {
      // 认领只改服务端绑定；会话仍走既有的 guestLogin（同一 device_key）——
      // 复用已验证过的登录路径，比在端侧另起一套"塞 token"的实现安全。
      await ref.read(apiClientProvider).claimIdentity(code);
      if (!mounted) return;
      await ref.read(sessionProvider.notifier).guestLogin();
      if (!mounted) return;
      _codeCtl.clear();
      _toast('身份已恢复：这台设备重新认回原来的账号了');
    } on ApiException catch (e) {
      _toast(e.zh);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.shield_outlined, size: 18),
                SizedBox(width: 6),
                Text('备份身份',
                    style: TextStyle(fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 6),
            const Text(
              '游客号只有这一条恢复通道：生成备份码抄下来，换机或重装后输入它就能找回自己的歌。'
              '备份码等同账号凭证，只显示这一次；重新生成会让旧码当场作废。',
              style: TextStyle(fontSize: 12, color: Colors.white60, height: 1.5),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: _busy ? null : _rotate,
              icon: const Icon(Icons.refresh, size: 16),
              label: Text(_issued == null ? '生成备份码' : '重新生成（旧码作废）'),
            ),
            if (_issued != null) ...[
              const SizedBox(height: 10),
              SelectableText(
                _issued!,
                style: const TextStyle(
                    fontFamily: 'monospace', fontSize: 20, letterSpacing: 1.5),
              ),
            ],
            const SizedBox(height: 14),
            TextField(
              controller: _codeCtl,
              enabled: !_busy,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                isDense: true,
                labelText: '我有备份码，恢复身份',
                hintText: '例如 ABCD-EFGH-JKLM',
              ),
            ),
            const SizedBox(height: 8),
            FilledButton.tonalIcon(
              onPressed: _busy ? null : _claim,
              icon: const Icon(Icons.login, size: 16),
              label: const Text('用备份码恢复'),
            ),
          ],
        ),
      ),
    );
  }
}
