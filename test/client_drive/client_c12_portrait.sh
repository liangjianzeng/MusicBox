#!/bin/sh
# C1(音乐) -> C2(带真实人像定妆照) 组合全链（跑在测试机 toybox curl）
# 参数: $1=API $2=portrait_url $3=device_key
API=${1:-http://192.168.1.10:7900}
PURL=${2:-http://192.168.1.10:8765/portrait.png}
KEY=${3:-c12-portrait-1125r2}
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "########## C1 音乐：生成->adopt 拿 work_id ##########"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token); echo "$AT" > $S/token
echo "token_len=${#AT} user=$(echo "$R" | jget nickname)"
SEED=$(( $(date +%s%N) % 900000 + 100000 ))
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"prompt\":\"温暖给妈妈写首生日歌\",\"mood\":\"温暖\",\"tags\":\"piano,warm,birthday\",\"sec\":30,\"count\":1,\"seed_base\":$SEED}" $API/v1/works/generate)
echo "GEN_RAW=$(echo "$G" | head -c 400)"
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
echo "JOB=$JOB"
i=0
while [ $i -lt 120 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status)
  echo "  poll[$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C1 FAIL: $(echo "$J"|head -c 400)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "JOB_RAW=$(echo "$J" | head -c 500)"
CID=$(echo "$J" | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
echo "CID=$CID"
AD=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" "$API/v1/works/$CID/adopt")
echo "ADOPT_RAW=$(echo "$AD" | head -c 300)"
WID=$(echo "$AD" | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
echo "$WID" > $S/work_id
echo "C1 work_id=$WID"

echo "########## C2 上传真实人像 ##########"
curl -s -m 30 -o $S/portrait.png -w 'portrait_http=%{http_code} bytes=%{size_download}\n' "$PURL"
UP=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -F "consent=true" -F "file=@$S/portrait.png" $API/v1/mv/image)
echo "upload=$(echo "$UP" | head -c 260)"
IID=$(echo "$UP" | jget image_id); echo "$IID" > $S/image_id; echo "image_id=$IID"

echo "########## C2 建项目(source=upload) ##########"
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"f\",\"source\":\"upload\",\"image_id\":\"$IID\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\"}" $API/v1/mv/projects)
echo "proj=$(echo "$P" | head -c 400)"
PID=$(echo "$P" | jget id); echo "$PID" > $S/project_id

echo "########## C2 派单定妆照 ##########"
G2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
echo "jobs=$(echo "$G2" | head -c 260)"
JOB2=$(echo "$G2" | jget job_id)
i=0
while [ $i -lt 120 ]; do
  J2=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB2)
  ST=$(echo "$J2" | jget status)
  echo "  c2poll[$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "C2 FAIL: $(echo "$J2"|head -c 400)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "$J2" > $S/cast_job.json
echo "== job 摘要 =="
echo "$J2" | grep -oE '"(status|note|code|message)"[^,}]*' | head -12
echo "== 项目定妆候选(机检写入) =="
curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID" | grep -oE '"(cast_image_[0-9]+_url|status)"[^,}]*' | head -12
