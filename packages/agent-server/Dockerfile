# Stage 1: 安装依赖 + 编译 TypeScript
FROM node:20-alpine AS builder

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

# 安装依赖
RUN npm install --workspaces --if-present 2>/dev/null || \
    cd packages/brain && npm install && cd /app && \
    cd packages/agent-server && npm install && cd /app

# 复制 agent-server 源码
COPY packages/agent-server/ packages/agent-server/

# 编译 TypeScript
RUN cd packages/brain && npm run build && cd /app && \
    cd packages/agent-server && npm run build && cd /app

# Stage 2: 最小运行时镜像
FROM node:20-alpine

WORKDIR /app

# 复制编译产物和依赖
COPY --from=builder /app/packages/agent-server/dist ./dist
COPY --from=builder /app/packages/agent-server/node_modules ./node_modules
COPY --from=builder /app/packages/brain/dist ./brain-dist
COPY --from=builder /app/packages/agent-server/package.json ./

# 创建数据目录
RUN mkdir -p /data

ENV NODE_ENV=production

EXPOSE 8082

USER node

CMD ["node", "dist/server.js"]
