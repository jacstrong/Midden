# Compose with HTTPS

This is the most common way to run Midden for a team: Docker Compose with [Caddy](https://caddyserver.com) in front to handle certificates. Everything is in [`docker/docker-compose.https.yml`](../docker/docker-compose.https.yml) and [`docker/Caddyfile`](../docker/Caddyfile).

## Set it up

You need Docker with Compose and a DNS name that points at the machine. From a checkout, create `docker/.env`:

```bash
MIDDEN_HOSTNAME=midden.corp.example
```

Then start it, and get the first admin's one-time password from the log:

```bash
docker compose -f docker/docker-compose.https.yml up -d
docker compose -f docker/docker-compose.https.yml logs midden | grep 'one-time password'
```

Open `https://midden.corp.example`, sign in as `admin`, and change the password when prompted.

Only Caddy publishes ports. Midden itself is reachable only from Caddy, on a private network.

## Choosing a certificate

Which certificate you can use depends on how the machine is reachable. To change it, edit the site block in `docker/Caddyfile`:

**The machine can be reached from the internet.** There's nothing to change. Caddy gets a certificate from Let's Encrypt and renews it for you. Ports 80 and 443 must be open.

**It's on an internal network or a hunt LAN.** Let's Encrypt can't reach it, so have Caddy use its own private certificate authority by adding this line inside the site block:

```
tls internal
```

Browsers will warn until you trust Caddy's root certificate. To get a copy to install on your team's machines:

```bash
docker compose -f docker/docker-compose.https.yml cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./midden-root.crt
```

**Your organization issues certificates.** Mount them into the Caddy container with a `volumes` entry, then point at them inside the site block:

```
tls /certs/fullchain.pem /certs/privkey.pem
```

## Using another proxy

Any reverse proxy works if it does these four things:

- Forwards WebSocket upgrades on `/api/ws`, and holds them open.
- Sends `X-Forwarded-Proto` and `X-Forwarded-For`.
- Allows request bodies up to `MIDDEN_MAX_UPLOAD_MB`.
- Doesn't buffer responses to `/api/ws`.

Then tell Midden about it with `MIDDEN_PUBLIC_ORIGIN` and `MIDDEN_TRUST_PROXY=true`. There's an [nginx example](deploy.md#https) in the deployment guide.

Only turn on `MIDDEN_TRUST_PROXY` when a proxy really is in front. Otherwise anyone can forge those headers, including the client address the login rate limit relies on.

## Backup and upgrade

Everything Midden stores is in the `midden-data` volume. Before an upgrade, take a consistent copy of the database and bring it out of the volume. Attachments and raw scans are in `/data/blobs`, so [copy those too](deploy.md#backup-and-restore) if you want the files as well:

```bash
docker compose -f docker/docker-compose.https.yml exec midden \
  node /app/dist/main.js backup /data/midden-backup.db
docker compose -f docker/docker-compose.https.yml cp midden:/data/midden-backup.db ./midden-backup.db
```

To upgrade:

```bash
docker compose -f docker/docker-compose.https.yml pull
docker compose -f docker/docker-compose.https.yml up -d
```

The file uses the `latest` image. To control when upgrades happen, change it to a specific version.
