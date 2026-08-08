# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.11.1-bookworm-slim

FROM ${NODE_IMAGE} AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/fetcher/package.json apps/fetcher/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/wechat-adapter/package.json apps/wechat-adapter/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/collector/package.json packages/collector/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/testkit/package.json packages/testkit/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS source
COPY . .

FROM source AS web-build
RUN pnpm --filter @attention/web build \
    && find apps/web/.next/standalone -type f -name '*.map' -delete

FROM source AS service-build
RUN pnpm --filter @attention/auth build \
    && pnpm --filter @attention/worker build \
    && pnpm --filter @attention/fetcher build \
    && pnpm --filter @attention/wechat-adapter build \
    && pnpm --filter @attention/db build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
LABEL org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
COPY --chown=node:node LICENSE /licenses/Attention/LICENSE
STOPSIGNAL SIGTERM

FROM runtime AS web
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /workspace/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

FROM runtime AS worker
COPY --from=service-build --chown=node:node /workspace/apps/worker/dist/index.js ./index.js
USER node
CMD ["node", "index.js"]

FROM runtime AS fetcher
ENV FETCHER_HOST=0.0.0.0
ENV FETCHER_PORT=4100
COPY --from=service-build --chown=node:node /workspace/apps/fetcher/dist/index.cjs ./index.cjs
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.FETCHER_PORT||'4100')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "index.cjs"]

FROM runtime AS wechat-adapter
ENV WECHAT_ADAPTER_HOST=0.0.0.0
ENV WECHAT_ADAPTER_PORT=4200
COPY --from=service-build --chown=node:node /workspace/apps/wechat-adapter/dist/index.js ./index.js
USER node
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WECHAT_ADAPTER_PORT||'4200')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "index.js"]

FROM runtime AS migrate
COPY --from=service-build --chown=node:node /workspace/packages/db/dist ./dist
COPY --from=service-build --chown=node:node /workspace/packages/db/drizzle ./drizzle
COPY --from=service-build --chown=node:node /workspace/packages/auth/dist/seed-demo-filter.js ./seed-demo-filter.js
USER node
CMD ["node", "dist/migrate.js"]
