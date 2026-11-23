#!/usr/bin/env bash
# SP3 · 生乐批量计时 —— :8190 两档时长（30s / 4min）× 3 候选，逐发 curl 计时（2026-11-23）
# 用法：bash spikes/SP3_acestep_batch.sh        环境：MUSIC_URL(默认 http://127.0.0.1:8190) SEED_BASE
# 说明：仅预研计时，不领单不回传；生成服务与执行器同机部署（剧场 :8190 协议，见 CONTRACTS §4）。
set -u
MUSIC_URL="${MUSIC_URL:-http://127.0.0.1:8190}"
SEED_BASE="${SEED_BASE:-910000}"
OUT="$(mktemp -d)"; ROWS="$OUT/rows.txt"; : > "$ROWS"

skip() { echo "SKIP: $1"; exit 0; }
command -v curl >/dev/null || skip "无 curl"
probe=$(curl -sS -o /dev/null -m 5 -w '%{http_code}' "$MUSIC_URL/" 2>/dev/null || echo 000)
[ "$probe" != "000" ] || skip "生成服务不可达（$MUSIC_URL），请在 5060 Ti 生乐机上运行"

echo "== SP3 生乐批量计时 =="
echo "档位 | 候选 | seed | HTTP | 墙钟s | 服务端gen_s"
for SEC in 30 240; do
  for SEQ in 1 2 3; do
    SEED=$((SEED_BASE + SEC * 10 + SEQ))
    BODY=$(printf '{"mood":"温暖","seconds":%s,"seed":%s,"tags":["pop","folk","warm"],"bpm":96,"lyrics":"","prompt":"温暖的原创小样，适合日常轻听，结构完整","instrumental":false}' "$SEC" "$SEED")
    OUTFILE="$OUT/r_${SEC}_${SEQ}.json"
    read -r CODE TTOTAL <<<"$(curl -sS -o "$OUTFILE" -m 660 -w '%{http_code} %{time_total}' "$MUSIC_URL/music" -H 'content-type: application/json' -d "$BODY" 2>/dev/null || echo '000 0')"
    GEN=$(node -e 'try{const j=require(process.argv[1]);console.log(j.gen_seconds!==undefined?Number(j.gen_seconds).toFixed(1):"-")}catch(e){console.log("-")}' "$OUTFILE" 2>/dev/null || echo -)
    echo "$SEC | $SEQ | $SEED | $CODE | $TTOTAL | $GEN"
    echo "$SEC $CODE $TTOTAL" >> "$ROWS"
  done
done

awk '{n[$1]++; s[$1]+=$3; if($2!=200) bad[$1]++} END{print "\n== 汇总 =="; for(k in n) printf "%ss 档：%d 发，成功 %d，墙钟均值 %.1fs\n", k, n[k], n[k]-(bad[k]+0), s[k]/n[k]}' "$ROWS"
rm -rf "$OUT"
echo "判读：30s 档单发应 <300s（执行器 lane 超时线）；4min 档看 OOM/排队；连续 3 发稳定即可放心上线 music lane。"
