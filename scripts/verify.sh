#!/usr/bin/env bash
# MusicBox · 零依赖质量闸门（P0-2）
# 目的：让「主干是否可发布」这件事变成一条命令、一个退出码，不再依赖某个人的肌肉记忆。
# 用法：
#   bash scripts/verify.sh            # 快检（秒级）：语法 + 路由/契约对账 + 起服冒烟
#   bash scripts/verify.sh --full     # 加上全量验收套件（约 2 分钟）
#   bash scripts/verify.sh --repeat N # 全量验收重复 N 次，用于查 flake（P1-1 门票：--repeat 20 全绿）
# 退出码：0=可发布；非 0=禁止入仓/发布。首行输出即失败点。
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="$(pwd)"
FAILS=0
PORT="${MB_VERIFY_PORT:-7990}"
VARROOT="${MB_VERIFY_VAR:-/tmp/musicbox-verify-$$}"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

command -v node >/dev/null || { echo "需要 node（≥22，用 node:sqlite）"; exit 2; }
step "环境：$(node -v) @ $BASE"

# —— 1. 语法闸门：全量 JS/MJS 可解析（今天那次主干瘫痪就是被这一步拦住的）——
step "1/5 语法检查（node --check 全量 JS/MJS）"
njs=0; nbad=0
while IFS= read -r f; do
  njs=$((njs + 1))
  if ! out=$(node --check "$f" 2>&1); then
    nbad=$((nbad + 1))
    bad "语法错误 $f"
    printf '%s\n' "$out" | sed 's/^/      /' | head -5
  fi
done < <(find src/server src/executor src/workers test scripts -type f \( -name '*.js' -o -name '*.mjs' \) \
          -not -path '*/node_modules/*' -not -path '*/build/*' -not -path '*/third_party/*' | sort)
[ "$nbad" -eq 0 ] && ok "语法通过（$njs 个文件）"

# —— 2. 未提交/未跟踪的裸奔改动提醒（防「入仓未入库工作」式快照）——
step "2/5 工作区卫生"
if command -v git >/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
  nm=$(git diff --numstat 2>/dev/null | wc -l); nu=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l)
  if [ "${nm:-0}" -gt 20 ] || [ "${nu:-0}" -gt 40 ]; then
    printf '  \033[33m!\033[0m 工作区已攒 %s 个已改文件 / %s 个未跟踪文件 —— 请拆小提交（每个提交前跑本脚本）\n' "${nm:-0}" "${nu:-0}"
  else
    ok "工作区改动量可接受（已改 $nm / 未跟踪 $nu）"
  fi
  # —— 凭据扫描（抢救 P0-5）：只扫「会进仓的文件」；本机 etc/*.env 已被 gitignore ——
  # 文档/配置类扫口令形态；代码类只扫硬编码令牌形态（`password = envStr(...)` 这类合法代码不算泄漏）。
  # 仓库内公开默认值（admin1234 / dev-executor-token / 888888）是代码默认值，不算凭据泄漏，单独排除。
  CRED_LIST=/tmp/mb-cred.$$
  { git ls-files 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u \
    | grep -vE '^scripts/verify(_routes)?\.(sh|mjs)$' > "$CRED_LIST"
  DOC=$(grep -E '\.(md|sh|ps1|py|yaml|yml|txt|env|example|json)$' "$CRED_LIST" | grep -v 'spark.env.example')
  CODE=$(grep -E '\.(js|mjs|cjs|dart)$' "$CRED_LIST")
  CRED_HITS=/tmp/mb-credhit.$$
  { [ -n "$DOC" ] && echo "$DOC" | xargs grep -lnIE 'Lxt[0-9]{6,}|sshpass[[:space:]]+-p[[:space:]]*[^<]|(password|passwd|口令|密码)[[:space:]]*[:=][[:space:]]*["'"'"'`]?[A-Za-z0-9#@%^*_+.\-]{6,}' 2>/dev/null; \
    [ -n "$CODE" ] && echo "$CODE" | xargs grep -lnIE 'Lxt[0-9]{6,}|at_[0-9a-f]{24,}|x-executor-token["'"'"' ]*[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9._-]{16,}["'"'"']' 2>/dev/null; } \
    | sort -u | xargs -r grep -lIvE '^[[:space:]]*$' 2>/dev/null > "$CRED_HITS" || true
  # 只含公开默认值的命中不算泄漏
  CRED_HIT=0
  if [ -s "$CRED_HITS" ]; then
    while IFS= read -r f; do
      REAL=$(grep -nIE 'Lxt[0-9]{6,}|sshpass[[:space:]]+-p[[:space:]]*[^<]|(password|passwd|口令|密码)[[:space:]]*[:=][[:space:]]*["'"'"'`]?[A-Za-z0-9#@%^*_+.\-]{6,}|at_[0-9a-f]{24,}' "$f" 2>/dev/null \
             | grep -viE 'admin1234|dev-executor-token|888888|<[^>]+>|\.\.\.|xxx|placeholder')
      [ -n "$REAL" ] && { CRED_HIT=$((CRED_HIT+1)); printf '      %s\n' "$f"; echo "$REAL" | head -2 | sed 's/^/        /'; }
    done < "$CRED_HITS"
  fi
  rm -f "$CRED_LIST" "$CRED_HITS"
  if [ "$CRED_HIT" -gt 0 ]; then
    bad "凭据扫描：$CRED_HIT 个将入仓文件命中口令/token 形态 —— 先脱敏再提交（真值只准放 etc/*.env，已 gitignore）"
  else
    ok "凭据扫描干净"
  fi
  if git diff --check >/tmp/mb-ws.$$ 2>&1 && [ -s /tmp/mb-ws.$$ ]; then
    bad "git 空白错误（行尾空格/混用缩进）："; head -5 /tmp/mb-ws.$$ | sed 's/^/      /'
  else
    ok "无空白错误"
  fi
  rm -f /tmp/mb-ws.$$
else
  ok "（非 git 仓库，跳过）"
fi

# —— 3. 路由/契约三方对账 ——
step "3/5 路由与契约对账"
if out=$(node scripts/verify_routes.mjs --with-contract 2>&1); then
  printf '%s\n' "$out" | sed 's/^/  /'
else
  printf '%s\n' "$out" | sed 's/^/  /'; FAILS=$((FAILS + 1))
fi
# 机器可读契约清单双向对账（P1-3）：实现 ↔ contract/routes.json 必须互相覆盖。
# 计划里写的是可选 --with-contract，这里直接常开：静态检查极便宜，而"单向对账"正是契约烂掉的开始。
if out=$(node scripts/verify_contract.mjs 2>&1); then
  printf '%s\n' "$out" | grep -v Experimental | sed 's/^/  /'
else
  printf '%s\n' "$out" | grep -v Experimental | sed 's/^/  /'; FAILS=$((FAILS + 1))
fi

# —— 4. 起服冒烟：真的把 server 拉起来，/healthz 必须 200（挡住 require 期崩溃）——
step "4/5 起服冒烟（: $PORT）"
mkdir -p "$VARROOT"
MB_VAR_ROOT="$VARROOT" MB_PORT="$PORT" MB_ENV=dev MB_DEV_OTP=1 \
  node src/server/index.js >"$VARROOT/server.log" 2>&1 &
SRV=$!
alive=""
for _ in $(seq 1 45); do
  if ! kill -0 "$SRV" 2>/dev/null; then break; fi
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then alive=1; break; fi
  sleep 0.35
done
if [ -n "$alive" ]; then
  ok "/healthz 200"
  body=$(curl -s -m 3 "http://127.0.0.1:$PORT/healthz")
  printf '%s\n' "$body" | grep -q '"ok":true' && ok "healthz 载荷正确：$body" || bad "healthz 载荷异常：$body"
  # 安全红线：日志里不得出现明文口令/固定验证码
  # P0-3 已修并由 V28 验收套件钉住（prod fail-closed / 限流 / 令牌过期 / 日志无明文凭据）：
  # 这里默认**硬失败**，不再留 TODO 软放行 —— 留软放行等于给回归开门。
  if grep -qE 'admin1234|888888' "$VARROOT/server.log"; then
    bad "启动日志泄露明文凭据（见 $VARROOT/server.log；P0-3 已修，出现即回归，见 test/acceptance/v28_boot_security.test.js）"
  else
    ok "启动日志无明文凭据"
  fi
else
  bad "server 未能启动（端口 $PORT）—— 日志尾部："
  tail -20 "$VARROOT/server.log" 2>/dev/null | sed 's/^/      /'
fi
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null

# —— 5. 验收套件（可选）——
if [ "${1:-}" = "--full" ] || [ "${1:-}" = "--repeat" ]; then
  REPS=1
  [ "${1:-}" = "--repeat" ] && REPS="${2:-20}"
  step "5/5 全量验收套件 × $REPS"
  for i in $(seq 1 "$REPS"); do
    log="$VARROOT/acceptance-$i.log"
    if node --test --test-concurrency=1 "test/acceptance/*.test.js" >"$log" 2>&1; then
      # node 的摘要行前常有 \r 进度帧，^ℹ 会匹配不到 → 计数取空。
      # **读不到计数的"全绿"等于没跑**：2026-11-28 真出现过 pass= 空仍打印全绿的现场，
      # 无证据的绿比红更危险（它会让人以为 217 条判词跑过了）。所以取空即判红。
      pass=$(tr '\r' '\n' < "$log" | grep -oP '(?<=^ℹ pass )\d+' | tail -1)
      skip=$(tr '\r' '\n' < "$log" | grep -oP '(?<=^ℹ skipped )\d+' | tail -1)
      if [ -z "$pass" ]; then
        bad "第 $i 轮读不到判词计数（node 退出码 0 但摘要没落地）—— 无证据的绿不算绿，判红"
        echo "      完整日志：$log"
      else
        ok "第 $i 轮全绿（pass=$pass skip=$skip）"
      fi
    else
      fail=$(tr '\r' '\n' < "$log" | grep -oP '(?<=^ℹ fail )\d+' | tail -1)
      bad "第 $i 轮红（fail=$fail）—— 失败用例："
      sed -n '/failing tests:/,$p' "$log" | grep -E '^✖ ' | head -10 | sed 's/^/      /'
      echo "      完整日志：$log"
    fi
  done
else
  step "5/5 全量验收套件（跳过；用 --full 或 --repeat 20 打开）"
fi

# 失败时保留运行时目录（内含 server.log / acceptance-N.log），通过时才清理
if [ "$FAILS" -eq 0 ]; then rm -rf "$VARROOT" 2>/dev/null; else printf '\n  运行时与验收日志保留在：%s\n' "$VARROOT"; fi
printf '\n'
if [ "$FAILS" -eq 0 ]; then
  printf '\033[32m\033[1m✅ 闸门通过：可以入仓/发布\033[0m\n'; exit 0
else
  printf '\033[31m\033[1m❌ 闸门失败：%d 项 —— 禁止入仓/发布\033[0m\n' "$FAILS"; exit 1
fi
