#!/usr/bin/env bash
# Fails if prisma/schema.prisma changed without a migration under prisma/migrations/.
# Usage: scripts/check-schema-migration.sh [base-ref]   (default: origin/master)
set -euo pipefail

BASE="${1:-origin/master}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "ERROR: base ref '$BASE' not found — fetch it first (CI uses actions/checkout fetch-depth: 0)." >&2
  exit 1
fi

CHANGED="$(git diff --name-only "$BASE"...HEAD || true)"

schema_changed=false
migrations_changed=false
if printf '%s\n' "$CHANGED" | grep -q '^prisma/schema\.prisma$'; then schema_changed=true; fi
if printf '%s\n' "$CHANGED" | grep -q '^prisma/migrations/'; then migrations_changed=true; fi

if [ "$schema_changed" = true ] && [ "$migrations_changed" = false ]; then
  cat >&2 <<'EOF'
ERROR: prisma/schema.prisma changed but no migration was added under prisma/migrations/.

The production database is push-managed (nothing in the build pipeline syncs the schema),
so a bare schema change with no migration is how drift ships.

Add prisma/migrations/<timestamp>_<name>/migration.sql and record the DB apply step in HANDOFF.md.
EOF
  exit 1
fi

echo "OK: schema/migration guard passed."
