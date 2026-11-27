/// 歌词解析 + 「当前唱到哪一行」映射。
///
/// 纯函数、零 Flutter 依赖，单独成文件就是为了被测试钉住。
///
/// 现场（2026-11-27）：用户用深度档填了完整歌词生成歌曲，歌词好好地存在服务端 works.lyrics
/// 里（纯文本，形如 `[Verse]` / 一行词 / `[Chorus]` / 一行词…），**但没有逐行时间戳**。
/// App 之前只把它当成一次性生成参数，播完就丢：播放界面上一个字都看不到，更没有任何
/// "唱到哪一行" 的跟进。这里把它接回来。
///
/// 诚实优先：我们只有**行序**，没有每行几点几分。所以"当前行"是按行数在总时长上线性内插
/// 出来的近似值，界面上必须挂 [lyricSyncDisclaimer]，不许装作精确对齐。
library;

/// 全文没有任何小节标记时，所有行统一归到这个段名下（界面不会再画小标题）。
const String untitledSection = '歌词';

/// 近似同步的自证文案。**不许删，也不许改得像精确对齐** —— 这是按行序猜的。
const String lyricSyncDisclaimer = '近似同步 · 未做逐字对齐';

/// 时长拿不到时不猜当前行，说清楚。
const String lyricHintDurationUnknown = '时长未知 · 不猜当前行';

/// 服务端确认这首没填词（lyrics 是空串）。
const String lyricHintBlank = '这首没有歌词 · 纯音乐或未填词';

/// 歌词里只有 `[Verse]` 这类段落标记，一行正文都没有。
const String lyricHintTagOnly = '只有段落标记 · 没解析出歌词正文';

/// 这条数据里压根没带 lyrics 字段（候选试听、旧缓存等），跟"确认没有"是两回事。
const String lyricHintMissing = '歌词没随这条播放带过来';

/// 想去服务端补取但没取到（离线 / 作品已删）。
const String lyricHintUnavailable = '歌词没取到 · 离线或这首已不在';

/// 正在补取。
const String lyricHintLoading = '正在取歌词…';

/// 歌词来源判定。分成这些档是为了**不把"不知道"演成"没有"**。
enum LyricAvailability {
  /// 解析出了正文行，可以唱跟。
  ready,

  /// 服务端明确给了空串：纯音乐或未填词。
  blank,

  /// 有文本，但只解析出 `[Verse]` 这类标记，没有正文。
  tagOnly,

  /// 数据里没有 lyrics 字段 —— 我们不知道，不等于没有。
  unknown,

  /// 正在向服务端补取。
  loading,

  /// 补取失败（离线 / 作品不存在）。
  unavailable,
}

/// 一行歌词。
class LyricLine {
  const LyricLine({
    required this.text,
    required this.section,
    required this.startsSection,
  });

  /// 歌词正文（已 trim，**不含** `[Verse]` 这类小节标记本身）。
  final String text;

  /// 所属小节标签，如 `Verse` / `Pre-Chorus`；全文无标记时为 [untitledSection]。
  final String section;

  /// 是否该小节在本行首次出现 —— 界面据此只画一次小标题。
  final bool startsSection;

  @override
  String toString() => 'LyricLine($section·$text)';
}

/// 一份歌词。
class LyricSheet {
  const LyricSheet({
    required this.availability,
    this.lines = const [],
    this.hasSectionTags = false,
  });

  factory LyricSheet.of(LyricAvailability availability) =>
      LyricSheet(availability: availability);

  /// 从 works.lyrics 原始文本建一份。
  ///
  /// `null` 与 `''` 必须区分开：前者是"这条数据没带歌词"（不能对用户说没有歌词），
  /// 后者才是服务端确认过的"这首没填词"。
  factory LyricSheet.fromText(String? text) {
    if (text == null) return LyricSheet.of(LyricAvailability.unknown);
    if (text.trim().isEmpty) return LyricSheet.of(LyricAvailability.blank);
    final lines = parseLyricLines(text);
    if (lines.isEmpty) return LyricSheet.of(LyricAvailability.tagOnly);
    return LyricSheet(
      availability: LyricAvailability.ready,
      lines: lines,
      hasSectionTags: lines.any((l) => l.startsSection && l.section != untitledSection),
    );
  }

  final LyricAvailability availability;
  final List<LyricLine> lines;

  /// 文本里到底出现过 `[Xxx]` 小节标记吗。没有就别在界面上编一个小标题出来。
  final bool hasSectionTags;

  bool get isReady => availability == LyricAvailability.ready;
  int get lineCount => lines.length;

  /// 空态/进行态要给用户看的那句话。ready 时为空串（界面不画）。
  String get hintText => switch (availability) {
        LyricAvailability.ready => '',
        LyricAvailability.blank => lyricHintBlank,
        LyricAvailability.tagOnly => lyricHintTagOnly,
        LyricAvailability.unknown => lyricHintMissing,
        LyricAvailability.loading => lyricHintLoading,
        LyricAvailability.unavailable => lyricHintUnavailable,
      };
}

/// 已知小节标签：表内归一化（大小写、连字符、空格都不敏感），表外的 `[Xxx]` 原样当标签。
const Map<String, String> _knownSections = {
  'intro': 'Intro',
  'verse': 'Verse',
  'prechorus': 'Pre-Chorus',
  'chorus': 'Chorus',
  'postchorus': 'Post-Chorus',
  'bridge': 'Bridge',
  'hook': 'Hook',
  'refrain': 'Refrain',
  'drop': 'Drop',
  'interlude': 'Interlude',
  'outro': 'Outro',
};

/// 整行就是一个方括号标记才算小节标签：`[Verse]`、`【副歌】`。
/// 像 `[Chorus] 我来了` 这种混着正文的行按正文处理，不吞字。
final RegExp _tagPattern = RegExp(r'^\s*[\[【]\s*([^\]】]{1,40}?)\s*[\]】]\s*$');

String? _sectionTagOf(String rawLine) {
  final m = _tagPattern.firstMatch(rawLine);
  final raw = m?.group(1)?.trim();
  if (raw == null || raw.isEmpty) return null;
  final key = raw.toLowerCase().replaceAll(RegExp(r'[^a-z0-9\u4e00-\u9fff]'), '');
  return _knownSections[key] ?? raw;
}

/// 把 lyrics 文本解析成行。
///
/// 规则（都是现场逼出来的）：
/// * `[Xxx]` / `【Xxx】` 整行是段落标记 → **不算一行**，只作为后续行的所属小节；
/// * 空行（含只有空格/制表符）丢弃，连续空行不产生空洞；
/// * 全文没有小节标记也能工作：整段当作一段，段名 [untitledSection]；
/// * 只有标记没有正文 → 返回空列表（界面据此走 [lyricHintTagOnly]，不许留白）。
List<LyricLine> parseLyricLines(String text) {
  final out = <LyricLine>[];
  var section = untitledSection;
  var sectionUsed = false; // 当前小节是否已经出过行；出过就不再画小标题
  for (final raw in text.split(RegExp(r'\r\n|\r|\n'))) {
    final line = raw.trim();
    if (line.isEmpty) continue;
    final tag = _sectionTagOf(line);
    if (tag != null) {
      section = tag;
      sectionUsed = false; // 同一个 [Chorus] 出现两次，第二次也要有小标题
      continue;
    }
    out.add(LyricLine(
      text: line,
      section: section,
      startsSection: !sectionUsed,
    ));
    sectionUsed = true;
  }
  return out;
}

/// 当前播放位置 → 该高亮第几行（0 起）。拿不到就说 `null`，界面一行都不许亮。
///
/// **诚实说明**：works.lyrics 没有逐行时间戳，这里把总时长按行数均分，落在哪段就是哪行 ——
/// 纯线性内插，不是真实对齐，也不可能是。所以界面上必须挂 [lyricSyncDisclaimer]。
///
/// 不变量（测试逐条钉住）：
/// * 单调不减：位置往后走，行号绝不回退；
/// * 越界钳制：负位置算第 0 行，超过总时长算最后一行；
/// * 行数 0、时长 0/负数/null、任何 NaN/Infinity → 一律 `null`（宁可不亮，不能瞎亮）。
int? lyricLineIndex({
  required double positionSec,
  required double? durationSec,
  required int lineCount,
}) {
  if (lineCount <= 0) return null;
  if (durationSec == null || !durationSec.isFinite || durationSec <= 0) return null;
  if (!positionSec.isFinite) return null;
  final pos = positionSec < 0 ? 0.0 : positionSec;
  final idx = (pos / durationSec * lineCount).floor();
  if (idx <= 0) return 0;
  if (idx >= lineCount) return lineCount - 1;
  return idx;
}

/// [lyricLineIndex] 的 Duration 版，省掉调用点每次手写 `/1000`。
int? lyricLineIndexOf({
  required Duration position,
  required Duration? duration,
  required int lineCount,
}) =>
    lyricLineIndex(
      positionSec: position.inMilliseconds / 1000.0,
      durationSec: duration == null ? null : duration.inMilliseconds / 1000.0,
      lineCount: lineCount,
    );
