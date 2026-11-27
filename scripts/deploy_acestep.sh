#!/usr/bin/env bash
# 把 vendor/acestep/server.py 推到 GeekPro 并重启引擎（引擎入口的唯一事实来源在本仓库）。
# 用法：GP_PASS=… bash scripts/deploy_acestep.sh [--no-restart]
# 为什么需要它：改仓库里的副本而不同时推到 GeekPro，跑的就还是旧那份 —— 三处上限不一致的坑就是这么来的。
set -euo pipefail
: "${GP_PASS:?需要先 export GP_PASS（引擎机 SSH 口令，不入库）}"
HOST="${GP_HOST:-100.100.140.75}"; USER="${GP_USER:-jianz}"
REMOTE_DIR="${ACE_REMOTE_DIR:-E:/Work/X-Theater/runtime/acestep}"
BIND="${ACE_BIND:-100.100.140.75}"; PORT="${ACE_PORT:-8190}"
SRC="vendor/acestep/server.py"; STAMP=$(date +%Y%m%d-%H%M)
[ -f "$SRC" ] || { echo "✗ 缺 $SRC"; exit 1; }
GPDIR="${GP_DIR:-scripts/geekpro}"
GP() { GP_HOST="$HOST" GP_USER="$USER" python3 "$GPDIR/gp.py" -t "${1:-90}" "${@:2}"; }
echo "① 远端原件先备份 → server.py.bak-$STAMP"
GP 60 "copy /Y $REMOTE_DIR/server.py $REMOTE_DIR/server.py.bak-$STAMP" | grep -aiE "已复制|copied|backup" || true
echo "② 推我们这份"
GP_HOST="$HOST" GP_USER="$USER" python3 "$GPDIR/gp_put.py" "$SRC" "$REMOTE_DIR/server.py" >/dev/null 2>&1
GP 60 "certutil -dump $REMOTE_DIR/server.py >nul && for %I in ($REMOTE_DIR/server.py) do @echo PUSHED %~zI bytes" | grep -aoE "PUSHED [0-9]+ bytes" || echo "  △ 未取到远端字节数，请复核"
if [ "${1:-}" = "--no-restart" ]; then echo "（按要求不重启）"; exit 0; fi
echo "③ 停掉 8190 上的旧监听"
GP 60 "Get-NetTCPConnection -LocalPort $PORT -State Listen | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" >/dev/null 2>&1 || true
echo "④ 起新引擎（绑 Tailscale 网卡，绝不 0.0.0.0；需长时间持有会话，用后台任务跑）"
echo "   前台/后台启动命令（自己挑一条，另开窗口持有）："
echo "   GP_PASS=… python3 "$GPDIR/gp.py" -t 43200 'set HF_HUB_OFFLINE=1&& cd /d ${REMOTE_DIR//\//\\}&& venv\\Scripts\\python.exe -m uvicorn server:app --host $BIND --port $PORT --log-level warning'"
