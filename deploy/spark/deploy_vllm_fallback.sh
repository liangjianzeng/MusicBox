#!/usr/bin/env bash
# MusicBox · DGX Spark 应急自部署兜底 —— 默认关闭；仅当托管端点长期不可用时 RUN=1 启用（2026-11-23）
# 目标：小杯开源 Qwen（Apache-2.0 白名单）经 vLLM 暴露与托管一致的 OpenAI 兼容路径 :8193/v1，
#       执行器零改动（继续用 MB_LLM_VLM_URL）。应急期结束后请回指托管端点。
# 用法：bash deploy_vllm_fallback.sh          # 干跑：只打印将执行的命令
#       RUN=1 bash deploy_vllm_fallback.sh    # 确认后真启（容器方式，Spark Ubuntu）
set -euo pipefail

PORT="${PORT:-8193}"
MODEL="${VLLM_MODEL:-Qwen/Qwen3-8B}"        # 小杯；VL 需求可用 Qwen/Qwen3-VL-4B-Instruct
SERVED="${VLLM_SERVED_NAME:-qwen38-fp4}"    # 对执行器保持同一模型名
IMG="${VLLM_IMAGE:-vllm/vllm-openai:latest}"

echo "== MusicBox vLLM 兜底（应急用）=="
echo "   模型: ${MODEL}  对外名: ${SERVED}  端口: ${PORT}"

CMD=(docker run -d --name musicbox-vllm-fallback --restart unless-stopped
  --gpus all --ipc=host --network host
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface"
  "$IMG"
  --model "$MODEL"
  --served-model-name "$SERVED"
  --port "$PORT"
  --max-model-len 8192
  --gpu-memory-utilization 0.85)
# 图像能力（如需 intent_image）可加：--limit-mm-per-prompt image=2

if [[ "${RUN:-0}" != "1" ]]; then
  echo "[干跑] 将执行："
  printf '  %q' "${CMD[@]}"; echo
  echo "确认无误后：RUN=1 bash $0"
  exit 0
fi

"${CMD[@]}" >/dev/null
echo "已启动。等待就绪…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
    echo "就绪：把 MB_LLM_VLM_URL 指到 http://<spark-ip>:${PORT}/v1 即可（执行器零改动）。"
    exit 0
  fi
  sleep 5
done
echo "超时未就绪，查看日志：docker logs musicbox-vllm-fallback" >&2
exit 1
