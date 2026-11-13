#!/bin/sh
# Applies pending database migrations (unless RUN_MIGRATIONS=false), then starts the worker.
set -e
if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  node dist/migrate.mjs
fi
exec node dist/worker.mjs
