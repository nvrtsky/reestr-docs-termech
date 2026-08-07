#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${REGISTRY_ENV_FILE:-$DEPLOY_DIR/env.production}
BACKUP_DIR=${REGISTRY_BACKUP_DIR:-/var/backups/termech-doc-registry}
RETENTION_DAYS=${REGISTRY_BACKUP_RETENTION_DAYS:-2}

case "$RETENTION_DAYS" in
  ''|*[!0-9]*) echo "Invalid backup retention: $RETENTION_DAYS" >&2; exit 1 ;;
esac
if [ "$RETENTION_DAYS" -lt 1 ]; then
  echo "Backup retention must be at least one day" >&2
  exit 1
fi

case "$BACKUP_DIR" in
  /var/backups/termech-doc-registry|/var/backups/termech-doc-registry/*) ;;
  *) echo "Unsafe registry backup directory: $BACKUP_DIR" >&2; exit 1 ;;
esac

umask 077
install -d -m 0750 "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%d-%H%M%S)
TARGET="$BACKUP_DIR/registry-$STAMP.dump"
TEMP="$TARGET.tmp"

cleanup() {
  rm -f -- "$TEMP"
}
trap cleanup EXIT HUP INT TERM

docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" \
  exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$TEMP"
test -s "$TEMP"
chmod 0600 "$TEMP"
mv -- "$TEMP" "$TARGET"
sha256sum "$TARGET" > "$TARGET.sha256"
chmod 0600 "$TARGET.sha256"

"$SCRIPT_DIR/verify-registry-backup.sh" "$TARGET"

RETENTION_MINUTES=$((RETENTION_DAYS * 24 * 60))
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f \
  \( -name 'registry-*.dump' -o -name 'registry-*.dump.sha256' \) \
  -mmin "+$RETENTION_MINUTES" -delete

printf '%s\n' "$TARGET"
