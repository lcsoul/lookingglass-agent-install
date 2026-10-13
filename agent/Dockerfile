FROM node:20-slim

# 安装网络诊断工具：ping (iputils)、traceroute、mtr
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping traceroute mtr \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# 通过环境变量配置接入：
#   SERVER_URL  中心服务端 WebSocket 地址，如 ws://<server-host>/ws/agent
#   NODE_TOKEN  节点令牌（在 Web 控制台添加节点时生成）
CMD ["node", "src/index.js"]
