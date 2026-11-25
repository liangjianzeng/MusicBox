import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart' as mb;
import '../../core/speech/asr_engine.dart';
import '../../core/speech/speech_settings.dart';
import '../../core/state.dart';
import 'intent_flow_page.dart';

/// 语音一次采集的结果（端侧录的 WAV + 端侧识别文本 + 换档说明）。
class VoiceCaptureResult {
  const VoiceCaptureResult({
    this.wavPath,
    this.local,
    this.engineNote,
    this.engine,
  });

  /// 端侧录下的 16k mono WAV（交给服务端复核用；服务端档为 m4a）
  final String? wavPath;

  /// 端侧识别结果（服务端档为 null）
  final AsrOutcome? local;

  /// 档位被换过的原因（必须上屏，不许静默换档）
  final String? engineNote;

  final AsrEngineKind? engine;

  bool get hasAnything =>
      (wavPath != null && wavPath!.isNotEmpty) || (local?.hasText ?? false);
}

/// 「你说的话」确认页（强制一屏）。
///
/// 分工：**端侧管手感（边说边出字），服务端管准（逐字复核 + 情绪）**。
/// 这里就是把两者摊给用户看，并给一次改字的机会：
/// · 逐字区可直接编辑，改过就走文本线重新理解（不用重录）；
/// · 服务端没听清 / 没响应 → 明说，并退回本机识别结果，同时标注出处；
/// · 谁都没给出文字 → 只给「重说 / 打字」两条活路，不给空白页。
class TranscriptConfirmPage extends ConsumerStatefulWidget {
  const TranscriptConfirmPage({
    super.key,
    required this.capture,
    this.easy = true,
    this.autoOpenFlow = true,
  });

  final VoiceCaptureResult capture;
  final bool easy;

  /// true：确认后本页面自己打开意图流；false：只回传 intent_id（宿主自己接管）
  final bool autoOpenFlow;

  @override
  ConsumerState<TranscriptConfirmPage> createState() =>
      _TranscriptConfirmPageState();
}

enum _Phase { waitingServer, ready, failed, submitting }

class _TranscriptConfirmPageState extends ConsumerState<TranscriptConfirmPage> {
  _Phase _phase = _Phase.waitingServer;
  TextEditingController _text = TextEditingController();
  mb.Intent? _card; // 服务端理解结果（理解卡片，逐字也来自它）
  String? _intentId;
  bool _serverAuthoritative = false; // 逐字是否来自服务端
  String? _note; // 诚实说明（换档/降级原因）
  String? _error;
  Timer? _timeout;
  bool _cancelled = false;

  @override
  void initState() {
    super.initState();
    _text = TextEditingController(text: widget.capture.local?.text.trim() ?? '');
    _note = widget.capture.engineNote;
    _run();
  }

  @override
  void dispose() {
    _cancelled = true;
    _timeout?.cancel();
    _text.dispose();
    super.dispose();
  }

  AsrOutcome? get _local => widget.capture.local;

  bool get _edited =>
      _card?.sourceText != null && _text.text.trim() != _card!.sourceText!.trim();

  Future<void> _run() async {
    final api = ref.read(apiClientProvider);
    final wav = widget.capture.wavPath;
    final engine = widget.capture.engine;
    final hasLocal = _local?.hasText ?? false;
    // 谁负责「准」：
    // · 服务端档 / 即时档 → 上传复核（即时档给不出情绪，逐字与情绪都认服务端的）；
    // · 精听档 → 本机整段就带情绪与事件，**不上传**（用户为它下模型就是为了离线可用）；
    //   只有本机没听清且允许兜底时，才把音频交给服务端救一次。
    final fallbackOk = ref.read(speechSettingsProvider).fallbackToServer;
    final needServer = wav != null &&
        wav.isNotEmpty &&
        (engine == null ||
            engine == AsrEngineKind.server ||
            engine == AsrEngineKind.streamingZipformer ||
            (engine == AsrEngineKind.senseVoiceOffline && !hasLocal && fallbackOk));
    // 1) 需要服务端 → 交给它复核（这是"准"的来源）
    if (needServer) {
      try {
        final id = await api.intentVoice(wav,
            filename: wav.toLowerCase().endsWith('.wav') ? 'voice.wav' : 'voice.m4a');
        if (_cancelled) return;
        _intentId = id;
        final card = await _pollCard(api, id);
        if (_cancelled) return;
        if (card != null) {
          _card = card;
          final sv = card.sourceText?.trim() ?? '';
          if (sv.isNotEmpty && !card.degraded) {
            _serverAuthoritative = true;
            _text.text = sv;
            _phase = _Phase.ready;
          } else if (sv.isNotEmpty) {
            // 服务端有逐字但理解是兜底的
            _serverAuthoritative = true;
            _text.text = sv;
            _phase = _Phase.ready;
            _note = '理解服务在兜底状态，卡片参数可能偏保守，可以直接改。';
          } else if (_local != null && _local!.hasText) {
            _phase = _Phase.ready;
            _note = '服务端没听清，这一版用的是本机识别的结果。';
          } else {
            _phase = _Phase.failed;
            _error = '服务端没听清，本机也没识别出内容。';
          }
        } else {
          final bool okLocal = _local?.hasText ?? false;
          _phase = okLocal ? _Phase.ready : _Phase.failed;
          // 有话可确认才提"用本机结果"，否则别把两句自相矛盾的话同时端上桌
          _note = okLocal ? '服务端迟迟没回话，这一版用的是本机识别的结果。' : null;
          _error = okLocal ? null : '服务端没响应，本机也没识别出内容。';
        }
      } on ApiException catch (e) {
        if (_cancelled) return;
        if (_local?.hasText ?? false) {
          _phase = _Phase.ready;
          _note = '上传失败（${e.zh}），这一版用的是本机识别的结果。';
        } else {
          _phase = _Phase.failed;
          _error = '上传失败：${e.zh}';
        }
      } catch (_) {
        if (_cancelled) return;
        if (_local?.hasText ?? false) {
          _phase = _Phase.ready;
          _note = '服务端不可用，这一版用的是本机识别的结果。';
        } else {
          _phase = _Phase.failed;
          _error = '服务端不可用，本机也没识别出内容。';
        }
      }
      if (mounted) setState(() {});
      return;
    }
    // 2) 没音频只有端侧文本（纯端侧档）→ 直接可确认
    if (_local?.hasText ?? false) {
      setState(() => _phase = _Phase.ready);
      return;
    }
    setState(() {
      _phase = _Phase.failed;
      _error = _local?.error ?? '没听清，再说一遍';
    });
  }

  /// 轮询意图卡直到逐字/兜底标记出现（服务端完成时才一起写库）
  Future<mb.Intent?> _pollCard(ApiClient api, String id) async {
    final deadline = DateTime.now().add(const Duration(seconds: 22));
    mb.Intent? last;
    while (DateTime.now().isBefore(deadline)) {
      try {
        final c = await api.intent(id);
        last = c;
        if (c.sourceText != null || c.degraded) return c;
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 400));
    }
    return last;
  }

  Future<void> _confirm() async {
    final t = _text.text.trim();
    if (t.isEmpty) {
      setState(() => _error = '这句是空的，改个字或重说一条');
      return;
    }
    setState(() => _phase = _Phase.submitting);
    final api = ref.read(apiClientProvider);
    try {
      String cardId = _intentId ?? '';
      // 改过字（或压根没走服务端）→ 文本线重新理解，理解跟着改后的字走
      if (_edited || cardId.isEmpty || !_serverAuthoritative) {
        cardId = await api.intentText(t, intentId: cardId.isEmpty ? null : cardId);
        final c = await _pollCard(api, cardId);
        if (c != null) _card = c;
      }
      if (cardId.isEmpty) {
        if (!mounted) return;
        setState(() {
          _phase = _Phase.ready;
          _error = '没拿到这张卡片的编号，请再点一次「就这句」';
        });
        return;
      }
      if (!mounted) return;
      if (widget.autoOpenFlow) {
        Navigator.of(context).pop();
        await Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => IntentFlowPage(intentId: cardId, easy: widget.easy)));
      } else {
        Navigator.of(context).pop(ConfirmExit(kConfirmIntent, cardId));
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.ready;
        _error = e.zh;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.ready;
        _error = '没能提交，请再点一次「就这句」';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final busy = _phase == _Phase.waitingServer || _phase == _Phase.submitting;
    return Scaffold(
      appBar: AppBar(
        title: const Text('你说的话'),
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _SourceBadge(
                authoritative: _serverAuthoritative,
                busy: _phase == _Phase.waitingServer,
                localLabel: _local?.engineLabel,
              ),
              const SizedBox(height: 10),
              if (_note != null) _HintBar(text: _note!, tone: _HintTone.warn),
              if (_card?.degraded ?? false)
                const _HintBar(
                  text: '这次理解走了保底词典（识别或理解服务没起来），参数可能不准，可直接改。',
                  tone: _HintTone.warn,
                ),
              const SizedBox(height: 6),
              // 逐字区：可编辑
              TextField(
                controller: _text,
                minLines: 2,
                maxLines: 5,
                enabled: !busy,
                style: TextStyle(
                    fontSize: widget.easy ? 20 : 16, height: 1.45),
                decoration: InputDecoration(
                  hintText: _phase == _Phase.failed
                      ? (_error ?? '没听清，点下面「重说」再来一次')
                      : '（没听到内容）',
                  border: const OutlineInputBorder(),
                  filled: true,
                  fillColor: scheme.surfaceContainerHighest.withValues(alpha: .35),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  if (_local?.emotion != null) ...[
                    _Chip(
                        icon: Icons.mood_rounded,
                        label: '情绪：${_zhEmotion(_local!.emotion!)}'),
                    const SizedBox(width: 8),
                  ],
                  if (_local?.events.isNotEmpty ?? false) ...[
                    _Chip(
                        icon: Icons.graphic_eq_rounded,
                        label: '背景：${(_local!.events).join('、')}'),
                    const SizedBox(width: 8),
                  ],
                  if (_local?.durationSec != null)
                    _Chip(
                        icon: Icons.timer_outlined,
                        label: '${(_local!.durationSec!).toStringAsFixed(1)} 秒'),
                ],
              ),
              const SizedBox(height: 6),
              // AI 理解摘要（有卡才显示；没卡就说实话）
              _Understanding(card: _card, busy: _phase == _Phase.waitingServer),
              const Spacer(),
              if (_error != null) ...[
                Text(_error!,
                    style: TextStyle(color: scheme.error, fontSize: widget.easy ? 16 : 13)),
                const SizedBox(height: 10),
              ],
              if (busy)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 18),
                  child: Center(
                      child: SizedBox(
                          width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5))),
                )
              else ...[
                FilledButton.icon(
                  onPressed: _confirm,
                  icon: const Icon(Icons.check_rounded),
                  label: Text(_edited ? '按改后的这句生成' : '就这句'),
                  style: FilledButton.styleFrom(
                      minimumSize: Size(0, widget.easy ? 60 : 48)),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => Navigator.of(context)
                            .pop(const ConfirmExit(kConfirmRedo, '')),
                        icon: const Icon(Icons.refresh_rounded),
                        label: const Text('重说一遍'),
                        style: OutlinedButton.styleFrom(
                            minimumSize: Size(0, widget.easy ? 56 : 44)),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => Navigator.of(context)
                            .pop(ConfirmExit(kConfirmTyped, _text.text.trim())),
                        icon: const Icon(Icons.keyboard_rounded),
                        label: const Text('改成打字'),
                        style: OutlinedButton.styleFrom(
                            minimumSize: Size(0, widget.easy ? 56 : 44)),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 用户没走"就这句"，而是选了别的出路（重说 / 改成打字）
const String kConfirmRedo = 'redo';
const String kConfirmTyped = 'typed';

/// autoOpenFlow=false 时，确认后回传 intent_id 给宿主接管
const String kConfirmIntent = 'intent';

class ConfirmExit {
  const ConfirmExit(this.kind, this.text);
  final String kind;

  /// 「改成打字」时把已识别/已编辑的文字带回输入框
  final String text;
}

class _SourceBadge extends StatelessWidget {
  const _SourceBadge(
      {required this.authoritative, required this.busy, this.localLabel});

  final bool authoritative;
  final bool busy;
  final String? localLabel;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, text, color) = busy
        ? (Icons.cloud_sync_rounded, '服务端复核中…', scheme.primary)
        : authoritative
            ? (Icons.verified_rounded, '服务端已复核', scheme.primary)
            : (Icons.phone_iphone_rounded, localLabel ?? '本机识别', scheme.tertiary);
    return Row(
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 6),
        Text(text, style: TextStyle(color: color, fontSize: 12.5)),
      ],
    );
  }
}

enum _HintTone { warn }

class _HintBar extends StatelessWidget {
  const _HintBar({required this.text, required this.tone});
  final String text;
  final _HintTone tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bg = tone == _HintTone.warn
        ? scheme.tertiaryContainer.withValues(alpha: .45)
        : scheme.surfaceContainerHighest.withValues(alpha: .5);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration:
            BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(tone == _HintTone.warn ? Icons.info_outline_rounded : Icons.lightbulb_outline_rounded,
                size: 16, color: scheme.onSurfaceVariant),
            const SizedBox(width: 8),
            Expanded(
                child: Text(text,
                    style: TextStyle(
                        fontSize: 12.5, color: scheme.onSurfaceVariant, height: 1.4))),
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: .5),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: scheme.onSurfaceVariant),
          const SizedBox(width: 4),
          Text(label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _Understanding extends StatelessWidget {
  const _Understanding({required this.card, required this.busy});
  final mb.Intent? card;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final c = card;
    if (busy && c == null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12)),
        child: Text('正在理解你想听什么…',
            style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
      );
    }
    if (c == null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12)),
        child: Text('还没拿到理解结果。确认这句后我再想一遍。',
            style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
      );
    }
    final bits = <String>[
      if (c.mood.isNotEmpty) '情绪 ${c.mood.join('、')}',
      if (c.genreHypotheses.isNotEmpty) '曲风 ${c.genreHypotheses.join('、')}',
      c.vocal == 'instrumental' ? '纯音乐' : (c.vocal == 'song' ? '要人声' : '人声未定'),
      if ((c.durationHint ?? '').isNotEmpty) '时长 ${_dur(c.durationHint!)}',
    ];
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('AI 听到的意思',
              style: TextStyle(
                  fontSize: 11.5,
                  color: scheme.onSurfaceVariant,
                  fontWeight: FontWeight.w600)),
          const SizedBox(height: 5),
          Text(
            (c.sceneDesc ?? '').trim().isEmpty
                ? '（还没给出场景描述）'
                : c.sceneDesc!.trim(),
            style: const TextStyle(fontSize: 14, height: 1.45),
          ),
          if (bits.isNotEmpty) ...[
            const SizedBox(height: 7),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: bits.map((b) => _Chip(icon: Icons.circle, label: b)).toList(),
            ),
          ],
          const SizedBox(height: 6),
          Text('拿不准的地方会在下一页问你，也可以直接改上面那句。',
              style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }

  static String _dur(String h) => switch (h) {
        'short' => '偏短',
        'medium' => '适中',
        'long' => '偏长',
        _ => h,
      };
}

/// 情绪标签的人话（**不出现任何模型/引擎名**）
String _zhEmotion(String e) => switch (e.toLowerCase()) {
      'happy' => '愉快',
      'sad' => '低落',
      'angry' => '激动',
      'neutral' => '平和',
      'fearful' => '紧张',
      'disgusted' => '不悦',
      'surprised' => '意外',
      '' => '',
      _ => e,
    };
