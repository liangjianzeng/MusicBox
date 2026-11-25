#!/bin/sh
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d '{"device_key":"xm13-fullload-1125"}' $API/v1/auth/guest)
AT=$(echo "$R" | tr '{,[]' '\n' | grep -oE '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$AT" > $S/token
PID=$(cat $S/project_id)
echo "re-auth ok, len=${#AT}"
curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d '{"character_id":"mvc_052ae0a4a4f0bc3049be","cast_image_url":"http://192.168.1.10:7900/f/2026-11/f_9fdc37a0f77948e8b402.png"}' $API/v1/mv/projects/$PID/cast/confirm | head -c 140
echo
curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/mv/projects/$PID" | grep -oE '"status":"[a-z]*"' | head -1
