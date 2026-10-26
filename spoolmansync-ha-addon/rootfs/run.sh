#!/usr/bin/env bash
# SpoolmanSync Add-on Startup Script

set -e

echo "=== SpoolmanSync Add-on Starting ==="

# Read add-on options
CONFIG_PATH=/data/options.json
DIRECT_PORT=3000
if [ -f "$CONFIG_PATH" ]; then
    SPOOLMAN_URL=$(jq -r '.spoolman_url // ""' "$CONFIG_PATH")
    if [ -n "$SPOOLMAN_URL" ] && [ "$SPOOLMAN_URL" != "null" ]; then
        export SPOOLMAN_URL
        echo "Spoolman URL configured: $SPOOLMAN_URL"
    fi

    CONFIGURED_PORT=$(jq -r '.port // 3000' "$CONFIG_PATH")
    if [ -n "$CONFIGURED_PORT" ] && [ "$CONFIGURED_PORT" != "null" ]; then
        DIRECT_PORT="$CONFIGURED_PORT"
    fi
fi

export DIRECT_ACCESS_PORT="$DIRECT_PORT"
echo "Direct access port: $DIRECT_PORT"

# Read the ingress port assigned by Supervisor (dynamic, avoids conflicts with other add-ons)
INGRESS_PORT=$(curl -s -X GET "http://supervisor/addons/self/info" \
  -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" | jq -r '.data.ingress_port // empty' 2>/dev/null || true)
if ! printf '%s' "$INGRESS_PORT" | grep -Eq '^[1-9][0-9]{0,4}$'; then
    echo "Warning: could not read the ingress port from the Supervisor (got '${INGRESS_PORT}'); using 8099"
    INGRESS_PORT=8099
fi
echo "Ingress port: $INGRESS_PORT"

# The sidebar depends on the ingress port, so a direct port that collides with it gives way.
if [ "$DIRECT_PORT" -eq "$INGRESS_PORT" ]; then
    echo "Warning: port ${DIRECT_PORT} is the ingress port; using $((DIRECT_PORT + 1)) for direct access"
    DIRECT_PORT=$((DIRECT_PORT + 1))
    export DIRECT_ACCESS_PORT="$DIRECT_PORT"
fi

# Derive internal Next.js port from direct port (+1) to avoid conflicts on host_network
INTERNAL_PORT=$((DIRECT_PORT + 1))
# Avoid colliding with the ingress port
if [ "$INTERNAL_PORT" -eq "$INGRESS_PORT" ]; then
    INTERNAL_PORT=$((INTERNAL_PORT + 1))
fi
export PORT="$INTERNAL_PORT"
echo "Internal Next.js port: $INTERNAL_PORT"

# Fill in the nginx template with the ports
sed -i "s/__DIRECT_PORT__/${DIRECT_PORT}/g; s/__INGRESS_PORT__/${INGRESS_PORT}/g; s/__INTERNAL_PORT__/${INTERNAL_PORT}/g" \
  /etc/nginx/http.d/default.conf

# Supervisor token is automatically available
if [ -n "$SUPERVISOR_TOKEN" ]; then
    echo "Supervisor token available for HA API access"
else
    echo "Warning: SUPERVISOR_TOKEN not set"
fi

# Run Prisma migrations
echo "Running database migrations..."
cd /app

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
    npx prisma migrate resolve --rolled-back "$FAILED" 2>&1 && npx prisma migrate deploy 2>&1
}

if npx prisma migrate deploy 2>&1 || retry_failed_migration; then
    echo "Migrations complete."
else
    echo "Migration error (non-fatal, continuing; usage tracking will not work until it succeeds)"
fi

# Start nginx in background
# nginx serves the configured direct access port and the Supervisor-assigned ingress port
# Both proxy to the internal Next.js server
echo "Starting nginx on ports ${DIRECT_PORT} (direct) and ${INGRESS_PORT} (ingress)..."
nginx -g 'daemon off;' &

# Start the Next.js server on internal port
# Bound to 127.0.0.1 - only accessible via nginx, not directly from outside
echo "Starting Next.js server on port ${PORT}..."
exec node server.js
