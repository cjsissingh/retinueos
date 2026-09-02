#!/usr/bin/env bash
# scripts/dev.sh — start the whole app for local development with one command.
#
# Postgres runs in Docker (the only piece that needs to be containerized for
# dev); backend and frontend run natively via their own `npm run dev`, which
# is what gives real HMR (tsx watch / next dev) — see docker-compose.yml,
# whose backend/frontend services build production images and have none.
#
# Usage: ./scripts/dev.sh
# Ctrl+C stops backend + frontend. Postgres is left running (it's slow to
# warm up and holds your data) — stop it yourself with `docker compose stop
# postgres` if you want it down too.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example to .env and fill it in first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

# PORT is scoped to the backend only, below — next dev also honors $PORT and
# would otherwise steal it out from under the frontend's default of 3000.
unset PORT

export DATABASE_URL="${DATABASE_URL:-postgres://retinueos:retinueos@localhost:5432/retinueos}"
export FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:3000}"
export NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-http://localhost:8080}"
BACKEND_PORT="${PORT:-8080}"

for pkg_dir in backend frontend; do
  if [ ! -d "$pkg_dir/node_modules" ]; then
    echo "==> Installing $pkg_dir dependencies (first run)..."
    (cd "$pkg_dir" && npm install)
  fi
done

echo "==> Starting Postgres (docker compose)..."
docker compose up -d postgres

echo "==> Waiting for Postgres to be healthy..."
attempts=0
until [ "$(docker compose ps -q postgres | xargs docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "Postgres didn't become healthy in time — check 'docker compose logs postgres'." >&2
    exit 1
  fi
  sleep 1
done

echo "==> Running backend migrations..."
(cd backend && npm run db:migrate)

# Kill everything in this script's process group on exit (Ctrl+C included),
# so backgrounded npm/tsx/next processes don't linger.
trap 'echo; echo "==> Stopping backend/frontend..."; kill 0; echo "==> Postgres left running (docker compose stop postgres to stop it)."' EXIT INT TERM

echo "==> Starting backend (tsx watch) and frontend (next dev)..."
(cd backend && PORT="$BACKEND_PORT" npm run dev 2>&1 | sed -e "s/^/[backend]  /") &
(cd frontend && npm run dev -- -H 0.0.0.0 2>&1 | sed -e "s/^/[frontend] /") &

wait
