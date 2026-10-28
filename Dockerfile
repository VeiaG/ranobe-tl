# syntax=docker/dockerfile:1
# One image for the web app and the worker; build for a Raspberry Pi with --platform linux/arm64.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /src

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps apps
RUN pnpm --filter @ranobe-tl/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/app/drizzle NODE_OPTIONS=--no-deprecation
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /src/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /src/apps/web/drizzle ./drizzle
COPY --from=build --chown=app:app /src/apps/web/dist/worker.mjs /src/apps/web/dist/migrate.mjs ./
COPY --chown=app:app docker/entrypoint.sh ./entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
CMD ["web"]
