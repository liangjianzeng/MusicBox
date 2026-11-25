#!/bin/sh
# C2 客户端定妆照全链（跑在小米13）：项目 → cast_image → 轮询 → 读面
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
AT=$(cat $S/token)
WID=$(cat $S/work_id)
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
echo "== 项目（work_id=$WID，AI 脸档）"
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"f\",\"source\":\"ai\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\"}" $API/v1/mv/projects)
echo "proj=$(echo "$P" | head -c 400)"
PID=$(echo "$P" | jget id)
echo "$PID" > $S/project_id
echo "project_id=$PID"

echo "== 派单定妆照"
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
echo "jobs=$(echo "$G" | head -c 300)"
JOB=$(echo "$G" | jget job_id)
echo "job=$JOB"

echo "== 轮询"
i=0
while [ $i -lt 60 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status)
  echo "  [$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 400)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "$J" > $S/cast_job.json
echo "job_json=$(echo "$J" | head -c 900)"

echo "== 读面：项目定妆候选"
curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID" | head -c 900
echo
