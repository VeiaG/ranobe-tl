# Configuration

`compose.yml` runs without any settings. Everything below is optional and goes into a `.env` file next to `compose.yml` (or into the environment variables of Coolify, Portainer, …). After changing it: `docker compose up -d`.

## Environment variables

| variable | default | what it does |
|---|---|---|
| `RANOBE_TL_VERSION` | `latest` in the repo, the release's own version in a release's `compose.yml` | image tag: `0.2.0`, `0.2` (patch updates only), `latest` (newest release), `edge` (the main branch, untested) |
| `APP_URL` | | the address you open the app at, e.g. `https://tl.example.com`. Set it when the app has a domain: cookies become `Secure`, and Telegram messages get "Open" links. Without it the app works on any address it is opened with (`http://192.168.1.20:3000`, a domain) |
| `APP_SECRET` | generated | encrypts API keys, the bucket secret and the Telegram token in the database, and signs sessions. When empty, one is generated on the first start into the `data` volume. See [Secrets](#secrets) |
| `PORT` | `3000` | port on the host |
| `TELEGRAM_BOT_TOKEN` | | bot from @BotFather. Easier: paste it in **Settings → Telegram** (that one wins, no restart) |
| `TELEGRAM_BOT_USERNAME` | | only if the container can't reach api.telegram.org to look it up |
| `WORKER_CONCURRENCY` | `2` | novels translated at the same time, until changed in **Settings → Instance** |
| `WORKER_SLOTS` | `8` | the most one worker can run at once; the real limit is the instance setting |
| `BACKUP_CRON` | `17 3 * * *` | when the nightly bucket backup check runs (see the README, Backups) |
| `TZ` | `UTC` | time zone of `BACKUP_CRON` |
| `TRUSTED_ORIGINS` | | with `APP_URL` set: other addresses allowed to sign in, comma-separated (a second domain, the LAN IP) |
| `POSTGRES_PASSWORD` | `ranobe` | the database is not exposed outside the compose network, so the default is fine on a home server. Changing it later needs the same change inside Postgres (`ALTER USER ranobe PASSWORD '…'`), the variable only applies when the volume is created |
| `DATABASE_URL` | set by compose | only to use your own Postgres (16+) instead of the `db` service |
| `DATABASE_POOL_SIZE` | `10` | connections per process |

API keys of the providers are **not** environment variables: add them in **Settings → API keys** (several per provider are fine, each novel picks one).

## Where things are stored

| | where | |
|---|---|---|
| novels, chapters (source and translation), glossaries, decisions, translation history, usage, accounts, settings | the `db` volume (Postgres) | |
| API keys, bucket secret, Telegram token | the `db` volume, encrypted with `APP_SECRET` (AES-256-GCM) | shown once when saved, never sent back to the browser |
| `APP_SECRET`, when generated | the `data` volume, file `/data/app-secret` | |
| backups (optional) | your S3/R2 bucket, a plain folder per novel | **Settings → Storage** |

`docker compose down` keeps the volumes; `docker compose down -v` deletes them, and everything with them.

### Secrets

Losing `APP_SECRET` (deleting the `data` volume, or changing the variable) does not lose any novel, but saved keys can no longer be decrypted: enter the API keys, the bucket secret and the Telegram token again, and everyone signs in again.

To manage it yourself instead: `openssl rand -base64 32`, put it into `.env` as `APP_SECRET=…`. Moving a generated one there: `docker compose exec app cat /data/app-secret`.

## Updating

```sh
docker compose pull && docker compose up -d
```

Migrations run on start. They only go forward, so before a big jump dump the database: `docker compose exec db pg_dump -U ranobe ranobe > backup.sql`.

With `RANOBE_TL_VERSION` pinned, change it and run the same command. A chapter being translated gets up to 10 minutes to finish when the container stops.

## Web and worker in separate containers

The `app` service runs both the web app and the translation worker (`command: all`, the default). To restart one without the other, or to put the worker on another machine, use the same image twice:

```yaml
services:
    app:
        # …as in compose.yml, plus:
        command: web
    worker:
        image: ghcr.io/veiag/ranobe-tl:${RANOBE_TL_VERSION:-latest}
        command: worker
        restart: unless-stopped
        environment:
            DATABASE_URL: postgres://ranobe:${POSTGRES_PASSWORD:-ranobe}@db:5432/ranobe
            APP_SECRET: ${APP_SECRET:?both containers need the same APP_SECRET}
            APP_URL: ${APP_URL:-}
        depends_on:
            db:
                condition: service_healthy
        stop_grace_period: 10m
```

Set `APP_SECRET` in `.env` for this: both containers must use the same one. Several workers are fine, novels are spread between them.

## Building the image yourself

```sh
git clone https://github.com/VeiaG/ranobe-tl && cd ranobe-tl
docker compose -f compose.yml -f compose.build.yml up -d --build
```
