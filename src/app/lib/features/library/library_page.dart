import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../shared/widgets/ai_badge.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/waveform_canvas.dart';
import '../assistant/assistant_surface.dart';
import '../create/shelf_page.dart';
import '../create/shelf_store.dart';
import '../player/player_provider.dart';
import 'work_detail_page.dart';

/// 曲库：网格（波形占位+时长+AI 角标）/ 筛选 chips / 分页 / 先缓存后网络
class LibraryPage extends ConsumerStatefulWidget {
  const LibraryPage({super.key});

  @override
  ConsumerState<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends ConsumerState<LibraryPage> {
  final _items = <Work>[];
  String? _cursor;
  bool _loading = false;
  bool _offline = false;
  bool _mine = true;
  String? _moodFilter;
  String? _genreFilter;
  String _q = '';
  int _requestGeneration = 0;
  final _search = TextEditingController();
  final _sc = ScrollController();

  _LibraryQuery get _query => _LibraryQuery(
        mine: _mine,
        mood: _moodFilter,
        genre: _genreFilter,
        q: _q,
      );

  void _refresh(VoidCallback update) {
    setState(() {
      update();
      _loading = false;
      _cursor = null;
      _items.clear();
      _offline = false;
    });
    _load(refresh: true);
  }

  @override
  void initState() {
    super.initState();
    _sc.addListener(() {
      if (_sc.position.pixels > _sc.position.maxScrollExtent - 300) {
        _loadMore();
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _load(refresh: true));
  }

  @override
  void dispose() {
    _requestGeneration++;
    _search.dispose();
    _sc.dispose();
    super.dispose();
  }

  Future<void> _load({bool refresh = false}) async {
    if (_loading && !refresh) return;
    final query = _query;
    final generation = ++_requestGeneration;
    final cursor = refresh ? null : _cursor;
    bool isCurrent() =>
        mounted && generation == _requestGeneration && query == _query;
    setState(() {
      _loading = true;
      _offline = false;
      if (refresh) {
        _cursor = null;
        _items.clear();
      }
    });
    // 先缓存（离线可用）
    if (refresh) {
      try {
        final cached = await ref.read(localDbProvider).cachedWorks();
        if (!isCurrent()) return;
        setState(() => _items.addAll(cached.where(query.matches)));
      } catch (_) {}
    }
    try {
      final (items, next) = await ref.read(apiClientProvider).works(
            mine: query.mine,
            genre: query.genre,
            mood: query.mood,
            q: query.q.isEmpty ? null : query.q,
            cursor: cursor,
          );
      if (!isCurrent()) return;
      setState(() {
        if (refresh) {
          _items
            ..clear()
            ..addAll(items);
        } else {
          _items.addAll(items);
        }
        _cursor = next;
        _offline = false;
      });
      await ref.read(localDbProvider).upsertWorks(items);
    } on ApiException catch (e) {
      if (!mounted || generation != _requestGeneration || query != _query) {
        return;
      }
      setState(() {
        _offline = true;
      });
      if (refresh && _items.isEmpty) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.zh)));
      }
    } finally {
      if (isCurrent()) setState(() => _loading = false);
    }
  }

  void _loadMore() {
    if (_cursor != null && !_loading) _load();
  }

  @override
  Widget build(BuildContext context) {
    final moods = <String>{
      ...kMoodOptions.take(8),
      if (_moodFilter != null) _moodFilter!,
    }.toList();
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _search,
                    textInputAction: TextInputAction.search,
                    onSubmitted: (v) => _refresh(() => _q = v.trim()),
                    decoration: InputDecoration(
                      hintText: '搜索作品',
                      isDense: true,
                      prefixIcon: const Icon(Icons.search, size: 18),
                      border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: () => _load(refresh: true),
                  icon: const Icon(Icons.refresh),
                  tooltip: '刷新',
                ),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 12),
            child: AssistantSuggestionCard(
              title: '帮我找适合现在听的歌',
              prompt: '请根据我当前的心情和曲库上下文，推荐适合现在听的歌并说明理由',
              icon: Icons.mood_outlined,
            ),
          ),
          // 筛选 chips：我的/广场 + mood + genre
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              children: [
                FilterChip(
                    label: const Text('我的'),
                    selected: _mine,
                    onSelected: (_) => _refresh(() => _mine = true)),
                const SizedBox(width: 6),
                FilterChip(
                    label: const Text('广场'),
                    selected: !_mine,
                    onSelected: (_) => _refresh(() => _mine = false)),
                const SizedBox(width: 10),
                const _ShelfChip(),
                Wrap(
                  spacing: 6,
                  children: moods
                      .map((m) => FilterChip(
                            label: Text(m),
                            selected: _moodFilter == m,
                            onSelected: (v) =>
                                _refresh(() => _moodFilter = v ? m : null),
                          ))
                      .toList(),
                ),
                const SizedBox(width: 10),
                Wrap(
                  spacing: 6,
                  children: kGenreOptions
                      .take(6)
                      .map((g) => FilterChip(
                            label: Text(g),
                            selected: _genreFilter == g,
                            onSelected: (v) =>
                                _refresh(() => _genreFilter = v ? g : null),
                          ))
                      .toList(),
                ),
              ],
            ),
          ),
          if (_offline && _items.isNotEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: Text('离线模式 · 展示符合筛选的本地缓存',
                  style: TextStyle(color: Colors.orangeAccent, fontSize: 12)),
            ),
          Expanded(
            child: _items.isEmpty && _loading
                ? const Center(child: CircularProgressIndicator())
                : _items.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Text('🪕', style: TextStyle(fontSize: 40)),
                            const SizedBox(height: 8),
                            Text(
                                _offline
                                    ? '离线模式 · 没有符合当前筛选的本地缓存'
                                    : _query.hasFilters
                                        ? '没有符合当前筛选的作品'
                                        : '还没有作品，去创作一首吧',
                                style: const TextStyle(color: Colors.white38)),
                            const SizedBox(height: 10),
                            OutlinedButton(
                                onPressed: () => _load(refresh: true),
                                child: const Text('重试')),
                          ],
                        ),
                      )
                    : GridView.builder(
                        controller: _sc,
                        padding: const EdgeInsets.all(12),
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          childAspectRatio: 0.82,
                          crossAxisSpacing: 10,
                          mainAxisSpacing: 10,
                        ),
                        itemCount: _items.length + (_cursor != null ? 1 : 0),
                        itemBuilder: (ctx, i) {
                          if (i >= _items.length) {
                            return const Center(
                                child:
                                    CircularProgressIndicator(strokeWidth: 2));
                          }
                          final w = _items[i];
                          return _WorkCard(
                            work: w,
                            onPlay: () => ref
                                .read(playerProvider.notifier)
                                .playQueue(_items, i),
                            onOpen: () => Navigator.of(context).push(
                              MaterialPageRoute(
                                  builder: (_) => WorkDetailPage(workId: w.id)),
                            ),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}

class _LibraryQuery {
  const _LibraryQuery({
    required this.mine,
    required this.mood,
    required this.genre,
    required this.q,
  });

  final bool mine;
  final String? mood;
  final String? genre;
  final String q;

  bool get hasFilters => !mine || mood != null || genre != null || q.isNotEmpty;

  bool matches(Work work) {
    if (work.status == 'retired') return false;
    if (mine ? work.visibility != 'private' : work.visibility != 'public') {
      return false;
    }
    if (mood != null &&
        !(work.mood ?? '').toLowerCase().contains(mood!.toLowerCase())) {
      return false;
    }
    if (genre != null &&
        !work.genres
            .any((g) => g.toLowerCase().contains(genre!.toLowerCase()))) {
      return false;
    }
    if (q.isNotEmpty) {
      final keyword = q.toLowerCase();
      final searchable = [
        work.title,
        work.lyrics ?? '',
        work.mood ?? '',
        ...work.genres,
      ].join('\n').toLowerCase();
      if (!searchable.contains(keyword)) return false;
    }
    return true;
  }

  @override
  bool operator ==(Object other) =>
      other is _LibraryQuery &&
      other.mine == mine &&
      other.mood == mood &&
      other.genre == genre &&
      other.q == q;

  @override
  int get hashCode => Object.hash(mine, mood, genre, q);
}

/// 灵感暂存架入口：生成好但还没「收下」的候选都在这里，退出/切页不丢
class _ShelfChip extends ConsumerWidget {
  const _ShelfChip();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final n = ref.watch(shelfProvider).length;
    final scheme = Theme.of(context).colorScheme;
    return ActionChip(
      avatar: Icon(n > 0 ? Icons.bookmark : Icons.bookmark_border,
          size: 16, color: n > 0 ? scheme.primary : Colors.white54),
      label: Text(n > 0 ? '暂存 $n' : '暂存',
          style: TextStyle(
              fontSize: 12.5,
              fontWeight: n > 0 ? FontWeight.w700 : FontWeight.w500,
              color: n > 0 ? Colors.white : Colors.white54)),
      tooltip: n > 0 ? '生成好但还没收下的候选都在这里（最近 8 次）' : '生成好但没收下的候选会自动存到这里',
      onPressed: () => Navigator.of(context)
          .push(MaterialPageRoute(builder: (_) => const ShelfPage())),
    );
  }
}

class _WorkCard extends StatelessWidget {
  const _WorkCard(
      {required this.work, required this.onPlay, required this.onOpen});

  final Work work;
  final VoidCallback onPlay;
  final VoidCallback onOpen;

  String _fmt(double sec) {
    final s = sec.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      // 真机 2026-11-27 用户反馈「我的里进不去」：卡片只有标题那一行能点开详情，点中间
      // （波形/封面区）毫无反应。根因是 InkWell 默认 deferToChild，而波形是 CustomPaint
      // 不接受命中 —— 卡片中间整块是"看得见却点不着"的死区。这里补一层 opaque 的点击面，
      // 让整张卡（含波形、留白）都能进详情；内部 ▶ 等控件仍各自优先响应。
      behavior: HitTestBehavior.opaque,
      onTap: onOpen,
      child: InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              scheme.surfaceContainerHigh,
              scheme.surfaceContainerLow,
            ],
          ),
          border: Border.all(color: Colors.white10),
        ),
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(colors: [
                      scheme.primary.withValues(alpha: .75),
                      scheme.tertiary.withValues(alpha: .55),
                    ]),
                  ),
                  child: const Center(
                      child: Text('💿', style: TextStyle(fontSize: 16))),
                ),
                const Spacer(),
                if (work.aiLabel) const AiBadge(small: true),
              ],
            ),
            const SizedBox(height: 10),
            Expanded(
              child: WaveformCanvas(
                peaks: pseudoPeaks(work.id, n: 40),
                height: 44,
                barWidth: 2.5,
                gap: 2,
              ),
            ),
            Row(
              children: [
                Text(_fmt(work.durationSec),
                    style:
                        const TextStyle(fontSize: 11, color: Colors.white54)),
                const Spacer(),
                IconButton(
                  onPressed: onPlay,
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.play_arrow_rounded, size: 20),
                ),
              ],
            ),
            Text(work.title.isEmpty ? '未命名作品' : work.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w600)),
            if (work.mood != null || work.genres.isNotEmpty)
              Text(
                [if (work.mood != null) work.mood!, ...work.genres].join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Colors.white38),
              ),
          ],
        ),
      ),
    ),
    );
  }
}
