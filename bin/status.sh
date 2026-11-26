#!/usr/bin/env bash
# MusicBox 全服务状态与端点自检（只读，无干预）
set -u
BASE="$HOME/MusicBox"
echo "== 进程（pid 档）"
for f in "$BASE"/run/*.pid; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .pid); p=$(cat "$f" 2>/dev/null)
  if kill -0 "$p" 2>/dev/null; then echo "  $n pid=$p ALIVE"; else echo "  $n pid=$p DEAD"; fi
done
echo "== 端口"
ss -tln | grep -E ':(7900|7901|8090|8188|8190|8191|8288|8390|8391|8395) ' || echo "  (无监听)"
echo "== 端点自检"
probe() { printf '  %-28s %s\n' "$1" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || echo ERR)"; }
# MV 全家桶六项（7900/8090/8188/8390/8391/8395）必须逐项在场，缺一即链路不完整
probe "API :7900 /healthz"      "http://127.0.0.1:7900/healthz"
probe "LLM :8090 /v1/models"    "http://127.0.0.1:8090/v1/models"   # 真值即 /v1/models；裸 /models 返回 404（2026-11-26 实测）
probe "生图队列 :8188 /system_stats" "http://127.0.0.1:8188/system_stats"
probe "lipsync :8390 /health"   "http://127.0.0.1:8390/health"
probe "mv_asr :8391 /health"    "http://127.0.0.1:8391/health"
probe "facegate :8395 /health"  "http://127.0.0.1:8395/health"
# 一期音乐线（同机可选）
probe "生乐 :8190 /health"      "http://127.0.0.1:8190/health"
probe "ASR :8191 /healthz"      "http://127.0.0.1:8191/healthz"
echo "== 内存"
free -g | sed -n '1,2p'
nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null
echo "== 最近日志尾"
for n in api executor acestep comfyui; do
  [ -f "$BASE/var/logs/$n.log" ] && { echo "-- $n --"; tail -3 "$BASE/var/logs/$n.log"; }
done
