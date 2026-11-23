#!/usr/bin/env bash
# SP1 · 意图链路预研 —— 3 段语音 → :8191 /asr → 托管多模态端点编译 → 打印 IntentCard 对照表（2026-11-23）
# 用法：bash spikes/SP1_intent_chain.sh [a.wav b.m4a c.wav]
#       缺省读 spikes/samples/{a,b,c}.{wav,m4a}；环境缺失打印 SKIP 原因并退出 0（不阻塞验收）。
# 环境：ASR_URL(默认 http://127.0.0.1:8191)  MB_LLM_VLM_URL(默认 http://127.0.0.1:8193/v1)  MB_LLM_VLM_MODEL(默认 qwen38-fp4)
set -u

ASR_URL="${ASR_URL:-http://127.0.0.1:8191}"
LLM="${MB_LLM_VLM_URL:-http://127.0.0.1:8193/v1}"
MODEL="${MB_LLM_VLM_MODEL:-qwen38-fp4}"
DIR="$(cd "$(dirname "$0")" && pwd)/samples"
OUT="$(mktemp -d)"

skip() { echo "SKIP: $1"; exit 0; }

# ---- 素材 ----
FILES=("$@")
if [ "${#FILES[@]}" -eq 0 ]; then
  for n in a b c; do
    for ext in wav m4a; do
      [ -f "$DIR/$n.$ext" ] && FILES+=("$DIR/$n.$ext") && break
    done
  done
fi
[ "${#FILES[@]}" -ge 1 ] || skip "缺少语音样本：请在 spikes/samples/ 放 a/b/c(.wav|.m4a)，或以参数传入 3 段 ≤60s 语音"

# ---- 环境探活 ----
command -v curl >/dev/null || skip "无 curl"
curl -fsS --max-time 5 "$ASR_URL/healthz" >/dev/null 2>&1 || skip "语音识别服务不可达（$ASR_URL），请先启动 src/workers/sensevoice/app.py"
LLM_OK=1
curl -fsS --max-time 5 "$LLM/models" >/dev/null 2>&1 || LLM_OK=0
[ "$LLM_OK" -eq 1 ] || echo "提示: 理解端点不可达（$LLM），本轮只出转写；执行器线上会自动走本地词典兜底"

SYSTEM='你是"一句话点歌"的意图编译器。输出严格 JSON（不解释）：{"mood":[],"scene_desc":"","genre_hypotheses":[],"vocal":"song|instrumental|unknown","duration_hint":"偏短|适中|偏长","confidence":0到1,"questions":[{"q_idx":0,"q":"","options":[{"idx":0,"label":""}],"recommended_idx":0}]}。confidence≥0.75 时 questions 为空；否则 1-2 题、每题 2-4 选项且必带 recommended_idx；mood/questions 用中文。'

echo "== SP1 意图链路预研：样本 ${#FILES[@]} 段 =="
for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"; n=$((i + 1))
  [ -f "$f" ] || { echo "[$n] 样本不存在，跳过：$f"; continue; }
  asr="$OUT/asr$n.json"
  code=$(curl -sS --max-time 60 -o "$asr" -w '%{http_code}' "$ASR_URL/asr" \
    -H 'content-type: application/json' -d "{\"path\":\"$(echo "$f" | sed 's/\\/\\\\/g')\"}" 2>/dev/null || echo 000)
  if [ "$code" != "200" ]; then echo "[$n] $f → ASR 失败 HTTP $code"; continue; fi
  card="$OUT/card$n.json"; echo "null" > "$card"
  if [ "$LLM_OK" -eq 1 ]; then
    TEXT=$(node -e 'try{const j=require(process.argv[1]);const s=JSON.stringify(j);console.log((j.text||"").slice(0,200));}catch(e){console.log("")}' "$asr" 2>/dev/null || echo "")
    LLM="$LLM" MODEL="$MODEL" SYSTEM="$SYSTEM" node -e '
      const fs = require("fs");
      const asr = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const body = { model: process.env.MODEL, temperature: 0.3, messages: [
        { role: "system", content: process.env.SYSTEM },
        { role: "user", content: "语音转写：" + (asr.text || "") + (asr.emotion && asr.emotion !== "neutral" ? "；情绪：" + asr.emotion : "") + ((asr.events||[]).length ? "；事件：" + asr.events.join(",") : "") }
      ]};
      fetch(process.env.LLM + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then(j => {
          const c = j.choices[0].message.content || "";
          const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(c); const s = (m ? m[1] : c).trim();
          const a = s.indexOf("{"), b = s.lastIndexOf("}");
          let card = null; try { card = JSON.parse(s.slice(a, b + 1)); } catch (e) {}
          fs.writeFileSync(process.argv[2], JSON.stringify({ ok: !!card, card, asr }));
        }).catch(e => { fs.writeFileSync(process.argv[2], JSON.stringify({ ok: false, card: null, asr, err: String(e.message || e) })); });
    ' "$asr" "$card" 2>/dev/null
    [ -s "$card" ] || echo "null" > "$card"
  fi
done

node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  const rows = [];
  for (const n of [1, 2, 3]) {
    const p = path.join(dir, "card" + n + ".json");
    if (!fs.existsSync(p)) continue;
    let o = null; try { o = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
    if (!o) continue;
    const asr = o.asr || {}, c = o.card || {};
    rows.push([n, (asr.text || "—").slice(0, 18), (c.mood || []).join("/") || (o.ok ? "—" : "本地兜底"),
      (c.genre_hypotheses || []).join("/") || "—", c.confidence !== undefined ? c.confidence : "—",
      Array.isArray(c.questions) ? c.questions.length : "—", (asr.emotion || "—") + "/" + ((asr.events || []).join(",") || "-")]);
  }
  if (!rows.length) { console.log("（无可用结果）"); process.exit(0); }
  const head = ["#", "转写", "mood", "曲风", "置信", "题数", "情绪/事件"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)) + 2);
  const line = (r) => r.map((v, i) => String(v).padEnd(w[i], " ")).join("|");
  console.log("\n== IntentCard 对照表 ==");
  console.log(line(head));
  console.log(w.map((x) => "-".repeat(x)).join("+"));
  rows.forEach((r) => console.log(line(r)));
  console.log("\n判读：转写可读 / mood·曲风合理 / confidence≥0.75 时应 0 题直出；若 mood 列全为「本地兜底」说明理解端点未起，链路仍不断。");
' "$OUT"
rm -rf "$OUT"
