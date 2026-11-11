# SpoolmanSync Home Assistant Add-on
# Builds the Next.js app with nginx for HA ingress proxy

# Accept BUILD_FROM for Supervisor compatibility but use node:20-alpine
ARG BUILD_FROM
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Add build tools for native modules (better-sqlite3)
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY app/package.json app/package-lock.json* ./
RUN npm ci

# Build stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/ .

ENV DATABASE_URL="file:./placeholder.db"
ENV ADDON_BUILD=true
RUN npx prisma generate
RUN npm run build

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Shutdown is handled in src/instrumentation.ts
ENV NEXT_MANUAL_SIG_HANDLE=true
ENV HA_MODE=addon

# Install runtime dependencies
RUN apk add --no-cache libc6-compat nginx bash jq curl

RUN mkdir -p /data

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy Prisma schema and config for migrations
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Copy all node_modules from deps
COPY --from=deps /app/node_modules ./node_modules

# Copy nginx config and run script
# Paths are relative to repo root (build context set in CI workflow)
COPY spoolmansync-ha-addon/rootfs/etc/nginx/http.d/default.conf /etc/nginx/http.d/default.conf
COPY spoolmansync-ha-addon/rootfs/run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 3000 8099

ENV HOSTNAME="127.0.0.1"
ENV DATABASE_URL="file:/data/spoolmansync.db"

CMD ["/run.sh"]
