#!/bin/sh
# 全业务流 C1->C2定妆保脸->C3定妆视频。自包含，跑测试机 toybox curl。
# 每步把产物落设备 $S，附 sha256；主机侧再 pull 肉眼复核。
# 参数: $1=API  $2=女主portrait路径  $3=device_key
API=${1:-http://192.168.1.10:7900}
PLOCAL=${2:-/data/local/tmp/mbx/protagonist_female.jpg}
KEY=${3:-faceguard-1450}
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
save() { # save <url> <outfile>  -> prints sha
  curl -s -m 90 -o "$S/$2" -w "  $2 code=%{http_code} bytes=%{size_download}\n" "$1" 2>/dev/null
  sha256sum "$S/$2" 2>/dev/null | awk '{print "  $2 sha="$1}'
}

echo "########## C1 音乐 ##########"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token); echo "token=${#AT} user=$(echo "$R" | jget nickname)"
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"prompt\":\"温暖给妈妈写首生日歌\",\"mood\":\"温暖\",\"tags\":\"piano,warm,birthday\",\"sec\":30,\"count\":1,\"seed_base\":424243}" $API/v1/works/generate)
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
i=0
while [ $i -lt 120 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status); [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C1 FAIL: $(echo "$J"|head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
CID=$(echo "$J" | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
AD=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" "$API/v1/works/$CID/adopt")
WID=$(echo "$AD" | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
echo "$WID" > $S/work_id; echo "C1 work=$WID"

echo "########## C2-a 上传女主 portrait ##########"
echo "upload sha: $(sha256sum "$PLOCAL" 2>/dev/null | awk '{print $1}')"
UP=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -F "consent=true" -F "file=@$PLOCAL" $API/v1/mv/image)
IID=$(echo "$UP" | jget image_id); echo "$IID" > $S/image_id; echo "C2 image_id=$IID"
[ -z "$IID" ] && { echo "C2 UPLOAD FAIL: $(echo "$UP"|head -c 300)"; exit 1; }

echo "########## C2-b 建项目 ##########"
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"f\",\"source\":\"upload\",\"image_id\":\"$IID\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\"}" $API/v1/mv/projects)
PID=$(echo "$P" | jget id); echo "$PID" > $S/project_id; echo "C2 project=$PID"
[ -z "$PID" ] && { echo "C2 PROJECT FAIL: $(echo "$P"|head -c 300)"; exit 1; }

echo "########## C2-c 派 cast_image（保脸关键，下载 3 候选）##########"
G2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
JOB2=$(echo "$G2" | jget job_id)
i=0
while [ $i -lt 180 ]; do
  J2=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB2)
  ST=$(echo "$J2" | jget status); [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C2 CAST FAIL: $(echo "$J2"|head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "C2 job=$JOB2 status=$(echo "$J2" | jget status) face_scores=$(echo "$J2" | grep -oE '\"face_scores\":\[[^]]*\]' | head -1)"
# 候选 url 在 job result.files.cast_image_1..3 指向字段；从 project 取 cast_images 或从 result 解析
CASTS=$(echo "$J2" | grep -oE 'http[^"]*\.png' | head -3)
n=0
for U in $CASTS; do
  n=$((n+1)); save "$U" "c2_cast_$n.png"
  [ $n -ge 3 ] && break
done
[ $n -lt 1 ] && { echo "C2 未取到候选图 url，尝试从 project 取"; PJ=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID"); echo "$PJ" | grep -oE 'http[^"]*\.png' | head -3 | while read U; do n=$((n+1)); save "$U" "c2_cast_$n.png"; done; }
echo "C2 saved $n candidates"

echo "########## C2-e cast/confirm 拍板（选候选1）##########"
FIRSTIMG=$(ls $S/c2_cast_1.png 2>/dev/null)
curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"character_id\":\"\",\"cast_image_url\":\"$(echo "$CASTS" | head -1)\"}" $API/v1/mv/projects/$PID/cast/confirm | head -c 200
echo

echo "########## C3 定妆视频（复核仍为女主）##########"
IMGURL=$(echo "$CASTS" | head -1)
G3=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$IMGURL\"}}" $API/v1/mv/projects/$PID/jobs)
JOB3=$(echo "$G3" | jget job_id)
i=0
while [ $i -lt 300 ]; do
  J3=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB3)
  ST=$(echo "$J3" | jget status); [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C3 FAIL: $(echo "$J3"|head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
P2=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$P2" | jget cast_video_url)
echo "C3 job=$JOB3 status=$(echo "$J3" | jget status) video=$VID"
save "$VID" "c3_cast_video.mp4"

echo "ALL-DONE key=$KEY work=$WID project=$PID image=$IID c2candidates=$n video=$VID"
