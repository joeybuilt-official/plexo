#!/bin/sh
# Run Drizzle migrations then exit.
# Called by the 'migrate' service in compose.yml before the API starts.
set -e

echo "[migrate] Running Drizzle migrations..."

# Run from the db package dir so relative migrationsFolder './drizzle' resolves correctly
cd /app/packages/db

# --max-old-space-size must fit within the container's mem_limit (256m).
# 200m leaves headroom for OS overhead and the tsx/ts-node bootstrap.
exec node --max-old-space-size=200 \
  /app/packages/db/node_modules/.bin/tsx src/migrate.ts
