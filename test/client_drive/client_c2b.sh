#!/bin/sh
# C2 定妆照全链（带真实人像上传）：下载人像 → multipart 上传 → 建项目(source=upload) → cast_image → 轮询 → 读面
# 参数: $1=API $2=portrait_url $3=device_key
API=${1:-http://192.168.1.10:7900}
PURL=${2:-http://192.168.1.10:8765/portrait.png}
KEY=${3:-c2-portrait-1125r2}
S=/data/local/tmp/mbx
mkdir -p $S
jget() { tr '{,[]' '\n' | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "== C1 游客"
R=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d "{\"device_key\":\"$KEY\"}" $API/v1/auth/guest)
AT=$(echo "$R" | jget access_token); echo "$AT" > $S/token
echo "token_len=${#AT} user=$(echo "$R" | jget nickname)"

echo "== 下载人像"
curl -s -m 30 -o $S/portrait.png -w 'portrait_http=%{http_code} bytes=%{size_download}\n' "$PURL"

echo "== 上传人像（multipart consent=true）"
UP=$(curl -s -m 40 -X POST -H "authorization: Bearer $AT" -F "consent=true" -F "file=@$S/portrait.png" $API/v1/mv/image)
echo "upload=$(echo "$UP" | head -c 300)"
IID=$(echo "$UP" | jget image_id); echo "image_id=$IID"

echo "== 建项目（character.source=upload）"
P=$(curl -s -m 20 -X POST -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"work_id\":\"\",\"character\":{\"gender\":\"f\",\"source\":\"upload\",\"image_id\":\"$IID\",\"name\":\"测试主角\"},\"brief\":\"暖光棚定妆，柔和侧光，中性背景\"}" $API/v1/mv/projects)
# 若 work_id 为空需真实 work_id；此处改用已有音乐作品：先派单生成一个再建项目（见下）
echo "proj=$(echo "$P" | head -c 400)"
