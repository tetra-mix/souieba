# ビルドはリポジトリのルートで: docker build -f apps/server/Dockerfile -t souieba-server .
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @souieba/server... \
 && pnpm --filter @souieba/server build

# node:sqlite は Node に組み込みなので、ネイティブ依存のない単一ファイルで動く
FROM node:24-slim
ENV NODE_ENV=production SOUIEBA_DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/apps/server/dist/ ./
RUN printf '#!/bin/sh\nexec node /app/admin-cli.mjs "$@"\n' > /usr/local/bin/souieba-admin \
 && chmod +x /usr/local/bin/souieba-admin \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/main.mjs"]
