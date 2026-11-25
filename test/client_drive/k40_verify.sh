#!/bin/sh
# K40（2211133C / Android 16 / 98fc9410）验证本次改动：DGX 落位后端 + 客户端全链
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
mkdir -p $S
ok() { echo "  -> $1"; }

echo "=== V0 网 / 包 / 服务档"
curl -s -m 5 -o /dev/null -w 'healthz=%{http_code}\n' $API/healthz
ifconfig wlan0 2>/dev/null | grep -E 'inet addr' | head -1
curl -s -m 5 http://192.168.1.10:8190/health | tr ',' '\n' | grep -E 'handler_ready|lm_ready|gen_count' | head -3

echo "=== V1 游客会话（device_key k40-fullload-1125）"
T=$(date +%s)
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d '{"device_key":"k40-fullload-1125"}' $API/v1/auth/guest)
AT=$(echo "$R" | tr '{,[]' '\n' | grep -oE '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$AT" > $S/token
echo "user=$(echo "$R" | tr '{,[]' '\n' | grep -oE '"nickname":"[^"]*"' | head -1 | cut -d'"' -f4)  token_len=${#AT}  wall=$(( $(date +%s) - T ))s"

echo "=== V2 生乐（sec=30 count=1 seed=424250）"
T=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d '{"prompt":"清晨阳光，给爸爸写首温柔唤醒 song","mood":"温柔","tags":"guitar,warm,morning","sec":30,"count":1,"seed_base":424250}' $API/v1/works/generate)
JOB=$(echo "$G" | tr '{,[]' '\n' | grep -oE '"job_id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "job=$JOB  credits=$(echo "$G" | tr '{,[]' '\n' | grep -oE '"credits_charged":[0-9]+' | head -1)"
i=0
while [ $i -lt 40 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "music_status=$ST  wall=$(( $(date +%s) - T ))s"
AU=$(echo "$J" | grep -oE '"audio_url":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -m 90 -o $S/v2.mp3 -w 'audio get_code=%{http_code} bytes=%{size_download}\n' "$AU"
CID=$(echo "$J" | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
A=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" $API/v1/works/$CID/adopt)
WID=$(echo "$A" | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
echo "$WID" > $S/work_id
echo "adopt work=$WID"
curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/works?mine=1" | grep -oE '"title":"[^"]*"' | head -3

echo "=== V3 项目 + 定妆照"
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"m\",\"source\":\"ai\",\"name\":\"K40 验证主角\"},\"brief\":\"晨光室内定妆，柔和侧光，中性背景\"}" $API/v1/mv/projects)
PID=$(echo "$P" | grep -oE 'mvp_[a-f0-9]*' | head -1)
echo "$PID" > $S/project_id
echo "project=$PID  status=$(echo "$P" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)"
T=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
JOB=$(echo "$G" | tr '{,[]' '\n' | grep -oE '"job_id":"[^"]*"' | head -1 | cut -d'"' -f4)
i=0
while [ $i -lt 40 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "cast_image_status=$ST  wall=$(( $(date +%s) - T ))s"
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
IMG=$(echo "$P2" | grep -oE 'http://[^"]*\.png' | head -1)
echo "cast_images_n=$(echo "$P2" | grep -oE 'http://[^"]*\.png' | grep -c .)  first=$IMG"
curl -s -m 60 -o $S/v3.png -w 'cast_image get_code=%{http_code} bytes=%{size_download}\n' "$IMG"

echo "=== V4 定妆视频"
T=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$IMG\"}}" $API/v1/mv/projects/$PID/jobs)
JOB=$(echo "$G" | tr '{,[]' '\n' | grep -oE '"job_id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "job=$JOB"
i=0
while [ $i -lt 90 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "cast_video_status=$ST  wall=$(( $(date +%s) - T ))s"
P3=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$P3" | grep -oE 'http://[^"]*\.mp4' | head -1)
curl -s -m 180 -o $S/v4.mp4 -w 'cast_video get_code=%{http_code} bytes=%{size_download}\n' "$VID"
FRAMES=$(echo "$P3" | tr '{' '\n' | grep '"url":"http' | grep -oE 'http://[^"]*\.png')
echo "frames_n=$(echo "$FRAMES" | grep -c .)"
n=0
for f in $FRAMES; do n=$((n+1)); [ $n -gt 2 ] && break; curl -s -m 30 -o $S/v4_f$n.png -w "frame$n get_code=%{http_code} bytes=%{size_download}\n" "$f"; done

echo "=== V5 拍板 + 状态推进"
CH=$(echo "$P3" | grep -oE 'mvc_[a-f0-9]*' | head -1)
SEL=""; n=0
for f in $FRAMES; do n=$((n+1)); [ $n -gt 8 ] && break; [ -n "$SEL" ] && SEL="$SEL,"; SEL="$SEL{\"url\":\"$f\",\"sel\":true}"; done
C=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"character_id\":\"$CH\",\"cast_image_url\":\"$IMG\",\"frame_sel\":[$SEL]}" $API/v1/mv/projects/$PID/cast/confirm)
echo "confirm_code=$(echo "$C" | grep -oE '"code":"[A-Z_]*"' | head -1)  character=$(echo "$C" | grep -oE '"name":"[^"]*"' | head -1)"
P4=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "project_status=$(echo "$P4" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)  viewrefs_n=$(echo "$P4" | tr '{' '\n' | grep '"url":"http' | grep -c .)"

echo "=== V6 全加载内存档（三族 + 生乐 同时驻）"
curl -s -m 8 http://192.168.1.10:8188/system_stats | tr ',' '\n' | grep -E 'ram_free|ram_total' | head -2
curl -s -m 8 http://192.168.1.10:8190/health | tr ',' '\n' | grep -E 'handler_ready|lm_ready|gen_count|vram_peak_mb' | head -4
ls -la $S/v2.mp3 $S/v3.png $S/v4.mp4 $S/v4_f1.png 2>/dev/null
