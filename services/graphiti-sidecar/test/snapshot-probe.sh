#!/usr/bin/env bash
# snapshot-probe.sh — Phase 11 schema-compat probe.
#
# Per phase-11-design.md §"Architecture" step 4:
#   1. Snapshot prod's per-workspace Kuzu DB to a staging volume
#   2. Start the new sidecar image pointed at probe-stub.py + the staging volume
#   3. POST /v1/episodes (canonical 5-S-V-O text)
#   4. POST /v1/search (Austin) — expect ≥1 result
#   5. Tear down + report exit code
#
# Usage (CI / GH Actions):
#   PROBE_VERSION=0.30.0 ./snapshot-probe.sh
#   exit 0 = compat green, exit 1 = compat fail (do NOT merge bump PR)
#
# Required env:
#   PROBE_VERSION         graphiti-core version under test (drives image tag)
#   PLEXO_SERVICE_KEY     same key used by the sidecar in prod (HMAC)
#   PROBE_KUZU_SOURCE     path to a tar.gz of /data/graphiti from prod
#                         (default: /tmp/graphiti-snapshot.tgz)
set -euo pipefail

PROBE_VERSION="${PROBE_VERSION:?PROBE_VERSION required}"
PLEXO_SERVICE_KEY="${PLEXO_SERVICE_KEY:?PLEXO_SERVICE_KEY required}"
PROBE_KUZU_SOURCE="${PROBE_KUZU_SOURCE:-/tmp/graphiti-snapshot.tgz}"
PROBE_WORKSPACE="${PROBE_WORKSPACE:-00000000-0000-0000-0000-00000000c0fe}"

if [[ ! -f "$PROBE_KUZU_SOURCE" ]]; then
    echo "FATAL: PROBE_KUZU_SOURCE=$PROBE_KUZU_SOURCE not found" >&2
    exit 2
fi

# Stage Kuzu data to a fresh dir so the probe can't corrupt prod data.
STAGING_DIR="$(mktemp -d)/graphiti"
mkdir -p "$STAGING_DIR"
tar -xzf "$PROBE_KUZU_SOURCE" -C "$STAGING_DIR" --strip-components=1

cleanup() {
    docker rm -f probe-stub-${PROBE_VERSION} 2>/dev/null || true
    docker rm -f probe-sidecar-${PROBE_VERSION} 2>/dev/null || true
    rm -rf "$(dirname "$STAGING_DIR")"
}
trap cleanup EXIT

# Start probe stub on a private port.
docker run -d --rm --name probe-stub-${PROBE_VERSION} \
    -e PLEXO_SERVICE_KEY="$PLEXO_SERVICE_KEY" \
    -p 127.0.0.1:18091:8090 \
    -v "$PWD/services/graphiti-sidecar/test:/app" -w /app \
    python:3.12-slim \
    sh -c 'pip install -q fastapi uvicorn && uvicorn probe-stub:app --host 0.0.0.0 --port 8090'

# Start sidecar at PROBE_VERSION pinned in requirements.txt against the
# staging Kuzu volume + the stub URL for inference.
docker run -d --rm --name probe-sidecar-${PROBE_VERSION} \
    -e PLEXO_SERVICE_KEY="$PLEXO_SERVICE_KEY" \
    -e PLEXO_INFERENCE_BASE=http://host.docker.internal:18091/api/inference \
    -e KUZU_DATA_DIR=/data/graphiti \
    -p 127.0.0.1:18092:8080 \
    -v "$STAGING_DIR:/data/graphiti" \
    --add-host host.docker.internal:host-gateway \
    service:probe-${PROBE_VERSION}

echo "waiting for probe sidecar healthy…"
for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:18092/v1/health >/dev/null 2>&1; then break; fi
    sleep 2
done

# Run smoke against the staging stack via tsx (mirrors prod smoke flow).
GRAPHITI_SIDECAR_URL=http://127.0.0.1:18092 \
PLEXO_SERVICE_KEY="$PLEXO_SERVICE_KEY" \
SMOKE_WORKSPACE_ID="$PROBE_WORKSPACE" \
    timeout 240 node ./node_modules/.bin/tsx packages/graphiti-bridge/scripts/smoke.ts
