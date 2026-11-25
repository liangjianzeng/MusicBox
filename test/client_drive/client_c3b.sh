#!/bin/sh
# C3b 定妆视频产物取回 + 拍板（跑在小米13，复用项目）
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
AT=$(cat $S/token)
PID=$(cat $S/project_id)

echo "== 读面：定妆视频 + 抽帧"
P=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$P" | grep -oE 'http://[^"]*\.mp4' | head -1)
IMG=$(echo "$P" | grep -oE 'http://[^"]*\.png' | head -1)
FRAMES=$(echo "$P" | grep -oE 'http://[^"]*\.jpg' | head -13)
echo "cast_video_url=$VID"
echo "cast_image=$IMG"
echo "frames_n=$(echo "$FRAMES" | grep -c .)"

echo "== 产物取回（客户端可达）"
curl -s -m 180 -o $S/c3.mp4 -w 'video get_code=%{http_code} bytes=%{size_download}\n' "$VID"
curl -s -m 30 -o $S/c3_f1.jpg -w 'frame get_code=%{http_code} bytes=%{size_download}\n' "$(echo "$FRAMES" | head -1)"
ls -la $S/c3.mp4 $S/c3_f1.jpg

echo "== 拍板（定妆确认，前 8 帧）"
SEL=""
n=0
for f in $FRAMES; do
  n=$((n+1)); [ $n -gt 8 ] && break
  [ -n "$SEL" ] && SEL="$SEL,"
  SEL="$SEL{\"url\":\"$f\",\"sel\":true}"
done
C=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"cast_image_url\":\"$IMG\",\"frame_sel\":[$SEL]}" $API/v1/mv/projects/$PID/cast/confirm)
echo "confirm=$(echo "$C" | head -c 300)"

echo "== 状态推进"
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "project_status=$(echo "$P2" | grep -oE '"status":"[a-z]*"' | head -1)"
echo "viewrefs_n=$(echo "$P2" | grep -oE '"url":"http' | grep -c .)"
echo "cast_image_url_set=$(echo "$P2" | grep -oE '"cast_image_url":"http[^"]*"' | head -1)"
