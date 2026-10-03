#!/bin/bash
# Runs after a Replit merge (.replit [postMerge]). It installs dependencies only.
# Schema changes are never pushed by a hook: docs/DATABASE_SECURITY.md forbids
# build-hook schema pushes and startup-time DDL. For a disposable development
# database, review the Drizzle diff first and run the push by hand:
#   pnpm --filter @workspace/valo-pay-1-db run push
set -e
pnpm install --frozen-lockfile
echo "Dependencies installed. Database schema changes are not applied automatically; see docs/DATABASE_SECURITY.md."
