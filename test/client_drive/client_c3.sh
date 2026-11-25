#!/bin/sh
# C3 客户端定妆视频全链（跑在小米13）：定妆照 → cast_video → 轮询 → 抽帧 → 产物取回 → 拍板
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
AT=$(cat $S/token)
PID=$(cat $S/project_id)
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "== 定妆照 URL"
P=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
IMG=$(echo "$P" | grep -oE 'http://[^"]*\.png' | head -1)
echo "cast_image=$IMG"

echo "== 派单定妆视频"
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$IMG\"}}" $API/v1/mv/projects/$PID/jobs)
echo "jobs=$(echo "$G" | head -c 260)"
JOB=$(echo "$G" | jget job_id)
echo "job=$JOB"

echo "== 轮询"
i=0
while [ $i -lt 90 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status)
  echo "  [$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 400)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "wall=$(( $(date +%s) ))"

echo "== 读面：定妆视频 + 抽帧"
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$P2" | jget cast_video_url)
echo "cast_video_url=$VID"
FRAMES=$(echo "$P2" | grep -oE 'http://[^"]*\.jpg' | head -13)
echo "frames_n=$(echo "$FRAMES" | grep -c .)"
curl -s -m 120 -o $S/c3.mp4 -w 'video get_code=%{http_code} bytes=%{size_download}\n' "$VID"
ls -la $S/c3.mp4

echo "== 拍板（定妆确认，frame_sel 前 8 帧）"
SEL=""
n=0
for f in $FRAMES; do
  n=$((n+1)); [ $n -gt 8 ] && break
  [ -n "$SEL" ] && SEL="$SEL,"
  SEL="$SEL{\"url\":\"$f\",\"sel\":true}"
done
CH=$(echo "$P2" | jget '"id":"mvc_')
[ -z "$CH" ] && CH=$(echo "$P2" | grep -oE 'mvc_[a-f0-9]*' | head -1)
C=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"cast_image_url\":\"$IMG\",\"frame_sel\":[$SEL]}" $API/v1/mv/projects/$PID/cast/confirm)
echo "confirm=$(echo "$C" | head -c 420)"
echo "project_status=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID" | jget status)"
