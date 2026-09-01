#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# Phase G nightly RDB snapshot for service.
# - Triggers BGSAVE inside the container (non-blocking; redis-cli waits for
#   the dump to finish via INFO persistence loop)
# - Copies the resulting dump.rdb out to /var/backups/falkordb/
# - Retains the last 7 daily snapshots
# - Optionally uploads off-host via aws s3 cp (--offhost-upload)
#
# Designed to run from the deploy host. ADR 0030.

set -euo pipefail

CONTAINER="${FALKORDB_CONTAINER:-service}"
BACKUP_DIR="${FALKORDB_BACKUP_DIR:-/var/backups/falkordb}"
RETAIN_DAYS="${FALKORDB_BACKUP_RETAIN_DAYS:-7}"
OFFHOST_UPLOAD=0
TS="$(date -u +%Y-%m-%d)"
DEST="${BACKUP_DIR}/falkordb-${TS}.rdb"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --offhost-upload) OFFHOST_UPLOAD=1; shift;;
    -h|--help)
      cat <<USAGE
Usage: falkordb_backup.sh [--offhost-upload]

Env:
  FALKORDB_CONTAINER          (default: service)
  FALKORDB_BACKUP_DIR         (default: /var/backups/falkordb)
  FALKORDB_BACKUP_RETAIN_DAYS (default: 7)
  AWS_S3_BACKUP_BUCKET        (required for --offhost-upload)
USAGE
      exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

log() { printf '[falkordb-backup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p "${BACKUP_DIR}"

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  log "ERROR: container ${CONTAINER} not found"
  exit 3
fi

log "BGSAVE on ${CONTAINER}"
docker exec "${CONTAINER}" redis-cli BGSAVE >/dev/null

# Wait for BGSAVE to complete. INFO persistence reports rdb_bgsave_in_progress.
# Cap at 10 minutes; abort on stale BGSAVE rather than hanging the cron slot.
DEADLINE=$(( $(date +%s) + 600 ))
while :; do
  IN_PROGRESS="$(docker exec "${CONTAINER}" redis-cli INFO persistence \
    | awk -F: '/^rdb_bgsave_in_progress:/ {gsub(/\r/,""); print $2}')"
  if [[ "${IN_PROGRESS}" == "0" ]]; then
    break
  fi
  if (( $(date +%s) > DEADLINE )); then
    log "ERROR: BGSAVE still in progress after 10 minutes"
    exit 4
  fi
  sleep 5
done

log "BGSAVE complete; copying dump.rdb out of container"
# FalkorDB uses the standard redis dir (/data) by default. Cope with operators
# who customized `dir` by reading it back from CONFIG GET.
RDB_DIR="$(docker exec "${CONTAINER}" redis-cli CONFIG GET dir \
  | awk 'NR==2 {gsub(/\r/,""); print}')"
RDB_FILE="$(docker exec "${CONTAINER}" redis-cli CONFIG GET dbfilename \
  | awk 'NR==2 {gsub(/\r/,""); print}')"
RDB_PATH="${RDB_DIR%/}/${RDB_FILE}"

docker cp "${CONTAINER}:${RDB_PATH}" "${DEST}"
log "wrote ${DEST} ($(stat -c%s "${DEST}") bytes)"

# Retention: keep the last RETAIN_DAYS daily files.
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'falkordb-*.rdb' -mtime +"${RETAIN_DAYS}" -print -delete \
  | sed 's/^/[falkordb-backup] removed /'

if (( OFFHOST_UPLOAD )); then
  if [[ -z "${AWS_S3_BACKUP_BUCKET:-}" ]]; then
    log "WARN: --offhost-upload requested but AWS_S3_BACKUP_BUCKET unset; skipping"
  elif ! command -v aws >/dev/null 2>&1; then
    log "WARN: aws cli not installed; skipping off-host upload"
  else
    S3_DEST="s3://${AWS_S3_BACKUP_BUCKET}/falkordb/falkordb-${TS}.rdb"
    log "uploading to ${S3_DEST}"
    aws s3 cp "${DEST}" "${S3_DEST}"
    log "off-host upload complete"
  fi
fi

log "done"
