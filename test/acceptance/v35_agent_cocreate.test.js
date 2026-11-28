// V35 · 智能体共创（伴创）—— 逐条随契约 契约 v5.5 落地时增补，本文件当前覆盖 v5.5.7 预算熔断。
//
// 为什么先做这一条：`l2assistant` 此前**完全没有**预算护栏。全站 fuseCheck 的调用点只有
// `l2music/facade.js:214` 与 `l2mv/facade.js:212`，统一助手一条都没有；而它偏偏是 19 工具、
// 9 个付费动作的那一层，也是"智能体归一"之后唯一要继续长能力的那一层。
// 单轮助手靠"一轮最多一张票"侥幸没出事；多步智能体会连发确认票，侥幸就没了。
//
// 本文件锁死四件事：
//   ① 熔断必须真的拦得住（不发票、不扣费、不派单），且必须落在**发票咽喉内部** —— 放外面就能被绕过；
//   ② 不得误伤：未超预算的付费票、以及 est.credits=0 的免费写票必须照常签发；
//   ③ 护栏触发要按"护栏"收口而不是按"故障"：meta.fused 必须进响应体（此前 cleanMeta 白名单里没有 fused，
//      客户端只能读中文文案猜"是被挡了还是没听懂" —— 即 v5.4.5 给 gated 记过的那类观测缺口）；
//   ④ 文案必须诚实：累计额度是**账号级**的，写"请新开会话继续"是把用户支使去撞第二道墙（v5.4.2 同源）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S, adminToken, seq = 0;

async function loginAdmin(ctx) {
  const r = await ctx.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
  assert.strictEqual(r.status, 200, '管理员登录应 200，实际 ' + r.status + ' ' + r.text.slice(0, 160));
  return r.json.token;
}
async function setFlag(token, key, enabled, grayscale) {
  const r = await S.api('POST', '/admin/config/features', {
    token, json: { key, enabled, grayscale: grayscale === undefined ? (enabled ? 1 : 0) : grayscale },
  });
  assert.strictEqual(r.status, 200, `设置开关 ${key} 应 200，实际 ${r.status} ${r.text.slice(0, 160)}`);
  return r.json.flag;
}
const balance = async (token) => (await S.credits(token)).balance;
const ctxOfWork = (id) => ({ surface: 'library', refs: [{ type: 'work', id }] });
const ask = (token, text, context, sessionId) => S.api('POST', '/v1/assistant/messages', {
  token,
  json: Object.assign(
    { text, client_msg_id: 'v34-' + Date.now() + '-' + (++seq) },
    context ? { context } : {},
    sessionId ? { session_id: sessionId } : {}),
});
const musicJobRows = (userId) => S.db.all("SELECT * FROM jobs WHERE user_id=? AND type='music'", userId);
// 白盒写库：helpers 的 db 门面只有 all（只读），写必须走 openWhiteDb（同 v17 的 dbWrite）
function dbWrite(ctx, sql, ...params) {
  const w = H.openWhiteDb(ctx.dbPath);
  try { w.prepare(sql).run(...params); } finally { try { w.close(); } catch (e) { /* noop */ } }
}
// 把某账号的"已消费票面价"顶到指定累计值：熔断读的就是这个口径（沿用 l2music 的账号级语义）
const forceSpent = (userId, credits) => dbWrite(S,
  "INSERT INTO chat_tickets(id,scope,subject_type,subject_id,user_id,action,args_json,est_credits,est_minutes,hash,ver,status,created_at,consumed_at)"
  + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  'mk_v34_fuse_' + Date.now() + '_' + (++seq), 'assistant', 'user', userId, userId,
  'music.adjust_params', '{}', credits, 1, 'h', 'v', 'consumed',
  new Date().toISOString(), new Date().toISOString());
// 审计落 audit(kind,obj)（store.js:495），user_id 在 obj JSON 里，不在列上
const fuseAudit = (userId) => S.db.all("SELECT * FROM audit WHERE kind='assistant.fuse' AND obj LIKE ?", '%' + userId + '%');

describe('V35 智能体共创 · 预算熔断（契约 v5.5.7）', () => {
  before(async () => {
    // LLM 在验收环境不可达 → mode=rule，判定确定，不会因模型抖动漏判熔断是否触发
    S = await H.boot('V34', { env: { MB_MV_ASSISTANT_CHAT: '1', MB_MUSIC_ASSISTANT: '1', MB_MUSIC_ASSISTANT_CHAT: '1' } });
    S.executor.transcodeMode = 'real';
    adminToken = await loginAdmin(S);
  });
  after(async () => {
    if (S) {
      // 闸门复原：assistant_actions 必须回到关（fail-closed），否则会污染后续套件
      await setFlag(adminToken, 'assistant_actions', false, 0);
      S.executor.transcodeMode = 'park';
      await S.close();
    }
  });

  async function paidUser() {
    const g = await S.newGuest();
    await S.credits(g.token); S.seedLedger(g.user.id, 1000);
    const workId = S.seedWork(g.user.id, { title: '熔断样本' });
    await setFlag(adminToken, 'assistant_actions', true, 1);
    return { g, workId };
  }

  it('V35-⑱a 未超预算时付费票照常签发（熔断不得误伤正常路径）', async () => {
    const { g, workId } = await paidUser();
    const r = await ask(g.token, '再欢快一点', ctxOfWork(workId));
    assert.strictEqual(r.status, 200, '正常付费应 200，实际 ' + r.status + ' ' + r.text.slice(0, 160));
    assert.ok(r.json.ticket && r.json.ticket.action === 'music.adjust_params',
      '未超预算必须签发 music.adjust_params 票，实际 ' + JSON.stringify(r.json).slice(0, 200));
    assert.notStrictEqual((r.json.meta || {}).fused, true, '未超预算不得报 fused');
    assert.strictEqual(r.json.ticket.status, 'pending', '签发阶段票必须 pending');
    assert.strictEqual(musicJobRows(g.user.id).length, 0, '签发阶段不得派单');
  });

  it('V35-⑱b 免费写票（est.credits=0）不受熔断影响', async () => {
    const { g, workId } = await paidUser();
    // 先把账号累计顶过阈值：若免费票也被拦，说明熔断没区分付费/免费，会把助手整个封死
    forceSpent(g.user.id, 130);
    const r = await ask(g.token, '把《熔断样本》标题改成《改名测试》', ctxOfWork(workId));
    assert.strictEqual(r.status, 200, '免费写应 200，实际 ' + r.status + ' ' + r.text.slice(0, 160));
    const meta = r.json.meta || {};
    assert.notStrictEqual(meta.fused, true, '免费写（cost=0）不得被预算护栏拦下：' + JSON.stringify(meta));
    if (meta.tool === 'music.set_title') {
      assert.ok(r.json.ticket, '免费写票必须照常签发');
    }
  });

  it('V35-⑱c 超软预算 → meta.fused + 会话 broken + 不发票不扣费不派单', async () => {
    const { g, workId } = await paidUser();
    const health0 = await S.api('GET', '/healthz');
    const audit0 = (health0.json && health0.json.audit_failures) || 0;
    forceSpent(g.user.id, 130); // 基准 100 × 120% = 120，130 越线
    const bal0 = await balance(g.token);
    const jobs0 = musicJobRows(g.user.id).length;

    const r = await ask(g.token, '再欢快一点', ctxOfWork(workId));
    assert.strictEqual(r.status, 200, '熔断须诚实回执 200，不得 5xx/悬挂，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    const meta = r.json.meta || {};
    assert.strictEqual(meta.fused, true, 'meta.fused 必须进响应体（此前 cleanMeta 无 fused 白名单）：' + JSON.stringify(meta));
    assert.strictEqual(r.json.ticket, undefined, '熔断时不得签发确认票');
    assert.strictEqual(await balance(g.token), bal0, '熔断不得扣费');
    assert.strictEqual(musicJobRows(g.user.id).length, jobs0, '熔断不得派单');
    const sess = S.db.all('SELECT * FROM chat_sessions WHERE id=?', r.json.session_id)[0];
    assert.ok(sess && sess.status === 'broken', '熔断必须落 chat_sessions.status=broken，实际 ' + JSON.stringify(sess && sess.status));
    assert.ok(fuseAudit(g.user.id).length, '熔断必须留审计痕 audit(kind=assistant.fuse)，否则事后无从归因');
    const health1 = await S.api('GET', '/healthz');
    assert.strictEqual((health1.json && health1.json.audit_failures) || 0, audit0,
      '护栏触发不是故障，不得污染 audit_failures（对齐 v5.3.4）');
  });

  it('V35-⑱d 已 broken 的会话后续请求必须真拒 409（否则熔断只是打了个招呼）', async () => {
    const { g, workId } = await paidUser();
    forceSpent(g.user.id, 130);
    const first = await ask(g.token, '再欢快一点', ctxOfWork(workId));
    assert.strictEqual((first.json.meta || {}).fused, true, '前置：首轮应触发熔断');
    const bal0 = await balance(g.token);
    const r2 = await ask(g.token, '再欢快一点', ctxOfWork(workId), first.json.session_id);
    assert.strictEqual(r2.status, 409, 'broken 会话后续请求必须 409，实际 ' + r2.status + ' ' + r2.text.slice(0, 160));
    const code = String((r2.json && (r2.json.code || (r2.json.error && r2.json.error.code))) || '');
    assert.strictEqual(code, 'SESSION_BROKEN', '必须回 SESSION_BROKEN 供客户端机器分流，实际 ' + JSON.stringify(r2.json).slice(0, 160));
    assert.strictEqual(await balance(g.token), bal0, '被拦的请求一分钱都不能扣');
  });

  it('V35-⑱e 文案诚实：账号级额度不得谎称"新开会话即可继续"（v5.4.2 同源）', async () => {
    const { g, workId } = await paidUser();
    forceSpent(g.user.id, 130);
    const r = await ask(g.token, '再欢快一点', ctxOfWork(workId));
    const reply = String((r.json && r.json.reply) || '');
    assert.ok(/预算|积分/.test(reply), '熔断回复必须说明是被预算护栏挡的，实际「' + reply.slice(0, 80) + '」');
    // 禁的是"许诺新开就能继续"这个句式，不是禁"新开会话"这个词 ——
    // 诚实的写法恰恰要主动说明"新开会话不会清零"，粗断言会把诚实话也判成违规。
    assert.ok(!/请新开会话|新开会话(后|就|即)?可?继续/.test(reply),
      '累计额度是账号级的，许诺"新开会话即可继续"是把用户支使去撞第二道墙：「' + reply.slice(0, 110) + '」');
    assert.ok(/不会.*清零|账号累?计?/.test(reply), '必须说明额度是账号级、新开会话不清零：「' + reply.slice(0, 110) + '」');
    // 并用行为证明上面那句文案不是空话：新会话确实仍被拦
    const r2 = await ask(g.token, '再欢快一点', ctxOfWork(workId));
    assert.strictEqual((r2.json.meta || {}).fused, true, '新开会话仍应被账号级预算拦下（与文案一致）');
    assert.notStrictEqual(r2.json.session_id, r.json.session_id, '确实换到了新会话，排除"同会话假拦截"');
  });

  it('V35-⑱f 闸门复原后 fail-closed：assistant_actions 关时付费动作仍一律 gated', async () => {
    const { g, workId } = await paidUser();
    await setFlag(adminToken, 'assistant_actions', false, 0);
    const bal0 = await balance(g.token);
    const r = await ask(g.token, '再欢快一点', ctxOfWork(workId));
    assert.strictEqual(r.status, 200, '闸门关闭应 200 诚实门控，实际 ' + r.status);
    assert.strictEqual((r.json.meta || {}).status, 'gated', '闸门关必须 gated（v5.4.4）');
    assert.strictEqual(r.json.ticket, undefined, '闸门关不得发票');
    assert.strictEqual(await balance(g.token), bal0, '闸门关不得扣费');
  });
});

// ———— V35-㉞ 原生 function calling 的工具面（契约 v5.5，P1）————
// 为什么值得单独立测：模型侧那份 JSON Schema 必须与**治理白名单**逐字一致。
// 两处清单一旦各写各的，就会出现"白名单加了工具、模型永远看不见"或反过来"模型能点、治理不认"，
// 这类漂移没有报错，只会静默表现为"助手不会这个"。同 IA review #7 编译期常量的教训。
const core = require('../../src/server/l2assistant/core.js');
const facade = require('../../src/server/l2assistant/facade.js');

describe('V35 智能体共创 · 原生 tools 面（契约 v5.5）', () => {
  const schemas = facade.toolSchemas();
  const byName = Object.fromEntries(schemas.map((s) => [s.function.name, s.function]));
  // 自带上下文：上一个 suite 的 after() 已把 S 关掉，跨 suite 复用同一个会连不上（不是产品问题）
  let S2;
  before(async () => { S2 = await H.boot('V35-tools'); });
  after(async () => { if (S2) await S2.close(); });

  it('V35-㉞a 模型侧工具清单与治理白名单逐一对齐（防两份清单漂移）', () => {
    const want = Object.keys(core.TOOLS).sort();
    const got = schemas.map((s) => s.function.name).sort();
    assert.deepStrictEqual(got, want, '模型可见工具必须恰为白名单 19 项，不缺不多');
    assert.strictEqual(schemas.length, 19, '统一助手工具面应恰为 19 项（契约 v5.0）');
  });

  it('V35-㉞b 单个 ID 类参数不进模型 schema（靠限制能力，不靠 prompt 承诺）', () => {
    const leaks = [];
    for (const [name, def] of Object.entries(core.TOOLS)) {
      for (const [key, spec] of Object.entries((def && def.params) || {})) {
        if (!spec || !['entity', 'shotId'].includes(spec.kind)) continue;
        const props = (byName[name] && byName[name].parameters.properties) || {};
        if (key in props) leaks.push(name + '.' + key);
        const req = (byName[name] && byName[name].parameters.required) || [];
        if (req.includes(key)) leaks.push(name + '.' + key + '(required)');
      }
    }
    assert.deepStrictEqual(leaks, [], '模型不得有机会提供作品/镜头/人格 ID（v5.4.3：这类 ID 只认服务端核验的 refs）');
    // 反向保护：shotIds 承载"顺序"语义，一刀切隐藏会把镜头重排打死
    assert.ok(byName['mv.shot_reorder'].parameters.properties.order, 'mv.shot_reorder.order 必须保留，否则重排功能被误杀');
  });

  it('V35-㉞c 类型映射正确：integer 给数值区间、string 给长度上限，不得混用', () => {
    const card = byName['music.set_card'].parameters.properties;
    assert.strictEqual(card.sec.type, 'integer');
    assert.strictEqual(card.sec.minimum, 15, 'integer 必须带 minimum（治理域 15..240）');
    assert.strictEqual(card.sec.maximum, 240, 'integer 必须带 maximum');
    assert.strictEqual(card.bpm.minimum, 40);
    assert.strictEqual(card.bpm.maximum, 200);
    // string 的 max 是**长度**上限，误映射成 maximum 会让模型以为可以传数值区间
    assert.strictEqual(card.scene_desc.type, 'string');
    assert.strictEqual(card.scene_desc.maxLength, 300, 'string 必须映射成 maxLength');
    assert.strictEqual(card.scene_desc.maximum, undefined, 'string 不得出现 maximum（长度≠数值上限）');
    assert.deepStrictEqual(card.vocal.enum, ['song', 'instrumental', 'unknown'], 'enum 值必须与治理 spec 一致');
    assert.ok(!('mood' in byName['music.set_card'].parameters.required), 'optional 参数不得进 required');
  });

  it('V35-㉞d 每个工具都有描述，付费项必须写明需用户确认，且不得出现"已完成/已生成"', () => {
    const PAID = ['music.adjust_params', 'music.regenerate', 'music.cover', 'music.extend', 'mv.shot_reshoot'];
    for (const name of Object.keys(core.TOOLS)) {
      const d = String(byName[name].description || '');
      assert.ok(d.length >= 6, name + ' 缺工具描述，模型无从选择');
      assert.ok(!/已完成|已生成|已扣费|已提交成功/.test(d), name + ' 描述不得暗示已办成（拍板权在人，v5.0）');
      if (PAID.includes(name) || !core.TOOLS[name].readOnly) {
        assert.ok(/需用户确认|确认/.test(d), name + ' 是写/付费动作，描述必须写明需用户确认');
      }
    }
  });

  it('V35-㉞e 工具面绝不外泄执行体，只给 name/description/parameters', () => {
    for (const s of schemas) {
      assert.deepStrictEqual(Object.keys(s).sort(), ['function', 'type'], '外层只允许 type/function');
      assert.deepStrictEqual(Object.keys(s.function).sort(), ['description', 'name', 'parameters'],
        '给模型的只能有 name/description/parameters，执行体绝不外泄');
    }
  });

  it('V35-㉞f 规则模式常开：原生 tools 不可用也不影响工具命中（LLM 关时仍出结果）', async () => {
    const g = await S2.newGuest();
    const r = await S2.api('POST', '/v1/assistant/messages', {
      token: g.token, json: { text: '搜一下轻电子', client_msg_id: 'v35t-' + Date.now() },
    });
    assert.strictEqual(r.status, 200, 'LLM 不可达时规则层必须照常应答，实际 ' + r.status + ' ' + r.text.slice(0, 140));
    assert.strictEqual((r.json.meta || {}).mode, 'rule', '未开灰度/LLM 不可达必须记 mode=rule，不得假称 llm+rule');
  });
});

// ———— V35-㉟ 原生 tool_calls 真跑（假 LLM，契约 v5.5 / P1）————
// 前面 ⑱/㉞ 都测不到这条路径：验收环境 LLM 不可达，一律 mode=rule。
// 而 P1 的风险恰恰全在解析与取舍上：arguments 怎么 parse、白名单外的工具名怎么处置、
// 思考模型 content 为 null 而 reasoning 满屏时**会不会把推理草稿当回复吐给用户**（附录 A 实测就是这个形状）。
// 所以起一个假 OpenAI 兼容端点，把这三种形状逐一喂进去。
const http = require('node:http');

describe('V35 智能体共创 · 原生 tool_calls 真跑（假 LLM）', () => {
  const REASONING = '我在琢磨该调哪个工具，这段推理草稿绝不该出现在回复里';
  let S3, adminToken, fake, script = {}, nodeId;

  const completionFor = (payload) => {
    if (script.mode === 'no_tools' && payload.tools) {
      return { code: 400, body: { error: { message: 'This model/server does not support tools' } } };
    }
    if (script.mode === 'no_tools') {
      // 文本协议（旧路）应答：手搓 JSON —— 用来验证端点不认 tools 时仍能降级出结果
      return { code: 200, body: { choices: [{ message: { content: '{"intent":"搜索","tool":"library.search","args":{"q":"轻电子"},"reply":"找到几首轻电子"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } } };
    }
    if (script.mode === 'bogus') {
      return { code: 200, body: { choices: [{ message: { content: null, reasoning: REASONING, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'not.a.real.tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } } };
    }
    if (script.mode === 'reasoning_only') {
      return { code: 200, body: { choices: [{ message: { content: null, reasoning: REASONING }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 30 } } };
    }
    return { code: 200, body: { choices: [{ message: { content: null, reasoning: REASONING, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'library.search', arguments: '{"q":"轻电子"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 44, completion_tokens_details: { reasoning_tokens: 30 } } } };
  };

  before(async () => {
    fake = http.createServer((req, res) => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'fake-llm', object: 'model' }] }));
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch (e) { /* 交给下游报错 */ }
        const out = completionFor(payload);
        res.writeHead(out.code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    S3 = await H.boot('V35-llm');
    const lg = await S3.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
    adminToken = lg.json.token;
    const nc = await S3.api('POST', '/admin/model-nodes', {
      token: adminToken, json: { kind: 'llm', engine: 'fake-llm', endpoint: 'http://127.0.0.1:' + port + '/v1', label: 'V35 假 LLM' },
    });
    nodeId = (nc.json && (nc.json.node && nc.json.node.id || nc.json.id)) || null;
    assert.ok(nodeId, '注册假 llm 节点应成功，实际 ' + nc.status + ' ' + nc.text.slice(0, 140));
    // 显式把 llm 默认节点指到假端点（不依赖"新建即默认"，也不受环境已有节点影响）
    dbWrite(S3, 'DELETE FROM model_defaults WHERE kind=\'llm\'');
    dbWrite(S3, 'INSERT INTO model_defaults(kind,node_id,locked,created_at,updated_at) VALUES(?,?,0,?,?)', 'llm', nodeId, new Date().toISOString(), new Date().toISOString());
    const fl = await S3.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'assistant_chat_music', enabled: true, grayscale: 1 } });
    assert.strictEqual(fl.status, 200, '开启对话灰度应 200，实际 ' + fl.status);
  });
  after(async () => {
    if (S3) {
      await S3.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'assistant_chat_music', enabled: false, grayscale: 0 } });
      await S3.close();
    }
    if (fake) fake.close();
  });
  let n = 0;
  const say = async (token, text) => (await S3.api('POST', '/v1/assistant/messages', {
    token, json: { text, client_msg_id: 'v35llm-' + Date.now() + '-' + (++n) },
  }));

  it('V35-㉟a 原生 tool_calls 命中白名单工具，且推理草稿绝不外泄成回复', async () => {
    script.mode = 'tool';
    const g = await S3.newGuest();
    const r = await say(g.token, '帮我搜一下轻电子');
    assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 140));
    const meta = r.json.meta || {};
    assert.strictEqual(meta.mode, 'llm+rule', '假 LLM 就绪时必须记 llm+rule，实际 ' + meta.mode);
    assert.strictEqual(meta.tool, 'library.search', '必须采纳原生 tool_calls 的工具名，实际 ' + JSON.stringify(meta));
    assert.ok(!String(r.json.reply || '').includes(REASONING.slice(0, 12)),
      'reasoning 是"正在琢磨调哪个工具"的草稿，绝不能当回复给用户');
    const usage = S3.db.all("SELECT * FROM audit WHERE kind='assistant.llm_usage'").length;
    assert.ok(usage >= 1, '必须记录 token 用量（智能体成本闸门的依据）');
  });

  it('V35-㉟b 白名单外的工具名一律弃用并留痕，不交给下游试试看', async () => {
    script.mode = 'bogus';
    const g = await S3.newGuest();
    const r = await say(g.token, '帮我搜一下轻电子');
    assert.strictEqual(r.status, 200, '幻觉工具名不得把请求打成 5xx，实际 ' + r.status);
    assert.ok((r.json.meta || {}).tool == null, '白名单外的工具名必须被弃（tool 应为 null，不是某个值）：' + JSON.stringify(r.json.meta));
    assert.ok(!String(r.json.reply || '').includes(REASONING.slice(0, 12)), '同样不得外泄推理草稿');
    assert.ok(S3.db.all("SELECT * FROM audit WHERE kind='assistant.tool_call.rejected'").length >= 1,
      '弃用必须留痕，否则模型幻觉无从统计与收敛');
  });

  it('V35-㉟c content 为 null 且无工具调用时，不把 reasoning 冒充答案', async () => {
    script.mode = 'reasoning_only';
    const g = await S3.newGuest();
    const r = await say(g.token, '今天写点什么好');
    assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status);
    assert.ok(!String(r.json.reply || '').includes(REASONING.slice(0, 12)),
      '没有 content 时宁可交回规则层，也不能把 reasoning 当回复（这是最像"能答"的一种错）');
  });

  it('V35-㉟d 端点不认 tools（400）时回落文本协议，仍能命中工具', async () => {
    script.mode = 'no_tools';
    const g = await S3.newGuest();
    const r = await say(g.token, '帮我搜一下轻电子');
    assert.strictEqual(r.status, 200, '降级不得打断助手，实际 ' + r.status + ' ' + r.text.slice(0, 140));
    assert.strictEqual((r.json.meta || {}).tool, 'library.search', '不支持 tools 时必须靠文本协议兜住，实际 ' + JSON.stringify(r.json.meta));
  });
});

// ———— V35-㊱ 真机 LLM（默认跳过；设 MB_REAL_LLM_URL 才跑）————
// 为什么单列一条：假端点只能证明"我的解析写得对"，证明不了"真模型接受我生成的 schema、
// 且不会把 reasoning 当回复"。真 vLLM 完全可能因为某个 JSON Schema 字段直接 400，而假端点什么都收。
// 默认 skip：验收套件必须能在无外网/无 DGX 的机器上跑（见 docs/runbook-dev.md 的 HF_HUB_OFFLINE 口径）。
// 跑法：MB_REAL_LLM_URL=http://100.81.83.59:8090/v1 MB_REAL_LLM_MODEL=qwen38-fp4 node --test test/acceptance/v35_agent_cocreate.test.js
const REAL_URL = process.env.MB_REAL_LLM_URL || '';
const REAL_MODEL = process.env.MB_REAL_LLM_MODEL || 'qwen38-fp4';

describe('V35 智能体共创 · 真机 LLM（可选）', { skip: REAL_URL ? false : '需真实 LLM：设 MB_REAL_LLM_URL 后开启' }, () => {
  let S4, adminToken;
  before(async () => {
    S4 = await H.boot('V35-real');
    const lg = await S4.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
    adminToken = lg.json.token;
    const nc = await S4.api('POST', '/admin/model-nodes', {
      token: adminToken, json: { kind: 'llm', engine: REAL_MODEL, endpoint: REAL_URL, label: 'V35 真机 LLM' },
    });
    const nodeId = (nc.json && (nc.json.node && nc.json.node.id || nc.json.id)) || null;
    assert.ok(nodeId, '注册真机 llm 节点应成功，实际 ' + nc.status + ' ' + nc.text.slice(0, 160));
    dbWrite(S4, "DELETE FROM model_defaults WHERE kind='llm'");
    dbWrite(S4, 'INSERT INTO model_defaults(kind,node_id,locked,created_at,updated_at) VALUES(?,?,0,?,?)', 'llm', nodeId, new Date().toISOString(), new Date().toISOString());
    const fl = await S4.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'assistant_chat_music', enabled: true, grayscale: 1 } });
    assert.strictEqual(fl.status, 200, '开启对话灰度应 200');
  });
  after(async () => {
    if (S4) {
      await S4.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'assistant_chat_music', enabled: false, grayscale: 0 } });
      await S4.close();
    }
  });
  let k = 0;
  const say = async (token, text) => (await S4.api('POST', '/v1/assistant/messages', {
    token, json: { text, client_msg_id: 'v35real-' + Date.now() + '-' + (++k) },
  }));

  it('V35-㊱a 真模型接受生成的 19 份 schema 并产出合法工具决策', async () => {
    const g = await S4.newGuest();
    const cases = [['帮我搜一下轻电子', 'library.search'], ['我现在有哪些待确认的票', 'assistant.ticket_query'], ['我有哪些作品', 'library.search']];
    for (const [text, want] of cases) {
      const r = await say(g.token, text);
      assert.strictEqual(r.status, 200, text + ' 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 140));
      const meta = r.json.meta || {};
      assert.strictEqual(meta.mode, 'llm+rule', text + ' 真模型就绪时必须是 llm+rule，实际 ' + meta.mode);
      assert.ok(meta.tool == null || core.TOOLS[meta.tool], text + ' 命中的工具必须在白名单内，实际 ' + meta.tool);
      assert.ok(String(r.json.reply || '').length > 0, text + ' 必须有回复，不得空转');
      assert.ok(!/reasoning|tool_calls|{"intent"/.test(String(r.json.reply || '')),
        text + ' 回复里不得出现协议痕迹：' + String(r.json.reply).slice(0, 80));
      if (meta.tool) assert.strictEqual(meta.tool, want, text + ' 期望命中 ' + want + '，实际 ' + meta.tool);
    }
    const usage = S4.db.all("SELECT obj FROM audit WHERE kind='assistant.llm_usage' ORDER BY rowid DESC LIMIT 1");
    assert.ok(usage.length, '真机跑过必须留下 token 用量审计');
    const u = JSON.parse(usage[0].obj);
    assert.ok(u.prompt_tokens > 100, 'prompt_tokens 应反映 19 份 schema 的常驻成本（实测约 1.9k），实际 ' + u.prompt_tokens);
  });

  it('V35-㊱b 真模型不得把付费/写动作说成已完成（拍板权在人）', async () => {
    const g = await S4.newGuest();
    const r = await say(g.token, '把这首歌改得更欢快一点');
    const reply = String((r.json && r.json.reply) || '');
    assert.ok(!/已经?(帮你)?(生成|改好|完成|做好)了/.test(reply),
      '不得声称已完成，必须落在确认环节：「' + reply.slice(0, 100) + '」');
  });
});

// ———— V35-①~⑦ / ⑰：意图卡内核与检索围栏（契约 v5.5.6/8/9/10/11/12）————
// 用例号与 CONTRACTS.md v5.5 各行的「验收」列一一对应，契约改了测试就得跟着红。
// 卡一律直接造行，不走 LLM 编译路径：那些缺陷在 answerIntent 本身，
// 借道编译只会让测试结果跟着模型可用性一起抖。
describe('V35 智能体共创 · 意图卡内核与检索（契约 v5.5.6~12）', () => {
  let S5, adminToken, guest;
  const intentApi = require('../../src/server/api/intent.js');

  const mkCard = (ctx, user, over) => {
    const id = 'in_t' + Math.random().toString(36).slice(2, 10);
    const now = new Date().toISOString();
    const o = over || {};
    // 调用方可能传 newGuest() 的返回（{token,user:{id}}）也可能直接传 user，两种都收
    const uid = (user && user.user && user.user.id) || (user && user.id);
    assert.ok(uid, '造卡必须有 user_id：静默插 NULL 会让后面的断言全在骗人');
    // 20 列 ↔ 20 个值逐列写死：上一版把 user_id 的 ? 漏掉，错位成"参数 2 无法绑定"，
    // 看着像产品 bug 其实是测试自己的 SQL 数错列 —— 这类错只能靠逐列对齐防住。
    dbWrite(ctx,
      `INSERT INTO intent_cards(
         id, user_id, source_kind, source_ref, mood, scene_desc, genre_hypotheses, vocal, duration_hint,
         confidence, questions, answers, rounds, status, gen_params, created_at, updated_at, ask_budget, source_text, degraded)
       VALUES(?, ?, 'text', NULL, '', '', ?, ?, '', 0.2, ?, '[]', 0, 'clarifying', '{}', ?, ?, ?, NULL, 0)`,
      id, uid, o.genre || '电子', o.vocal || 'unknown',
      JSON.stringify(o.questions || defaultQs()), now, now, o.ask_budget || 2);
    return id;
  };
  const defaultQs = () => ([
    { q_idx: 0, q: '要人声还是纯音乐？', options: [{ idx: 0, label: '女声', set: { dim: 'gender', tags_add: ['female vocal'] } }, { idx: 1, label: '纯音乐（无人声）', set: { vocal: 'instrumental' } }], recommended_idx: 0 },
    { q_idx: 1, q: '情绪基调？', options: [{ idx: 0, label: '欢快明亮' }, { idx: 1, label: '安静治愈' }, { idx: 2, label: '热血带感' }, { idx: 3, label: '忧伤抒情' }], recommended_idx: 2 },
    { q_idx: 2, q: '节奏更快些？', options: [{ idx: 0, label: '快一点', set: { bpm: 128 } }, { idx: 1, label: '慢一点', set: { bpm: 76 } }], recommended_idx: 0 },
  ]);

  before(async () => {
    S5 = await H.boot('V35-card');
    const lg = await S5.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
    adminToken = lg.json.token;
    guest = await S5.newGuest();
  });
  after(async () => { if (S5) await S5.close(); });
  let n5 = 0;
  const answer = (id, answers) => S5.api('POST', '/v1/intent/' + id + '/answer', {
    token: guest.token, json: { answers, client_msg_id: 'v35c-' + Date.now() + '-' + (++n5) },
  });
  const cardOf = (id) => S5.db.all('SELECT * FROM intent_cards WHERE id=?', id)[0] || null;

  it('V35-① ask_budget 按卡分档：默认卡三题被拒，伴创卡可一次答三题（v5.5.8）', async () => {
    const a = mkCard(S5, guest, { ask_budget: 2 });
    const r2 = await answer(a, [{ q_idx: 0, option_idx: 0 }, { q_idx: 1, option_idx: 0 }, { q_idx: 2, option_idx: 0 }]);
    assert.strictEqual(r2.status, 400, '默认卡一次答三题必须被拒，实际 ' + r2.status);
    assert.ok(/2 题/.test(r2.text), '拒绝文案要说明上限，实际「' + r2.text.slice(0, 120) + '」');

    const b = mkCard(S5, guest, { ask_budget: 3 });
    const r3 = await answer(b, [{ q_idx: 0, option_idx: 0 }, { q_idx: 1, option_idx: 2 }, { q_idx: 2, option_idx: 0 }]);
    assert.strictEqual(r3.status, 200, '伴创卡一次答三题应放行，实际 ' + r3.status + ' ' + r3.text.slice(0, 140));
    assert.strictEqual(Number(cardOf(b).rounds), 1, '三题只算一轮，不得凑成两轮');
  });

  it('V35-② 选项自带 set 才落参数：BPM 今天落不了地的缺陷必须闭掉（v5.5.9）', async () => {
    const id = mkCard(S5, guest, { ask_budget: 3 });
    const r = await answer(id, [{ q_idx: 2, option_idx: 0 }]); // set:{bpm:128}
    assert.strictEqual(r.status, 200, r.text.slice(0, 140));
    const gp = JSON.parse(cardOf(id).gen_params || '{}');
    assert.strictEqual(gp.bpm, 128, 'set.bpm 必须进 gen_params（此前 UPDATE 不含 gen_params，bpm 永远丢）');
  });

  it('V35-③ set.tags_add 不得并入 genre_hypotheses；dim=gender 落 voice 承载位（v5.5.9）', async () => {
    const id = mkCard(S5, guest, { ask_budget: 3, genre: '电子', vocal: 'unknown' });
    const r = await answer(id, [{ q_idx: 0, option_idx: 0 }]); // 女声：tags_add female vocal + dim gender
    assert.strictEqual(r.status, 200, r.text.slice(0, 140));
    const row = cardOf(id);
    const genres = String(row.genre_hypotheses || '');
    assert.ok(genres.includes('电子'), '用户已选的流派不得被 unionArr(cap=3,a优先) 静默挤掉（勾女声出男声根因）');
    assert.ok(!genres.includes('female vocal'), 'tags_add 只能进 gen_params.tags，混进展示位就会挤掉用户的显式选择');
    const gp = JSON.parse(row.gen_params || '{}');
    assert.ok((gp.tags || []).includes('female vocal'), 'tags_add 应落到 gen_params.tags');
    assert.strictEqual(row.voice, '女声', 'dim=gender 的选项必须落 voice 列，而不是靠猜标签');
  });

  it('V35-④ 同题重复提交只算一次，rounds 不多计（v5.5.10 去重合并）', async () => {
    const id = mkCard(S5, guest, { ask_budget: 3 });
    const r = await answer(id, [{ q_idx: 0, option_idx: 1 }, { q_idx: 0, option_idx: 0 }, { q_idx: 1, option_idx: 0 }]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 140));
    const row = cardOf(id);
    const ans = JSON.parse(row.answers || '[]');
    assert.strictEqual(ans.filter((a) => a.q_idx === 0).length, 1, '同一 q_idx 只能留一条，否则 confidence 被刷');
    const first = ans.find((a) => a.q_idx === 0);
    assert.strictEqual(first.option_idx, 1, '重复提交取第一次，后来的必须无效');
    assert.strictEqual(Number(row.rounds), 1);
    // 已答过的题不得跨轮二次计分
    const confAfter = row.confidence;
    const r2 = await answer(id, [{ q_idx: 0, option_idx: 0 }]);
    if (r2.status === 200) {
      assert.ok(Math.abs(Number(cardOf(id).confidence) - Number(confAfter)) < 1e-9, '重复作答同一题不得再涨 confidence');
    }
  });

  it('V35-⑤⑥⑦ patchIntentInternal 内部必须限流，助手通道不再绕桶（v5.5.11）', () => {
    const u = { id: 'u_rate_' + Date.now(), phone: null };
    const row = { id: 'in_rate_' + Date.now(), user_id: u.id, status: 'clarifying', mood: '', genre_hypotheses: '', vocal: 'unknown', scene_desc: '', duration_hint: '', gen_params: '{}', confidence: 0.5, questions: '[]', answers: '[]', rounds: 0, voice: null };
    let limited = 0, ok = 0;
    for (let i = 0; i < 14; i++) {
      try { intentApi.patchIntentInternal(u, row, { bpm: 90 + (i % 5) }); ok++; }
      catch (e) { if (e && e.code === 'RATE_LIMITED') limited++; else throw e; }
    }
    assert.ok(limited >= 1, '连续 14 次内部改卡必须触发限流（此前只有 HTTP 端点限流，助手两条通道一直绕桶）');
    assert.ok(ok >= 8 && ok <= 12, '限流应落在 10 次/60s 附近，实际放行 ' + ok + ' 次');
  });

  it('V35-⑰ 检索：无源如实说没源、艺人问法不给参数域、只映射 catalog 四域（v5.5.5/6）', async () => {
    await S5.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'createAgentMode', enabled: true, grayscale: 1 } });
    await S5.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'agentWebSearch', enabled: true, grayscale: 1 } });

    const r = await S5.api('POST', '/v1/agent/tools/web_search', { token: guest.token, json: { query: '适合夏天的city pop' } });
    assert.strictEqual(r.status, 200, '检索端点应可用，实际 ' + r.status + ' ' + r.text.slice(0, 140));
    const b = r.json;
    assert.ok(/^[0-9a-f]{16}$/.test(String(b.query_hash || '')), 'query_hash 必须是稳定短摘要（缓存与审计都靠它）');
    if (!b.ok) {
      assert.ok(/检索源|没有.*源/.test(String(b.reason || '')), '无源必须如实说明，不能空数组假装搜过了：' + JSON.stringify(b).slice(0, 160));
      assert.deepStrictEqual(b.results, [], '无源时不得凭空造结果');
    }
    const bad = await S5.api('POST', '/v1/agent/tools/web_search', { token: guest.token, json: { query: '写成像某歌手那样的风格' } });
    assert.strictEqual(bad.status, 200);
    assert.strictEqual(bad.json.artist_blocked, true, '模仿具体艺人的问法必须被识别（v5.5.6）');
    const dom = bad.json.domains || {};
    for (const k of ['moods', 'genres', 'style_words', 'voice']) {
      assert.deepStrictEqual(dom[k] || [], [], '艺人问法下四域必须全空：不给任何可转参数的映射');
    }
    // 纯函数侧：只认 catalog 有的词，映射不上要进 dropped
    const ws = require('../../src/server/core/websearch.js');
    const hit = ws.mapDomains('这是一首适合夜晚的电子曲，女声，带点复古合成器');
    assert.ok(hit.hit.genres.length >= 1 && hit.hit.voice.length >= 1, 'catalog 里有的词必须命中');
    const none = ws.mapDomains('完全不相干的一句话 blahblah');
    assert.deepStrictEqual(none.hit.genres, [], '词典没有的说法不得凭空映射');
    assert.ok(none.dropped.length > 0, '映射不上的要如实进 dropped，不能假装什么都没发生');
  });

  it('V35-⑧⑨ 技能投递：只给目录不给正文、rank 150 高于内置、正文按需取（v5.5.12）', async () => {
    const c = await S5.api('GET', '/v1/agent/skills', { token: guest.token });
    assert.strictEqual(c.status, 200, '技能目录应可用，实际 ' + c.status + ' ' + c.text.slice(0, 140));
    const list = c.json.skills || [];
    assert.ok(list.length >= 8, '首批技能至少 8 个，实际 ' + list.length);
    assert.ok(list.every((s) => s.rank === 150), '服务端投递层 rank 必须恒为 150（高于 APK 内置 100 才能免发版热修）');
    assert.ok(list.every((s) => s.body === undefined), '目录只给 name/description：正文常驻会白烧 token');
    assert.ok(list.some((s) => s.name === 'create-pipeline'), '编排器技能必须在目录里');
    const one = await S5.api('GET', '/v1/agent/skills/create-pipeline', { token: guest.token });
    assert.strictEqual(one.status, 200);
    assert.ok(String(one.json.body || '').length > 80, '按需取正文必须拿到方法正文');
    const miss = await S5.api('GET', '/v1/agent/skills/no-such-skill', { token: guest.token });
    assert.strictEqual(miss.status, 404, '不存在的技能要 404，不得返回空正文让模型以为有');
  });

  it('V35-⑩⑪ 偏好读写：同 key 只有一份、能删；灰度关时 /v1/agent/* 一律 404（v5.5.16 / v5.5.2）', async () => {
    const k = 'pref_tempo_' + Date.now();
    const a = await S5.api('PUT', '/v1/agent/memory', { token: guest.token, json: { key: k, value: '偏好 92 bpm' } });
    assert.strictEqual(a.status, 200, a.text.slice(0, 140));
    await S5.api('PUT', '/v1/agent/memory', { token: guest.token, json: { key: k, value: '偏好 100 bpm' } });
    const rows = S5.db.all('SELECT COUNT(*) AS c FROM agent_memory WHERE user_id=? AND key=?', guest.user.id, k)[0];
    assert.strictEqual(Number(rows.c), 1, '同一偏好只能有一份，堆积会让 prompt 里全是自相矛盾的历史残骸');
    const g = await S5.api('GET', '/v1/agent/memory', { token: guest.token });
    assert.ok((g.json.memories || []).some((m) => m.key === k && m.value === '偏好 100 bpm'), 'UPSERT 必须是覆盖不是追加');
    const d = await S5.api('DELETE', '/v1/agent/memory/' + k, { token: guest.token });
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.json.removed, true, '用户必须能删掉自己被打上的偏好');
    const bad = await S5.api('PUT', '/v1/agent/memory', { token: guest.token, json: { key: '中文 key', value: 'x' } });
    assert.strictEqual(bad.status, 400, 'key 必须限字符集，否则同一偏好会被大小写/全角变体堆成多份');

    // v5.5.2 的正确方向：新特性位**就该**走 GET /v1/app/config（运营要能关断），
    // 禁止的只是把它塞进 /v1/assistant/bootstrap 的 capabilities（v5.0 固定六字段，旧客户端解析会碎）。
    // 路径必须写对：上一版误写 /v1/config → 404 → features 是空对象 → 断言"字段不存在"空转通过。
    const onCfg = await S5.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'createAgentMode', enabled: true, grayscale: 1 } });
    assert.strictEqual(onCfg.status, 200, '开关联动应 200，实际 ' + onCfg.status);
    const cfgOn = await S5.api('GET', '/v1/app/config', {});
    assert.strictEqual(cfgOn.status, 200, '/v1/app/config 必须 200（断言前先把请求本身验住，否则空对象会让所有"不存在"断言空转）');
    assert.strictEqual(((cfgOn.json || {}).features || {}).createAgentMode, true,
      '运营开启后 App 必须能从 /v1/app/config 读到 createAgentMode，否则第 4 档位永远点不亮（v5.5.2）');

    await S5.api('POST', '/admin/config/features', { token: adminToken, json: { key: 'createAgentMode', enabled: false, grayscale: 0 } });
    const off = await S5.api('POST', '/v1/agent/llm', { token: guest.token, json: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(off.status, 404, '灰度关时智能体端点必须 404，不给探测面（v5.5.2）');
    const cfgOff = await S5.api('GET', '/v1/app/config', {});
    assert.strictEqual(cfgOff.status, 200);
    assert.strictEqual(((cfgOff.json || {}).features || {}).createAgentMode, false, '关断后 App 必须读到 false，第 4 档位随之隐藏');
    // 六字段红线：伴创上线不得动统一助手 bootstrap 的 capabilities 形状
    const bs = await S5.api('GET', '/v1/assistant/bootstrap', { token: guest.token });
    if (bs.status === 200) {
      assert.deepStrictEqual(Object.keys((bs.json || {}).capabilities || {}).sort(),
        ['actions', 'chat', 'llm', 'music', 'mv', 'voice'],
        'capabilities 必须仍是 v5.0 那固定六字段，加字段会碎旧客户端解析（v5.5.2）');
    }
  });
});
