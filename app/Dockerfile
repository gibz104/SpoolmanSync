FROM node:20-alpine AS base

# Update npm — pinned to the latest major that still supports Node 20.
# `npm@latest` (12.x) now requires Node >=22 and breaks the build on this base.
RUN npm install -g npm@11

# Install dependencies only when needed
FROM base AS deps
# Add build tools for native modules (better-sqlite3)
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set DATABASE_URL for Prisma generate (doesn't need real DB, just needs to exist)
ENV DATABASE_URL="file:./placeholder.db"

# Generate Prisma client
RUN npx prisma generate

# Build Next.js
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Shutdown is handled in src/instrumentation.ts
ENV NEXT_MANUAL_SIG_HANDLE=true

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache libc6-compat

# Set up the data folder for SQLite
RUN mkdir -p /data

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy Prisma schema and config for migrations
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Copy all node_modules from deps (includes Prisma CLI, better-sqlite3, and all dependencies)
# This ensures all transitive dependencies are available for migrations
COPY --from=deps /app/node_modules ./node_modules

# Copy entrypoint script
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/data/spoolmansync.db"

CMD ["./entrypoint.sh"]
