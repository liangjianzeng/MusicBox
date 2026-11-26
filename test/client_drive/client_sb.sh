#!/bin/sh
# storyboard 派单：自动编译剧本+同步镜头+出 storyboard_url
# 参数: $1=API $2=device_key
API=${1:-http://192.168.1.10:7900}
KEY=${2:-c12-portrait-1125r2}
PID=mvp_b57a682a1dac71cb9941
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "########## S1 认证 ##########"
AT=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest | tr '{,[]' '\n' | grep -oE '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "token_len=${#AT}"

echo "########## S2 派单 storyboard ##########"
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d '{"type":"storyboard"}' "$API/v1/mv/projects/$PID/jobs")
echo "jobs_raw=$(echo "$G" | head -c 400)"
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
echo "S job=$JOB"

i=0
while [ $i -lt 300 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/jobs/$JOB")
  ST=$(echo "$J" | jget status)
  echo "  spoll[$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "S FAIL: $(echo "$J" | head -c 500)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "$J" > $S/storyboard_job.json

echo "########## S3 项目状态与镜头 ##########"
PR=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "$PR" > $S/storyboard_proj.json
echo "$PR" | grep -oE '"status":"[^"]*"' | head -1
echo "$PR" | grep -oE '"(seq|status|storyboard_url)"[^,}]*' | head -30
