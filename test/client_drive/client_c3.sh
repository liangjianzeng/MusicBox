#!/bin/sh
# C3 定妆视频全链：认证→取第一张定妆照→派 cast_video→轮询→验证 视频+抽帧
# 参数: $1=API $2=device_key
API=${1:-http://192.168.1.10:7900}
KEY=${2:-c12-portrait-1125r2}
PID=mvp_b57a682a1dac71cb9941
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "########## C3 认证 ##########"
AT=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest | tr '{,[]' '\n' | grep -oE '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "token_len=${#AT}"

echo "########## 取第一张定妆照（项目响应内首个 .png URL）##########"
PR=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "$PR" > $S/c3_proj.json
C3=$(echo "$PR" | grep -oE 'http[^"]+\.png' | sed -n '1p')
echo "chosen_cast_image=$C3"

echo "########## C3 派单定妆视频 ##########"
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$C3\"}}" "$API/v1/mv/projects/$PID/jobs")
echo "jobs_raw=$(echo "$G" | head -c 300)"
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
echo "C3 job=$JOB"

i=0
while [ $i -lt 240 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/jobs/$JOB")
  ST=$(echo "$J" | jget status)
  echo "  c3poll[$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C3 FAIL: $(echo "$J" | sed -n '1p')"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "$J" > $S/c3_job.json

echo "########## C3 结果验证 ##########"
echo "$J" | grep -oE '"(status|note|cast_video_url|frame_[0-9]+_url)"[^,}]*' | sed -n '1,20p'
