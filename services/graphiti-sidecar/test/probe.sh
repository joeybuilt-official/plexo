#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# probe.sh — Phase 11 schema-compat probe (FalkorDB era).
#
# Stands up a throwaway stack on a private docker network and drives the
# sidecar image under test through ingest → graph read → search:
#
#   falkordb   (ephemeral, no volume — a fresh graph every run)
#   probe-stub (this same image; it already carries fastapi + uvicorn)
#   sidecar    (the image built at the candidate graphiti-core pin)
#   client     (this same image, one shot, on the same network)
#
# Then `probe_client.py` asserts the structure survived the bump. See that
# file for what each assertion catches.
#
# `docker` is the ONLY thing this needs on the host — no python3, no curl. The
# first version published the sidecar on 127.0.0.1 and drove it from the host,
# which works on a workstation and fails on a CI runner that is itself a
# container: `-p` publishes on the HOST's loopback, not the runner's, and the
# runner image has no python3 anyway (exit 127, `python3: command not found`).
# Everything that talks to the sidecar now runs in a container on its network
# and addresses it by container name, which behaves identically in both places.
#
# This REPLACED snapshot-probe.sh, which staged a tarball of prod's Kuzu
# data over SSH. Kuzu is gone (ADR 0010 moved the sidecar to FalkorDB) and
# the workflow's snapshot step still carried `<prod-server-ip>` placeholders,
# so it could never run. Nothing here touches prod or needs a deploy key.
#
# Usage:
#   PROBE_IMAGE=graphiti-sidecar:probe-0.29.3 ./probe.sh
#   exit 0 = compat green, non-zero = do NOT merge the bump
set -euo pipefail

PROBE_IMAGE="${PROBE_IMAGE:?PROBE_IMAGE required (the sidecar image under test)}"
FALKORDB_IMAGE="${FALKORDB_IMAGE:-falkordb/falkordb:v4.18.6}"
# Not a credential: this key only ever authenticates the probe stack to itself.
PLEXO_SERVICE_KEY="${PLEXO_SERVICE_KEY:-probe-local-service-key}"
# Small on purpose — the FalkorDB vector index is built at this dimension and
# prod's 3072 buys nothing when the embeddings are constants.
PROBE_EMBEDDING_DIM="${PROBE_EMBEDDING_DIM:-256}"
PROBE_WORKSPACE="${PROBE_WORKSPACE:-00000000-0000-0000-0000-00000000c0fe}"
PROBE_BOOT_TIMEOUT_S="${PROBE_BOOT_TIMEOUT_S:-120}"

RUN_ID="$$-$(date +%s)"
NET="graphiti-probe-${RUN_ID}"
FALKOR="graphiti-probe-falkor-${RUN_ID}"
STUB="graphiti-probe-stub-${RUN_ID}"
SIDECAR="graphiti-probe-sidecar-${RUN_ID}"

cleanup() {
    local code=$?
    if [[ $code -ne 0 ]]; then
        echo "--- sidecar logs (tail) ---" >&2
        docker logs --tail 120 "$SIDECAR" 2>&1 | sed 's/^/  /' >&2 || true
        echo "--- probe-stub logs (tail) ---" >&2
        docker logs --tail 60 "$STUB" 2>&1 | sed 's/^/  /' >&2 || true
    fi
    docker rm -f "$SIDECAR" "$STUB" "$FALKOR" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    return $code
}
trap cleanup EXIT

echo "probe: image=$PROBE_IMAGE falkordb=$FALKORDB_IMAGE dim=$PROBE_EMBEDDING_DIM"
docker network create "$NET" >/dev/null

docker run -d --name "$FALKOR" --network "$NET" "$FALKORDB_IMAGE" >/dev/null

# The stub runs from the image under test so the probe needs no second build
# and no pip install at run time; the sidecar image already ships fastapi.
docker run -d --name "$STUB" --network "$NET" \
    -e PLEXO_SERVICE_KEY="$PLEXO_SERVICE_KEY" \
    -e PROBE_EMBEDDING_DIM="$PROBE_EMBEDDING_DIM" \
    -w /app/test \
    "$PROBE_IMAGE" \
    uvicorn probe-stub:app --host 0.0.0.0 --port 8090 >/dev/null

docker run -d --name "$SIDECAR" --network "$NET" \
    -e PLEXO_SERVICE_KEY="$PLEXO_SERVICE_KEY" \
    -e FALKORDB_HOST="$FALKOR" \
    -e FALKORDB_PORT=6379 \
    -e PLEXO_INFERENCE_BASE="http://${STUB}:8090/api/inference" \
    -e GRAPHITI_EMBEDDING_DIM="$PROBE_EMBEDDING_DIM" \
    "$PROBE_IMAGE" >/dev/null

echo "probe: waiting for the sidecar to report healthy…"
deadline=$((SECONDS + PROBE_BOOT_TIMEOUT_S))
# Same one-liner the image's own HEALTHCHECK uses, run inside the container, so
# the host needs neither curl nor python3.
until docker exec "$SIDECAR" python3 -c \
    "import urllib.request; urllib.request.urlopen('http://localhost:8080/v1/health').read()" \
    >/dev/null 2>&1; do
    if [[ $SECONDS -ge $deadline ]]; then
        echo "FATAL: sidecar did not become healthy in ${PROBE_BOOT_TIMEOUT_S}s" >&2
        exit 1
    fi
    # A crashed container never becomes healthy — fail now, with its logs.
    if [[ "$(docker inspect -f '{{.State.Running}}' "$SIDECAR" 2>/dev/null)" != "true" ]]; then
        echo "FATAL: sidecar container exited during boot" >&2
        exit 1
    fi
    sleep 2
done

docker run --rm --network "$NET" \
    -e PROBE_SIDECAR_URL="http://${SIDECAR}:8080" \
    -e PLEXO_SERVICE_KEY="$PLEXO_SERVICE_KEY" \
    -e PROBE_WORKSPACE="$PROBE_WORKSPACE" \
    -w /app/test \
    "$PROBE_IMAGE" \
    python3 probe_client.py
