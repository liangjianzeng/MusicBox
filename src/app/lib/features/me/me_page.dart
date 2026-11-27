import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
