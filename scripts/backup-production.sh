#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
STORAGE_VOLUME="${STORAGE_VOLUME:-datalens_storage_data}"
BACKUP_ROOT="${BACKUP_ROOT:-${ROOT_DIR}/backups}"

cd "$ROOT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing production environment file: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing production Compose file: $COMPOSE_FILE" >&2
  exit 1
fi

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
"${compose[@]}" config --quiet

is_running() {
  "${compose[@]}" ps --status running --services | grep -Fxq "$1"
}

api_was_running=0
frontend_was_running=0
if is_running api; then api_was_running=1; fi
if is_running frontend; then frontend_was_running=1; fi

if (( api_was_running == 0 )); then
  echo "The production API is not running; refusing to create an uncoordinated backup." >&2
  exit 1
fi

if ! docker volume inspect "$STORAGE_VOLUME" >/dev/null 2>&1; then
  echo "Uploaded-file storage volume not found: $STORAGE_VOLUME" >&2
  echo "Set STORAGE_VOLUME to the actual production Compose volume name." >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"
target="$BACKUP_ROOT/datalens-$timestamp"
mkdir -m 700 "$target"

resume_services() {
  local exit_code=$?
  trap - EXIT
  if (( api_was_running == 1 )); then
    "${compose[@]}" start api >/dev/null || {
      echo "WARNING: API did not restart automatically; start it manually." >&2
      exit_code=1
    }
  fi
  if (( frontend_was_running == 1 )); then
    "${compose[@]}" start frontend >/dev/null || {
      echo "WARNING: frontend did not restart automatically; start it manually." >&2
      exit_code=1
    }
  fi
  exit "$exit_code"
}
trap resume_services EXIT

echo "Stopping frontend first so no new requests enter the application..."
"${compose[@]}" stop frontend
echo "Waiting for active API requests to drain..."
"${compose[@]}" stop api

echo "Creating PostgreSQL logical backup..."
"${compose[@]}" exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$target/database.dump"

echo "Creating uploaded-file storage backup..."
docker run --rm \
  --mount "type=volume,src=$STORAGE_VOLUME,dst=/source,readonly" \
  --mount "type=bind,src=$target,dst=/backup" \
  alpine:3.21 \
  sh -ec 'tar -czf /backup/storage.tar.gz -C /source .'

cat > "$target/manifest.txt" <<EOF
created_at_utc=$(date -u +%FT%TZ)
git_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
compose_file=$COMPOSE_FILE
storage_volume=$STORAGE_VOLUME
database_backup=database.dump
storage_backup=storage.tar.gz
EOF

(
  cd "$target"
  sha256sum database.dump storage.tar.gz manifest.txt > SHA256SUMS
)

echo "Backup completed: $target"
echo "Verify SHA256SUMS and copy the entire directory to encrypted off-host storage."
