// V2 · 生成闭环（验收驱动施工 · 施工方 D · 2026-11-23）
// 断言源：CONTRACTS.md §0（错误码/审核）/§2（works/generate 参数边界与幂等）/§4（fail→refund）
//         docs/musicbox-construction-plan.md §5 V2：同参数并发 5 请求只 1 job；失败呈现真实错误码+自动 refund。
// transcode 双向（fake executor 内置）：ffmpeg 存在→真实转码断 done；缺失→fail(FFMPEG_MISSING) 断 failed+refund。
//   —— 断言方向按环境自动选择：done 方向在无 ffmpeg 机器上按前置条件跳过（施工计划 §2 ffmpeg 待装），fail 方向恒执行。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const H = require('./helpers.js');

let S;

describe('V2 生成闭环', () => {
  before(async () => { S = await H.boot('V2'); });
  after(async () => { if (S) await S.close(); });

  it('V2-① 同参数并发 5 请求 → 只建 1 个 job + 4 个 idempotent，且不重复扣分（契约 §2 幂等键）', async () => {
    const g = await S.newGuest();
    const body = { mode: 'simple', prompt: 'v2-concurrent-fixed-9f3c', mood: '轻快', sec: 15, count: 3 };
    const rs = await Promise.all(Array.from({ length: 5 }, () => S.generate(g.token, body)));
    for (const r of rs) {
      assert.strictEqual(r.status, 202, 'V2-① 并发提交每次都应 202（契约 §2），实际 ' + r.status + ' ' + r.text.slice(0, 150));
    }
    const jobIds = new Set(rs.map((r) => r.json.job_id));
    assert.strictEqual(jobIds.size, 1, 'V2-① 同参并发 5 必须收敛为同一 job_id（幂等键=hash(user+归一化参数)），实际 ' + jobIds.size + ' 个: ' + [...jobIds].join(','));
    const fresh = rs.filter((r) => r.json.idempotent === false);
    assert.strictEqual(fresh.length, 1, 'V2-① 应恰有 1 次 idempotent=false、其余 true，实际 flags=' + JSON.stringify(rs.map((r) => r.json.idempotent)));
    const charged = rs.filter((r) => (r.json.credits_charged || 0) > 0);
    assert.strictEqual(charged.length, 1, 'V2-① credits_charged>0 只应出现在首次提交，实际 ' + charged.length + ' 次，响应=' + JSON.stringify(rs.map((r) => r.json)));
    const c = await S.credits(g.token);
    assert.strictEqual(c.balance, 5, 'V2-① 并发 5 次只应扣一次 45，balance 应为 5，实际 ' + c.balance);
  });

  it('V2-② 参数边界：count=5 / sec=300 等非法入参 → 400 BAD_REQUEST（契约 §2 count 1-4、sec 15-240）', async () => {
    const g = await S.newGuest();
    const bad = [
      [{ mode: 'simple', prompt: H.uniq('v2b'), count: 5 }, 'count=5 超上限 4'],
      [{ mode: 'simple', prompt: H.uniq('v2b'), count: 0 }, 'count=0 低于下限 1'],
      [{ mode: 'simple', prompt: H.uniq('v2b'), sec: 300 }, 'sec=300 超上限 240'],
      [{ mode: 'simple', prompt: H.uniq('v2b'), sec: 10 }, 'sec=10 低于下限 15'],
    ];
    for (const [body, why] of bad) {
      const r = await S.generate(g.token, body);
      assert.strictEqual(r.status, 400, 'V2-② ' + why + ' 应 400（契约 §2），实际 ' + r.status + ' ' + r.text.slice(0, 150));
      assert.ok(r.json && r.json.code === 'BAD_REQUEST', 'V2-② ' + why + ' 应返回 {code:BAD_REQUEST,message}（契约 §0 错误约定），实际 ' + r.text.slice(0, 150));
      assert.ok(typeof r.json.message === 'string' && r.json.message.length > 0, 'V2-② 错误响应须含可读 message（契约 §0）');
    }
    const c = await S.credits(g.token);
    assert.strictEqual(c.balance, 50, 'V2-② 参数被拒不得扣分，balance 应仍为 50，实际 ' + c.balance);
  });

  it('V2-③ 审核词命中 → 400 MODERATION_BLOCK 且不扣分（软门样例：占位词「测试违禁词A」）', async () => {
    const g = await S.newGuest();
    const r = await S.generate(g.token, { mode: 'simple', prompt: '来一首关于' + H.WORD_A + '的歌', sec: 15 });
    assert.strictEqual(r.status, 400, 'V2-③ prompt 命中审核词库应 400（契约 §0 MODERATION_BLOCK），实际 ' + r.status + ' ' + r.text.slice(0, 150));
    assert.ok(r.json && r.json.code === 'MODERATION_BLOCK', 'V2-③ 应返回 code=MODERATION_BLOCK，实际 ' + r.text.slice(0, 150));
    const c = await S.credits(g.token);
    assert.strictEqual(c.balance, 50, 'V2-③ 被审核拦截不得扣分，balance 应为 50，实际 ' + c.balance);
    // 对照：同结构但无违禁词 → 正常受理
    const ok = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v2-clean'), sec: 15 });
    assert.strictEqual(ok.status, 202, 'V2-③ 对照组（无违禁词）应 202，实际 ' + ok.status + ' ' + ok.text.slice(0, 150));
  });

  it('V2-④ 余额不足 → 400 CREDITS_NOT_ENOUGH（契约 §0/§1）', async () => {
    const g = await S.newGuest();
    const r1 = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v2r'), sec: 15, count: 3 }); // 扣 45 → 余 5
    assert.strictEqual(r1.status, 202, 'V2-④ 前置 generate(count=3) 应 202，实际 ' + r1.status);
    const c1 = await S.credits(g.token);
    assert.strictEqual(c1.balance, 5, 'V2-④ 前置扣费后 balance 应为 5，实际 ' + c1.balance);
    const r2 = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v2r'), sec: 15, count: 1 }); // 需 15 > 5
    assert.strictEqual(r2.status, 400, 'V2-④ 余额 5 时再扣 15 应 400，实际 ' + r2.status + ' ' + r2.text.slice(0, 150));
    assert.ok(r2.json && r2.json.code === 'CREDITS_NOT_ENOUGH', 'V2-④ 应返回 code=CREDITS_NOT_ENOUGH（契约 §0 常用 code），实际 ' + r2.text.slice(0, 150));
    const c2 = await S.credits(g.token);
    assert.strictEqual(c2.balance, 5, 'V2-④ 拒绝后余额不变（仍 5），实际 ' + c2.balance);
  });

  it('V2-⑤ transcode 失败方向（降级语义，2026-11-23 契约裁决 DEV-TXFAIL）：ffmpeg 缺失 → 父 job 降级 done + wav 直发 + 不退款', async () => {
    const g = await S.newGuest();
    S.executor.transcodeMode = 'fail'; // 强制模拟执行器机缺 ffmpeg（环境本身缺失时 'auto' 亦为此方向）
    try {
      const r = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v2ff'), sec: 15, count: 1 });
      assert.strictEqual(r.status, 202, 'V2-⑤ generate 应 202，实际 ' + r.status);
      // 契约（CONTRACTS §2 降级语义）：transcode 永久失败 → 父 job done，候选 wav master 直发、不退款；
      // 仅当候选为空才 failed+refund。原"failed+refund"推理已由主会话裁决废止（生成成功、产物真实可播不退费）。
      const job = await S.waitForJob(g.token, r.json.job_id, { timeoutMs: 60000 });
      assert.strictEqual(job.status, 'done', 'V2-⑤ transcode 连败后 job 应降级 done（契约降级语义），实际 ' + job.status);
      assert.strictEqual(job.error, null, 'V2-⑤ 降级 done 不应带 error，实际 ' + JSON.stringify(job.error));
      const cands = job.candidates || [];
      assert.strictEqual(cands.length, 1, 'V2-⑤ 降级交付应含候选，实际 ' + cands.length);
      assert.strictEqual(cands[0].format, 'wav', 'V2-⑤ 降级候选 format 应为 wav（转码失败回退 master），实际 ' + cands[0].format);
      assert.ok(cands[0].audio_url && /\.wav(\?|$)/.test(cands[0].audio_url), 'V2-⑤ 降级候选 audio_url 应为 wav master URL，实际 ' + cands[0].audio_url);
      const c = await S.credits(g.token);
      assert.strictEqual(c.balance, 35, 'V2-⑤ 降级交付不退款（50-15=35），实际 ' + c.balance);
    } finally {
      S.executor.transcodeMode = 'park';
    }
  });

  it('V2-⑥ transcode 完成方向：ffmpeg 存在 → 真实转码 mp3(320k) + peaks → job done 且候选可播', async (t) => {
    if (!S.ffmpeg) {
      t.skip('V2-⑥ 前置：本机无 ffmpeg（施工计划 §2"ffmpeg 二进制 待装"）。done 方向需在执行器机装 ffmpeg 后执行；fail 方向已由 V2-⑤ 覆盖。');
      return;
    }
    const g = await S.newGuest();
    S.executor.transcodeMode = 'real';
    try {
      const r = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v2ok'), sec: 15, count: 3 });
      assert.strictEqual(r.status, 202, 'V2-⑥ generate 应 202，实际 ' + r.status);
      const job = await S.waitForJob(g.token, r.json.job_id, { timeoutMs: 150000 });
      assert.strictEqual(job.status, 'done', 'V2-⑥ transcode 完成后 job 应 done（契约 §2"transcode 完成后 job 才算 done"），实际 ' + job.status + ' error=' + JSON.stringify(job.error));
      assert.ok(Array.isArray(job.candidates) && job.candidates.length === 3, 'V2-⑥ done 的 job 应含 3 个候选，实际 ' + JSON.stringify(job.candidates && job.candidates.map((c) => c.id)));
      for (const cand of job.candidates) {
        assert.ok(typeof cand.audio_url === 'string' && /^https?:\/\//.test(cand.audio_url), 'V2-⑥ candidate.audio_url 应为绝对 URL（契约 §0 *_url 绝对化），实际 ' + cand.audio_url);
        assert.ok(/\.mp3(\?|$)/.test(cand.audio_url), 'V2-⑥ audio_url 应为转码后播放档 mp3（契约 §2 candidate.format），实际 ' + cand.audio_url);
        assert.strictEqual(cand.format, 'mp3', 'V2-⑥ candidate.format 应为 "mp3"（契约 §2），实际 ' + cand.format);
        const f = await H.httpReq('GET', cand.audio_url, { timeoutMs: 30000 });
        assert.strictEqual(f.status, 200, 'V2-⑥ /f/* 静态读音频应 200（契约 §2 公共静态读），实际 ' + f.status);
        assert.ok(f.buffer.length > 2000, 'V2-⑥ mp3 播放档应有实质内容（>2KB），实际 ' + f.buffer.length + ' 字节');
        const isMp3 = (f.buffer[0] === 0xff && (f.buffer[1] & 0xe0) === 0xe0) || f.buffer.slice(0, 3).toString('latin1') === 'ID3';
        assert.ok(isMp3, 'V2-⑥ 播放档字节须为 MP3（帧同步头或 ID3），实际前 4 字节 ' + f.buffer.slice(0, 4).toString('hex'));
        const dec = spawnSync(S.ffmpeg, ['-v', 'error', '-i', cand.audio_url, '-f', 'null', '-'], { timeout: 120000, windowsHide: true });
        assert.strictEqual(dec.status, 0, 'V2-⑥ 播放档必须真实可解码（ffmpeg 校验），stderr=' + (dec.stderr || '').toString().slice(0, 300));
      }
      const c = await S.credits(g.token);
      assert.strictEqual(c.balance, 5, 'V2-⑥ 成功路径不退款，balance 应维持 50-45=5，实际 ' + c.balance);
    } finally {
      S.executor.transcodeMode = 'park';
    }
  });

  it('V2-⑦ seed/instrumental 显式入参必须落 payload 并进幂等键（契约 §2 文本创作线 2026-11-24 补白名单）', async () => {
    const payload = (id) => {
      const r = S.db.all('SELECT payload FROM jobs WHERE id=?', String(id));
      return r.length ? JSON.parse(r[0].payload) : null;
    };
    const g = await S.newGuest();
    const base = { mode: 'custom', prompt: H.uniq('v2seed'), lyrics: '[Verse]\n验收歌词', bpm: 100, sec: 15, count: 1 };
    const a = await S.generate(g.token, Object.assign({}, base, { seed: 4242, instrumental: false }));
    assert.strictEqual(a.status, 202, 'V2-⑦ 带 seed 提交应 202，实际 ' + a.status + ' ' + a.text.slice(0, 150));
    const b = await S.generate(g.token, Object.assign({}, base, { seed: 4242, instrumental: false }));
    assert.strictEqual(b.json.job_id, a.json.job_id, 'V2-⑦ 同参同 seed 应命中幂等返回同一 job，实际 ' + b.json.job_id + ' vs ' + a.json.job_id);
    assert.strictEqual(b.json.idempotent, true, 'V2-⑦ 同参同 seed 重复提交应 idempotent:true 且不重复扣分，实际 ' + JSON.stringify(b.json));
    const c = await S.generate(g.token, Object.assign({}, base, { seed: 9999, instrumental: false }));
    assert.notStrictEqual(c.json.job_id, a.json.job_id, 'V2-⑦ 改 seed 必须派新 job——否则 10 分钟幂等窗口把「换个 Seed 再来」吃掉（契约 §2 幂等键含 seed）');
    const pa = payload(a.json.job_id), pc = payload(c.json.job_id);
    assert.strictEqual(pa && pa.seed_base, 4242, 'V2-⑦ body.seed 必须写进 payload.seed_base（候选依次 +0/+1/+2），实际 ' + JSON.stringify(pa && pa.seed_base));
    assert.strictEqual(pc && pc.seed_base, 9999, 'V2-⑦ 第二单 payload.seed_base 应为 9999，实际 ' + JSON.stringify(pc && pc.seed_base));
    const badSeed = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v2badseed'), sec: 15, seed: -5 });
    assert.strictEqual(badSeed.status, 400, 'V2-⑦ 非法 seed（-5）应 400 BAD_REQUEST，实际 ' + badSeed.status + ' ' + badSeed.text.slice(0, 150));

    const g2 = await S.newGuest(); // 独立游客：避开每日 50 积分对多单断言的干扰
    const i1 = await S.generate(g2.token, { mode: 'simple', prompt: H.uniq('v2inst'), sec: 15, count: 1, instrumental: true });
    assert.strictEqual(i1.status, 202, 'V2-⑦ instrumental=true 提交应 202，实际 ' + i1.status + ' ' + i1.text.slice(0, 150));
    const pi = payload(i1.json.job_id);
    assert.strictEqual(pi && pi.instrumental, true, 'V2-⑦ instrumental=true 必须落 payload（纯音乐不得只靠 tags 里一个「纯音乐」碰运气），实际 ' + JSON.stringify(pi && pi.instrumental));
    const v1 = await S.generate(g2.token, { mode: 'simple', prompt: H.uniq('v2vocal'), sec: 15, count: 1, instrumental: false });
    const pv = payload(v1.json.job_id);
    assert.ok(pv && String(pv.lyrics).trim() === '', 'V2-⑦ 前置：该单应无歌词，实际 ' + JSON.stringify(pv && pv.lyrics));
    assert.strictEqual(pv.instrumental, false, 'V2-⑦ 显式 instrumental=false 不得被「空歌词即纯音乐」推断覆盖（人声+留空歌词曾被误判纯音乐），实际 ' + JSON.stringify(pv.instrumental));
    const badInst = await S.generate(g2.token, { mode: 'simple', prompt: H.uniq('v2badinst'), sec: 15, instrumental: 'maybe' });
    assert.strictEqual(badInst.status, 400, 'V2-⑦ 非法 instrumental 应 400，实际 ' + badInst.status + ' ' + badInst.text.slice(0, 150));
  });
});
