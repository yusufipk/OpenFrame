#!/usr/bin/env sh
set -eu

DB_HOST="${DOCKER_DB_HOST:-postgres}"
DB_PORT="${DOCKER_DB_PORT:-5432}"
MINIO_HEALTHCHECK_URL="${MINIO_HEALTHCHECK_URL:-http://minio:9000/minio/health/live}"
MAX_ATTEMPTS="${STARTUP_MAX_ATTEMPTS:-60}"
SLEEP_SECONDS="${STARTUP_SLEEP_SECONDS:-2}"

wait_for_tcp() {
  host="$1"
  port="$2"
  label="$3"
  attempt=1

  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if nc -z "$host" "$port" >/dev/null 2>&1; then
      echo "$label is reachable at $host:$port"
      return 0
    fi

    echo "Waiting for $label at $host:$port ($attempt/$MAX_ATTEMPTS)"
    attempt=$((attempt + 1))
    sleep "$SLEEP_SECONDS"
  done

  echo "Timed out waiting for $label at $host:$port" >&2
  exit 1
}

wait_for_http() {
  url="$1"
  label="$2"
  attempt=1

  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if curl --silent --fail "$url" >/dev/null 2>&1; then
      echo "$label is reachable at $url"
      return 0
    fi

    echo "Waiting for $label at $url ($attempt/$MAX_ATTEMPTS)"
    attempt=$((attempt + 1))
    sleep "$SLEEP_SECONDS"
  done

  echo "Timed out waiting for $label at $url" >&2
  exit 1
}

wait_for_tcp "$DB_HOST" "$DB_PORT" "Postgres"
wait_for_http "$MINIO_HEALTHCHECK_URL" "MinIO"

echo "Bootstrapping database"
bun run scripts/docker-db-bootstrap.ts

echo "Running self-host bootstrap"
bun run self-host:bootstrap

echo "Starting OpenFrame"
exec bun run start
