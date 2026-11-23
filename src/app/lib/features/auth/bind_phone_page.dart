import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/state.dart';
import '../../shared/widgets/primary_button.dart';

/// 手机号绑定页（游客 → 注册）。DEV_OTP=1 时验证码固定 888888
class BindPhonePage extends ConsumerStatefulWidget {
  const BindPhonePage({super.key});

  @override
  ConsumerState<BindPhonePage> createState() => _BindPhonePageState();
}

class _BindPhonePageState extends ConsumerState<BindPhonePage> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  int _cooldown = 0;
  Timer? _timer;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _timer?.cancel();
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  bool get _phoneOk => RegExp(r'^1\d{10}$').hasMatch(_phone.text.trim());

  Future<void> _requestCode() async {
    if (!_phoneOk || _cooldown > 0) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).requestCode(_phone.text.trim());
      setState(() => _cooldown = 60);
      _timer = Timer.periodic(const Duration(seconds: 1), (t) {
        setState(() => _cooldown--);
        if (_cooldown <= 0) t.cancel();
      });
    } on ApiException catch (e) {
      setState(() => _error = e.zh);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    if (_code.text.trim().isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await ref
        .read(sessionProvider.notifier)
        .bindPhone(_phone.text.trim(), _code.text.trim());
    if (!mounted) return;
    setState(() => _busy = false);
    if (err == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('绑定成功 🎉')));
      Navigator.pop(context);
    } else {
      setState(() => _error = err);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('绑定手机号')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('绑定手机号后，换设备也能找回你的作品与积分',
              style: TextStyle(color: Colors.white70)),
          const SizedBox(height: 24),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            maxLength: 11,
            decoration: const InputDecoration(
              labelText: '手机号',
              counterText: '',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  decoration: const InputDecoration(
                    labelText: '验证码',
                    counterText: '',
                    border: OutlineInputBorder(),
                    helperText: '开发环境验证码固定为 888888',
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                width: 110,
                height: 48,
                child: OutlinedButton(
                  onPressed:
                      (_phoneOk && _cooldown == 0 && !_busy) ? _requestCode : null,
                  child: Text(_cooldown > 0 ? '${_cooldown}s' : '获取验证码',
                      style: const TextStyle(fontSize: 13)),
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.orangeAccent)),
          ],
          const SizedBox(height: 26),
          PrimaryButton(
            text: '绑定',
            big: true,
            icon: Icons.verified_outlined,
            loading: _busy,
            onPressed: (_phoneOk && !_busy) ? _verify : null,
          ),
        ],
      ),
    );
  }
}
