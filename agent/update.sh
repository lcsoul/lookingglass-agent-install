#!/usr/bin/env bash
# Agent 节点一键更新：拉取最新镜像并重启
# 用法：在 agent/ 目录中执行 bash update.sh
# 私有镜像时先登录一次：echo "$GHCR_PAT" | docker login ghcr.io -u <GitHub用户名> --password-stdin
set -euo pipefail
cd "$(dirname "$0")"

echo "⬇️ 拉取最新 agent 镜像…"
docker compose pull
echo "🔄 重启节点…"
docker compose up -d
docker image prune -f >/dev/null 2>&1 || true
echo "✅ 更新完成"
docker compose ps
