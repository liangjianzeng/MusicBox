import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import '../../shared/widgets/ai_badge.dart';
import '../../shared/widgets/mood_chips.dart';
import '../../shared/widgets/waveform_canvas.dart';
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
  final _search = TextEditingController();
  final _sc = ScrollController();

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
    _search.dispose();
    _sc.dispose();
    super.dispose();
  }

  Future<void> _load({bool refresh = false}) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      if (refresh) {
        _cursor = null;
        _items.clear();
      }
    });
    // 先缓存（离线可用）
    if (refresh) {
      try {
        final cached = await ref.read(localDbProvider).cachedWorks();
        if (mounted && _items.isEmpty) {
          setState(() => _items.addAll(cached));
        }
      } catch (_) {}
    }
    try {
      final (items, next) = await ref.read(apiClientProvider).works(
            mine: _mine,
            genre: _genreFilter,
            mood: _moodFilter,
            q: _q.isEmpty ? null : _q,
            cursor: refresh ? null : _cursor,
          );
      if (!mounted) return;
      setState(() {
        if (refresh) {
          _items
          ..clear()
          ..addAll(items);
        }
        if (!refresh) _items.addAll(items);
        _cursor = next;
        _offline = false;
      });
      await ref.read(localDbProvider).upsertWorks(items);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _offline = true;
        });
        if (refresh && _items.isEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.zh)));
        }
      }
    } finally {
      if (mounted) setState(() => _loading = false);
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
                    onSubmitted: (v) {
                      _q = v.trim();
                      _load(refresh: true);
                    },
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
          // 筛选 chips：我的/广场 + mood + genre
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              children: [
                FilterChip(
                    label: const Text('我的'),
                    selected: _mine,
                    onSelected: (_) {
                      setState(() => _mine = true);
                      _load(refresh: true);
                    }),
                const SizedBox(width: 6),
                FilterChip(
                    label: const Text('广场'),
                    selected: !_mine,
                    onSelected: (_) {
                      setState(() => _mine = false);
                      _load(refresh: true);
                    }),
                const SizedBox(width: 10),
                Wrap(
                  spacing: 6,
                  children: moods
                      .map((m) => FilterChip(
                            label: Text(m),
                            selected: _moodFilter == m,
                            onSelected: (v) {
                              setState(() =>
                                  _moodFilter = v ? m : null);
                              _load(refresh: true);
                            },
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
                            onSelected: (v) {
                              setState(() =>
                                  _genreFilter = v ? g : null);
                              _load(refresh: true);
                            },
                          ))
                      .toList(),
                ),
              ],
            ),
          ),
          if (_offline)
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: Text('离线模式 · 展示本地缓存',
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
                            const Text('还没有作品，去创作一首吧',
                                style: TextStyle(color: Colors.white38)),
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
                                  builder: (_) =>
                                      WorkDetailPage(workId: w.id)),
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
    return InkWell(
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
                    style: const TextStyle(
                        fontSize: 11, color: Colors.white54)),
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
    );
  }
}
