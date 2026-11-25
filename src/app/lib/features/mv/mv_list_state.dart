import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/state.dart';
import 'mv_api_client.dart';
import 'mv_models.dart';

/// MV 列表侧状态：API 客户端注入、我的 MV 项目（GET /v1/mvs）与曲库候选

final mvApiClientProvider =
    Provider<MvApiClient>((ref) => MvApiClient(ref.watch(apiClientProvider)));

// ---------- 我的 MV 列表 ----------

class MvListState {
  const MvListState({
    this.items = const [],
    this.loading = false,
    this.error,
    this.cursor,
  });

  final List<MvSummary> items;
  final bool loading;
  final String? error;
  final String? cursor;

  MvListState copyWith({
    List<MvSummary>? items,
    bool? loading,
    String? error,
    bool clearError = false,
    String? cursor,
  }) =>
      MvListState(
        items: items ?? this.items,
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
        cursor: cursor ?? this.cursor,
      );
}

class MvProjectsNotifier extends StateNotifier<MvListState> {
  MvProjectsNotifier(this._ref) : super(const MvListState());
  final Ref _ref;
  bool _loadingMore = false;

  MvApiClient get _api => _ref.read(mvApiClientProvider);

  Future<void> load({bool refresh = true}) async {
    if (state.loading) return;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final (raw, next) =
          await _api.listMvs(mine: true, cursor: refresh ? null : state.cursor);
      final items = raw.map(MvSummary.fromMap).toList();
      state = MvListState(
        items: refresh ? items : [...state.items, ...items],
        cursor: next,
      );
    } on ApiException catch (e) {
      state = state.copyWith(loading: false, error: mvUserVisibleError(e));
    } catch (_) {
      state = state.copyWith(loading: false, error: '加载失败，请下拉重试');
    }
  }

  Future<void> loadMore() async {
    if (state.cursor == null || _loadingMore || state.loading) return;
    _loadingMore = true;
    await load(refresh: false);
    _loadingMore = false;
  }
}

final mvProjectsProvider =
    StateNotifierProvider.autoDispose<MvProjectsNotifier, MvListState>(
        (ref) => MvProjectsNotifier(ref));

// ---------- 曲库候选：已完成（有音轨）的作品，供向导步① ----------

class MvCandidatesState {
  const MvCandidatesState(
      {this.items = const [], this.loading = false, this.error});

  final List<Work> items;
  final bool loading;
  final String? error;

  MvCandidatesState copyWith(
          {List<Work>? items, bool? loading, String? error}) =>
      MvCandidatesState(
          items: items ?? this.items,
          loading: loading ?? this.loading,
          error: error ?? this.error);
}

class MvCandidatesNotifier extends StateNotifier<MvCandidatesState> {
  MvCandidatesNotifier(this._ref) : super(const MvCandidatesState());
  final Ref _ref;

  Future<void> load() async {
    if (state.loading) return;
    state = state.copyWith(loading: true);
    try {
      final (items, _) = await _ref.read(apiClientProvider).works(mine: true);
      // 「已完成」= 有可播主音轨的作品
      final done = items.where((w) => (w.audioUrl ?? '').isNotEmpty).toList();
      state = MvCandidatesState(items: done);
    } on ApiException catch (e) {
      state = state.copyWith(loading: false, error: mvUserVisibleError(e));
    } catch (_) {
      state = state.copyWith(loading: false, error: '曲库加载失败，请重试');
    }
  }
}

final mvCandidatesProvider =
    StateNotifierProvider.autoDispose<MvCandidatesNotifier, MvCandidatesState>(
        (ref) => MvCandidatesNotifier(ref));

// ---------- 共用错误文案 ----------

String mvFriendlyError(ApiException e) {
  if (e.code == 'MV_NOT_READY') return e.zh;
  if (e.code == 'NETWORK') return '网络不可达，请检查网络或服务器地址';
  return e.zh;
}

String mvUserVisibleText(String? raw) => userVisibleText(mvHuman(raw));

String mvUserVisibleError(ApiException e) {
  if (e.code == 'BUDGET_EXCEEDED' || e.code == 'CREDITS_NOT_ENOUGH') {
    return '本次操作未完成，请稍后重试';
  }
  return mvUserVisibleText(mvFriendlyError(e));
}
