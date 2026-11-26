#!/usr/bin/env bash
# MusicBox 执行器起服（六 lane，daemon 天然单并发；共宿主只观测 ram_free，无 /free）
set -u
BASE="$HOME/MusicBox"
LOG="$BASE/var/logs/executor.log"
PID="$BASE/run/executor.pid"
LANES="${MB_LANES:-music,intent,ffmpeg,imgspark,vidspark,lipsync,align}"

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "executor already running pid=$(cat "$PID")"; exit 0
fi
set -a; . "$BASE/etc/spark.env"; set +a
cd "$BASE/src"
setsid nohup "$BASE/node/bin/node" executor/index.js --lanes "$LANES" >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
echo "started executor pid=$(cat "$PID") lanes=$LANES log=$LOG"
