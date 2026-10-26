#!/bin/sh

# SpoolmanSync App Entrypoint
# Runs database migrations and starts the app

set -e

echo "=== SpoolmanSync Starting ==="

migrate() {
    node node_modules/prisma/build/index.js migrate deploy
}

# A migration that stopped part way (a full disk, say) is recorded as failed,
# and Prisma then refuses every later migration until it is resolved. Ours are
# re-runnable, so mark it rolled back and try once more.
retry_failed_migration() {
    FAILED=$(node -e "
const db = require('better-sqlite3')(process.env.DATABASE_URL.replace(/^file:/, ''));
const row = db.prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL').get();
console.log(row ? row.migration_name : '');" 2>/dev/null || true)
    [ -n "$FAILED" ] || return 1
    echo "Retrying interrupted migration $FAILED..."
    node node_modules/prisma/build/index.js migrate resolve --rolled-back "$FAILED" && migrate
}

# Run Prisma migrations using the local prisma binary
echo "Running database migrations..."
migrate || retry_failed_migration

echo "Migrations complete."

# Start the Next.js server
echo "Starting Next.js server..."
exec node server.js
