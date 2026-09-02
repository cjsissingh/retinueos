#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

default_config=$(
  cd "$REPO_ROOT"
  AUTH_PASSWORD=x docker compose -f docker-compose.yml config --format json
)
override_config=$(
  cd "$REPO_ROOT"
  AUTH_PASSWORD=x \
    HOST_BIND_ADDRESS=0.0.0.0 \
    POSTGRES_HOST_PORT=55432 \
    BACKEND_HOST_PORT=38080 \
    FRONTEND_HOST_PORT=33000 \
    docker compose -f docker-compose.yml config --format json
)

assert_port() {
  local config="$1"
  local service="$2"
  local published="$3"
  local target="$4"
  local host_ip="$5"

  jq -e --arg service "$service" --arg published "$published" --argjson target "$target" --arg host_ip "$host_ip" \
    '(.services[$service].ports | length) == 1 and
      .services[$service].ports[0].published == $published and
      .services[$service].ports[0].target == $target and
      .services[$service].ports[0].host_ip == $host_ip' \
    <<<"$config" >/dev/null
}

assert_port "$default_config" postgres 5432 5432 127.0.0.1
assert_port "$default_config" backend 8080 8080 127.0.0.1
assert_port "$default_config" frontend 3000 3000 127.0.0.1

assert_port "$override_config" postgres 55432 5432 0.0.0.0
assert_port "$override_config" backend 38080 8080 0.0.0.0
assert_port "$override_config" frontend 33000 3000 0.0.0.0

jq -e --arg context "$REPO_ROOT/backend" '.services.backend.build.context == $context' \
  <<<"$override_config" >/dev/null
jq -e --arg context "$REPO_ROOT/frontend" '.services.frontend.build.context == $context' \
  <<<"$override_config" >/dev/null

echo "docker compose config test passed"
