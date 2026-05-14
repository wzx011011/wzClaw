# Stage 1: Install dependencies
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production

# Stage 2: Minimal runtime image
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV RELAY_DATA_DIR=/app/data

EXPOSE 8080

USER node

CMD ["node", "server.js"]
