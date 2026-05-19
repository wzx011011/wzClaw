# ============================================================
# Docker Hand 镜像构建配置
# NAS 上运行的 Docker Hand，连接 agent-server 执行工具调用
# ============================================================

# Stage 1: 安装依赖 + 编译 TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖配置和源码（compose 使用仓库根目录作为 build context）
COPY packages/hand/package*.json ./
COPY packages/hand/tsconfig.json ./
COPY packages/hand/src/ src/
COPY packages/hand/tools/ tools/
COPY packages/hand/docker-entry.ts ./

# 安装依赖并编译
RUN npm install && npm run build

# Stage 2: 最小运行时镜像
FROM node:20-alpine

WORKDIR /app

# 复制编译产物和运行时依赖
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# 生产环境
ENV NODE_ENV=production

# 以非 root 用户运行（安全最佳实践）
USER node

# 入口：启动 Docker Hand 连接 agent-server
CMD ["node", "dist/docker-entry.js"]
