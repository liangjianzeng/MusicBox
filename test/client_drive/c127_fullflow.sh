#!/bin/sh
# 全业务流 C1->C7。设备只驱动 API 编排；文件下载/肉眼复核由主机完成（设备在 Tailscale，连不上 API 的 LAN 文件 URL）。
# 每步把 project_id + 关键文件 URL 追加到 manifest，主机 pull manifest 后逐个 curl 复核。
# 参数: $1=API  $2=女主portrait路径  $3=device_key
API=${1:-http://100.81.83.59:7900}
PLOCAL=${2:-/data/local/tmp/mbx/protagonist_female.jpg}
KEY=${3:-dev-m332bf-1540}
S=/data/local/tmp/mbx
MAN=$S/manifest.txt
: > $MAN
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
jgetj() { # jgetj <json> <path like candidates.0.id>  simple: echo json to stdout
  echo "$1"
}
poll() { # poll <jobid> -> echoes full job JSON on done, "failed:<json>" on fail
  local JID=$1 N=120 i=0 J ST
  while [ $i -lt $N ]; do
    J=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/jobs/$JID")
    ST=$(echo "$J" | jget status); [ "$ST" = done ] && { echo "$J"; return; }
    [ "$ST" = failed ] && { echo "failed:$J"; return; }
    i=$((i+1)); sleep 5
  done
  echo "$J"
}
manifest() { echo "$1" >> $MAN; }

echo "########## C1 音乐(60s女生歌唱) ##########"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token); echo "token=${#AT} user=$(echo "$R" | jget nickname)"
LYRICS='夜的安静 你在我身边 风过头发 时间是礼物 光的承诺 慢慢说 都不远'
G=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"mode\":\"custom\",\"prompt\":\"女声演唱，温暖女声，细腻高音\",\"lyrics\":\"$LYRICS\",\"tags\":\"female,vocal,warm,piano\",\"mood\":\"warm\",\"bpm\":80,\"sec\":60,\"count\":1,\"vocal\":\"song\"}" $API/v1/works/generate)
JOB=$(echo "$G" | jget job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jget id)
echo "C1 job=$JOB"
ST=$(poll "$JOB"); echo "C1 job status=$ST"
case "$ST" in failed:*) echo "C1 FAIL: $ST"; exit 1;; esac
CID=$(echo "$ST" | jgetj | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$CID" ] && CID=$(echo "$ST" | grep -oE 'c_[0-9a-f]+' | head -1)
AD=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" "$API/v1/works/$CID/adopt")
WID=$(echo "$AD" | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$WID" ] && WID=$(echo "$ST" | grep -oE 'result_work_id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$WID" ] && WID=$(echo "$AD" | grep -oE 'w_[0-9a-f]+' | head -1)
echo "C1 work=$WID"
manifest "C1 work_id=$WID"

echo "########## C2-a 上传女主 portrait ##########"
echo "upload sha: $(sha256sum "$PLOCAL" 2>/dev/null | awk '{print $1}')"
UP=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -F "consent=true" -F "file=@$PLOCAL" $API/v1/mv/image)
IID=$(echo "$UP" | jget image_id); echo "$IID" > $S/image_id; echo "C2 image_id=$IID"
[ -z "$IID" ] && { echo "C2 UPLOAD FAIL: $(echo "$UP"|head -c 300)"; exit 1; }

echo "########## C2-b 建项目(budget_credits=1000000) ##########"
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"f\",\"source\":\"upload\",\"image_id\":\"$IID\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\",\"budget_credits\":1000000}" $API/v1/mv/projects)
PID=$(echo "$P" | jget id); echo "$PID" > $S/project_id; echo "C2 project=$PID"
[ -z "$PID" ] && { echo "C2 PROJECT FAIL: $(echo "$P"|head -c 300)"; exit 1; }
manifest "C2 project_id=$PID"

echo "########## C2-c cast_image(保脸关键) ##########"
G2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' $API/v1/mv/projects/$PID/jobs)
JOB2=$(echo "$G2" | jget job_id)
ST2=$(poll "$JOB2"); echo "C2 cast job=$JOB2 status=$ST2"
case "$ST2" in failed:*) echo "C2 CAST FAIL: $ST2"; exit 1;; esac
# 候选图 URL 在项目 JSON 的 cast_images（LAN 地址，主机拉取）
PJ=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
CASTS=$(echo "$PJ" | grep -oE 'http[^"]*\.png' | head -3)
n=0; for U in $CASTS; do n=$((n+1)); echo "c2_cast_$n $U" >> $MAN; echo "  c2_cast_$n=$U"; done
manifest "C2 cast_images=$(echo $CASTS | tr ' ' ',')"
[ $n -lt 1 ] && { echo "C2 未取到候选图"; }

echo "########## C2-e cast/confirm 拍板（选候选1）##########"
FIRSTIMG=$(echo "$CASTS" | head -1)
CF=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"cast_image_url\":\"$FIRSTIMG\"}" $API/v1/mv/projects/$PID/cast/confirm)
echo "C2 confirm: $(echo "$CF" | jget status)"
manifest "C2 confirm=$(echo "$CF" | head -c 200)"

echo "########## C3 定妆视频 ##########"
G3=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$FIRSTIMG\"}}" $API/v1/mv/projects/$PID/jobs)
JOB3=$(echo "$G3" | jget job_id)
ST3=$(poll "$JOB3"); echo "C3 cast job=$JOB3 status=$ST3"
case "$ST3" in failed:*) echo "C3 FAIL: $ST3"; exit 1;; esac
PJ=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
VID=$(echo "$PJ" | grep -oE 'http[^"]*\.mp4' | head -1); echo "C3 video=$VID"
[ -n "$VID" ] && manifest "C3 cast_video=$VID"

echo "########## C4 拍镜(storyboard->逐镜 shoot) ##########"
GS=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"storyboard"}' $API/v1/mv/projects/$PID/jobs)
JOB_S=$(echo "$GS" | jget job_id); ST_S=$(poll "$JOB_S"); echo "C4 storyboard job=$JOB_S status=$ST_S"
PJ=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
echo "$PJ" | grep -oE '"shots":\[[^]]*\]' | sed 's/"shots":\[//; s/\]$//' | grep -oE '\{[^{}]*\}' | while read shot; do
  SID=$(echo "$shot" | grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  SKIND=$(echo "$shot" | grep -oE '"kind":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "  shot=$SID kind=$SKIND"
  echo "$SID $SKIND" >> $S/shots.txt
done
# 逐镜 shoot
while read SID SKIND; do
  [ -z "$SID" ] && continue
  GS2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"type\":\"shoot\",\"params\":{\"shot_id\":\"$SID\"}}" $API/v1/mv/projects/$PID/jobs)
  JS=$(echo "$GS2" | jget job_id); SS=$(poll "$JS"); echo "C4 shoot $SID job=$JS status=$SS"
  case "$SS" in failed:*) echo "C4 shoot $SID FAIL: $SS";; esac
done < $S/shots.txt
manifest "C4 shots=$(cat $S/shots.txt 2>/dev/null | tr '\n' ';')"

echo "########## C5 口型(演唱镜) ##########"
grep 'singing' $S/shots.txt 2>/dev/null | while read SID SKIND; do
  [ -z "$SID" ] && continue
  GL=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"type\":\"lipsync\",\"params\":{\"shot_id\":\"$SID\"}}" $API/v1/mv/projects/$PID/jobs)
  JL=$(echo "$GL" | jget job_id); SL=$(poll "$JL"); echo "C5 lipsync $SID job=$JL status=$SL"
done

echo "########## C6 歌词对齐 ##########"
GA=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"align"}' $API/v1/mv/projects/$PID/jobs)
JA=$(echo "$GA" | jget job_id); ST_A=$(poll "$JA"); echo "C6 align job=$JA status=$ST_A"

echo "########## C7 成片合成 ##########"
GC=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"compose"}' $API/v1/mv/projects/$PID/jobs)
JC=$(echo "$GC" | jget job_id); ST_C=$(poll "$JC"); echo "C7 compose job=$JC status=$ST_C"
case "$ST_C" in failed:*) echo "C7 FAIL: $ST_C";; fi
PJ=$(curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID")
MV=$(echo "$PJ" | grep -oE 'http[^"]*\.mp4' | tail -1); echo "C7 mv_video=$MV"
[ -n "$MV" ] && manifest "C7 mv_video=$MV"

echo "ALL-DONE key=$KEY work=$WID project=$PID c2candidates=$n video=$VID mv=$MV"
manifest "RESULT=ALL-DONE key=$KEY work=$WID project=$PID"
