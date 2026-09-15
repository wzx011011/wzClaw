#!/usr/bin/env bash
# 部署 zcode relay 到 NAS Docker（镜像 wzxclaw-zcode-relay，宿主端口 18884 仅本机，
# 经 nginx 子域名 zcode.5945.top 反代提供 WSS）。重跑即更新。
# 注册密钥：本机 ~/.wzxclaw/zcode-companion/relay-secret（仅含 secret 一行，
# 不进 git）存在时注入 -e REGISTRATION_SECRET，relay 仅允许带 proof 的注册；
# 缺失时开放注册（本地/内网零摩擦）。
set -euo pipefail
cd "$(dirname "$0")"

DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker
NAME=wzxclaw-zcode-relay
BUILD_DIR=/volume1/docker/zcode-relay-build
SECRET_FILE="$HOME/.wzxclaw/zcode-companion/relay-secret"

# 读取注册密钥（首行，去 CRLF）。文件存在但为空视为配置错误：直接终止部署，
# 避免用户以为有密钥保护、实际部署出开放注册的 relay。
# 注入方式：scp 到 NAS 的 0600 env 文件 + docker --env-file——不走
# -e 值参数（会进 NAS 进程列表/命令历史，违反「密钥不进进程参数」约定）。
ENV_FILE_NAS="$BUILD_DIR/relay.env"
RUN_ARGS=(-d --name "$NAME" --restart unless-stopped -p 127.0.0.1:18884:18884)
if [ -f "$SECRET_FILE" ]; then
  REG_SECRET="$(sed -n '1p' "$SECRET_FILE" | tr -d '\r\n')"
  if [ -z "$REG_SECRET" ]; then
    echo "错误: $SECRET_FILE 为空——请写入一行密钥（openssl rand -base64 32）后重跑，或删除该文件以开放注册" >&2
    exit 1
  fi
  RUN_ARGS+=(--env-file "$ENV_FILE_NAS")
else
  echo "未设置注册密钥，relay 将开放注册" >&2
fi

ssh nas "mkdir -p $BUILD_DIR"
# -r：lib/ 是目录（proof/protocol 共享模块）
scp -r Dockerfile package.json server.js lib nas:$BUILD_DIR/
if [ -f "$SECRET_FILE" ]; then
  printf 'REGISTRATION_SECRET=%s\n' "$REG_SECRET" | ssh nas "cat > $ENV_FILE_NAS && chmod 600 $ENV_FILE_NAS"
fi
ssh nas "$DOCKER build -t $NAME $BUILD_DIR"
ssh nas "$DOCKER rm -f $NAME 2>/dev/null || true; \
  $DOCKER run ${RUN_ARGS[*]} $NAME"
ssh nas "$DOCKER ps --filter name=$NAME --format '{{.Names}} {{.Status}}'"
