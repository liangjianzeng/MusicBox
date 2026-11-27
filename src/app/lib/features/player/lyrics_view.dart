import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models.dart';
import '../../core/state.dart';
import '../create/creation_ui.dart';
import 'lyrics.dart';
import 'player_provider.dart';

/// 候选试听（reveal 页拿 Candidate 拼的 Work）、旧本地缓存这些路径里 `Work.lyrics` 是
/// `null` —— 那是"这条数据没带"，不是"这首没歌词"。按作品 id 补取一次；取不到就老实说
/// 取不到，**绝不把"没拿到"演成"这首没歌词"**。
final workLyricsProvider =
    FutureProvider.family<LyricSheet, String>((ref, id) async {
  final api = ref.read(apiClientProvider);
  try {
    final detail = await api.work(id);
    return LyricSheet.fromText(detail.work.lyrics);
  } catch (_) {
    return LyricSheet.of(LyricAvailability.unavailable);
  }
});

LyricSheet _sheetOf(WidgetRef ref, Work work) {
  final text = work.lyrics;
  if (text != null) return LyricSheet.fromText(text);
  if (work.id.isEmpty) return LyricSheet.of(LyricAvailability.unknown);
  final fetched = ref.watch(workLyricsProvider(work.id));
  if (fetched.isLoading) return LyricSheet.of(LyricAvailability.loading);
  return fetched.valueOrNull ?? LyricSheet.of(LyricAvailability.unavailable);
}

/// 播放位置能用播放器报的时长就用它，退而用作品元数据里的时长；两个都拿不到就是
/// `null` —— 上游 [lyricLineIndex] 会返回 null，界面一行都不亮（宁可不亮，不能瞎亮）。
Duration? _durationOf(Duration? fromPlayer, Work work) {
  if (fromPlayer != null && fromPlayer.inMilliseconds > 0) return fromPlayer;
  final sec = work.durationSec;
  if (sec.isFinite && sec > 0) return Duration(milliseconds: (sec * 1000).round());
  return null;
}

/// 播放页歌词区。
///
/// * [singleLine] = false：整幅可滚动列表，自动跟随当前行；
/// * [singleLine] = true：迷你播放条用，只显示当前一行（前面挂 `≈` 表示近似）。
///
/// 只吃数据不吃播放器，所以能直接在 widget test 里 pump。
class LyricsView extends StatefulWidget {
  const LyricsView({
    super.key,
    required this.sheet,
    required this.activeIndex,
    this.singleLine = false,
    this.durationKnown = true,
  });

  final LyricSheet sheet;

  /// 当前该高亮的行；`null` 表示不配高亮（时长未知 / 没有行），此时**一行都不许亮**。
  final int? activeIndex;

  final bool singleLine;

  /// 时长是否可信。false 时列表照常显示，但不跟进当前行，并写明原因。
  final bool durationKnown;

  static const double activeFontSize = 17.5;
  static const double lineFontSize = 15;

  @override
  State<LyricsView> createState() => _LyricsViewState();
}

class _LyricsViewState extends State<LyricsView> {
  final ScrollController _controller = ScrollController();
  final Map<int, GlobalKey> _lineKeys = {};
  Timer? _resume;
  bool _userScrolling = false;

  bool get _followable =>
      !widget.singleLine && widget.durationKnown && widget.activeIndex != null;

  @override
  void initState() {
    super.initState();
    if (_followable) _scheduleFollow();
  }

  @override
  void didUpdateWidget(LyricsView old) {
    super.didUpdateWidget(old);
    final changedWork = old.sheet.lines.length != widget.sheet.lines.length ||
        old.sheet.availability != widget.sheet.availability;
    if (widget.activeIndex != old.activeIndex || changedWork) _scheduleFollow();
  }

  @override
  void dispose() {
    _resume?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _scheduleFollow() {
    if (!_followable) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _userScrolling) return;
      final idx = widget.activeIndex;
      if (idx == null) return;
      final ctx = _lineKeys[idx]?.currentContext;
      if (ctx == null) return;
      Scrollable.ensureVisible(
        ctx,
        alignment: 0.35,
        duration: const Duration(milliseconds: 320),
        curve: Curves.easeOutCubic,
      );
    });
  }

  /// 用户自己翻过歌词，就让他看几秒，别抢他的滚动。
  bool _onUserScroll(UserScrollNotification n) {
    // depth==0：只认本歌词列表自己的滚动，别被外层（矮屏整页滚动）带偏。
    if (n.depth != 0) return false;
    if (n.metrics.axis == Axis.vertical) {
      _resume?.cancel();
      _userScrolling = true;
      _resume = Timer(const Duration(seconds: 5), () {
        if (!mounted) return;
        setState(() => _userScrolling = false);
        _scheduleFollow();
      });
    }
    return false;
  }

  TextStyle _styleOf(bool active) => TextStyle(
        fontSize: active ? LyricsView.activeFontSize : LyricsView.lineFontSize,
        height: 1.5,
        fontWeight: active ? FontWeight.w700 : FontWeight.w500,
        color: active ? CreationPalette.violetBright : CreationPalette.muted,
      );

  Widget _hint(String text) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: CreationPalette.faint,
              fontSize: 13,
              height: 1.5,
            ),
          ),
        ),
      );

  Widget _line(int i) {
    final line = widget.sheet.lines[i];
    final active = !widget.singleLine &&
        widget.durationKnown &&
        widget.activeIndex == i;
    final showHeading =
        widget.sheet.hasSectionTags && line.startsSection;
    return KeyedSubtree(
      key: _lineKeys.putIfAbsent(i, GlobalKey.new),
      child: Padding(
        padding: EdgeInsets.only(top: showHeading ? 14 : 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showHeading)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  line.section,
                  style: const TextStyle(
                    color: CreationPalette.violet,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .6,
                  ),
                ),
              ),
            Text(
              line.text,
              style: _styleOf(active),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sheet = widget.sheet;

    if (!sheet.isReady) {
      if (widget.singleLine) {
        // 迷你条不许留白假装"这行没词"，把状态直接说出来。
        return Padding(
          padding: const EdgeInsets.only(right: 8),
          child: Text(
            sheet.hintText,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: CreationPalette.faint),
          ),
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const _LyricsHeader(),
          Expanded(child: _hint(sheet.hintText)),
        ],
      );
    }

    if (widget.singleLine) {
      final idx = widget.durationKnown ? widget.activeIndex : null;
      final text = idx == null
          ? lyricHintDurationUnknown
          : sheet.lines[idx].text;
      return Padding(
        padding: const EdgeInsets.only(right: 8),
        child: Text(
          // ≈ 是"这行是按行序猜的"，不是装饰符。
          '≈ $text',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontSize: 11,
            color: CreationPalette.violetBright,
            fontWeight: FontWeight.w600,
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _LyricsHeader(),
        if (!widget.durationKnown)
          const Padding(
            padding: EdgeInsets.only(bottom: 6),
            child: Text(
              lyricHintDurationUnknown,
              style: TextStyle(fontSize: 11, color: CreationPalette.faint),
            ),
          ),
        Expanded(
          child: NotificationListener<UserScrollNotification>(
            onNotification: _onUserScroll,
            // 故意不用 ListView / ListView.builder：歌词要在**当前行还没进视口**时就能
            // Scrollable.ensureVisible 摸到它的 RenderObject。ListView（哪怕传 children）
            // 是 SliverMultiBoxAdaptor，只构建视口±cacheExtent 那几行，目标行的 GlobalKey
            // 拿不到 context，自动跟随会静默失灵 —— 唱到副歌歌词却不动，就是白做。
            // 歌词在服务端被截到 4000 字（api/works.js），一次建完最多两百来行，值。
            child: SingleChildScrollView(
              controller: _controller,
              padding: const EdgeInsets.fromLTRB(4, 2, 4, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = 0; i < sheet.lineCount; i++) _line(i),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 歌词区标题 + 近似同步自证。**这行字不许拿掉**：当前行是按行序线性内插猜的，
/// 没有逐字/逐行对齐，界面不能长得像精确卡拉 OK。
class _LyricsHeader extends StatelessWidget {
  const _LyricsHeader();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Container(
            width: 3,
            height: 12,
            decoration: BoxDecoration(
              color: CreationPalette.violet,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 8),
          const Text(
            '歌词',
            style: TextStyle(
              color: CreationPalette.text,
              fontSize: 13,
              fontWeight: FontWeight.w800,
            ),
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
            decoration: BoxDecoration(
              color: CreationPalette.amber.withValues(alpha: .10),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(
                color: CreationPalette.amber.withValues(alpha: .28),
              ),
            ),
            child: const Text(
              lyricSyncDisclaimer,
              style: TextStyle(
                color: CreationPalette.amber,
                fontSize: 10,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 播放器接线版：自己吃 position/duration 流，也负责 lyrics 缺失时补取。
class PlayerLyrics extends ConsumerWidget {
  const PlayerLyrics({super.key, required this.work, this.singleLine = false});

  final Work work;
  final bool singleLine;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sheet = _sheetOf(ref, work);
    final audio = ref.watch(playerProvider.notifier).audio;
    return StreamBuilder<Duration?>(
      stream: audio.durationStream,
      builder: (context, durSnap) {
        final dur = _durationOf(durSnap.data, work);
        return StreamBuilder<Duration>(
          stream: audio.positionStream,
          builder: (context, posSnap) {
            final pos = posSnap.data ?? Duration.zero;
            return LyricsView(
              sheet: sheet,
              activeIndex: lyricLineIndexOf(
                position: pos,
                duration: dur,
                lineCount: sheet.lineCount,
              ),
              singleLine: singleLine,
              durationKnown: dur != null,
            );
          },
        );
      },
    );
  }
}
