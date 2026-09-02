#!/usr/bin/env bash
set -euo pipefail

LABEL="$1"
URL="$2"
MAX_ATTEMPTS="${3:-30}"
INTERVAL_SECONDS="${RETINUEOS_WAIT_INTERVAL_SECONDS:-2}"

attempt=1
until curl --fail --silent --show-error --output /dev/null "$URL"; do
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "$LABEL did not become ready after $MAX_ATTEMPTS attempts." >&2
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep "$INTERVAL_SECONDS"
done
