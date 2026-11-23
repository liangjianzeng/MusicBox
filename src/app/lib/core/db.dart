import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import 'models.dart';

/// 本地镜像库：作品缓存（先缓存后网络）/ 播放历史 / 通用离线缓存
class LocalDb {
  LocalDb._(this._db);

  final Database _db;

  static Future<LocalDb> open() async {
    final dir = await getDatabasesPath();
    final db = await openDatabase(
      '$dir/musicbox.db',
      version: 1,
      onCreate: (db, v) async {
        await db.execute(
            'CREATE TABLE works_mirror(id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)');
        await db.execute(
            'CREATE TABLE play_history(id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT, payload TEXT NOT NULL, played_at INTEGER NOT NULL)');
        await db.execute('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      },
    );
    return LocalDb._(db);
  }

  // ---------- 作品镜像 ----------

  Future<void> upsertWorks(List<Work> works) async {
    if (works.isEmpty) return;
    final batch = _db.batch();
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final w in works) {
      batch.insert('works_mirror',
          {'id': w.id, 'payload': jsonEncode(w.toMap()), 'updated_at': now},
          conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  Future<void> cacheWork(Work w) => upsertWorks([w]);

  Future<List<Work>> cachedWorks() async {
    final rows = await _db.query('works_mirror',
        orderBy: 'updated_at DESC', limit: 300);
    return rows
        .map((r) => Work.fromMap(
            (jsonDecode(r['payload'] as String) as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<Work?> cachedWork(String id) async {
    final rows =
        await _db.query('works_mirror', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return Work.fromMap(
        (jsonDecode(rows.first['payload'] as String) as Map).cast<String, dynamic>());
  }

  // ---------- 播放历史 ----------

  Future<void> logPlay(Work w) async {
    await _db.insert('play_history', {
      'work_id': w.id,
      'payload': jsonEncode(w.toMap()),
      'played_at': DateTime.now().millisecondsSinceEpoch,
    });
    // 只保留最近 200 条
    await _db.delete(
      'play_history',
      where: 'id NOT IN (SELECT id FROM play_history ORDER BY played_at DESC LIMIT 200)',
    );
  }

  Future<List<Work>> playHistory() async {
    final rows = await _db.query('play_history',
        orderBy: 'played_at DESC', limit: 60);
    return rows
        .map((r) => Work.fromMap(
            (jsonDecode(r['payload'] as String) as Map).cast<String, dynamic>()))
            .toList();
  }

  // ---------- 通用离线缓存 ----------

  Future<void> setKv(String k, String v) =>
      _db.insert('kv', {'k': k, 'v': v}, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<String?> getKv(String k) async {
    final rows = await _db.query('kv', where: 'k = ?', whereArgs: [k], limit: 1);
    return rows.isEmpty ? null : rows.first['v'] as String;
  }

  /// 清除离线缓存（作品镜像 + kv，保留播放历史供“我的”回顾）
  Future<void> clearCache() async {
    await _db.delete('works_mirror');
    await _db.delete('kv');
  }

  Future<void> close() => _db.close();
}
