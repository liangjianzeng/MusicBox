#!/usr/bin/env bash
# MusicBox API 起服（:7900 零依赖 Node 服务端；产物 /f/*；WSS /ws；健康 /healthz）
set -u
BASE="$HOME/MusicBox"
LOG="$BASE/var/logs/api.log"
PID="$BASE/run/api.pid"

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "api already running pid=$(cat "$PID")"; exit 0
fi
if ss -tln | grep -q ":7900 "; then
  echo "port 7900 occupied by unknown process; abort"; exit 1
fi
set -a; . "$BASE/etc/spark.env"; set +a
cd "$BASE/src"
setsid nohup "$BASE/node/bin/node" server/index.js >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
echo "started api pid=$(cat "$PID") log=$LOG"
