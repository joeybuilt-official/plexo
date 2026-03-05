#!/bin/sh
set -e
echo "[migrate] Running Drizzle migrations..."
exec node /app/migrate.mjs
