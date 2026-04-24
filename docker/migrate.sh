#!/bin/sh
# Run Drizzle migrations then exit.
# Called by the 'migrate' service in compose.yml before the API starts.
set -e

echo "[migrate] --- Startup Check ---"
echo "[migrate] PWD: $(pwd)"
cd /app/packages/db
echo "[migrate] New PWD: $(pwd)"
echo "[migrate] USER: $(whoami)"
echo "[migrate] MIGRATIONS_DIR: $MIGRATIONS_DIR"

# Locate tsx CLI entrypoint. 
# It might be in packages/db/node_modules, at the root, or hoisted elsewhere.
TSX_PATH=""
for path in \
  "/app/packages/db/node_modules/tsx/dist/cli.mjs" \
  "/app/node_modules/tsx/dist/cli.mjs" \
  "/app/apps/api/node_modules/tsx/dist/cli.mjs" \
  "$(which tsx 2>/dev/null)"
do
  if [ -f "$path" ]; then
    TSX_PATH="$path"
    break
  fi
done

if [ -z "$TSX_PATH" ]; then
  echo "[migrate] ERROR: Could not find tsx entrypoint (cli.mjs)"
  echo "[migrate] Directory listing of /app/packages/db/node_modules:"
  ls -la /app/packages/db/node_modules || echo "  (directory missing)"
  exit 1
fi

echo "[migrate] Found tsx at: $TSX_PATH"
echo "[migrate] Executing migration target: src/migrate.ts"

# Use the absolute path to ensure node finds it correctly from the /app/packages/db directory
exec node --max-old-space-size=200 \
  "$TSX_PATH" src/migrate.ts

