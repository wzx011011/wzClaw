# Stage 1: 安装依赖 + 编译 TypeScript
FROM node:22-alpine AS builder

WORKDIR /app

# better-sqlite3 需要 native binding，安装编译工具链
RUN apk add --no-cache python3 make g++

# 复制根 workspace 配置（monorepo 结构）
COPY package.json package.json
COPY pnpm-workspace.yaml pnpm-workspace.yaml
COPY pnpm-lock.yaml pnpm-lock.yaml

# 复制 brain 和 agent-server 包
COPY packages/brain/package.json packages/brain/package.json
COPY packages/brain/ packages/brain/
COPY packages/agent-server/package.json packages/agent-server/package.json

# 安装依赖（仓库使用 pnpm workspace）。Docker 构建环境无交互审批，显式允许 native 依赖构建。
RUN corepack enable && \
    pnpm config set dangerously-allow-all-builds true && \
    pnpm install --frozen-lockfile

# 复制 agent-server 源码
COPY packages/agent-server/ packages/agent-server/

# 编译 TypeScript
RUN cd packages/brain && npm run build && cd /app && \
    cd packages/agent-server && npm run build && cd /app

# Stage 2: 最小运行时镜像
FROM node:22-alpine

WORKDIR /app

# 复制完整 workspace，保留 pnpm node_modules 链接结构
COPY --from=builder /app ./

# 创建数据目录
RUN mkdir -p /data

ENV NODE_ENV=production
ENV WZXCLAW_CONFIG_DIR=/data/.wzxclaw

EXPOSE 8082

USER node

CMD ["node", "packages/agent-server/dist/server.js"]
