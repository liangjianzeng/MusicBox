import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../../root_shell.dart';
import 'bind_phone_page.dart';

/// 游客静默登录门禁：启动即用 SharedPreferences token / 静默游客登录
class SessionGate extends ConsumerStatefulWidget {
  const SessionGate({super.key});

  @override
  ConsumerState<SessionGate> createState() => _SessionGateState();
}

class _SessionGateState extends ConsumerState<SessionGate> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(sessionProvider.notifier).bootstrap();
    });
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    switch (session.status) {
      case SessionStatus.loading:
        return const _SplashPage();
      case SessionStatus.failed:
        return _RetryPage(error: session.error ?? '连接失败');
      case SessionStatus.ready:
        return const RootShell();
    }
  }
}

class _SplashPage extends StatelessWidget {
  const _SplashPage();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('🎵', style: TextStyle(fontSize: 56)),
            SizedBox(height: 12),
            Text('MusicBox',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
            SizedBox(height: 6),
            Text('让灵感即刻成曲', style: TextStyle(color: Colors.white54)),
            SizedBox(height: 24),
            SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2)),
          ],
        ),
      ),
    );
  }
}

/// 登录失败重试页：不白屏，可改服务器地址
class _RetryPage extends ConsumerStatefulWidget {
  const _RetryPage({required this.error});
  final String error;

  @override
  ConsumerState<_RetryPage> createState() => _RetryPageState();
}

class _RetryPageState extends ConsumerState<_RetryPage> {
  bool _retrying = false;

  Future<void> _retry() async {
    setState(() => _retrying = true);
    await ref.read(sessionProvider.notifier).guestLogin();
    if (mounted) setState(() => _retrying = false);
  }

  Future<void> _editServer() async {
    final cfg = ref.read(configProvider);
    final controller = TextEditingController(text: cfg.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('服务器地址'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            hintText: 'http://服务器地址:端口',
            helperText: '调试后门：修改后自动重新登录（默认地址由打包注入）',
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text.trim()),
              child: const Text('保存')),
        ],
      ),
    );
    if (url != null && url.isNotEmpty) {
      await ref.read(configProvider.notifier).setBaseUrl(url);
      await ref.read(sessionProvider.notifier).guestLogin();
    }
  }

  @override
  Widget build(BuildContext context) {
    final cfg = ref.watch(configProvider);
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('📡', style: TextStyle(fontSize: 48)),
              const SizedBox(height: 16),
              const Text('连不上服务器',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text('${widget.error}\n当前地址：${cfg.baseUrl}',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white54)),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _retrying ? null : _retry,
                  icon: _retrying
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.refresh),
                  label: const Text('重试'),
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _editServer,
                icon: const Icon(Icons.dns_outlined),
                label: const Text('服务器设置'),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const BindPhonePage()),
                ),
                child: const Text('已有账号？绑定手机号',
                    style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
