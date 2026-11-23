# 安全策略（Security Policy）

## 报告漏洞

请通过 GitHub 的 **Report a vulnerability**（Security Advisories，私密渠道）报告安全问题，勿开公开 Issue。
我们会尽力在 72 小时内响应、30 天内给出处理结论。

## 本项目的基本安全边界（自述）

- 鉴权：`Authorization: Bearer <access_token>`；令牌仅存哈希（`sessions.access_token_hash`，SHA-256）
- 审核：用户输入与生成参数过词库（`var/config/moderation_words.txt`，数据不入仓）拦截 `MODERATION_BLOCK`
- AI 标识：一切生成物带 `ai_label`，用户界面不暴露底层引擎型号
- 计费账本：`credit_ledger` 只追加、Σdelta==balance 恒等校验为验收硬断言（V1）
- 产物访问：`/f/*` 为不可猜测文件名（`f_<20hex>`）；正式部署应置于鉴权反代之后

## 不支持版本

v0.x 开发期：仅 `main` 分支获得安全修复。
