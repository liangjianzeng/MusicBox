import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart'
    show MediaItem;

import '../../core/models.dart';
import '../../core/state.dart';

/// 全局播放器状态：队列 + 当前索引 + 播放态
class PlayerUiState {
  const PlayerUiState({
    this.queue = const [],
    this.index = -1,
    this.playing = false,
    this.buffering = false,
  });

  final List<Work> queue;
  final int index;
  final bool playing;
  final bool buffering;

  Work? get current =>
      (index >= 0 && index < queue.length) ? queue[index] : null;

  PlayerUiState copyWith({
    List<Work>? queue,
    int? index,
    bool? playing,
    bool? buffering,
  }) =>
      PlayerUiState(
        queue: queue ?? this.queue,
        index: index ?? this.index,
        playing: playing ?? this.playing,
        buffering: buffering ?? this.buffering,
      );
}

/// just_audio + just_audio_background：锁屏/通知栏可控
class PlayerNotifier extends StateNotifier<PlayerUiState> {
  PlayerNotifier(this._ref) : super(const PlayerUiState()) {
    _player.playerStateStream.listen((ps) {
      state = state.copyWith(
          playing: ps.playing, buffering: ps.processingState == ProcessingState.loading);
    });
  }

  final Ref _ref;
  final AudioPlayer _player = AudioPlayer();

  AudioPlayer get audio => _player;

  /// 播放一组作品（曲库/揭晓页共用）
  Future<void> playQueue(List<Work> works, int startIndex) async {
    if (works.isEmpty) return;
    final w = works[startIndex];
    if (w.audioUrl == null || w.audioUrl!.isEmpty) return;
    state = state.copyWith(queue: works, index: startIndex);
    try {
      final item = MediaItem(
        id: w.id.isEmpty ? 'c_${DateTime.now().millisecondsSinceEpoch}' : w.id,
        title: w.title.isEmpty ? '未命名作品' : w.title,
        artist: 'MusicBox',
        album: 'AI 生成',
        duration: Duration(seconds: w.durationSec.round()),
      );
      await _player.setAudioSource(
        AudioSource.uri(Uri.parse(w.audioUrl!), tag: item),
      );
      await _player.play();
      await _ref.read(localDbProvider).logPlay(w);
    } catch (_) {
      // 播放失败静默，UI 显示错误态
    }
  }

  Future<void> toggle() async {
    if (state.current == null) return;
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
  }

  Future<void> next() async {
    if (state.queue.isEmpty) return;
    final i = (state.index + 1) % state.queue.length;
    await playQueue(state.queue, i);
  }

  Future<void> prev() async {
    if (state.queue.isEmpty) return;
    final i = (state.index - 1 + state.queue.length) % state.queue.length;
    await playQueue(state.queue, i);
  }

  Future<void> seek(Duration pos) async {
    await _player.seek(pos);
  }

  Future<void> stop() async {
    await _player.stop();
    state = state.copyWith(index: -1, playing: false);
  }
}

final playerProvider =
    StateNotifierProvider<PlayerNotifier, PlayerUiState>((ref) {
  return PlayerNotifier(ref);
});
