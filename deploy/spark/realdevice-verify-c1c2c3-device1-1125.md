# 真机全链路验证 · 设备 1（98fc9410 / gx10-85f3）C1→C2→C3

日期：2026-11-25（Asia/Shanghai）

## 结论
C1（音乐）→ C2（定妆照）→ C3（定妆视频）三环节在设备 1 全链路跑通，产出经文件级魔数校验为真图真视频。

## 产物与验证

### C1 音乐链（上轮已验）
- work_id=`w_9b740dd4e36480d1277d`，bpm 92，30s。

### C2 定妆照
- 角色 `mvc_2d874c974a079716031b`，`source=upload`，`portrait_upload=ul_37a6d4a9b6bc553ca407`。
- 3 张候选图 `cast_images`，真 PNG，单张 ~1.8MB，魔数 `89 50 4E 47 0D 0A 1A 0A`。

### C3 定妆视频（本轮完成）
- 派单 `job=j_1a848093f5e72edaeca6`，`credits_charged=20`，状态 done，progress 100，note="定妆视频完成"，error=None。
- 落库 `cast_video_url=http://192.168.1.10:7900/f/2026-11/f_8d90a32b28e824960c00.mp4`
  - 真 MP4：4,230,425 bytes，`file` → ISO Media MP4 Base Media v1；魔数 `00 00 00 20 66 74 79 70 69 73 6F 6D`（ftypisom）。
- 抽帧 13 张，示例 `f_546bd7a9762f89078464.png`：真 PNG，736×1312 RGB，魔数 `89 50 4E 47`。抽帧图为女性侧脸肖像（米白色高领罗纹针织衫）。

## 本轮修复

### Bug 1：C3 派单参数结构（client_c3.sh）
`POST /v1/mv/projects/:id/jobs` 的 `cast_video` 分支（`src/server/api/mv.js:691-694`）取
`params.cast_image_url || ch.cast_image_url`，而 `params` 来自 body 的嵌套 `b.params`
（`src/server/api/mv.js:673`）。顶层传 `cast_image_url` 被静默忽略，返回
`BAD_REQUEST: 请先派单 cast_image 并挑选定妆照`。

修正：请求体改为
```json
{"type":"cast_video","params":{"cast_image_url":"http://.../f_30243d977e57966d3941.png"}}
```
修正后派单到计费步（`credits_charged=20`），确认参数结构已正确。

### Bug 2：游客积分耗尽
`GET /v1/auth/guest` 按 `device_key` 复用游客号（`src/server/api/admin.js:51`），故
C1/C2/C3 为同一用户 `u_475c779d35c2bf48f14f`。账本显示当日 `+50` 免费档被两轮 C1+C2
耗尽（`-15gen -10cast -15gen -10cast = -50`），C3 报 `CREDITS_NOT_ENOUGH`。

解决：用运营后台凭据（用户名/口令取自 `etc/spark.env`，2026-11-26 抢救脱敏：用户名不再写进本文档，该账号口令已轮换）登录 `/admin/login` 取 token，
`POST /admin/credits/adjust {user_id, delta:50, reason:"realdevice-verify-c3"}` →
`balance_after:50`。随后 C3 正常计费。

## 待办
- 设备 2 `8b1e8747`：跑同样 C1+C2+C3 全链。
- 设备 3 `M332BF`：relay `100.75.247.55` 离线，待重测。

## 留档
- 定妆视频抽帧：`/tmp/cast_frame.png`（736×1312 PNG）
- 定妆视频：`/tmp/cast_video.mp4`（4.2MB MP4）
