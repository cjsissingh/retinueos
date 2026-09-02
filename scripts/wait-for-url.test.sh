#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

mkdir -p "$FIXTURE_DIR/bin"
printf '0\n' >"$FIXTURE_DIR/attempts"

cat >"$FIXTURE_DIR/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

attempts=$(cat "$RETINUEOS_TEST_ATTEMPTS_FILE")
attempts=$((attempts + 1))
printf '%s\n' "$attempts" >"$RETINUEOS_TEST_ATTEMPTS_FILE"

if [ "$attempts" -lt 3 ]; then
  exit 22
fi
FAKE_CURL
chmod +x "$FIXTURE_DIR/bin/curl"

cat >"$FIXTURE_DIR/bin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1" != "0" ]; then
  echo "Expected RETINUEOS_WAIT_INTERVAL_SECONDS=0, received $1." >&2
  exit 1
fi
FAKE_SLEEP
chmod +x "$FIXTURE_DIR/bin/sleep"

PATH="$FIXTURE_DIR/bin:$PATH" \
  RETINUEOS_TEST_ATTEMPTS_FILE="$FIXTURE_DIR/attempts" \
  RETINUEOS_WAIT_INTERVAL_SECONDS=0 \
  "$REPO_ROOT/scripts/wait-for-url.sh" "frontend" "https://retinueos.example/login" 5

if [ "$(cat "$FIXTURE_DIR/attempts")" != "3" ]; then
  echo "Expected the readiness check to succeed on its third attempt." >&2
  exit 1
fi

echo "wait-for-url retry test passed"
