import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../../shared/widgets/consent.dart';
import '../auth/bind_phone_page.dart';

/// 我的：积分余额+每日额度 / 流水 / 服务器地址 / 清缓存 / 关于+隐私条款
class MePage extends ConsumerWidget {
  const MePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final cfg = ref.watch(configProvider);
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
                          fontWeight: FontWeight.w700,
                          color: Colors.white70)),
                  const SizedBox(height: 6),
                  Text('${credits?.balance ?? '--'}',
                      style: const TextStyle(
                          fontSize: 36, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text('每日免费额度 $quota · 今日已用 $used',
                      style: const TextStyle(
                          fontSize: 12, color: Colors.white54)),
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
                        style:
                            TextStyle(fontSize: 12, color: Colors.white38))
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
                  leading: const Icon(Icons.cleaning_services_outlined),
                  title: const Text('清除缓存'),
                  subtitle: const Text('清理作品离线缓存（不影响云端作品）',
                      style: TextStyle(fontSize: 12)),
                  onTap: () async {
                    await ref.read(localDbProvider).clearCache();
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('缓存已清除')));
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
                                style: TextStyle(
                                    fontWeight: FontWeight.w700)),
                            SizedBox(height: 8),
                            Text('云端 AI 音乐生成 · 灵感一拍即合'),
                            SizedBox(height: 12),
                            Text('隐私条款（语音/图像）',
                                style: TextStyle(
                                    fontWeight: FontWeight.w700)),
                            SizedBox(height: 4),
                            Text(kBiometricPrivacyText),
                            SizedBox(height: 8),
                            Text(
                                'AI 生成内容均带“AI 生成”标注；情绪与意图为 AI 推测，可在意图卡点改。'),
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

  Future<void> _editServer(BuildContext context, WidgetRef ref) async {
    final cfg = ref.read(configProvider);
    final c = TextEditingController(text: cfg.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('服务器地址'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: c,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                hintText: 'http://10.0.2.2:7900',
                helperText: '模拟器访问宿主机用 10.0.2.2；真机填局域网 IP',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, c.text.trim()),
              child: const Text('保存')),
        ],
      ),
    );
    if (url != null && url.isNotEmpty) {
      await ref.read(configProvider.notifier).setBaseUrl(url);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('服务器地址已更新')));
    }
  }
}
