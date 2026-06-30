#!/usr/bin/env bash
#
# Run the idempotent production migration using the DATABASE_* values already
# in .env — so you never have to retype psql credentials. Safe to re-run.
#
#   ./scripts/db-migrate.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $(pwd)" >&2
  exit 1
fi

# Read a single KEY=value from .env without sourcing it (values may contain
# characters like < > that break `source`, e.g. SMTP_FROM).
v() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '"\r' | sed 's/[[:space:]]*$//'; }

HOST="$(v DATABASE_HOST)";     HOST="${HOST:-localhost}"
PORT="$(v DATABASE_PORT)";     PORT="${PORT:-5432}"
USER="$(v DATABASE_USERNAME)"
NAME="$(v DATABASE_NAME)"
PASS="$(v DATABASE_PASSWORD)"

if [ -z "$USER" ] || [ -z "$NAME" ]; then
  echo "ERROR: DATABASE_USERNAME / DATABASE_NAME missing from .env" >&2
  exit 1
fi

echo "→ Applying migration_production.sql to ${NAME}@${HOST}:${PORT} as ${USER}"
PGPASSWORD="$PASS" psql -h "$HOST" -p "$PORT" -U "$USER" -d "$NAME" -f migration_production.sql
echo "✓ Done"
