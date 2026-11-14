FROM node:24-alpine AS base

# npm 12 runs dependency install scripts only for the packages approved in
# package.json's allowScripts (better-sqlite3 and Prisma). A new dependency
# with an install script fails the deps stage below until it is reviewed.
RUN npm install -g npm@12
# Otherwise Prisma's CLI asks Prisma's servers about updates at every start.
ENV CHECKPOINT_DISABLE=1

# Install dependencies only when needed
FROM base AS deps
# Add build tools for native modules (better-sqlite3)
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci \
 && npm install-scripts ls | tee /tmp/install-scripts \
 && grep -q '^No packages with unreviewed install scripts' /tmp/install-scripts

# Only what the app needs to run, without the build and test tools. The
# Prisma CLI is among them, for the migrations at start.
FROM deps AS prod-deps
RUN npm prune --omit=dev

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

# Copy the production node_modules (includes the Prisma CLI and better-sqlite3
# with all their dependencies, for migrations)
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy entrypoint script
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/data/spoolmansync.db"

CMD ["./entrypoint.sh"]
