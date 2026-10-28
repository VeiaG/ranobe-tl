#!/bin/sh
# web: the Next.js app · worker: translations + Telegram bot · all: both in one container (small setups)
set -e
node /app/migrate.mjs
case "${1:-web}" in
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
