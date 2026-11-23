# MusicBox VPS 部署手册（2026-11-23）

> 覆盖：域名/DNS → TLS(certbot) → Nginx → API(systemd) → 执行机(执行器 + SenseVoice) → 健康自检。
> 契约真源：仓库根 `CONTRACTS.md`。本目录仅部署件，**不含业务代码**。

## 0. 前提

| 项 | 值 |
|---|---|
| VPS | 2C4G 起，Ubuntu 22.04/Debian 12，Node ≥22（零依赖服务端用 `node:sqlite`） |
| 域名 | 例 `musicbox.example.com`，A 记录指向 VPS |
| 目录约定 | 代码在 `/srv/musicbox`，运行数据 `/srv/musicbox/var`（`var/db`、`var/out/<yyyy-mm>`） |
| 专用用户 | `useradd -r -m -d /srv/musicbox -s /usr/sbin/nologin musicbox` |

```bash
apt update && apt install -y nginx certbot python3-certbot-nginx nodejs npm git
# 建议用 nvm 或 NodeSource 安装 Node ≥22；验证：node -v
```

## 1. 目录与密钥

```bash
mkdir -p /etc/musicbox /var/www/certbot
# 服务端配置（server 方负责其格式，参考 src/server 的 config）：
cat > /etc/musicbox/api.env <<'ENV'
PORT=7900
# executorToken=<随机长串>   ← 与执行器令牌一致（示例键名以 server 实现为准）
ENV
# 执行机侧（装在 GPU/执行机，非本机）：
cat > /etc/musicbox/executor.env <<'ENV'
MB_API_URL=https://musicbox.example.com
MB_EXECUTOR_TOKEN=<executorToken>
MB_LANES=music,intent,ffmpeg
MB_MUSIC_URL=http://127.0.0.1:8190
MB_ASR_URL=http://127.0.0.1:8191
MB_LLM_VLM_URL=http://<spark内网IP>:8193/v1
ENV
chmod 600 /etc/musicbox/*.env
```

## 2. Nginx + certbot

1. 编辑 `deploy/vps/nginx.conf`：替换 `musicbox.example.com`、`/executor/` 的 allow 段（执行机出口 IP）、证书路径。
2. 首次签发（standalone 最省事，注意先停 nginx 或改用 webroot `/var/www/certbot`）：

```bash
certbot certonly --webroot -w /var/www/certbot -d musicbox.example.com
# 自动续期（certbot 定时器默认已装）：
certbot renew --dry-run
```

3. 装载站点：

```bash
cp deploy/vps/nginx.conf /etc/nginx/sites-available/musicbox
ln -s /etc/nginx/sites-available/musicbox /etc/nginx/sites-enabled/musicbox
nginx -t && systemctl reload nginx
```

## 3. systemd 单元

```bash
cp deploy/vps/systemd/musicbox-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now musicbox-api
journalctl -u musicbox-api -f    # 应看到监听 :7900
```

## 4. 执行机（内网，可多台）

在 5060 Ti 生乐机上（与 ACE-Step `:8190` 同机，SenseVoice `:8191` 同机 CPU）：

```bash
cd /srv/musicbox
python3 -m venv .venv && .venv/bin/pip install -r src/workers/sensevoice/requirements.txt
nohup .venv/bin/python src/workers/sensevoice/app.py >/var/log/musicbox-asr.log 2>&1 &   # :8191
cp deploy/vps/systemd/musicbox-executor.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now musicbox-executor
journalctl -u musicbox-executor -f    # 应看到「已接入调度：… 通道=music,intent,ffmpeg」
```

要点：
- 执行器**只出网**拉单，GPU 机零入站；`/executor/` 段在 Nginx 侧用源 IP 白名单。
- 冒烟可先 `EXECUTOR_MOCK=1 systemctl edit musicbox-executor` 加一行 Environment 再 restart（无 GPU 也能全链路验收）。

## 5. 启动顺序与自检

顺序：**API → Nginx →（执行机）ASR → 执行器**。

```bash
curl -fsS https://musicbox.example.com/healthz                       # API 健康
curl -fsS https://musicbox.example.com/v1/auth/guest -X POST         # 游客态可通
curl -fsS http://127.0.0.1:8191/healthz                              # （执行机上）ASR 健康
node src/executor/index.js --help                                    # 执行器参数自检
```

端到端：游客 token `POST /v1/works/generate` → `GET /v1/jobs/:id` 轮询到 `done` → 候选 `audio_url` 可播。

## 6. 常见坑

| 现象 | 排查 |
|---|---|
| 执行器一直「接入失败」 | `MB_API_URL`/令牌/`/executor/` IP 白名单三查；证书链用 `curl -v` |
| job 一直 queued | 执行器 lane 与 job type 不匹配（见 `journalctl` 的「本机未启用该任务通道」） |
| 候选没声音 | 检查执行机 ffmpeg 是否在 PATH（`MB_FFMPEG` 覆盖）；`fail=FFMPEG_MISSING` |
| 静态 404 | `/f/` alias 是否指 `/srv/musicbox/var/out/`（带尾斜杠） |
| WSS 秒断 | `/ws` 的 `proxy_read_timeout` 是否 3600s、Upgrade 头是否透传 |
