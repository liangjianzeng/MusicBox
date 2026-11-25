#!/usr/bin/env bash
# MusicBox 二期 worker 三件起服（83xx 仅回环；懒加载 + 空闲释放）
# 用法：bash start_workers.sh [asr|facegate|lipsync|all]
set -u
BASE="$HOME/MusicBox"
SRC="$BASE/src/workers"
# 落位档即环境首（否则 worker 即 /opt 默认档：MODEL_ROOT/ROOTS 失落位 ⇒ scaffold 503）
if [ -f "$BASE/etc/spark.env" ]; then
  set -a; . "$BASE/etc/spark.env"; set +a
fi
mkdir -p "$BASE/var/logs" "$BASE/run" "$BASE/var/models/facegate/models"

start_one() {
  local name="$1" port="$2" mod="$3" venv="$4"
  local log="$BASE/var/logs/$name.log" pid="$BASE/run/$name.pid"
  if [ -f "$pid" ] && kill -0 "$(cat "$pid")" 2>/dev/null; then
    echo "$name already running pid=$(cat "$pid")"; return 0
  fi
  if ss -tln | grep -q ":$port "; then
    echo "$name: port $port occupied; abort (no kill)"; return 1
  fi
  [ -x "$venv/bin/python" ] || { echo "$name: missing venv $venv"; return 1; }
  cd "$SRC"
  setsid nohup "$venv/bin/python" "$mod" >> "$log" 2>&1 < /dev/null &
  echo $! > "$pid"
  echo "started $name pid=$(cat "$pid") port=$port log=$log"
}

VBASE="${MB_VENV_BASE:-$BASE/var}"
case "${1:-all}" in
  asr)      start_one mv_asr      8391 mv_asr/app.py      "$VBASE/venv-asr" ;;
  facegate) start_one mv_facegate 8395 mv_facegate/app.py "$VBASE/venv-facegate" ;;
  lipsync)  start_one mv_lipsync  8390 mv_lipsync/app.py  "$VBASE/venv-lipsync" ;;
  asr1)     start_one sensevoice  8191 sensevoice/app.py  "$VBASE/venv-asr" ;;
  all)      start_one mv_asr 8391 mv_asr/app.py "$VBASE/venv-asr"
           start_one mv_facegate 8395 mv_facegate/app.py "$VBASE/venv-facegate"
           start_one mv_lipsync 8390 mv_lipsync/app.py "$VBASE/venv-lipsync"
           start_one sensevoice 8191 sensevoice/app.py "$VBASE/venv-asr" ;;
  *) echo "usage: $0 [asr|facegate|lipsync|asr1|all]"; exit 2 ;;
esac
