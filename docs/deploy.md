# Running it on a domain

The app needs nothing from outside to work: the Telegram bot uses long polling, so a Raspberry Pi at home behind a router is fine. A domain is only for opening it from anywhere with HTTPS.

Whatever puts it on the domain, set `APP_URL` to that address (`https://tl.example.com`): cookies become `Secure` and Telegram messages link to the app.

## Coolify

1. **Project → New resource → Docker Compose Empty**, paste the `compose.yml` of the [latest release](https://github.com/VeiaG/ranobe-tl/releases/latest).
2. Remove the `ports:` lines of the `app` service: Coolify's proxy reaches the container directly, and port 3000 on the server may be taken.
3. In the `app` service, set **Domains** to `https://tl.example.com:3000`. The `:3000` is the port inside the container, the site itself is on 443.
4. **Environment variables**: `APP_URL=https://tl.example.com`. Coolify lists the other variables from the compose file; all can stay empty.
5. Point the domain's DNS (an `A` record) at the server and **Deploy**. Coolify gets the certificate.

Updating: **Redeploy** pulls the image again. To pin a version, set `RANOBE_TL_VERSION` (e.g. `0.2.0`) in the environment variables.

Volumes (`db`, `data`) are kept between deploys. Coolify's own scheduled database backups don't see a database inside a compose resource; use **Settings → Storage** in the app (a folder per novel in R2/S3) and, for a full copy, `pg_dump` (see [configuration](configuration.md#updating)).

## Caddy

On the same machine, with ports 80/443 open:

```
tl.example.com {
    reverse_proxy localhost:3000
}
```

## Cloudflare Tunnel

For a Raspberry Pi at home without opening ports: create a tunnel in **Cloudflare Zero Trust → Networks → Tunnels**, install `cloudflared` on the Pi with the command it shows, and add a public hostname `tl.example.com` → `http://localhost:3000`.

## nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
# chapters and folders upload as zips; nginx allows 1 MB by default
client_max_body_size 200m;
```
