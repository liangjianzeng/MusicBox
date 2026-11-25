#!/bin/sh
# C3c 拍板（定妆确认）修正：frames 即 .png 且带 "url" 键；显式 character_id
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
AT=$(cat $S/token)
PID=$(cat $S/project_id)

P=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
IMG=$(echo "$P" | grep -oE 'http://[^"]*\.png' | head -1)
CH=$(echo "$P" | grep -oE 'mvc_[a-f0-9]*' | head -1)
FRAMES=$(echo "$P" | tr '{' '\n' | grep '"url":"http' | grep -oE 'http://[^"]*\.png')
echo "character=$CH  frames_n=$(echo "$FRAMES" | grep -c .)  cast_image=$IMG"

echo "== 抽帧取回（客户端可达，前 3）"
n=0
for f in $FRAMES; do
  n=$((n+1)); [ $n -gt 3 ] && break
  curl -s -m 30 -o $S/frame_$n.png -w "frame$n get_code=%{http_code} bytes=%{size_download}\n" "$f"
done

echo "== 拍板"
SEL=""
n=0
for f in $FRAMES; do
  n=$((n+1)); [ $n -gt 8 ] && break
  [ -n "$SEL" ] && SEL="$SEL,"
  SEL="$SEL{\"url\":\"$f\",\"score\":null,\"sel\":true}"
done
C=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"character_id\":\"$CH\",\"cast_image_url\":\"$IMG\",\"frame_sel\":[$SEL]}" $API/v1/mv/projects/$PID/cast/confirm)
echo "confirm=$(echo "$C" | head -c 320)"

echo "== 状态推进（casting → scripting）"
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "project_status=$(echo "$P2" | grep -oE '"status":"[a-z]*"' | head -1)"
echo "viewrefs_n=$(echo "$P2" | tr '{' '\n' | grep '"url":"http' | grep -c .)"
echo "cast_image_url=$(echo "$P2" | grep -oE '"cast_image_url":"http[^"]*"' | head -1)"
