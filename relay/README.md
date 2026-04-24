# wzxClaw WebSocket Relay - NAS 部署指南

通过 Docker 在 NAS 上部署 wzxClaw WebSocket 中继服务，配合 nginx 反向代理实现 HTTPS/WSS 访问。

## 前提条件

- NAS 上已安装 Docker 和 docker-compose
- NAS 上已有 nginx 反向代理，5945.top 域名已配置 HTTPS（Let's Encrypt 或其他）
- nginx 已在运行并处理 5945.top 的流量

## 快速部署

```bash
# 1. 从仓库根目录进入 relay 目录
cd relay

# 2. 创建 .env 文件，设置认证 token
echo "AUTH_TOKEN=your-secret-token-here" > .env

# 3. 构建并启动容器
docker-compose up -d --build

# 4. 查看日志确认启动成功
docker logs wzxclaw-relay
# 应该看到: Relay server listening on port 8080
```

## Nginx 配置

将 `nginx/relay.conf` 的内容添加到 5945.top 的 server 配置块中：

```bash
# 查看当前 nginx 配置（根据实际路径调整）
cat /etc/nginx/conf.d/5945.top.conf

# 添加 location /relay/ 块到 server { } 中
# 可以直接复制 nginx/relay.conf 的内容

# 测试配置
nginx -t

# 重载 nginx
nginx -s reload
```

配置完成后，中继服务可以通过以下地址访问：

```
wss://5945.top/relay/?token=your-secret-token&role=mobile
```

## Flutter 应用配置

在 Flutter 应用的服务器设置中：

- **服务器地址:** `wss://5945.top/relay/`
- **Token:** 与 .env 中的 AUTH_TOKEN 一致

应用会自动拼接完整连接 URL：

```
wss://5945.top/relay/?token=your-secret-token&role=mobile
```

## 桌面端 wzxClaw 配置

桌面端可以通过两种方式连接：

**方式一：通过 nginx（推荐，广域网可用）**

```
wss://5945.top/relay/?token=your-secret-token&role=desktop
```

**方式二：局域网直连（同一网络时更低延迟）**

```
ws://NAS局域网IP:8081/?token=your-secret-token&role=desktop
```

## 常用操作

```bash
# 查看容器状态
docker ps | grep wzxclaw-relay

# 查看日志
docker logs -f wzxclaw-relay

# 重启容器
docker-compose restart

# 停止容器
docker-compose down

# 更新并重新部署
docker-compose up -d --build
```

## 端口说明

| 端口 | 用途         | 访问范围             |
| ---- | ------------ | -------------------- |
| 8080 | 容器内部端口 | 仅容器内             |
| 8081 | NAS 本地端口 | 仅 127.0.0.1（本机） |
| 443  | nginx HTTPS  | 公网（5945.top）     |

## 故障排查

### 容器无法启动

```bash
# 查看详细日志
docker logs wzxclaw-relay

# 常见原因：
# - AUTH_TOKEN 未设置：确保当前目录下有 .env 文件
# - 端口冲突：检查 8081 端口是否被占用
#   netstat -tlnp | grep 8081
```

### WebSocket 连接失败

```bash
# 检查 nginx 错误日志
tail -f /var/log/nginx/error.log

# 常见原因：
# - nginx 未添加 /relay/ location 块
# - proxy_pass 目标端口错误（应该是 8081）
# - 容器未运行：docker ps | grep wzxclaw-relay
```

### Token 认证失败

```bash
# 确认 .env 文件存在
cat .env

# 确认容器内的环境变量
docker exec wzxclaw-relay env | grep AUTH_TOKEN
```

## 更新 Token

```bash
# 1. 修改 .env 文件
echo "AUTH_TOKEN=new-secret-token" > .env

# 2. 重启容器
docker-compose up -d

# 3. 同步更新 Flutter 应用和桌面端的 token 配置
```
