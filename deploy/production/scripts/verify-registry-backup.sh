#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /var/backups/termech-doc-registry/registry-YYYYmmdd-HHMMSS.dump" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${REGISTRY_ENV_FILE:-$DEPLOY_DIR/env.production}
DUMP=$1

case "$DUMP" in
  /var/backups/termech-doc-registry/registry-*.dump) ;;
  *) echo "Unexpected registry dump path: $DUMP" >&2; exit 1 ;;
esac

test -r "$DUMP"
test -r "$DUMP.sha256"
sha256sum -c "$DUMP.sha256"

TEST_DB="registry_restore_test_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() {
  docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" \
    exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$TEST_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" \
  exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$TEST_DB"
docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" \
  exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-acl --exit-on-error' sh "$TEST_DB" < "$DUMP"
docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" \
  exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -Atc "select count(*) from registry_documents"' sh "$TEST_DB"

echo "Registry backup restore test passed: $DUMP"
