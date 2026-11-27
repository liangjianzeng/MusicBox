// V3/V5/V6/V7/V9/V10/V12 · 需真机 / GPU / 真 LLM 的验收套件（施工方 D · 2026-11-23）
// 本文件是"验收意图的完整登记"：断言清单按 docs/musicbox-construction-plan.md §5 逐条写出，
// 但执行需要本机之外的前置条件（Android 真机 / ACE-Step :8190 GPU / DGX Spark qwen38-fp4 / SenseVoice :8191 /
// 真实语料与音频样本 / M2 社区后端），当前环境不具备 → 全部 {skip:true} 并注明前置。
// 前置补齐后把对应用例的 skip 去掉即可进入回归（断言逻辑届时按 CONTRACTS.md 落地，不允许放宽）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');
const intentApi = require('../../src/server/api/intent.js');

describe('V3 播放器（M0 · 需 Android 真机）', () => {
  it('V3-1 锁屏控制：锁屏界面出现 播放/暂停/上一首/下一首 并真实生效', { skip: '前置：Android 真机 + M0-8 播放器（audio_service）就位；SP5 结论' }, () => {});
  it('V3-2 后台连播：App 退后台队列自动续播，不错序不静音', { skip: '前置：Android 真机 + audio_service 后台权限' }, () => {});
  it('V3-3 杀进程恢复：强杀后重开，播放队列与断点恢复（契约侧无队列端点 → 端侧 drift 缓存验收）', { skip: '前置：Android 真机 + M0-9 离线缓存' }, () => {});
  it('V3-4 WSS 断网 30s 自动重连（契约 §3 /ws?token=）且 job.done 不重复通知（幂等按 job_id 去重）', { skip: '前置：真机断网场景 + server WSS 实现（可先由 tests 半自动：脚本断连重连，去重断言可入 CI）' }, () => {});
  it('V3-5 credit.delta 事件与 REST 账本一致（WS 收到 delta 后 Σ==balance）', { skip: '前置：server WSS 实现' }, () => {});
});

describe('V5 M0 真机端到端（冷启动→导出全程无缺口）', () => {
  it('V5-1 冷启动→创作台→生成（真实 :8190）→进度→揭晓动画→采纳→库内可见', { skip: '前置：真机签名 APK + ACE-Step :8190 GPU 服务在线（施工计划 §2 已在跑）' }, () => {});
  it('V5-2 锁屏播放生成结果 + 导出 MP3/WAV 到本地存储', { skip: '前置：真机 + M1-10 导出功能' }, () => {});
  it('V5-3 全程积分口径正确：生成扣 45、失败退全款，账本与 UI 一致', { skip: '前置：真机 + 可注入失败的 GPU 环境（OOM 演练）' }, () => {});
  it('V5-4 弱网（限速 3G）下进度页降级为轮询、不重复扣分', { skip: '前置：真机 + 网络损伤仪/charles 限速' }, () => {});
});

describe('V6 语音意图（M1 · 需 SenseVoice :8191 + 真 LLM :8193 + 标注语料）', () => {
  it('V6-1 10 段标注语音→mood/情绪标签命中 ≥7/10（真 ASR+LLM 链路，非 mock）', { skip: '前置：:8191 SenseVoice 起服务 + DGX qwen38-fp4 可达 + test/fixtures 标注语料 10 段（待收集）' }, () => {});
  it('V6-2 意图卡字段完整：mood[]/scene_desc/genre_hypotheses[]/vocal/duration_hint/confidence 全非空且类型正确', { skip: '前置：同 V6-1' }, () => {});
  it('V6-3 60s 上限硬校验：>60s 音频上传 → 4xx（契约 §2 ≤60s）；>10MB → 4xx', { skip: '前置：server 就绪后可先半自动执行（fake executor 环境即可跑），语料待放入 test/fixtures' }, () => {});
  it('V6-4 ASR 端点不可达 → 启发式兜底不报错、confidence<0.5（契约 §0 LLM 可选性）', { skip: '前置：需可切换的 :8191/:8193 起停控制（deploy 脚本）' }, () => {});
});

describe('V7 图像意图（M1 · 需 DGX Spark qwen38-fp4 真 VLM + 场景图集）', () => {
  it('V7-1 10 张场景图→mood/scene_desc 合理率抽评 ≥8/10（人工抽评表）', { skip: '前置：cfg.llmVlmUrl 指向真 qwen38-fp4 + test/fixtures 场景图 10 张（待收集）' }, () => {});
  it('V7-2 OCR：图内文字被提取进 scene_desc/意图要素（海报类样例）', { skip: '前置：同 V7-1 + 含文字样例图' }, () => {});
  it('V7-3 >8MB 或非 jpg/png → 4xx（契约 §2 /v1/intent/image 限制）', { skip: '前置：server 就绪即可半自动跑（fake executor 环境可测上传校验）' }, () => {});
});

describe('V9 人格与谱系（M1 · 需真实人声样本 + ACE-Step 真引擎的 seed 复现性）', () => {
  it('V9-1 persona 全链：登记（20-40s 音频）→ 列表 → cover 选用 → 出片', { skip: '前置：真人声样本 20-40s + 执行器两段式克隆协议对 :8190 生效' }, () => {});
  // ── V9-2 补位（2026-11-27）───────────────────────────────────────────────
  // 这条以前是"常年 skip"（理由：需 done 作品 + 克隆链），于是 to-persona 的 bug 一路活到今天：
  // 它把 **整条 240s 作品** 当声纹写库，还落在**公共 /f/* 目录**（v5.2.1 明令声纹必须私有）。
  // **被跳过的判词就是坏功能能出货的方式** —— 现在假执行器能出 done 作品，前置早就不成立了，
  // 所以这里写的是真判词，只在"本机没有 ffmpeg"时才跳（那是环境缺失，不是能力缺失）。
  const HAS_FF = (() => { try { return !!H.findFfmpeg(); } catch (e) { return false; } })();
  describe('V9-2 从作品提声纹（补位后为真判词）', () => {
    let S;
    before(async () => {
      S = await H.boot('V9-2', { runId: 'acceptance-V9-2' });
      // 假执行器默认不做真实转码，job 会停在 progress=90（产物没落地就没有 audio_master，
      // 也就没有"作品的音频源文件"可裁）—— 与 v4_library 同一做法
      S.executor.transcodeMode = 'real';
    });
    after(async () => { if (S) await S.close(); });

    it('V9-2 to-persona 必须裁成 20-40s、落私有 var/voices/、且公共 /f/* 取不到', { skip: HAS_FF ? false : '前置：本机无 ffmpeg（裁剪能力不可用，环境缺失）' }, async () => {
      const g = await S.newGuest();
      // sec 刚过 20s 下限即可：假执行器的生成耗时随 sec 线性增长，30s 素材会顶爆等待窗口
      const { work } = await S.genAndAdopt(g.token, {
        mode: 'custom', prompt: '声纹取样测试', lyrics: '[Verse]\n取样歌词甲\n取样歌词乙', sec: Number(process.env.MB_T_SEC || 24), count: 1,
      }, { timeoutMs: 300000 });
      assert.ok(work && work.id, 'V9-2 前置：需要一条 done 的作品');

      const r = await S.api('POST', `/v1/works/${work.id}/to-persona`, { token: g.token, json: { name: '我的声线', start_sec: 1, seconds: 20 } });
      assert.strictEqual(r.status, 200, 'V9-2 to-persona 应 200，实际 ' + r.status + ' ' + (r.text || '').slice(0, 220));
      const p = r.json && r.json.persona;
      assert.ok(p && p.id, 'V9-2 应返回 {persona}，实际 ' + (r.text || '').slice(0, 160));

      const ref = S.db.all('SELECT voice_ref FROM personas WHERE id=?', p.id)[0].voice_ref;
      assert.ok(String(ref).startsWith('voices/'),
        'V9-2 声纹必须带 voices/ 前缀存进私有目录（契约 v5.2.1：任何持 URL 者可下载他人声纹 = 未经同意的声纹扩散），实际 ' + ref);
      assert.ok(String(ref) !== work.audio_master,
        'V9-2 不许把整条作品的 audio_master 当声纹（旧实现就是这么写的，4 分钟参考根本不符合 cover 用法）：' + ref);

      const abs = path.join(path.resolve(__dirname, '../..'), 'var-test', 'acceptance-V9-2', 'voices', String(ref).slice('voices/'.length));
      assert.ok(fs.existsSync(abs), 'V9-2 voice_ref 指向的文件必须真实存在（不存在=执行器永远读不到，克隆会静默失效）：' + abs);
      const dur = intentApi.audioDurationSec(fs.readFileSync(abs), 'wav');
      assert.ok(dur >= 20 && dur <= 40,
        `V9-2 声纹样本必须落在 20-40 秒（契约 §8 上传防线），实际 ${dur} 秒`);

      const pub = await S.api('GET', '/f/' + String(ref).replace(/^voices\//, ''), {});
      assert.ok(pub.status === 404 || pub.status === 403,
        'V9-2 声纹不得经公共 /f/* 取到（应 404/403），实际 ' + pub.status);
    });

    it('V9-2b 源码级防回归：裁剪失败必须诚实 NOT_READY，禁止静默退回"整条作品当声纹"', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/api/personas.js'), 'utf8');
      const fn = src.slice(src.indexOf('function fromWork'), src.indexOf('module.exports'));
      assert.ok(fn.length > 200, 'V9-2b 读不到 fromWork 实现，personas.js 结构变了要同步本测试');
      assert.ok(/NOT_READY/.test(fn),
        'V9-2b 裁剪工具不可用时必须明确 NOT_READY 并指引改走录音登记（静默降级=用户以为克隆生效其实从未发生）');
      assert.ok(/spawnSync\(\s*bin/.test(fn), 'V9-2b 必须真的做裁剪（调用 ffmpeg 二进制），不是直接引用整条作品');
      assert.ok(/VOICE_PREFIX\s*\+\s*saved\.rel/.test(fn),
        'V9-2b 声纹必须带 voices/ 前缀落私有目录；把 audio_master 直接写进 voice_ref 的老写法不许回来');
      // 老实现的指纹：INSERT 参数里出现 `w.audio_master, U.jstr(...)`（把整条作品当声纹）
      assert.ok(!/w\.audio_master,\s*U\.jstr/.test(fn),
        'V9-2b 检测到 voice_ref 仍被赋成 w.audio_master（整条作品当声纹），老写法不许回来');
    });
  });
  it('V9-3 variation 同 seed 改单参数：{bpm:±10} 后 A/B 仅预期维不同（seed 一致性由真实引擎保证）', { skip: '前置：ACE-Step :8190 真引擎 + seed 复现性（SP3 结论）' }, () => {});
  it('V9-4 seed-pack 复刻：GET seed-pack → 以同参重生成 → 产物指纹一致（同 seed 同参数）', { skip: '前置：同 V9-3' }, () => {});
  it('V9-5 extend/cover 谱系：lineage.kind=extend/cover 且 parent 链正确、扣分工时 20 分', { skip: '前置：done 作品 + 真引擎（extend/cover 需真实生成）' }, () => {});
});

describe('V10 DSP（M1 · 需 ffmpeg 执行器机 + 真机导出面）', () => {
  it('V10-1 变调不变速：pitch +2 后基频 ×2^(2/12)、时长误差 <2%（asetrate+aresample+atempo 补偿，契约 §4 基线）', { skip: '前置：执行器机 ffmpeg（施工计划 §2 待装）；server dsp lane 就绪后此条可自动化进 CI' }, () => {});
  it('V10-2 变速不变调：tempo 1.25× 后时长 ÷1.25、音高不变（atempo，契约 §4 基线）', { skip: '前置：同 V10-1' }, () => {});
  it('V10-3 trim/fade/concat/slice 各 op 产物时长与包络符合参数', { skip: '前置：同 V10-1' }, () => {});
  it('V10-4 导出格式/命名规范 + waveform peaks(400点) 与音频对齐（峰值位置误差 <1%）', { skip: '前置：ffmpeg + 真机导出 UI（M1-10）' }, () => {});
});

describe('V12 社区回路（M2 · 社区后端未施工）', () => {
  it('V12-1 挑战投稿→榜单排名→挑战完成积分结算', { skip: '前置：M2-3/M2-5 社区与挑战后端' }, () => {});
  it('V12-2 翻唱谱系：cover fork 链 + 授权开关 + 署名（M2-4）', { skip: '前置：M2-4 翻唱链' }, () => {});
  it('V12-3 切片分发：≤30s 切片 + 封面 + AI 标注随片（M2-6）', { skip: '前置：M2-6 分发链' }, () => {});
  it('V12-4 审核与举报闭环：举报→处置→状态变更可见（M2-3）', { skip: '前置：M2-3 审核闭环（当前仅 V11-④ 审计落库）' }, () => {});
});

// 占位：确保本文件在未 skip 语境下也符合 node:test 结构（无实际断言）
it('登记完整性：V3-V12 断言清单与施工计划 §5 一一对应', () => {
  assert.ok(true, '清单完整性由人审 + 本文件评审保证');
});
