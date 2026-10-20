FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.mjs ./
COPY src ./src
COPY shared ./shared
COPY public ./public
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund \
    && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts/setup-youtube.mjs ./scripts/setup-youtube.mjs
RUN node scripts/setup-youtube.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.mjs"]
