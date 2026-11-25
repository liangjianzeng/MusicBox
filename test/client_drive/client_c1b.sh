#!/bin/sh
# C1b 产物取回 + 采纳（跑在小米13，复用 saved job）
API=http://192.168.1.10:7900
S=/data/local/tmp/mbx
AT=$(cat $S/token)
J=$(cat $S/job.json)
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "== 产物取回（客户端可达）"
AU=$(echo "$J" | jget audio_url)
WU=$(echo "$J" | tr '{,[]' '\n' | grep -oE '"waveform_url":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "audio_url=$AU"
curl -s -m 90 -o $S/c1.mp3 -w 'audio get_code=%{http_code} bytes=%{size_download}\n' "$AU"
curl -s -m 30 -o $S/c1.json -w 'wave get_code=%{http_code} bytes=%{size_download}\n' "$WU"
ls -la $S/c1.mp3 $S/c1.json

echo "== 采纳（候选 → 作品）"
CID=$(echo "$J" | tr '{,[]' '\n' | grep -oE '"id":"c_[^"]*"' | head -1 | cut -d'"' -f4)
echo "cand=$CID"
A=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"candidate_id\":\"$CID\"}" $API/v1/works/$CID/adopt)
echo "adopt=$(echo "$A" | head -c 300)"
WID=$(echo "$A" | tr '{,[]' '\n' | grep -oE '"id":"w_[^"]*"' | head -1 | cut -d'"' -f4)
echo "$WID" > $S/work_id
echo "work_id=$WID"

echo "== 作品列表可见（客户端读面）"
curl -s -m 15 -H "authorization: Bearer $AT" "$API/v1/works?mine=1" | head -c 400
echo
