# syntax=docker/dockerfile:1.7
# Build from the repository root. Operator must pin the reviewed final image digest.
ARG NODE_IMAGE=node:24.11.1-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/reader-browser apps/reader-browser
RUN pnpm install --frozen-lockfile --filter @attention/reader-browser
RUN pnpm --filter @attention/reader-browser build \
    && pnpm --filter @attention/reader-browser deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS renderer
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /workspace/apps/reader-browser/dist/runner.js ./runner.js
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && groupadd --gid 10001 reader \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp reader \
    && chmod -R a+rX /opt/playwright
ENV NODE_ENV=production HOME=/tmp TMPDIR=/tmp ATTENTION_ISOLATED_READER=1
USER 10001:10001
ENTRYPOINT ["node", "/app/runner.js"]
