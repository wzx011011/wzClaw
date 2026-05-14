#!/bin/bash
# ============================================================
# wzxClaw NAS 部署脚本
# 在 NAS SSH 终端执行此脚本
# ============================================================

set -e

DEPLOY_DIR="/volume1/wzxclaw"
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)

echo "=== wzxClaw NAS 部署 ==="
echo "仓库: $REPO_DIR"
echo "部署目录: $DEPLOY_DIR"
echo ""

# 1. 检查 .env
if [ ! -f "$REPO_DIR/deploy/.env" ]; then
    echo "错误: deploy/.env 文件不存在"
    echo "创建: echo 'AUTH_TOKEN=你的token' > deploy/.env"
    exit 1
fi

# 2. 创建 NAS 部署目录
ssh nas "mkdir -p $DEPLOY_DIR/data" 2>/dev/null || {
    echo "提示: 无法通过 ssh nas 连接，请手动上传"
    echo ""
    echo "手动部署步骤:"
    echo "  1. scp -r $REPO_DIR/packages nas:$DEPLOY_DIR/"
    echo "  2. scp -r $REPO_DIR/package.json nas:$DEPLOY_DIR/"
    echo "  3. scp -r $REPO_DIR/pnpm-workspace.yaml nas:$DEPLOY_DIR/"
    echo "  4. scp -r $REPO_DIR/pnpm-lock.yaml nas:$DEPLOY_DIR/"
    echo "  5. scp $REPO_DIR/deploy/.env nas:$DEPLOY_DIR/"
    echo "  6. scp $REPO_DIR/deploy/docker-compose.yml nas:$DEPLOY_DIR/"
    echo "  7. ssh nas 'cd $DEPLOY_DIR && docker-compose up -d --build'"
    echo ""
    echo "或者在 NAS 终端直接执行:"
    echo "  cd $DEPLOY_DIR && docker-compose up -d --build"
    exit 0
}

# 3. 上传文件
echo "上传文件到 NAS..."
scp "$REPO_DIR/deploy/.env" "nas:$DEPLOY_DIR/"
scp "$REPO_DIR/deploy/docker-compose.yml" "nas:$DEPLOY_DIR/"

# 4. 上传源码
scp -r "$REPO_DIR/packages" "nas:$DEPLOY_DIR/"
scp "$REPO_DIR/package.json" "nas:$DEPLOY_DIR/"
scp "$REPO_DIR/pnpm-workspace.yaml" "nas:$DEPLOY_DIR/"
[ -f "$REPO_DIR/pnpm-lock.yaml" ] && scp "$REPO_DIR/pnpm-lock.yaml" "nas:$DEPLOY_DIR/"

# 5. 构建并启动
echo "构建并启动容器..."
ssh nas "cd $DEPLOY_DIR && docker-compose up -d --build"

# 6. 检查状态
echo ""
echo "容器状态:"
ssh nas "docker-compose -f $DEPLOY_DIR/docker-compose.yml ps"

echo ""
echo "健康检查:"
ssh nas "curl -s http://localhost:8082/health" || echo "agent-server 未就绪"

echo ""
echo "=== 部署完成 ==="
echo "agent-server: wss://5945.top/agent/"
echo "health: http://localhost:8082/health"
echo "查看日志: ssh nas 'docker-compose -f $DEPLOY_DIR/docker-compose.yml logs -f'"
