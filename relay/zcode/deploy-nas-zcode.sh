#!/usr/bin/env bash
# 部署 zcode relay 到 NAS Docker（镜像 wzxclaw-zcode-relay，宿主端口 18884 仅本机，
# 经 nginx 子域名 zcode.5945.top 反代提供 WSS）。重跑即更新。
set -euo pipefail
cd "$(dirname "$0")"

DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker
NAME=wzxclaw-zcode-relay
BUILD_DIR=/volume1/docker/zcode-relay-build

ssh nas "mkdir -p $BUILD_DIR"
scp Dockerfile package.json server.js nas:$BUILD_DIR/
ssh nas "$DOCKER build -t $NAME $BUILD_DIR"
ssh nas "$DOCKER rm -f $NAME 2>/dev/null || true; \
  $DOCKER run -d --name $NAME --restart unless-stopped -p 127.0.0.1:18884:18884 $NAME"
ssh nas "$DOCKER ps --filter name=$NAME --format '{{.Names}} {{.Status}}'"
