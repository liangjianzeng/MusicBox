#!/bin/sh
# C1音乐 -> C2真实人像定妆照(本地 portrait) -> C3定妆视频（自包含，跑测试机 toybox curl）
# 参数: $1=API $2=本地portrait路径 $3=device_key
API=${1:-http://192.168.1.10:7900}
PLOCAL=${2:-/data/local/tmp/mbx/portrait.png}
KEY=${3:-c123local-1309}
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "########## C1 音乐全链 ##########"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token); echo "token_len=${#AT} user=$(echo "$R" | jget nickname)"
T0=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"prompt\":\"温暖给妈妈写首生日歌\",\"mood\":\"温暖\",\"tags\":\"piano,warm,birthday\",\"sec\":30,\"count\":1,\"seed_base\":424243}" $API/v1/works/generate)
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
i=0
while [ $i -lt 120 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C1 FAIL: $(echo "$J"|head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
CID=$(echo "$J" | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
AD=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" "$API/v1/works/$CID/adopt")
WID=$(echo "$AD" | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
echo "$WID" > $S/work_id
echo "C1 wall=$(( $(date +%s) - T0 ))s work=$WID"

echo "########## C2 上传真实人像+定妆照 ##########"
UP=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -F "consent=true" -F "file=@$PLOCAL" $API/v1/mv/image)
IID=$(echo "$UP" | jget image_id); echo "$IID" > $S/image_id; echo "C2 image_id=$IID"
[ -z "$IID" ] && { echo "C2 UPLOAD FAIL: $(echo "$UP"|head -c 300)"; exit 1; }
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"f\",\"source\":\"upload\",\"image_id\":\"$IID\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\"}" $API/v1/mv/projects)
PID=$(echo "$P" | jget id); echo "$PID" > $S/project_id; echo "C2 project_id=$PID"
G2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
JOB2=$(echo "$G2" | jget job_id)
i=0
while [ $i -lt 120 ]; do
  J2=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB2)
  ST=$(echo "$J2" | jget status)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C2 FAIL: $(echo "$J2"|head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "C2 wall=$(( $(date +%s) - T0 ))s job=$JOB2 status=$(echo "$J2" | jget status)"
IMG=$(echo "$J2" | grep -oE 'http[^"]*\.png' | head -1); echo "C2 cast_image=$IMG"

echo "########## C3 定妆视频 ##########"
G3=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$IMG\"}}" $API/v1/mv/projects/$PID/jobs)
JOB3=$(echo "$G3" | jget job_id)
i=0
while [ $i -lt 180 ]; do
  J3=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB3)
  ST=$(echo "$J3" | jget status)
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C3 FAIL: $(echo "$J3"|head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$P2" | jget cast_video_url)
echo "C3 job=$JOB3 status=$(echo "$J3" | jget status) video=$VID"
curl -s -m 300 -o $S/c3.mp4 -w 'C3 video get_code=%{http_code} bytes=%{size_download}\n' "$VID" 2>/dev/null
echo "ALL-DONE key=$KEY work=$WID project=$PID video=$VID"