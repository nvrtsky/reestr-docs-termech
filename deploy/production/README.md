# Marketplace production deployment

The registry is deployed independently from the commercial-offer application.
The production instance is a multi-tenant Bitrix24 Marketplace application;
every installed portal has its own OAuth credentials and all business rows are
scoped by `portal_url`. Cloud and box portals are supported; box hosts must
resolve exclusively to public IP addresses and REST redirects are rejected.

The durable boundary and first-customer cutover decision are recorded in
[`docs/architecture/application-boundaries.md`](../../docs/architecture/application-boundaries.md).
`thermech.bitrix24.ru` starts with a clean tenant; data from its legacy local
registry is not restored into Marketplace production. The legacy local app is
removed immediately after acceptance.

## Server layout

- source: `/opt/reestr-docs`
- frontend: `127.0.0.1:3202`
- backend: `127.0.0.1:3203`
- PostgreSQL: internal Docker network only
- public UI and placement handler: `https://reestr.navrotsky.ru/`
- install handler: `https://reestr.navrotsky.ru/api/v1/bitrix/install`
- event handler: `https://reestr.navrotsky.ru/api/v1/bitrix/events`

## Environment

Create `deploy/production/env.production` from `env.example`, set mode `0600`,
and keep it outside Git. Generate independent secrets:

```bash
openssl rand -base64 36  # POSTGRES_PASSWORD
openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
```

DNS credentials, Marketplace test keys and legal details are kept separately
in the ignored `deploy/production/env.deploy.local`; copy its structure from
`env.deploy.example` and set mode `0600`. Do not copy DNS credentials into a
container or the server runtime env.

`BITRIX_CLIENT_ID`, `BITRIX_CLIENT_SECRET`, and `BITRIX_APP_CODE` come from the
Bitrix24 developer cabinet. Marketplace mode refuses to start without them.
`PUBLIC_BASE_URL` is the canonical public URL used for placement and event
callbacks; `WEB_ORIGIN` is the browser origin allowed by CORS.
`BITRIX_ALLOWED_DOMAINS` keeps the first customer explicit; additional portals
must use an official Bitrix24 cloud domain and must also exist in the encrypted
installation registry.

## First start

```bash
docker compose --env-file deploy/production/env.production \
  -f deploy/production/docker-compose.yml up -d --build
```

Database migrations run before the backend starts. Do not run the old global
seed command in Marketplace production: a clean tenant is initialized during
its installation, including a dedicated `Реестр документов` folder on that
portal's Bitrix24 Disk.

Keep the release directory mode at `0750`; use `0600` for env files, database
dumps, and checksums.

Bitrix24 REST audit entries include the portal, method, status and duration but
never tokens, request bodies or response bodies. Docker retains up to 1 GB per
service so the production host can preserve at least three days of REST audit
history; monitor disk usage before raising traffic limits.

## Host nginx and TLS

Copy `nginx/reestr.navrotsky.ru.bootstrap.conf` first, enable it, and switch the
DNS A record. After the record resolves to the server, obtain a Let's Encrypt
certificate and replace it with `nginx/reestr.navrotsky.ru.conf`. Run
`nginx -t` before every reload. The
upload route streams files to Bitrix24 Disk, so nginx request buffering and a
fixed body-size limit are disabled for the API.

## Bitrix24 application

Request scopes: `crm`, `placement`, `user`, `department`, `disk`, `im`, and
`task`/`tasks`. Register these URLs in the developer cabinet:

- application/install URL: `https://reestr.navrotsky.ru/api/v1/bitrix/install`;
- application handler: `https://reestr.navrotsky.ru/`;
- support: `https://reestr.navrotsky.ru/support.html`;
- privacy: `https://reestr.navrotsky.ru/privacy.html`;
- licence: `https://reestr.navrotsky.ru/license.html`.

After PR #12 is merged, installation binds `LEFT_MENU`,
`CRM_DEAL_DETAIL_TAB`, and `CRM_COMPANY_DETAIL_TAB`. The uninstall handler
verifies the stored application-token hash. `CLEAN=1` purges immediately;
otherwise the tenant is quarantined for `DATA_RETENTION_DAYS` and restored by
a reinstall during that period.

## Backup and health checks

Install the systemd backup timer from `deploy/production/systemd`. It keeps 14
days of dumps, writes SHA-256 checksums, and verifies every dump by restoring it
to a disposable database.

```bash
curl --fail http://127.0.0.1:3202/
curl --fail http://127.0.0.1:3203/api/v1/health/live
curl --fail http://127.0.0.1:3203/api/v1/health/ready
```

Before deployment, archive the current test database instead of restoring it
into the Marketplace volume. Keep that archive until the first customer and
Marketplace moderation have both been accepted.
