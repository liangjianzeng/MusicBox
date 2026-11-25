#!/bin/sh
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d '{"device_key":"k40-fullload-1125"}' $API/v1/auth/guest)
AT=$(echo "$R" | tr '{,[]' '\n' | grep -oE '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$AT" > $S/token
echo "re-auth len=${#AT}"
echo "== precheck（facegate 真档）"
curl -s -m 120 -H "authorization: Bearer $AT" -F "file=@$S/portrait.png" -F "consent=true" $API/v1/mv/image/precheck | head -c 900
echo
echo "== 上传（sha 去重即复用）"
curl -s -m 60 -H "authorization: Bearer $AT" -F "file=@$S/portrait.png" -F "consent=true" $API/v1/mv/image | head -c 200
echo
