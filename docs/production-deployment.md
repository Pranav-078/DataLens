# DataLens production deployment

This guide defines the production deployment path. It is intentionally separate from the local development `docker-compose.yml`; use `docker-compose.production.yml` with `.env.production`. Do not reuse local development containers or database volumes.

## Release prerequisites

- A Linux Docker host with Docker Compose v2.
- A domain name and an HTTPS reverse proxy / load balancer (Caddy, Traefik, Nginx, or a managed ingress) that terminates TLS and forwards to the host's loopback address on port 8080.
- Persistent backups for both PostgreSQL and `storage_data`. Database restore and uploaded-file restore must be coordinated.
- A unique long random PostgreSQL migration password, a different runtime database password, and an `AUTH_COOKIE_SECRET` generated from at least 48 random bytes.
- A Gemini API key only if the AI workspace is enabled.
- One API replica for this release. The authentication attempt limiter is process-local; do not scale the API horizontally until it is moved to a shared store.

## 1. Prepare secrets

Copy `.env.production.example` to `.env.production` on the deployment host. Do not commit the real file.

Generate URL-safe random secrets on the host:

```bash
openssl rand -hex 32
```

Use separate generated values for the cookie secret, migration password and runtime database password. Hex database passwords need no URL-encoding when inserted into the connection URLs.

Use one value for `AUTH_COOKIE_SECRET`, another for each database password. URL-encode database passwords before placing them inside `MIGRATION_DATABASE_URL` and `APP_DATABASE_URL`. Do not reuse the database superuser password for the API runtime account.

Set:

- `PUBLIC_ORIGIN` to the exact browser-facing HTTPS origin, without a path or trailing slash, such as `https://datalens.example.com`.
- `TRUST_PROXY_HOPS` to the actual number of trusted reverse proxies seen by the API. The default example is `2` for an HTTPS ingress/load balancer forwarding to the bundled Nginx container, which then forwards to the API. Add another hop for each trusted CDN/load-balancer proxy in front, and configure those proxies to overwrite the forwarded headers.
- `HTTP_BIND_ADDRESS=127.0.0.1` so the bundled HTTP entry point is not directly reachable from the public network. The host TLS proxy should connect to `127.0.0.1:8080`.
- `AUTH_ALLOW_REGISTRATION=false` for normal operation. Account registration has no email-verification flow in this release. For initial private onboarding only, enable registration temporarily, create the required accounts, then disable it and redeploy.

The API refuses to start in production without authentication, an HTTPS public origin, and an explicit trusted-proxy hop count. Cookie signing secrets are not sent to the browser.

## 2. Validate configuration and start

From the repository root on the deployment host:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml config --quiet
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.yml ps
```

The deployment sequence:
1. starts PostgreSQL and waits for its health check;
2. runs `prisma migrate deploy` with the migration database URL;
3. creates/updates the restricted runtime database role and grants DML permissions;
4. starts the Python profiler on the private data network;
5. starts the API using only the restricted runtime database URL;
6. starts the static frontend/reverse proxy.

The database has no published host port. The Python profiler has no published host port and is reachable only from the API over the private network. The API has no published host port; the frontend proxies same-origin `/api/*` requests to it. Only the frontend HTTP port is published, bound to loopback by default.

The runtime API database role receives SELECT/INSERT/UPDATE/DELETE on application tables and required sequence privileges. DDL and Prisma migrations use the separate migration/admin URL.

## 3. Configure HTTPS ingress

Configure the host-level or managed reverse proxy to:
- obtain and renew a valid certificate;
- redirect HTTP to HTTPS;
- forward the browser request to `http://127.0.0.1:8080`;
- overwrite (not append untrusted client-provided values to) `X-Forwarded-Proto` and `X-Forwarded-For`;
- preserve request method, path, cookies and response headers;
- allow upload bodies up to the configured total size; and
- allow at least 300 seconds for profiler-backed upload and AI stream requests.

The bundled Nginx serves the single-origin React app, proxies `/api/` to the Node API, supports server-sent event responses, and applies browser security headers. HSTS is served by the HTTPS ingress; enable it only after HTTPS works correctly for the entire domain.

Do not expose port 8080 directly to the public internet. If the ingress is on another host, change the bind address only after restricting the port with a firewall/security group to the ingress source addresses.

## 4. Verify release health

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps
curl -fsS https://datalens.example.com/api/health
curl -fsS https://datalens.example.com/api/health/ready
```

Expected readiness response is HTTP 200 with both `database` and `pgvector` checks equal to `ok`. Verify that:
- unauthenticated requests to project APIs return 401;
- login, logout and registration work only from the configured public origin;
- cross-origin POST requests are rejected with 403;
- a signed-in account cannot read another account's project;
- upload, Fast Preview, Full Analysis, quality issues, data catalog, schema drift, relationship rebuild/graph, and AI workspace (when configured) work;
- the new release can read previously uploaded files and the existing database after a restart.

## 5. Operations and backups

Back up PostgreSQL and the `storage_data` volume on a schedule. A database backup without uploaded CSV files is not a complete DataLens backup. Encrypt backups, restrict access, test restores, and set retention according to the data classification and user agreement.

Monitor API/profiler logs, database disk and memory, storage growth, CPU, health-check failures, upload/profiler duration, and Gemini errors/costs. Alert on repeated 5xx responses, repeated failed readiness checks, database space thresholds and failed backups.

Use `docker compose ... pull` / rebuilds only as part of a reviewed release. Keep the previous image tags and backups for rollback. Database migrations must be backward-compatible with the previous API version before rolling back application containers.

## Known product limitations to resolve before a public multi-tenant SaaS launch

- Email verification, password reset, MFA, organization roles, invitations, audit log screens and account deletion workflows are not implemented.
- The IP authentication throttler and upload-concurrency gate are process-local. This Compose deployment is deliberately one API replica; use shared stores/coordination before scaling horizontally.
- Uploads are limited to 50 MB per file, 10 files, and 100 MB per multipart batch by default. Only one large CSV upload is processed at a time per API process to limit memory pressure. Increase these limits only after load testing the host RAM and profiler memory.
- Registration has no email ownership verification. Keep it disabled except during controlled onboarding.
- AI answers and RAG retrieval are evidence aids, not guarantees. Review Gemini data-use terms, processing region, retention and contractual requirements before uploading confidential or regulated documents.
- Large CSV uploads are buffered in API memory and then loaded in profiler memory. Set limits for the host's available RAM and load-test with representative maximum-size files before opening access to external users.
- This deployment guide does not provision DNS, TLS certificates, a cloud firewall, object storage, backup schedules, monitoring, or provider secrets. Those are infrastructure-specific tasks and must be verified in the selected hosting account.

## Rollback

1. Stop new traffic at the HTTPS ingress.
2. Keep the PostgreSQL and storage volumes intact.
3. Redeploy the previous API/frontend image tags only when the previous application version is compatible with the current schema.
4. For an incompatible schema change, restore the coordinated database and storage backups to a separate recovery environment first; never delete production volumes to attempt a rollback.
