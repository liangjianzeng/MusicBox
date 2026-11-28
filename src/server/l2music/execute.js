// 音乐助手执行层（契约 v3.1 / 架构 l2，2026-11-24）——助手命令的落地点，复用既有派单/编辑原语。
// 纪律：免费工具走 applyMusicFree（复用 PATCH/点改语义 + 审计 initiated_by='assistant'）；付费动作一律经确认票
//       → executeMusicTicketAction，扣费唯一落点 = works.dispatchMusic（先扣后派单，账本复式记账）。
//       adjust 的 NL 解析在「发票前」由 resolveAdjust 完成（understood=false 只追问、不发票），杜绝"NL 直接扣费"后门。
'use strict';
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const engine = require('../core/engine');
const rules = require('../core/rules');
const U = require('../core/util');
const AC = require('../core/appconfig');
const lex = require('../rules/mv_lexicon');
const worksApi = require('../api/works');
const intentApi = require('../api/intent');
const adjustPrompt = require('../prompts/adjust');

const G = config.gen;

function ownWork(user, id) {
  const w = store.get('SELECT * FROM works WHERE id=?', String(id || ''));
  if (!w || w.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '作品不存在');
  return w;
}
function ownIntent(user, id) {
  const row = store.get('SELECT * FROM intent_cards WHERE id=?', String(id || ''));
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
  return row;
}

// —— 免费直执通道（set_title / set_card）+ 只读（query_status）——
function applyMusicFree(user, subject, tool, args) {
  const now = U.nowIso();
  if (tool === 'music.query_status') {
    if (subject.type === 'intent') {
      const row = ownIntent(user, subject.id);
      return { reply: '意图卡当前状态：' + ({ clarifying: '待你补充澄清', ready: '已明确，可以出曲了', consumed: '已用来出过曲' }[row.status] || row.status) + '。' };
    }
    const w = ownWork(user, subject.id);
    const dur = w.duration_sec ? Math.round(w.duration_sec) + ' 秒' : '时长未知';
    return { reply: '《' + lex.sanitize(String(w.title || '未命名灵感')).slice(0, 40) + '》当前状态：' + (w.status === 'draft' ? '草稿（未采用为正式作品）' : w.status) + '，时长约 ' + dur + '。' };
  }
  if (tool === 'music.set_title') {
    if (subject.type !== 'work') throw new U.ApiError('BAD_REQUEST', '改标题需要一首已生成的作品');
    const w = ownWork(user, subject.id);
    rules.moderateFields([args.title]);
    const t = lex.sanitize(String(args.title)).slice(0, 80);
    store.run('UPDATE works SET title=? WHERE id=?', t, w.id); // works 无 updated_at 列（对齐 patchWork）
    store.log('works.patch', { user_id: user.id, work_id: w.id, fields: ['title'], initiated_by: 'assistant' });
    return { reply: '标题已改为「' + t + '」。' };
  }
  if (tool === 'music.set_card') {
    if (subject.type !== 'intent') throw new U.ApiError('BAD_REQUEST', '调意图卡需要先有一张意图卡（说一句或哼一段灵感即可生成）');
    const row = ownIntent(user, subject.id);
    if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '这张意图卡已经用过，请重新发起灵感');
    const body = {};
    // 键列表取自唯一真源（v5.5.9），不再手抄：漏一个键就是「说了改好了但卡没变」
    for (const k of require('../core/fields').SET_CARD_KEYS) if (args[k] !== undefined) body[k] = args[k];
    if (!Object.keys(body).length) throw new U.ApiError('BAD_REQUEST', '没有要改的参数');
    intentApi.patchIntentInternal(user, row, body); // 复用点改内核（净化 + 审核 + 审计）
    store.log('music.assistant.exec', { user_id: user.id, subject_id: subject.id, action: 'music.set_card', fields: Object.keys(body), initiated_by: 'assistant' });
    return { reply: '意图卡已按你说的调整（' + Object.keys(body).join('、') + '）。要我照这版出曲吗？' };
  }
  throw new U.ApiError('BAD_REQUEST', '该操作需要走确认票');
}

// —— 昂贵动作在「发票前」解析（adjust 的 NL→delta 在此完成；understood=false 只追问不发票）——
async function resolveAdjust(user, subject, args) {
  if (subject.type !== 'work') return { ok: false, clarify: '微调要针对一首已生成的作品' };
  const w = ownWork(user, subject.id);
  const base = worksApi.variationBase(w); base.count = G.count_default;
  const r = await adjustPrompt.parseAdjust(String(args.text || ''), base);
  if (!r.understood) return { ok: false, clarify: r.clarify || '没太理解，能换个说法吗？比如再欢快一点、改成纯音乐、换女声' };
  return { ok: true, merged: adjustPrompt.mergeDelta(base, r.delta) };
}

// —— 确认票消费后的唯一执行器（付费动作一律经此；扣费唯一落点 = dispatchMusic）——
async function executeMusicTicketAction(user, subject, action, args, ticket) {
  const audit = { user_id: user.id, subject_type: subject.type, subject_id: subject.id, action, ticket_id: ticket ? ticket.id : null, initiated_by: 'assistant' };
  if (action === 'music.adjust_params') {
    if (subject.type !== 'work') throw new U.ApiError('BAD_REQUEST', '微调要针对一首已生成的作品');
    ownWork(user, subject.id);
    let merged = args && args.merged;
    if (!merged) {
      const rs = await resolveAdjust(user, subject, args);
      if (!rs.ok) throw new U.ApiError('NOT_READY', rs.clarify || '没太理解你想怎么调整', 409);
      merged = rs.merged;
    }
    const d = worksApi.dispatchMusic(user, 'adjust', { ...merged, count: G.count_default },
      { cost: AC.credits().adjust, reason: 'adjust', lineage: { kind: 'adjust', parent_id: subject.id } });
    store.log('music.assistant.exec', Object.assign({}, audit, { result: 'adjust', job_id: d && d.body && d.body.job_id, credits_charged: d && d.body && d.body.credits_charged }));
    return { reply: d && d.body && d.body.idempotent ? '这个调整刚才已经提交过了，不重复扣分。' : '已按你的话重做一版，稍等就能听到。', job_id: d && d.body && d.body.job_id, credits_charged: (d && d.body && d.body.credits_charged) || 0 };
  }
  if (action === 'music.regenerate') {
    if (subject.type === 'intent') {
      const row = ownIntent(user, subject.id);
      const r = intentApi.generateIntentInternal(user, row); // 消费意图卡出曲（内部派单，唯一扣费点）
      store.log('music.assistant.exec', Object.assign({}, audit, { result: 'regenerate_from_intent', job_id: r && r.body && r.body.job_id, credits_charged: r && r.body && r.body.credits_charged }));
      return { reply: r && r.body && r.body.idempotent ? '这版刚才在出了，不重复扣分。' : '好，按这版意图开始生成，几首候选马上就来。', job_id: r && r.body && r.body.job_id, credits_charged: (r && r.body && r.body.credits_charged) || 0 };
    }
    const w = ownWork(user, subject.id);
    const base = worksApi.variationBase(w);
    const count = Math.min(G.count_max, Math.max(G.count_min, Number(args && args.count) || G.count_default));
    const d = worksApi.dispatchMusic(user, 'generate', { ...base, count }, { reason: 'gen' });
    store.log('music.assistant.exec', Object.assign({}, audit, { result: 'regenerate', job_id: d && d.body && d.body.job_id, credits_charged: d && d.body && d.body.credits_charged }));
    return { reply: d && d.body && d.body.idempotent ? '这一批刚才在出了，不重复扣分。' : '好，按这版重新生成 ' + count + ' 个候选。', job_id: d && d.body && d.body.job_id, credits_charged: (d && d.body && d.body.credits_charged) || 0 };
  }
  if (action === 'music.cover') {
    const w = ownWork(user, subject.id);
    const p = store.get('SELECT * FROM personas WHERE id=?', String(args.persona_id));
    if (!p || (p.user_id !== user.id && !p.is_public)) throw new U.ApiError('NOT_FOUND', '声音人格不存在');
    const payload = U.jparse(w.gen_params, {}) || {};
    const cs = args.cover_strength == null ? 0.2 : U.clamp(Number(args.cover_strength) / 100, 0, 1);
    const d = worksApi.dispatchMusic(user, 'cover', {
      prompt: payload.prompt || w.title, tags: U.toArr(w.genres), mood: w.mood, bpm: w.bpm,
      sec: w.duration_sec || G.sec_default, count: 1, lyrics: w.lyrics, instrumental: false,
      persona_id: args.persona_id, cover_strength: cs,
      src_audio: w.audio_master ? path.join(config.paths.out, w.audio_master) : null,
    }, { cost: AC.credits().cover, reason: 'cover', lineage: { kind: 'cover', parent_id: w.id } });
    store.run('UPDATE personas SET use_count=use_count+1 WHERE id=?', args.persona_id);
    store.log('music.assistant.exec', Object.assign({}, audit, { result: 'cover', job_id: d && d.body && d.body.job_id, persona_id: args.persona_id, credits_charged: d && d.body && d.body.credits_charged }));
    return { reply: '好，用这个声音人格翻一版，稍等就好。', job_id: d && d.body && d.body.job_id, credits_charged: (d && d.body && d.body.credits_charged) || 0 };
  }
  if (action === 'music.extend') {
    const w = ownWork(user, subject.id);
    const payload = U.jparse(w.gen_params, {}) || {};
    const sec = Number(args && args.sec) || Math.min(G.sec_max, (w.duration_sec || G.sec_default) + 15);
    const d = worksApi.dispatchMusic(user, 'extend', {
      prompt: payload.prompt || w.title, tags: U.toArr(w.genres), mood: w.mood, bpm: w.bpm,
      sec, count: 1, lyrics: w.lyrics, instrumental: payload.instrumental,
      src_audio: w.audio_master ? path.join(config.paths.out, w.audio_master) : null,
    }, { cost: AC.credits().extend, reason: 'extend', lineage: { kind: 'extend', parent_id: w.id } });
    store.log('music.assistant.exec', Object.assign({}, audit, { result: 'extend', job_id: d && d.body && d.body.job_id, credits_charged: d && d.body && d.body.credits_charged }));
    return { reply: '好，把这首续长到约 ' + sec + ' 秒。', job_id: d && d.body && d.body.job_id, credits_charged: (d && d.body && d.body.credits_charged) || 0 };
  }
  store.log('music.assistant.audit', Object.assign({}, audit, { action: 'tool_not_whitelisted' }));
  throw new U.ApiError('FORBIDDEN', '该动作不允许通过确认票执行');
}

module.exports = { applyMusicFree, executeMusicTicketAction, resolveAdjust, ownWork, ownIntent };
