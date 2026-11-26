#!/usr/bin/env bash
# 主机驱动 C1->C7 全编排。host 调 guest 拿稳定 token、可直取 LAN 产物做肉眼复核。
# 设备仅用于：portrait 真机上传(已上传 ul_*) + 最终 mv_video 推设备真机播放。
set -u
API=${API:-http://192.168.1.10:7900}
EV=deploy/spark/evidence/flow-$(date +%m%d-%H%M)
mkdir -p "$EV"
KEY=${KEY:-host-flow-1612}
PORTRAIT=${PORTRAIT:-var/input/protagonist_female.jpg}
LYRICS='夜的安静 你在我身边 风过头发 时间是礼物 光的承诺 慢慢说 都不远'

jget() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
jgetid() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
jgetj() { grep -oE '\{[^{}]*\}' | head -1; }
poll() { # poll <jobid> -> full job JSON on done, "failed:<json>" on fail
  local JID=$1 i=0 J ST
  while [ $i -lt 120 ]; do
    J=$(curl -s -m 20 "$API/v1/jobs/$JID" -H "authorization: Bearer $AT")
    ST=$(echo "$J" | jget status); [ "$ST" = done ] && { echo "$J"; return; }
    [ "$ST" = failed ] && { echo "failed:$J"; return; }
    i=$((i+1)); sleep 4
  done
  echo "$J"
}
dl() { # dl <url> <outfile>
  curl -s -m 120 -o "$EV/$2" "$1"
  echo "  -> $2 bytes=$(stat -c%s "$EV/$2" 2>/dev/null || echo 0) sha=$(sha256sum "$EV/$2" 2>/dev/null | cut -c1-16)"
}

echo "########## auth ##########"
AT=$(curl -s -m 10 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" "$API/v1/auth/guest" | jget access_token)
echo "token=${#AT} user=$(curl -s -m 8 "$API/v1/credits" -H "authorization: Bearer $AT" | jget balance 2>/dev/null || echo n/a)"

echo "########## C1 音乐(60s女生歌唱) ##########"
G=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"mode\":\"custom\",\"prompt\":\"女声演唱，温暖女声，细腻高音\",\"lyrics\":\"$LYRICS\",\"tags\":\"female,vocal,warm,piano\",\"mood\":\"warm\",\"bpm\":80,\"sec\":60,\"count\":1,\"vocal\":\"song\"}" "$API/v1/works/generate")
JOB=$(echo "$G" | jgetid job_id); [ -z "$JOB" ] && JOB=$(echo "$G" | jgetid id)
ST=$(poll "$JOB"); echo "C1 job=$JOB status"
case "$ST" in failed:*) echo "C1 FAIL"; exit 1;; esac
CID=$(echo "$ST" | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
WID=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" "$API/v1/works/$CID/adopt" | jgetid id)
[ -z "$WID" ] && WID=$(echo "$ST" | grep -oE 'result_work_id":"w_[^"]*"' | cut -d'"' -f4)
echo "C1 work=$WID"

echo "########## C2-a 上传女主 portrait(真机输入) ##########"
IID=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -F "consent=true" -F "file=@$PORTRAIT" "$API/v1/mv/image" | jgetid image_id)
echo "C2 image_id=$IID"

echo "########## C2-b 建项目 ##########"
PID=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"$WID\",\"character\":{\"gender\":\"f\",\"source\":\"upload\",\"image_id\":\"$IID\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\",\"budget_credits\":1000000}" "$API/v1/mv/projects" | jgetid id)
echo "C2 project=$PID"

echo "########## C2-c cast_image(保脸关键) ##########"
G2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"cast_image"}' "$API/v1/mv/projects/$PID/jobs")
JOB2=$(echo "$G2" | jgetid job_id); ST2=$(poll "$JOB2")
case "$ST2" in failed:*) echo "C2 CAST FAIL"; exit 1;; esac
PJ=$(curl -s -m 15 "$API/v1/mv/projects/$PID" -H "authorization: Bearer $AT")
CASTS=$(echo "$PJ" | grep -oE 'http[^"]*\.png' | head -3)
n=0; for U in $CASTS; do n=$((n+1)); dl "$U" "c2_cast_$n.png"; done
echo "C2 saved $n candidates"

echo "########## C2-e cast/confirm ##########"
FIRSTIMG=$(echo "$CASTS" | head -1)
curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"cast_image_url\":\"$FIRSTIMG\"}" "$API/v1/mv/projects/$PID/cast/confirm" >/dev/null
echo "C2 confirm done (chosen=$FIRSTIMG)"

echo "########## C3 定妆视频 ##########"
G3=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"type\":\"cast_video\",\"params\":{\"cast_image_url\":\"$FIRSTIMG\"}}" "$API/v1/mv/projects/$PID/jobs")
JOB3=$(echo "$G3" | jgetid job_id); ST3=$(poll "$JOB3")
case "$ST3" in failed:*) echo "C3 FAIL"; exit 1;; esac
PJ=$(curl -s -m 15 "$API/v1/mv/projects/$PID" -H "authorization: Bearer $AT")
VID=$(echo "$PJ" | grep -oE 'http[^"]*\.mp4' | head -1)
dl "$VID" "c3_cast_video.mp4"
echo "C3 video=$VID"

echo "########## C4 拍镜 ##########"
GS=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"storyboard"}' "$API/v1/mv/projects/$PID/jobs")
JOB_S=$(echo "$GS" | jgetid job_id); ST_S=$(poll "$JOB_S")
PJ=$(curl -s -m 15 "$API/v1/mv/projects/$PID" -H "authorization: Bearer $AT")
echo "$PJ" | grep -oE '"shots":\[[^]]*\]' | sed 's/"shots":\[//; s/\]$//' | grep -oE '\{[^{}]*\}' | while read shot; do
  SID=$(echo "$shot" | jgetid id); SKIND=$(echo "$shot" | jgetid kind)
  echo "  shot=$SID kind=$SKIND"
  GS2=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
    -d "{\"type\":\"shoot\",\"params\":{\"shot_id\":\"$SID\"}}" "$API/v1/mv/projects/$PID/jobs")
  JS=$(echo "$GS2" | jgetid job_id); SS=$(poll "$JS")
  case "$SS" in failed:*) echo "  shoot $SID FAIL";; esac
  # 抽帧复核
  mkdir -p "$EV/c4_shot_$SID"
  curl -s -m 20 "$API/v1/jobs/$JS" -H "authorization: Bearer $AT" | grep -oE 'http[^"]*\.mp4' | head -1 | while read CLIP; do dl "$CLIP" "c4_shot_$SID/clip.mp4"; done
done

echo "########## C5 口型(演唱镜) ##########"
echo "$PJ" | grep -oE '"kind":"singing"' | wc -l | xargs echo "singing shots:"
echo "$PJ" | grep -oE '"shots":\[[^]]*\]' | sed 's/"shots":\[//; s/\]$//' | grep -oE '\{[^{}]*\}' | while read shot; do
  SKIND=$(echo "$shot" | jgetid kind); [ "$SKIND" != singing ] && continue
  SID=$(echo "$shot" | jgetid id)
  GL=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
    -d "{\"type\":\"lipsync\",\"params\":{\"shot_id\":\"$SID\"}}" "$API/v1/mv/projects/$PID/jobs")
  JL=$(echo "$GL" | jgetid job_id); SL=$(poll "$JL")
  case "$SL" in failed:*) echo "  lipsync $SID FAIL";; esac
  echo "  lipsync $SID job=$JL"
done

echo "########## C6 对齐 ##########"
GA=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"align"}' "$API/v1/mv/projects/$PID/jobs")
JA=$(echo "$GA" | jgetid job_id); ST_A=$(poll "$JA"); echo "C6 align job=$JA"

echo "########## C7 合成 ##########"
GC=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"type":"compose"}' "$API/v1/mv/projects/$PID/jobs")
JC=$(echo "$GC" | jgetid job_id); ST_C=$(poll "$JC")
case "$ST_C" in failed:*) echo "C7 FAIL";; fi
PJ=$(curl -s -m 15 "$API/v1/mv/projects/$PID" -H "authorization: Bearer $AT")
MV=$(echo "$PJ" | grep -oE 'http[^"]*\.mp4' | tail -1)
dl "$MV" "c7_mv_video.mp4"
echo "C7 mv_video=$MV"

echo "ALL-DONE work=$WID project=$PID candidates=$n video=$VID mv=$MV evidence=$EV"
