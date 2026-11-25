#!/bin/sh
# C1 客户端音乐全链（跑 **在小米13**，toybox curl）：游客 → 派单 → 轮询 → 产物取回 → 采纳
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "== C0 网与健康"
curl -s -m 5 -o /dev/null -w 'healthz=%{http_code}\n' $API/healthz

echo "== C1 游客会话"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d '{"device_key":"xm13-fullload-1125"}' $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token)
echo "access_token_len=${#AT}  user=$(echo "$R" | jget nickname)"
echo "$AT" > $S/token

echo "== C1 派单（sec=30 count=1）"
T0=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d '{"prompt":"温暖，给妈妈写首温馨的生日歌","mood":"温暖","tags":"piano,warm,gentle,birthday","sec":30,"count":1,"seed_base":424243}' $API/v1/works/generate)
JOB=$(echo "$G" | jget job_id)
[ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
echo "job=$JOB"
echo "resp=$(echo "$G" | head -c 300)"

echo "== C1 轮询"
i=0
while [ $i -lt 90 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status)
  PR=$(echo "$J" | tr '{,[]' '\n' | grep -oE '"progress":[0-9]+' | head -1 | cut -d: -f2)
  echo "  [$((i*5))s] status=$ST progress=$PR"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 400)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "wall=$(( $(date +%s) - T0 ))s"
echo "$J" > $S/job.json

echo "== C1 产物取回（客户端可达）"
AU=$(cat $S/job.json | jget audio_playback)
[ -z "$AU" ] && AU=$(cat $S/job.json | jget audio_master)
echo "url=$AU"
curl -s -m 90 -o $S/c1.wav -w 'get_code=%{http_code} bytes=%{size_download}\n' "$AU"
ls -la $S/c1.wav
CID=$(cat $S/job.json | tr '{,[]' '\n' | grep -oE '"id":"cand[^"]*"' | head -1 | cut -d'"' -f4)
echo "cand=$CID"
A=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{}' $API/v1/works/$CID/adopt)
echo "adopt=$(echo "$A" | head -c 240)"
WID=$(echo "$A" | jget work_id)
[ -z "$WID" ] && WID=$(echo "$A" | tr '{,[]' '\n' | grep -oE '"id":"w[^"]*"' | head -1 | cut -d'"' -f4)
echo "$WID" > $S/work_id
echo "work_id=$WID"
