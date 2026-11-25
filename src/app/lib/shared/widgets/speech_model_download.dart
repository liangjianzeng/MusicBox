import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/speech/speech_model_manager.dart';

enum SpeechModelPreparation {
  ready,
  serverFallback,
  canceled,
}

typedef SpeechModelDownloader = Future<void> Function(CancelToken? cancelToken);

Future<SpeechModelPreparation> prepareSpeechModel(
  BuildContext context, {
  required SpeechModel model,
  required bool allowServerFallback,
  SpeechModelDownloader? download,
}) async {
  final spec = SpeechModelManager.specOf(model);
  final choice = await showDialog<_DownloadChoice>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('首次使用本机识别'),
      content: Text(
        '需要下载「${spec.capability}」模型，约 ${_mb(spec.totalBytes)}。'
        '建议使用 Wi-Fi；下载完成后再按住说话。',
      ),
      actions: [
        if (allowServerFallback)
          TextButton(
            onPressed: () => Navigator.pop(context, _DownloadChoice.server),
            child: const Text('下次用服务端'),
          ),
        TextButton(
          onPressed: () => Navigator.pop(context, _DownloadChoice.cancel),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, _DownloadChoice.download),
          child: const Text('下载模型'),
        ),
      ],
    ),
  );
  if (choice == _DownloadChoice.server) {
    return SpeechModelPreparation.serverFallback;
  }
  if (choice != _DownloadChoice.download || !context.mounted) {
    return SpeechModelPreparation.canceled;
  }

  final ready = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (context) => _SpeechModelDownloadDialog(
      model: model,
      download: download ??
          (token) => SpeechModelManager.ensure(model, cancelToken: token),
    ),
  );
  return ready == true
      ? SpeechModelPreparation.ready
      : SpeechModelPreparation.canceled;
}

enum _DownloadChoice { download, server, cancel }

class _SpeechModelDownloadDialog extends StatefulWidget {
  const _SpeechModelDownloadDialog({
    required this.model,
    required this.download,
  });

  final SpeechModel model;
  final SpeechModelDownloader download;

  @override
  State<_SpeechModelDownloadDialog> createState() =>
      _SpeechModelDownloadDialogState();
}

class _SpeechModelDownloadDialogState
    extends State<_SpeechModelDownloadDialog> {
  StreamSubscription<SpeechProgressEvent>? _sub;
  CancelToken? _token;
  bool _busy = true;
  bool _cancelRequested = false;
  bool _closing = false;
  double? _fraction;
  String? _error;

  @override
  void initState() {
    super.initState();
    _sub = SpeechModelManager.updates.listen((event) {
      if (!mounted || event.model != widget.model) return;
      setState(() {
        if (event.phase == 'progress') _fraction = event.fileFraction;
        if (event.phase == 'done') _fraction = 1;
      });
    });
    _run();
  }

  Future<void> _run() async {
    final token = CancelToken();
    if (mounted) {
      setState(() {
        _token = token;
        _busy = true;
        _cancelRequested = false;
        _fraction = null;
        _error = null;
      });
    }
    try {
      await widget.download(token);
      if (!mounted || _closing) return;
      _close(true);
    } catch (e) {
      if (!mounted || _closing) return;
      if (_cancelRequested) {
        _close(false);
        return;
      }
      setState(() {
        _busy = false;
        _error = e is SpeechModelException ? e.message : '模型下载失败：$e';
      });
    }
  }

  void _close(bool ready) {
    if (!mounted || _closing) return;
    _closing = true;
    setState(() => _busy = false);
    Navigator.pop(context, ready);
  }

  void _cancel() {
    _cancelRequested = true;
    _token?.cancel();
    _close(false);
  }

  @override
  void dispose() {
    _sub?.cancel();
    if (_busy) _token?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final spec = SpeechModelManager.specOf(widget.model);
    return PopScope(
      canPop: !_busy,
      child: AlertDialog(
        title: const Text('正在准备本机识别'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${spec.capability} · 约 ${_mb(spec.totalBytes)}'),
            const SizedBox(height: 16),
            if (_busy) ...[
              LinearProgressIndicator(value: _fraction),
              const SizedBox(height: 10),
              Text(_fraction == null
                  ? '正在连接并校验文件…'
                  : '当前文件 ${(_fraction! * 100).round()}%'),
            ],
            if (_error != null) ...[
              Text(_error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error)),
              const SizedBox(height: 8),
              const Text('可以重试；已下载的完整文件会继续复用。'),
            ],
          ],
        ),
        actions: [
          TextButton(onPressed: _cancel, child: Text(_busy ? '取消下载' : '取消')),
          if (!_busy && _error != null)
            FilledButton(onPressed: _run, child: const Text('重试')),
        ],
      ),
    );
  }
}

String _mb(int bytes) => '${(bytes / 1024 / 1024).toStringAsFixed(0)} MB';
