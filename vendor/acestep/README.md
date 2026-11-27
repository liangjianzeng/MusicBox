# vendor/acestep —— ACE-Step 引擎的服务入口（我们owns 的副本）

**来历**：原件是 GeekPro 上 `E:\Work\X-Theater\runtime\acestep\server.py`（X-Theater 与 MusicBox
共用的 ACE 音乐服务）。2026-11-27 由 MusicBox 侧 scp 取回收编进本目录，原件 sha256
`8e4fc0c0e592f706…`（16,257 B，CRLF 保留），逐字节留在 `server.py.orig` 供 diff。

**为什么收进来**：原件把 `seconds` 入口卡成 `ge=15, le=180`，而它自己的 description 写着
"模型支持 10–600"。结果是：App 深度档时长滑块 15–240、API `sec` 15–240，全都被引擎入口
静默砍到 180 秒 —— 用户要 4 分钟只拿得到 3 分钟，界面还继续显示 240。这类"三处上限不一致"
只有把入口纳入我们仓库才能修得住、测得住。

**改动（只此一处语义 + 两处文档同步）**：
- `le=180` → `le=600`（与模型能力一致）；description 同步为 15–600；
- 文件头 API 摘要 `seconds 15-180` → `seconds 15-600`。

**部署（改完必须走这一步，否则跑的还是 GeekPro 上那份）**：
```bash
GP_PASS=… bash scripts/deploy_acestep.sh      # 先备份远端原件，再推我们这份，再重启引擎
```

**架构红线（不变）**：只有**执行器**能碰引擎；App 永远只跟 server 说话、经 `/f/*` 取件口拿产物。
引擎必须绑在 Tailscale 网卡上启动（`--host 100.100.140.75`），**绝不 `0.0.0.0`** —— 它没有鉴权、
没有配额，暴露出去等于送一块免费 GPU。
