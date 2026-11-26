#!/bin/sh
# C1 音乐全链（测试机 toybox curl）：游客→派单→轮询→产物取回→adopt
# 参数: $1=API $2=device_key
API=${1:-http://192.168.1.10:7900}
KEY=${2:-d1-fullload-1125r2}
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
echo "== C0 健康"
curl -s -m 6 -o /dev/null -w 'healthz=%{http_code}\n' $API/healthz
echo "== C1 游客"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token)
echo "token_len=${#AT} user=$(echo "$R" | jget nickname)"
echo "$AT" > $S/token
echo "== C1 派单"
T0=$(date +%s)
G=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"prompt\":\"温暖给妈妈写首生日歌\",\"mood\":\"温暖\",\"tags\":\"piano,warm,birthday\",\"sec\":30,\"count\":1,\"seed_base\":424243}" $API/v1/works/generate)
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
echo "job=$JOB"
echo "== C1 轮询"
i=0
while [ $i -lt 120 ]; do
  J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
  ST=$(echo "$J" | jget status)
  echo "  [$((i*5))s] status=$ST"
  [ "$ST" = done ] && break
  [ "$ST" = failed ] && { echo "FAIL: $(echo "$J" | head -c 300)"; exit 1; }
  i=$((i+1)); sleep 5
done
echo "wall=$(( $(date +%s) - T0 ))s"
# 轮询后重拉完整 job（poll 可能返回摘要无 candidates）
J=$(curl -s -m 15 -H "authorization: Bearer $AT" $API/v1/jobs/$JOB)
echo "$J" > $S/job.json
echo "== C1 产物"
AU=$(echo "$J" | jget audio_url); WU=$(echo "$J" | tr '{,[]' '\n' | grep -oE '"waveform_url":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$AU" ] && curl -s -m 30 -o $S/audio.mp3 -w 'audio=%{http_code} %{size_download}\n' "$AU"
[ -n "$WU" ] && curl -s -m 20 -o $S/wave.json -w 'wave=%{http_code} %{size_download}\n' "$WU"
echo "== C1 adopt（路径用 candidate_id）"
CID=$(echo "$J" | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
echo "candidate_id=$CID"
AD=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" "$API/v1/works/$CID/adopt")
echo "adopt=$(echo "$AD" | head -c 300)"
WID=$(echo "$AD" | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
echo "work_id=$WID"
echo "DONE key=$KEY job=$JOB wall=${wall:-?}s"
