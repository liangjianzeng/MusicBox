#!/usr/bin/env bash
# MusicBox 生乐服务起服（ACE-Step 1.5 协议壳 · 127.0.0.1:8190 · 惰性加载）
# 幂等：pid 档已活则退出 0；端口被别的进程则 abort 不杀。
set -u
BASE="$HOME/MusicBox"
SVC="$BASE/services/acestep"
PORT=8190
LOG="$BASE/var/logs/acestep.log"
PID="$BASE/run/acestep.pid"

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "acestep already running pid=$(cat "$PID")"; exit 0
fi
if ss -tln | grep -q ":$PORT "; then
  echo "port $PORT occupied by unknown process; abort"; exit 1
fi
[ -x "$SVC/venv/bin/python" ] || { echo "missing venv: $SVC/venv"; exit 1; }
[ -f "$SVC/server.py" ] || { echo "missing server.py"; exit 1; }

cd "$SVC"
setsid nohup "$SVC/venv/bin/python" server.py >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
echo "started acestep pid=$(cat "$PID") log=$LOG"
