# 构建上下文为仓库根目录：docker build -f apps/server/Dockerfile .

# ---- 阶段一：构建 Web UI ----
FROM node:24-alpine AS web
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @asterhive/web
COPY apps/web apps/web
RUN npm run build -w apps/web

# ---- 阶段二：服务器 + 静态界面（单容器同供 API 与 UI）----
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @asterhive/server

COPY apps/server/src apps/server/src
# worker CLI 自举源码（/bootstrap/ 端点原样分发）：仅 packages/sdk/src 下两个 .ts 小文件
COPY packages/sdk/src /app/sdk/
COPY skills /app/skills
COPY --from=web /repo/apps/web/dist /app/public

ENV HOST=0.0.0.0 \
    PORT=8067 \
    ASTERHIVE_DATA=/data \
    ASTERHIVE_STATIC_DIR=/app/public

# 命名卷挂载点：首次创建的卷会继承此属主，node 用户可写
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8067

CMD ["node", "apps/server/src/main.ts"]
