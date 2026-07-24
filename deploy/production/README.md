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

## Host nginx

Copy `deploy/production/nginx/termech-doc-registry.conf` to
`/etc/nginx/snippets/termech-doc-registry.conf` and include it inside the HTTPS
`server` block for `termech.navrotsky.ru`:

```nginx
include /etc/nginx/snippets/termech-doc-registry.conf;
```

Run `nginx -t` before reloading nginx.

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
