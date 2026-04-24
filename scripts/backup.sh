#!/bin/sh
# Plexo database backup script — runs inside the postgres-backup sidecar.
#
# Writes gzipped pg_dump archives to /backups with a UTC timestamp in the
# filename, then prunes archives older than BACKUP_RETENTION_DAYS days.
#
# Environment:
#   POSTGRES_HOST          (required) — postgres service hostname
#   POSTGRES_USER          (required)
#   POSTGRES_PASSWORD      (required)
#   POSTGRES_DB            (required)
#   BACKUP_RETENTION_DAYS  (optional, default 7)
#   BACKUP_DIR             (optional, default /backups)
#
# Exit status:
#   0 — backup succeeded and was at least 100 bytes
#   1 — pg_dump failed
#   2 — backup is suspiciously small (probable failure)
#
# The sidecar's long-running loop calls this on a fixed interval rather than
# relying on cron so the container image stays tiny and portable.

set -eu

RETENTION="${BACKUP_RETENTION_DAYS:-7}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/plexo-${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup: starting pg_dump → ${BACKUP_FILE}"

export PGPASSWORD="${POSTGRES_PASSWORD}"
if ! pg_dump \
    -h "${POSTGRES_HOST}" \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    --format=plain \
    --no-owner \
    --no-privileges \
    2>/tmp/backup-stderr \
    | gzip -9 > "${BACKUP_FILE}"; then
    echo "[backup] pg_dump failed:" >&2
    cat /tmp/backup-stderr >&2
    rm -f "${BACKUP_FILE}"
    exit 1
fi

SIZE_BYTES="$(stat -c '%s' "${BACKUP_FILE}" 2>/dev/null || wc -c < "${BACKUP_FILE}")"
if [ "${SIZE_BYTES}" -lt 100 ]; then
    echo "[backup] FATAL — backup is only ${SIZE_BYTES} bytes (likely failed)" >&2
    rm -f "${BACKUP_FILE}"
    exit 2
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup: OK ${BACKUP_FILE} (${SIZE_BYTES} bytes)"

# Retention pruning — only delete files matching our naming pattern so
# stray files in the backup dir (manual dumps, README) are left alone.
echo "[backup] pruning backups older than ${RETENTION} days"
find "${BACKUP_DIR}" -name 'plexo-*.sql.gz' -type f -mtime "+${RETENTION}" -print -delete || true

REMAINING="$(find "${BACKUP_DIR}" -name 'plexo-*.sql.gz' -type f | wc -l)"
echo "[backup] done — ${REMAINING} archive(s) retained"

# ── DI-008: MinIO / S3-compatible asset backup ───────────────────
# If the `mc` (MinIO Client) binary is available, mirror the asset bucket
# to /backups/minio/. The mc alias "minio" must be pre-configured:
#   mc alias set minio http://minio:9000 $STORAGE_ACCESS_KEY $STORAGE_SECRET_KEY
# If mc is not installed, skip silently — operators using external S3 should
# configure their own backup strategy (cross-region replication, versioning, etc).
MINIO_BACKUP_DIR="${BACKUP_DIR}/minio"
if command -v mc >/dev/null 2>&1; then
    echo "[backup] Starting MinIO asset mirror → ${MINIO_BACKUP_DIR}"
    mkdir -p "${MINIO_BACKUP_DIR}"
    if mc mirror --overwrite minio/"${STORAGE_BUCKET:-plexo-assets}" "${MINIO_BACKUP_DIR}/" 2>/dev/null; then
        MINIO_SIZE="$(du -sh "${MINIO_BACKUP_DIR}" 2>/dev/null | cut -f1)"
        echo "[backup] MinIO mirror OK (${MINIO_SIZE})"
    else
        echo "[backup] MinIO mirror failed or bucket not found — skipping"
    fi
else
    echo "[backup] mc not found — MinIO backup skipped (install minio-client for asset backups)"
fi
