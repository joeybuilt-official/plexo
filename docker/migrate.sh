#!/bin/sh
# Run Drizzle migrations then exit.
# Called by the 'migrate' service in compose.yml before the API starts.
set -e

echo "[migrate] Running Drizzle migrations..."

# Run from the db package dir so relative migrationsFolder './drizzle' resolves correctly
cd /app/packages/db

exec /app/packages/db/node_modules/.bin/tsx src/migrate.ts
