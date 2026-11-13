#!/bin/sh
# Off-site backup of the DeskPilot database (in addition to Supabase's own backups).
#
# Required env:
#   DATABASE_URL     direct Postgres connection string (port 5432)
#   BACKUP_S3_URI    e.g. s3://my-bucket/deskpilot
# Optional env:
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
#   BACKUP_S3_ENDPOINT   for S3-compatible storage (Hetzner, Backblaze B2, Cloudflare R2)
#   BACKUP_KEEP_DAYS     delete local temp file only; set bucket lifecycle rules for retention
#
# Needs pg_dump (same or newer major version as the server) and the AWS CLI.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_S3_URI:?BACKUP_S3_URI is required}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="${TMPDIR:-/tmp}/deskpilot-${STAMP}.dump"

echo "Dumping database..."
# Custom format: compressed, restorable table-by-table with pg_restore.
# auth = Supabase users (needed to restore memberships), public = app data,
# internal = rate limits/webhook ids, pgboss = queued and scheduled jobs.
pg_dump "$DATABASE_URL" \
  --format=custom --no-owner --no-privileges \
  --schema=public --schema=internal --schema=pgboss --schema=auth \
  --file="$FILE"

echo "Uploading to ${BACKUP_S3_URI}/ ..."
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  aws s3 cp "$FILE" "${BACKUP_S3_URI}/" --endpoint-url "$BACKUP_S3_ENDPOINT"
else
  aws s3 cp "$FILE" "${BACKUP_S3_URI}/"
fi

rm -f "$FILE"
echo "Backup ${STAMP} done."
