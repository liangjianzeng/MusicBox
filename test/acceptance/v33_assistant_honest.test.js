// V33 · 助手"没上下文/没能力"时必须诚实指路，不许背能力清单糊弄
// 断言源：src/server/l2assistant/facade.js ruleInterpret 的 need_context 分支与积分/余额分支。
// 为什么必须有这条（真机实跑抓出来的体感故障，2026-11-27）：
//   用户说「把标题改成《星河》」「把这首歌改得更明亮一点」，服务端回的是
//   「我在。可以查任务和确认票、搜索曲库、解释作品…」—— mode=rule、tool=null。
//   根因不是 LLM 抽风：规则层这些分支全 gated 在 `work`（已核验的作品引用）上，而实体
//   **只认服务端核验过的 context.refs**（CONTRACTS：文本或 LLM 给的 ID 不参与实体解析）。
//   没有 work 时原代码直接掉到最后那句自我介绍 —— 用户听起来就是被忽略，"助手看着不能用"就是这么来的。
//   MV 侧本来就有 need_context 的先例（"先选择一个属于你的 MV 镜头"），音乐侧缺的就是同款。
// 同时锁死两条计费面：这些"没做成"的回合一分钱都不能扣；付费动作在闸门默认关时必须明确告知而不是静默。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

// 那句"能力清单"就是本套件要消灭的东西（与 scripts/verify_real_music.mjs 的 SELF_INTRO 同口径）
const SELF_INTRO = /我在。可以|我可以帮你|作为.*(助手|AI)|可以查任务和确认票/;
const genBody = (idem) => ({
  mode: 'simple', prompt: '清晨海边的轻电子', mood: '治愈', tags: ['electronic'],
  count: 1, sec: 15, idem_key: idem,
});
const balance = async (token) => (await S.credits(token)).balance;
// helpers 的 db 门面只暴露 all/run（没有 get）—— 别再凭空发明 API，用例自己也会腐烂
const workTitle = (id) => { const r = S.db.all('SELECT title FROM works WHERE id=?', id); return r.length ? r[0].title : null; };
let seq = 0;
const ask = (token, text, context) => S.api('POST', '/v1/assistant/messages', {
  token,
  json: Object.assign({ text, client_msg_id: 'v33-' + Date.now() + '-' + (++seq) }, context ? { context } : {}),
});
const workCtx = (id) => ({ surface: 'library', refs: [{ type: 'work', id }] });

let S;
describe('V33 助手诚实兜底与上下文门', () => {
  before(async () => {
    // 统一助手对话版灰度开（helpers 默认 0）；LLM 在验收环境不可达 → mode=rule，正好验确定性兜底
    S = await H.boot('V33', { env: { MB_MV_ASSISTANT_CHAT: '1', MB_MUSIC_ASSISTANT: '1', MB_MUSIC_ASSISTANT_CHAT: '1' } });
    // adopt 需要 works 行真落库，而 works 行来自 transcode 产物 —— 默认 'park' 只占租约不改状态，job 会永远停在 90%
    S.executor.transcodeMode = 'real';
  });
  after(async () => { if (S) { S.executor.transcodeMode = 'park'; await S.close(); } });

  it('V33-① 作品级意图但没有已核验作品 → 诚实说明缺什么，绝不背能力清单，且不扣费', async () => {
    const g = await S.newGuest();
    const bal0 = await balance(g.token);
    const cases = [
      ['把标题改成《星河》', /哪首歌|歌名/],
      ['把这首歌改得更明亮一点', /哪一首|哪首|打开那首歌/],
      ['把这首换一批重出', /哪首歌|歌名|打开/],
    ];
    for (const [text, wantRe] of cases) {
      const r = await ask(g.token, text);
      assert.strictEqual(r.status, 200, text + ' 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 80));
      const reply = String((r.json && r.json.reply) || '');
      const meta = (r.json && r.json.meta) || {};
      assert.ok(!SELF_INTRO.test(reply), text + ' 回的是能力清单式搪塞：「' + reply.slice(0, 60) + '」');
      assert.ok(wantRe.test(reply), text + ' 应答必须点出缺什么，实际「' + reply.slice(0, 80) + '」');
      assert.strictEqual(meta.tool || null, null, text + ' 无上下文不得直接命中工具（防绕过 refs 核验）');
      assert.strictEqual(meta.intent, 'need_context', text + ' 应记 intent=need_context，实际 ' + meta.intent);
    }
    assert.strictEqual(await balance(g.token), bal0, '没做成的回合一分钱都不能扣');
  });

  it('V33-② 问积分/余额 → 不编数字、不假装查过，指路到真实入口，且不扣费', async () => {
    const g = await S.newGuest();
    const bal0 = await balance(g.token);
    const r = await ask(g.token, '帮我看看还有多少积分');
    assert.strictEqual(r.status, 200);
    const reply = String((r.json && r.json.reply) || '');
    assert.ok(!SELF_INTRO.test(reply), '自我介绍式搪塞：「' + reply.slice(0, 60) + '」');
    assert.ok(/余额|积分/.test(reply), '必须正面回应"积分"这件事：「' + reply.slice(0, 60) + '」');
    assert.ok(!/\d+\s*(积分|⚡|块|元)/.test(reply), '不得编造具体数字（工具面里没有只读余额工具）：「' + reply.slice(0, 80) + '」');
    assert.strictEqual((r.json.meta || {}).tool || null, null, '不能凭空冒出一个工具');
    assert.strictEqual(await balance(g.token), bal0, '问一句话不该动余额');
  });

  it('V33-③ 带上已核验作品上下文 → set_title 命中，免费写也必须先出确认票，票未确认不扣钱', async () => {
    if (!S.ffmpeg) { console.log('  ℹ 无 ffmpeg，跳过需要真实产物的用例'); return; }
    const g = await S.newGuest();
    const { work } = await S.genAndAdopt(g.token, genBody('v33-adopt-1'));
    assert.ok(work && work.id, '采纳应出 works 行');
    const bal0 = await balance(g.token);
    const r = await ask(g.token, '把标题改成《星河》', workCtx(work.id));
    const meta = (r.json || {}).meta || {};
    assert.strictEqual(r.status, 200);
    assert.strictEqual(meta.tool, 'music.set_title', '带上下文应命中 set_title，实际 tool=' + meta.tool + ' intent=' + meta.intent + ' reply=「' + String((r.json || {}).reply).slice(0, 60) + '」');
    const hasTicket = !!(r.json.ticket || r.json.ticket_id || (r.json.data && r.json.data.ticket));
    assert.ok(hasTicket, '契约：免费**写**（set_title）仍走确认票，不得静默改库');
    assert.strictEqual(await balance(g.token), bal0, '票未确认不得扣费');
    assert.notStrictEqual(workTitle(work.id), '星河', '未确认的票绝不能已经落库');
  });

  it('V33-④ 付费动作闸门默认关（fail-closed）→ 必须明确告知未开放，不发票、不扣费、不静默', async () => {
    if (!S.ffmpeg) { console.log('  ℹ 无 ffmpeg，跳过'); return; }
    const g = await S.newGuest();
    const { work } = await S.genAndAdopt(g.token, genBody('v33-adopt-2'));
    const bal0 = await balance(g.token);
    const r = await ask(g.token, '把这首歌改得更明亮一点', workCtx(work.id));
    const j = r.json || {}; const meta = j.meta || {};
    assert.strictEqual(r.status, 200);
    const hasTicket = !!(j.ticket || j.ticket_id || (j.data && j.data.ticket));
    if (meta.tool === 'music.adjust_params' && hasTicket) {
      // 闸门被显式打开的环境（例如实机 spark.env）里走这条：付费动作只出票，仍不得先扣钱
      assert.strictEqual(await balance(g.token), bal0, '付费动作出票后、确认前不得扣费');
      return;
    }
    const reply = String(j.reply || '');
    assert.ok(/未开放|尚未|还没有|暂不|不支持/.test(reply), '闸门关时必须说清楚，实际「' + reply.slice(0, 80) + '」');
    assert.ok(!SELF_INTRO.test(reply), '闸门关也不是背能力清单：「' + reply.slice(0, 60) + '」');
    assert.ok(!hasTicket, '闸门关时不得发票');
    assert.strictEqual(await balance(g.token), bal0, '闸门关的一分钱都不能扣');
  });

  it('V33-⑤ 上下文门只认服务端核验过的 refs：他人作品 / 候选 id 冒充都不生效', async () => {
    if (!S.ffmpeg) { console.log('  ℹ 无 ffmpeg，跳过'); return; }
    const owner = await S.newGuest();
    const { work } = await S.genAndAdopt(owner.token, genBody('v33-adopt-3'));
    const intruder = await S.newGuest();
    const bal0 = await balance(intruder.token);

    // ① 他人的作品 id —— 不得被解析成"当前作品"
    const r1 = await ask(intruder.token, '把标题改成《别人的歌》', workCtx(work.id));
    assert.strictEqual((r1.json || {}).meta.tool || null, null, '他人作品不得命中写工具（跨用户引用必须丢弃）');
    // ② 候选 id / 不存在的 id 冒充作品（上一条真机探针就是这么错的）—— 同样不得生效
    const r2 = await ask(intruder.token, '把标题改成《假的》', workCtx('c_not_a_work'));
    assert.strictEqual((r2.json || {}).meta.tool || null, null, '不存在的/候选 id 不得命中写工具');
    assert.ok(S.db.all("SELECT 1 FROM audit WHERE kind LIKE '%refs.rejected%'").length >= 1, '被拒的 refs 必须留审计痕（否则越权尝试无声无息）');
    assert.strictEqual(await balance(intruder.token), bal0, '越权尝试不得扣费');
    // 作品标题真没被改动（白盒复核，不只看 tool=null）
    assert.notStrictEqual(workTitle(work.id), '别人的歌', '他人作品被跨用户改动了 —— 上下文门失效');
  });
});
