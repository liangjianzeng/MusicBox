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
# 声纹投递口的实现必须跟 server.py 一起到位：server.py 里是 `from ref_intake import ...`，
# 只推一份 = 引擎起不来（ImportError），比克隆失败更糟。
SRC2="vendor/acestep/ref_intake.py"
[ -f "$SRC2" ] || { echo "✗ 缺 $SRC2（声纹投递口实现）"; exit 1; }
# 两份真源不许各改各的：services/ 是文档口径，vendor/ 是实际部署口径
if ! cmp -s services/acestep/ref_intake.py "$SRC2"; then
  echo "✗ services/acestep/ref_intake.py 与 $SRC2 不一致 —— 先同步再部署（三处不一致的坑就这么来的）"; exit 1
fi
GPDIR="${GP_DIR:-scripts/geekpro}"
GP() { GP_HOST="$HOST" GP_USER="$USER" python3 "$GPDIR/gp.py" -t "${1:-90}" "${@:2}"; }
echo "① 远端原件先备份 → server.py.bak-$STAMP"
GP 60 "copy /Y $REMOTE_DIR/server.py $REMOTE_DIR/server.py.bak-$STAMP" | grep -aiE "已复制|copied|backup" || true
echo "② 推我们这份"
GP_HOST="$HOST" GP_USER="$USER" python3 "$GPDIR/gp_put.py" "$SRC" "$REMOTE_DIR/server.py" >/dev/null 2>&1
GP 60 "certutil -dump $REMOTE_DIR/server.py >nul && for %I in ($REMOTE_DIR/server.py) do @echo PUSHED %~zI bytes" | grep -aoE "PUSHED [0-9]+ bytes" || echo "  △ 未取到远端字节数，请复核"
GP_HOST="$HOST" GP_USER="$USER" python3 "$GPDIR/gp_put.py" "$SRC2" "$REMOTE_DIR/ref_intake.py" >/dev/null 2>&1
GP 60 "for %I in ($REMOTE_DIR/ref_intake.py) do @echo PUSHED2 %~zI bytes" | grep -aoE "PUSHED2 [0-9]+ bytes" || echo "  △ ref_intake.py 未确认，引擎会 ImportError"
if [ "${1:-}" = "--no-restart" ]; then echo "（按要求不重启）"; exit 0; fi
echo "③ 停掉 8190 上的旧监听"
GP 60 "Get-NetTCPConnection -LocalPort $PORT -State Listen | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" >/dev/null 2>&1 || true
# 不设 ACE_REF_KEY 也能起来，但 /ref 会一律 503 —— 声纹送不进去，人格克隆继续诚实失败。
: "${ACE_REF_KEY:?重启引擎还需要 ACE_REF_KEY（声纹投递口共享密钥；不配则 /ref 一律 503，人格克隆照旧失败）}"
echo "④ 起新引擎（绑 Tailscale 网卡，绝不 0.0.0.0；需长时间持有会话，用后台任务跑）"
echo "   前台/后台启动命令（自己挑一条，另开窗口持有）："
echo "   GP_PASS=… python3 "$GPDIR/gp.py" -t 43200 'set HF_HUB_OFFLINE=1&& set ACE_REF_KEY=${ACE_REF_KEY}&& cd /d ${REMOTE_DIR//\//\\}&& venv\\Scripts\\python.exe -m uvicorn server:app --host $BIND --port $PORT --log-level warning'"

echo "⑤ 部署后自查（不用等人反馈）：/health 通、/ref 存在且不匿名"
echo "   curl -s -o /dev/null -w '%{http_code}\n' http://$BIND:$PORT/health"
echo "   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://$BIND:$PORT/ref        # 期望 401（口在、不匿名）"
echo "                                     # 503=没配 ACE_REF_KEY；404=推的是旧 server.py"
