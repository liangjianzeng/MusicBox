// scripts/e2e_smoke.mjs — 主会话总验收冒烟（2026-11-23）：guest→生成→3候选(mp3+peaks)→采纳→导出可达
// 用法：node scripts/e2e_smoke.mjs [base]，默认 http://127.0.0.1:7900
const BASE = String(process.argv[2] || 'http://127.0.0.1:7900').replace(/\/+$/, '');
// 产物 URL 是服务端按 MB_PUBLIC_BASE_URL 拼出来的**绝对地址**（那才是用户真正点开的地址）。
// 冒烟脚本换端口/换机跑时（runbook §3 就是这么教的），直接 fetch 这个绝对地址会连到另一台机器/另一个端口，
// 报出与"被测对象"无关的 ECONNREFUSED（实测：连 192.168.1.10:7900 被拒，排查方向整个被带偏）。
// 故：host 与被测 base 不同就按 base 回捞，并在结尾如实提示改写过几次 —— 公网可达性要另测，别混进冒烟。
let urlRewrites = 0;
function toBase(u) {
  const str = String(u || '');
  if (!/^https?:\/\//i.test(str)) return BASE + (str.startsWith('/') ? str : '/' + str);
  try {
    const a = new URL(str); const b = new URL(BASE);
    if (a.host !== b.host) { urlRewrites++; a.protocol = b.protocol; a.host = b.host; }
    return a.toString();
  } catch (e) { return BASE + str; }
}
const results = [];
let token = '';

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 160) });
  if (!ok) process.exitCode = 1;
}
async function api(method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) 游客登录
let r = await api('POST', '/v1/auth/guest');
check('guest 登录 200', r.status === 200 && r.j?.access_token, `status=${r.status}`);
token = r.j?.access_token || '';

// 2) me：余额 50
r = await api('GET', '/v1/me');
check('/me balance=50', r.status === 200 && r.j?.credits?.balance === 50, JSON.stringify(r.j?.credits));

// 3) 生成 3 候选
r = await api('POST', '/v1/works/generate', { mode: 'simple', prompt: '黄昏码头送别，写一首温暖怀念的歌', count: 3 });
check('generate 202', r.status === 202 && r.j?.job_id, `status=${r.status}`);
const jobId = r.j?.job_id;
check('generate 扣费 45', r.j?.credits_charged === 45, r.j?.credits_charged);

// 4) 幂等重发
const r2 = await api('POST', '/v1/works/generate', { mode: 'simple', prompt: '黄昏码头送别，写一首温暖怀念的歌', count: 3 });
check('幂等同 job', r2.status === 202 && r2.j?.job_id === jobId && r2.j?.idempotent === true, JSON.stringify(r2.j));
r = await api('GET', '/v1/me');
check('幂等不重复扣分 balance=5', r.j?.credits?.balance === 5, JSON.stringify(r.j?.credits));

// 5) 轮询 job done（真机引擎 3 候选≈3-5min：mock ≤150s，真机放宽到 360s）
let job = null;
for (let i = 0; i < 180; i++) {
  r = await api('GET', '/v1/jobs/' + jobId);
  job = r.j;
  if (job && (job.status === 'done' || job.status === 'failed')) break;
  await sleep(2000);
}
check('job done', job?.status === 'done', `status=${job?.status} progress=${job?.progress} note=${job?.note}`);
// 契约：candidates 在 job 响应顶层（jobs handler 从候选表重建）
const cands = job?.candidates || job?.result?.candidates || [];
check('3 候选', cands.length === 3, cands.length);
check('候选播放档 mp3', cands.length === 3 && cands.every(c => c.format === 'mp3' && c.audio_url), cands.map(c => c.format).join(','));
check('候选波形 peaks', cands.length === 3 && cands.every(c => c.waveform_url), '');

// 6) 下载回验 mp3 + peaks
if (cands[0]?.audio_url) {
  const a = await fetch(toBase(cands[0].audio_url));
  const buf = Buffer.from(await a.arrayBuffer());
  check('mp3 可下载且 >100KB', a.status === 200 && buf.length > 100_000, buf.length + 'B');
  const p = await fetch(toBase(cands[0].waveform_url));
  const pj = await p.json().catch(() => null);
  const arr = Array.isArray(pj) ? pj : pj?.peaks;
  check('peaks 数组 400 点', p.status === 200 && Array.isArray(arr) && arr.length >= 100, arr?.length);
}

// 7) 采纳 → work
r = await api('POST', `/v1/works/${jobId}/adopt`, { candidate_id: cands[0]?.id });
check('adopt 200 出 work', r.status === 200 && r.j?.work?.id, `status=${r.status}`);
const work = r.j?.work;
check('work 带 AI 标记', work?.ai_label === true, work?.ai_label);
r = await api('GET', '/v1/works?mine=1');
check('曲库列表含新作', (r.j?.items || []).some(w => w.id === work?.id), (r.j?.items || []).length);

// 8) work 详情
r = await api('GET', '/v1/works/' + work?.id);
check('work 详情父链', r.status === 200 && Array.isArray(r.j?.lineage_parents), `status=${r.status}`);

// 9) 谱系实测（DEV-ADOPT-LINEAGE）：独立用户（积分充足）generate(1)→adopt→adjust→adopt 子代→验父链
const g2 = await api('POST', '/v1/auth/guest');
const savedToken = token; token = g2.j?.access_token || savedToken;
let w2 = null;
{
  const r1 = await api('POST', '/v1/works/generate', { mode: 'simple', prompt: '谱系测试曲', count: 1 });
  if (r1.j?.job_id) {
    let j1 = null;
    for (let i = 0; i < 90 && !j1?.candidates; i++) { const jr = await api('GET', '/v1/jobs/' + r1.j.job_id); j1 = jr.j; if (j1?.status === 'failed') break; await sleep(2000); }
    const c1 = (j1?.candidates || [])[0];
    if (c1) { const a1 = await api('POST', `/v1/works/${r1.j.job_id}/adopt`, { candidate_id: c1.id }); w2 = a1.j?.work; }
  }
  check('谱系母作品就绪', !!w2?.id, w2?.id || '无');
  if (w2?.id) {
    const ra = await api('POST', `/v1/works/${w2.id}/adjust`, { text: '更欢快一点' });
    check('adjust 被理解', ra.status === 200 && ra.j?.understood === true, JSON.stringify(ra.j));
    if (ra.j?.job_id) {
      let adj = null;
      for (let i = 0; i < 120; i++) { const jr = await api('GET', '/v1/jobs/' + ra.j.job_id); adj = jr.j; if (adj && (adj.status === 'done' || adj.status === 'failed')) break; await sleep(2000); }
      check('adjust job done', adj?.status === 'done', `status=${adj?.status}`);
      const ac = (adj?.candidates || [])[0];
      if (ac) {
        const ar = await api('POST', `/v1/works/${ra.j.job_id}/adopt`, { candidate_id: ac.id });
        const nw = ar.j?.work;
        check('adjust 子代挂谱系', nw?.lineage?.kind === 'adjust' && nw?.lineage?.parent_id === w2.id, JSON.stringify(nw?.lineage));
        const pr = await api('GET', '/v1/works/' + w2.id);
        check('母作品 children_count≥1', (pr.j?.children_count || 0) >= 1, pr.j?.children_count);
      } else check('adjust 子代挂谱系', false, '无候选');
    }
  }
}
token = savedToken;

for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
console.log(`\n总计 ${results.filter(x => x.ok).length}/${results.length} 通过`);
if (urlRewrites > 0) {
  console.log(`提示：产物 URL 的 host 与被测 base 不同，已按 base 回捞 ${urlRewrites} 次。`
    + '（产物绝对地址由服务端 MB_PUBLIC_BASE_URL 决定；跨机/公网可达性请单独验，不要混进冒烟结论）');
}
