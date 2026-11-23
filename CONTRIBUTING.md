# 参与贡献（Contributing Guide）

欢迎 Issue 与 PR。动手前请先读完本页——本仓库的工程纪律比一般项目严，不守纪律的 PR 会被直接退回。

## 必读文档（按顺序）

1. [docs/musicbox-assessment-and-plan.md](docs/musicbox-assessment-and-plan.md) —— 做什么、给谁用
2. [docs/musicbox-architecture-design.md](docs/musicbox-architecture-design.md) —— 怎么做
3. [docs/musicbox-construction-plan.md](docs/musicbox-construction-plan.md) —— 何时/谁做、§5 验收 V1–V12
4. **[CONTRACTS.md](CONTRACTS.md) —— 冻结契约，唯一接口真源**

## 五条铁律

1. **先改契约，再改代码**：任何接口/状态码/字段/积分口径变动，必须先提 CONTRACTS.md 修改并在文中标注日期与理由，再动实现，最后回归 `test/acceptance/`。代码与契约冲突时，以契约为准。
2. **服务端/执行器零 npm 依赖**：只用 `node:` 内建模块（DB 用 `node:sqlite`，Node ≥22），CommonJS + `"use strict"` + 中文简短注释。加依赖的 PR 一律退回。
3. **计费诚信**：重试/降档梯子**不得裁剪用户已付费的交付维度**（count/sec）。减负只能降技术档位；失败必须全额 refund（见 lanes/index.js ladder 与偏差清单 DEV-LADDER-PAY）。
4. **敏感内容外置**：违禁词库等审核数据放 `var/config/moderation_words.txt`（运行时生成，**不入仓**），代码中不得手写敏感词。
5. **产物 URL 部署纪律**：`audio_url` 等在 complete 时由 `MB_PUBLIC_BASE_URL` 拼死，真机/多端部署必须配成客户端可达地址（CONTRACTS §0）。

## 本地开发

```bash
# 服务端（:7900）
node src/server/index.js
# 执行器（mock 模式，无 GPU 也出真可播 wav）
EXECUTOR_MOCK=1 node src/executor/index.js
# App（Flutter 在 C:/src/flutter 或你的安装路径）
cd src/app && flutter run
# 验收套件（必须全绿；用 glob 形式而非目录形式，--test-concurrency=1）
node --test --test-concurrency=1 "test/acceptance/*.test.js"
```

真机模式四件套（ACE-Step :8190 / SenseVoice :8191 / server / 执行器）见 README「快速开始 2b」；GPU 侧 ACE-Step 为剧场仓库**只读复用**，不得修改其文件、不得向其 venv 装包。

## 提 PR 前自查

- [ ] `node --test --test-concurrency=1 "test/acceptance/*.test.js"` 全绿（新行为须有新断言）
- [ ] 契约未动，或 CONTRACTS.md 已先行修改
- [ ] 未引入 npm 依赖；未把 `var/`、密钥、构建产物加入 git
- [ ] 用户可见文案不出现引擎型号名（ACE-Step/Qwen/SenseVoice…），AI 生成物带 `ai_label`

## 真机调试小抄（Android）

- 无线 adb：`adb connect <tailscale-ip>:5555`；Windows Git Bash 下建议用绝对路径 `~/AppData/Local/Android/Sdk/platform-tools/adb.exe`
- 白屏先看 PID 级日志：`adb logcat -d --pid=$(adb shell pidof <pkg>)`
- Flutter 页面对 uiautomator 无效，坐标操作前用 `exec-out screencap -p` 截图标定（可用 `scripts/png_probe.mjs` 做像素级定位）
- 后台播放问题查 `dumpsys media_session`（audio_service 三件套：Activity 继承 + Service/Receiver 声明 + FGS 权限，缺一即白屏）
