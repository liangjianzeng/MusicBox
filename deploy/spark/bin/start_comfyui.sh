#!/usr/bin/env bash
# MusicBox 生图/生视频队列起服（ComfyUI 共宿主 :8188，只发任务+只读观测，代码层无 /free）
# 幂等：pid 档已活则退出 0；端口被别的进程则 abort 不杀。
set -u
BASE="$HOME/MusicBox"
COMFY="$HOME/ComfyUI"
PORT=8188
LOG="$BASE/var/logs/comfyui.log"
PID="$BASE/run/comfyui.pid"

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "comfyui already running pid=$(cat "$PID")"; exit 0
fi
if ss -tln | grep -q ":$PORT "; then
  echo "port $PORT occupied by unknown process; abort (check manually)"; exit 1
fi
[ -x "$COMFY/venv/bin/python" ] || { echo "missing comfy venv"; exit 1; }

cd "$COMFY"
setsid nohup "$COMFY/venv/bin/python" main.py --port "$PORT" --listen 0.0.0.0 >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
echo "started comfyui pid=$(cat "$PID") log=$LOG"
