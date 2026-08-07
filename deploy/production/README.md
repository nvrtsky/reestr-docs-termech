# Production deployment

The registry is deployed independently from the commercial-offer application.

## Server layout

- source: `/var/www/termech-doc-registry`
- frontend: `127.0.0.1:3102`
- backend: `127.0.0.1:3103`
- PostgreSQL: internal Docker network only
- public UI: `https://termech.navrotsky.ru/registry/`
- API: `https://termech.navrotsky.ru/api/v1/registry/`

## Environment

Create `deploy/production/env.production` from `env.example`. The production
file must remain outside Git.

## First start

```bash
docker compose --env-file deploy/production/env.production \
  -f deploy/production/docker-compose.yml up -d --build

docker compose --env-file deploy/production/env.production \
  -f deploy/production/docker-compose.yml run --rm backend \
  node dist/db/seed.js
```

Database migrations run automatically before the backend starts. Seed is a
separate one-time command because repeated seed runs would overwrite catalog
and role changes made by registry administrators.

Keep the release directory owned by the deployment account and not writable by
other users. Recommended host modes are `0750` for
`/var/www/termech-doc-registry`, `0750` for
`/var/backups/termech-doc-registry`, `0600` for `env.production`, and `0600`
for database dumps/checksums. Do not use `0777` or world-readable backups.

## Host nginx

Copy `deploy/production/nginx/termech-doc-registry.conf` to
`/etc/nginx/snippets/termech-doc-registry.conf` and include it inside the HTTPS
`server` block for `termech.navrotsky.ru`:

```nginx
include /etc/nginx/snippets/termech-doc-registry.conf;
```

Run `nginx -t` before reloading nginx.

The registry upload route deliberately uses `client_max_body_size 0`: files are
streamed to Bitrix24 Disk and the effective size policy is defined by the
approved requirements and Bitrix24, not by nginx.

## Automated backup and restore test

Install the timer without touching any other application on the host:

```bash
chmod 0750 deploy/production/scripts/*.sh
install -m 0644 deploy/production/systemd/termech-registry-backup.service /etc/systemd/system/
install -m 0644 deploy/production/systemd/termech-registry-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now termech-registry-backup.timer
```

The backup script writes only to `/var/backups/termech-doc-registry`, applies
`0600`, writes a SHA-256 checksum, verifies every new dump in a disposable
database, and retains the last two days by default. A dump can also be checked
manually before a release:

```bash
deploy/production/scripts/verify-registry-backup.sh \
  /var/backups/termech-doc-registry/registry-YYYYmmdd-HHMMSS.dump
```

The verifier never restores over the production database: it creates a
temporary `registry_restore_test_*` database and drops it on exit.

## Health checks

```bash
curl --fail http://127.0.0.1:3102/
curl --fail http://127.0.0.1:3103/api/v1/health/live
curl --fail http://127.0.0.1:3103/api/v1/health/ready
```

## Portable data

For migration to another server, transfer:

1. the exact application source or release archive;
2. `deploy/production/env.production` through a secure channel;
3. a PostgreSQL dump created with `pg_dump`;
4. the Bitrix24 placement URLs if the public hostname changes.
