#!/bin/sh
# web: the Next.js app · worker: translations + Telegram bot · all: both in one container
set -e

# No APP_SECRET given: make one on the first start and keep it in the /data volume.
# It encrypts the API keys in the database, so losing it means entering the keys again.
if [ -z "$APP_SECRET" ] && [ -z "$BETTER_AUTH_SECRET" ]; then
    secret_file=/data/app-secret
    if [ ! -s "$secret_file" ]; then
        if ! (umask 077 && head -c 32 /dev/urandom | base64 > "$secret_file") 2>/dev/null; then
            echo "Cannot write $secret_file: set APP_SECRET or mount a writable volume at /data" >&2
            exit 1
        fi
        echo "Generated APP_SECRET in $secret_file (keep this volume, or set APP_SECRET yourself)"
    fi
    APP_SECRET=$(cat "$secret_file")
    export APP_SECRET
fi

node /app/migrate.mjs
case "${1:-all}" in
    web) exec node /app/apps/web/server.js ;;
    worker) exec node /app/worker.mjs ;;
    all)
        SKIP_MIGRATIONS=1 node /app/worker.mjs &
        worker=$!
        node /app/apps/web/server.js &
        web=$!
        trap 'kill -TERM $worker $web 2>/dev/null; wait' TERM INT
        # stop the container when either process exits, so the restart policy brings both back
        while kill -0 $worker 2>/dev/null && kill -0 $web 2>/dev/null; do sleep 5; done
        kill -TERM $worker $web 2>/dev/null
        wait
        exit 1
        ;;
    *) exec "$@" ;;
esac
