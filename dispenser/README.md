# Atlas Hub / Link Dispenser

Atlas Link Dispenser is a standalone service that verifies a person's Google account through a temporary Google Drive share, creates a secure passwordless session, and distributes administrator-managed links under configurable capacity and quota rules.

This is the Hub component of the Atlas-Next monorepo. It retains its own frontend, API, authentication, database, migrations, deployment and administration console; it is not a separate Git repository. Root `pnpm hub:*` and `pnpm *:all` commands are documented in [the repository guide](../docs/REPOSITORY.md).

## What is included

- A deliberately short user journey: email → Drive file → code → link.
- Encrypted Google OAuth storage, connection testing, file cleanup, and retry jobs.
- Server-side sessions with secure HttpOnly cookies, CSRF checks, revocation, and role authorization.
- Exact-address, domain, and safety-checked regex registration rules with priority and an interactive tester.
- Individual and newline-based bulk link creation (up to 5,000 rows per import).
- Balanced-random, random, weighted-random, and rotating sequential allocation.
- Transactional capacity enforcement, weekly global quotas, per-user overrides, quota resets, and multiple active assignments per user.
- User reporting with deduplication and link-level 24-hour aggregation.
- Threshold-based health monitoring with manual checks and DNS-aware private-network protection.
- User, assignment, verification, session, report, settings, Google connection, and audit administration.
- PostgreSQL migrations, Redis coordination, Docker Compose, readiness/liveness endpoints, and structured logs.

The implementation is described in [docs/architecture.md](docs/architecture.md).

## Production deployment on Ubuntu

Requirements: a current Ubuntu LTS VPS, a DNS record for the application hostname, and ports 80/443 available to a reverse proxy.

```bash
git clone https://github.com/paxton-warin/Atlas-Next.git /srv/atlas-next
cd /srv/atlas-next/dispenser
sudo ./scripts/bootstrap-ubuntu.sh   # skip if Docker Engine + Compose are installed
cp .env.example .env
./scripts/generate-secrets.sh
nano .env
docker compose config
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/health/ready
```

Copy each generated secret into `.env`. Make `POSTGRES_PASSWORD` and the password embedded in `DATABASE_URL` identical. Set:

- `APP_URL` to the final public HTTPS origin, with no trailing slash.
- `BOOTSTRAP_ADMIN_EMAIL` to the first administrator's exact normalized email.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` after creating the OAuth client.
- `APP_BIND=127.0.0.1` when Caddy runs on the host. Use `0.0.0.0` only when a firewall or external load balancer must reach port 3000 directly.

The app container runs migrations before starting. Open `APP_URL`; the empty database presents the one-time administrator setup screen. Enter `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_TOKEN`. After the first administrator exists, the bootstrap endpoint cannot create another one.

### HTTPS with Caddy

Install Caddy, copy [docs/Caddyfile.example](docs/Caddyfile.example) to `/etc/caddy/Caddyfile`, replace the hostname, and reload Caddy:

```bash
sudo systemctl reload caddy
curl -fsS https://links.example.com/health/ready
```

Caddy forwards Web requests and the API to the same container. Set `TRUSTED_PROXY_CIDRS` to a comma-separated list of the immediate Caddy peer IPs/CIDRs seen by the app; the default is loopback only. Never use a universal proxy trust setting. Secure cookies work because `APP_URL` is HTTPS. If CloudFront is placed in front, use the Caddy hostname as its custom origin, forward all cookies/query strings, allow every HTTP method, disable caching for `/api/*`, and preserve HTTPS. Do not cache authentication responses.

For viewer-IP logging behind CloudFront, configure Caddy's global `servers` block to trust only the current `CLOUDFRONT_ORIGIN_FACING` CIDRs from [AWS's published ranges](https://ip-ranges.amazonaws.com/ip-ranges.json), with `trusted_proxies_strict` and `client_ip_headers X-Forwarded-For`. Keep a last-good copy and refresh this list when AWS changes it. The dispenser's `reverse_proxy` must send `header_up X-Forwarded-For {client_ip}`, a single resolved viewer address, rather than the unverified leftmost header value. Direct-origin requests then use their actual socket address, not a caller-supplied forwarding header. Keep the app port private; update the app's trusted peer list if Caddy's address changes. This fixes new session/verification/request logs and per-IP rate limits; existing CloudFront-only records remain historical and are not guessed or rewritten.

## Google Drive verification

Follow [docs/google-drive.md](docs/google-drive.md). Google credentials are deployment secrets, but connecting/reconnecting the actual verification account is handled in **Administration → Verification**. Users cannot authenticate until that connection is complete. The OAuth refresh token is encrypted at rest; tokens and client secrets are never returned by the API.

## Administration

- **Overview** shows user, allocation, supply, capacity, health, report, and verification metrics.
- **Links** supports add/edit/remove, health checks, assignment resets, capacity, weight, expiry, notes, and monitoring. **Bulk add** accepts either `https://example.com` or `Display name | https://example.com`, one per line.
- **Users** supports search/filter, status and notes, weekly quota overrides, usage reset, assignment history/reset, and session revocation.
- **Email Rules** uses the highest-priority matching enabled rule. The global default decides addresses with no match.
- **Verification** connects and tests Google Drive and shows recent attempts without exposing codes.
- **Reports** aggregates affected links and lets admins resolve/dismiss reports or disable the link.
- **Settings** edits validation-backed registration, verification, assignment, reporting, and health policy without a redeploy.
- **Audit Log** records sensitive administrative changes with before/after data, excluding secrets.

## Local development

Use Node.js 22+ and pnpm 11. Start PostgreSQL and Redis, then create a development `.env` whose URLs point to them. `NODE_ENV=development` allows non-secure cookies on localhost.

```bash
corepack enable
pnpm install
pnpm build
pnpm db:migrate
pnpm dev
```

Vite runs the web development server and proxies `/api` and `/health` to Fastify; see `apps/web/vite.config.ts` for the ports.

## Validation and tests

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Database-backed tests use isolated containers and a fake Google provider:

```bash
docker compose -f docker-compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/atlas_dispenser_test \
TEST_REDIS_URL=redis://127.0.0.1:56379/15 \
pnpm --filter @atlas-link-dispenser/server test
docker compose -f docker-compose.test.yml down -v
```

The integration suite drops only a database whose URL contains `_test`. It covers bootstrap/session security, CSRF and roles, mocked Drive verification and failure, policy denial, multiple assignment allocation, deduplicated reporting, and 100 simultaneous users competing for a capacity-50 link.

## Operations

```bash
docker compose logs -f app
docker compose restart app
docker compose pull
git pull --ff-only
docker compose up -d --build
```

- `GET /health/live` proves the process is serving.
- `GET /health/ready` checks PostgreSQL and Redis without returning credentials or internal diagnostics.
- Container data persists in `postgres-data` and `redis-data`. PostgreSQL remains authoritative; losing Redis resets rate-limit counters and job locks but not application state.

### Backups

Create a PostgreSQL backup outside the container volume:

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U atlas_dispenser -d atlas_dispenser -Fc > "backups/atlas-dispenser-$(date +%F).dump"
```

Restore into a stopped/maintenance deployment only after testing the procedure:

```bash
docker compose exec -T postgres pg_restore -U atlas_dispenser -d atlas_dispenser --clean --if-exists < backups/atlas-dispenser-YYYY-MM-DD.dump
```

Back up `.env` separately in a secure secret store. Its encryption key is required to decrypt the stored Google connection. Never commit `.env` or database dumps.

## Security notes

All identity, quota, role, health, capacity, and assignment decisions occur on the server. Codes and sessions are HMAC-hashed, OAuth values use AES-256-GCM, mutating authenticated routes require CSRF, sensitive routes are Redis-rate-limited, and health checks reject credentials, non-HTTP schemes, private literal addresses, and hostnames resolving to private addresses. Health requests do not follow redirects.

The most important operational controls are keeping `.env` private, using HTTPS, restricting the published app port to the reverse proxy, applying host security updates, monitoring logs, and testing restores.

## Current practical limits

- Google controls delivery timing for Drive share notification emails; users can always use Drive's **Shared with me** view.
- Background work runs inside the API process rather than a separate queue service. Redis locks make multiple replicas safe, but unusually large installations may prefer a dedicated worker later.
- Health checks intentionally do not follow redirects and may need a configured health path/status list for destinations that reject `HEAD`.
- The application stores recent audit and activity history without a built-in retention purge; establish a database retention policy if local requirements demand one.

## New-account disposable email checks

Admin → **Check-Mail** configures the provider without environment-variable
changes or restarts. Save an API key in the password field and enable checking.
The key is encrypted using the server's existing encryption configuration and is
never returned by administrator APIs or written to audit payloads. A blank key
field keeps the saved key; removing it disables checking. The update starts
disabled until configured.

Only new accounts consume checks. Returning accounts bypass the provider at both
verification-request and sign-in completion. Independent whitelist rules support
exact email addresses, exact domains (for example `fcpsschools.net`), and bounded,
safety-validated regex patterns. A domain rule does not include lookalike domains
or subdomains; use an explicit regex if subdomains are intended. The whitelist
bypasses only Check-Mail, not ordinary email allow/deny rules or Google Drive
verification. The administrator tester never contacts the provider.

A persistent 30-day rolling request budget is capped at 1,000, with a configurable
lower limit. Cross-process reservations, normalized-email decision caching, and
pending-request deduplication prevent resends and concurrent attempts from
spending duplicate credits. Failed requests count conservatively and are not
automatically retried. Provider quota headers can further reduce the available
budget. The usage display is local accounting, not a claim about other clients'
requests against the same API key.

Disposable/blocked/invalid results reject new registration. Provider errors,
malformed replies, timeouts, or exhausted quota pause unchecked new registrations
with a retryable message; returning accounts and whitelist matches still bypass
the provider. Cached accepted/rejected decisions last 30 days; transient failures
are briefly cached to prevent repeated spending. No key or real provider requests
are needed to install the update or run its mocked-provider tests.

Provider contract: [official Check-Mail API documentation](https://docs.check-mail.org/api-and-authentication/).
