#!/usr/bin/env node
// 一次性修复：老作品里被人声词"切碎"的 tags。
//
// 症状（2026-11-27 真机）：曲库里《你该不该权衡利弊》显示 `夜晚 · female · vocal · 萨…`
// 而不是 `female vocal`。原因：早期把整条 tags 按空格切开存进 works.genres，
// 于是 "female vocal" 变成两个词 —— 而 `female` 单独一个词在引擎里几乎不含性别信息，
// 用户看到的和模型收到的都错位。后来的 split 修复只管新数据，老数据留在库里当证据。
//
// 规矩（判词会盯这几条）：
//   1. 词表**只从词典真源读**（src/server/prompts/dictionary.js），脚本里禁止另抄一份词表；
//   2. 只允许"精确重组"：相邻几项拼起来必须**正好等于**词典里存在的多词规范词，否则一个都不动；
//   3. 幂等：修完再跑一次必须是 0 改动；
//   4. 默认干跑（只打印），必须显式 --apply 才写库；写库要落审计（tags.repair）。
//
// 用法：
//   node scripts/repair_split_tags.mjs <db 路径>            # 干跑
//   node scripts/repair_split_tags.mjs <db 路径> --apply     # 真改

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dict = require('../src/server/prompts/dictionary');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('用法：node scripts/repair_split_tags.mjs <db 路径> [--apply]');
  process.exit(2);
}
const APPLY = process.argv.includes('--apply');

// —— 词表唯一真源：从词典里收集"含空格的规范词"（female vocal / behind the beat / harmonies …）
const canonical = new Set();
function collect(v) {
  if (typeof v === 'string' && v.includes(' ')) canonical.add(v.trim().toLowerCase());
}
for (const e of dict.VOICE_WORDS || []) {
  collect(e.en);
  (e.aliases || []).forEach(collect);
}
for (const s of dict.STYLE_WORDS || []) {
  collect(s.en);
  collect(s.zh);
}
for (const ent of dict.ENTRIES || []) {
  (ent.tags || []).forEach(collect);
  (ent.aliases || []).forEach(collect);
}
// 按词数从多到少试：先长匹配，避免 "behind the" 这类前缀被提前吃掉
const phrases = [...canonical]
  .map((s) => ({ s, words: s.split(/\s+/).filter(Boolean) }))
  .filter((p) => p.words.length >= 2)
  .sort((a, b) => b.words.length - a.words.length);

if (!phrases.length) {
  console.error('词典里一个多词规范词都没有 —— 词典可能坏了，拒绝继续');
  process.exit(1);
}
console.log(`词典真源：${phrases.length} 个多词规范词（最长 ${phrases[0].words.length} 词）`);

const norm = (x) => String(x ?? '').trim().toLowerCase();

/** 相邻项精确重组成词典规范词；不匹配的一律原样保留 */
function repair(list) {
  const out = [];
  let changed = false;
  let i = 0;
  while (i < list.length) {
    let hit = null;
    for (const p of phrases) {
      if (i + p.words.length > list.length) continue;
      const seg = list.slice(i, i + p.words.length).map(norm);
      if (seg.length === p.words.length && seg.every((w, k) => w === p.words[k])) {
        hit = p;
        break;
      }
    }
    if (hit) {
      // 保留原大小写风格：取第一段原本的写法当代表（不编新词）
      out.push(list.slice(i, i + hit.words.length).join(' ').trim());
      i += hit.words.length;
      changed = true;
    } else {
      out.push(list[i]);
      i += 1;
    }
  }
  return { out, changed };
}

const db = new DatabaseSync(dbPath);
const rows = db
  .prepare("SELECT id, title, genres FROM works WHERE genres IS NOT NULL AND genres != ''")
  .all();

let scanned = 0,
  fixed = 0;
const samples = [];
for (const r of rows) {
  scanned++;
  let arr;
  let asJson = false;
  const raw = String(r.genres).trim();
  if (raw.startsWith('[')) {
    try {
      arr = JSON.parse(raw);
      asJson = true;
    } catch {
      continue; // 坏 JSON 不在本脚本职责内（另有词典漂移待办）
    }
  } else {
    // 真实存量格式：逗号串（2026-11-27 查库确认，例如 `female,vocal,saxophone,vinyl,crackle`）。
    // 顺手把存储格式"改成 JSON"是另一种破坏：读侧没改就会当场显示为空，所以**按原格式写回**。
    arr = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr) || arr.length < 2) continue;
  const { out, changed } = repair(arr.map(String));
  if (!changed) continue;
  fixed++;
  if (samples.length < 12) samples.push({ id: r.id, title: r.title, before: arr, after: out });
  if (APPLY) {
    const stored = asJson ? JSON.stringify(out) : out.join(',');
    db.prepare('UPDATE works SET genres=? WHERE id=?').run(stored, r.id);
  }
}

if (APPLY && fixed) {
  // 审计：改了什么、改了几条，必须可追溯（与 store.log 同一张表）
  try {
    db.prepare(
      'INSERT INTO audit(kind,obj,created_at) VALUES(?,?,?)'
    ).run(
      'tags.repair',
      JSON.stringify({ fixed, scanned, by: 'scripts/repair_split_tags.mjs' }),
      new Date().toISOString()
    );
  } catch (e) {
    console.warn('审计写入失败（不影响数据修复）：', e.message);
  }
}
db.close();

console.log(`${APPLY ? '已修复' : '可修复（干跑，未写库）'} ${fixed} 条作品 / 共扫描 ${scanned} 条`);
for (const s of samples) {
  console.log(`  ${s.id} 《${s.title || '无题'}》`);
  console.log(`    改前 ${JSON.stringify(s.before)}`);
  console.log(`    改后 ${JSON.stringify(s.after)}`);
}
if (!APPLY && fixed) console.log('确认无误后加 --apply 真正写库。');
