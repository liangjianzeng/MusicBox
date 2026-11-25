#!/bin/sh
# K40 验证（上传人像真路径，即本次改动契约）：precheck → 上传 → 项目 → 定妆照 → 定妆视频 → 拍板
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
P=$S/portrait.png

echo "=== W1 游客"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d '{"device_key":"k40-fullload-1125"}' $API/v1/auth/guest)
AT=$(echo "$R" | tr '{,[]' '\n' | grep -oE '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$AT" > $S/token
echo "user=$(echo "$R" | tr '{,[]' '\n' | grep -oE '"nickname":"[^"]*"' | head -1 | cut -d'"' -f4)  token_len=${#AT}"

echo "=== W2 人像预检（facegate 四项人话反馈）"
curl -s -m 60 -H "authorization: Bearer $AT" -F "file=@$P" -F "consent=true" $API/v1/mv/image/precheck | head -c 700
echo

echo "=== W3 人像上传"
U=$(curl -s -m 60 -H "authorization: Bearer $AT" -F "file=@$P" -F "consent=true" $API/v1/mv/image)
echo "upload=$(echo "$U" | head -c 200)"
IMGID=$(echo "$U" | grep -oE 'ul_[a-f0-9]*' | head -1)
echo "image_id=$IMGID"
[ -z "$IMGID" ] && { echo "FATAL: 上传即无 image_id"; exit 1; }

echo "=== W4 项目（source=upload；先取消残留 casting 项目）"
OLD=$(cat $S/project_id 2>/dev/null)
if [ -n "$OLD" ]; then
  curl -s -m 15 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{}' $API/v1/mv/projects/$OLD/cancel | head -c 160
  echo
fi
WID=$(cat $S/work_id)
PR=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"m\",\"source\":\"upload\",\"image_id\":\"$IMGID\",\"name\":\"K40 验证主角\"},\"brief\":\"晨光室内定妆，柔和侧光\"}" $API/v1/mv/projects)
PID=$(echo "$PR" | grep -oE 'mvp_[a-f0-9]*' | head -1)
echo "project=$PID  err=$(echo "$PR" | grep -oE '"code":"[A-Z_]*"' | head -1)"
echo "$PID" > $S/project_id
[ -z "$PID" ] && { echo "FATAL: 项目即无 id"; exit 1; }

echo "=== W5 定妆照（上传照垫图 ×3 seed + facegate 对照）"
T=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
JOB=$(echo "$G" | tr '{,[]' '\n' | grep -oE '"job_id":"[^"]*"' | head -1 | cut -d'"' -f4)
i=0
while [ $i -lt 60 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 320)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "cast_image_status=$ST  wall=$(( $(date +%s) - T ))s"
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
IMG=$(echo "$P2" | grep -oE 'http://[^"]*\.png' | head -1)
echo "cast_images_n=$(echo "$P2" | grep -oE 'http://[^"]*\.png' | grep -c .)  first=$IMG"
[ -z "$IMG" ] && { echo "FATAL: 定妆照即无 URL"; exit 1; }
curl -s -m 60 -o $S/w5.png -w 'cast_image get_code=%{http_code} bytes=%{size_download}\n' "$IMG"

echo "=== W6 定妆视频"
T=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$IMG\"}}" $API/v1/mv/projects/$PID/jobs)
JOB=$(echo "$G" | tr '{,[]' '\n' | grep -oE '"job_id":"[^"]*"' | head -1 | cut -d'"' -f4)
i=0
while [ $i -lt 90 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 320)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "cast_video_status=$ST  wall=$(( $(date +%s) - T ))s"
P3=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$P3" | grep -oE 'http://[^"]*\.mp4' | head -1)
curl -s -m 180 -o $S/w6.mp4 -w 'cast_video get_code=%{http_code} bytes=%{size_download}\n' "$VID"
FRAMES=$(echo "$P3" | tr '{' '\n' | grep '"url":"http' | grep -oE 'http://[^"]*\.png')
echo "frames_n=$(echo "$FRAMES" | grep -c .)"
n=0
for f in $FRAMES; do n=$((n+1)); [ $n -gt 2 ] && break; curl -s -m 30 -o $S/w6_f$n.png -w "frame$n get_code=%{http_code} bytes=%{size_download}\n" "$f"; done

echo "=== W7 拍板 + 状态"
CH=$(echo "$P3" | grep -oE 'mvc_[a-f0-9]*' | head -1)
SEL=""; n=0
for f in $FRAMES; do n=$((n+1)); [ $n -gt 8 ] && break; [ -n "$SEL" ] && SEL="$SEL,"; SEL="$SEL{\"url\":\"$f\",\"sel\":true}"; done
C=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"character_id\":\"$CH\",\"cast_image_url\":\"$IMG\",\"frame_sel\":[$SEL]}" $API/v1/mv/projects/$PID/cast/confirm)
echo "confirm=$(echo "$C" | grep -oE '"code":"[A-Z_]*"' | head -1)  name=$(echo "$C" | grep -oE '"name":"[^"]*"' | head -1)"
P4=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "project_status=$(echo "$P4" | grep -oE '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)  viewrefs_n=$(echo "$P4" | tr '{' '\n' | grep '"url":"http' | grep -c .)"

echo "=== W8 全加载内存档"
curl -s -m 8 http://192.168.1.10:8188/system_stats | tr ',' '\n' | grep -E 'ram_free|ram_total' | head -2
curl -s -m 8 http://192.168.1.10:8190/health | tr ',' '\n' | grep -E 'handler_ready|lm_ready|gen_count|vram_peak_mb' | head -4
ls -la $S/w5.png $S/w6.mp4 $S/w6_f1.png 2>/dev/null
