# Architecture

Atlas Link Dispenser is an independent pnpm workspace. It shares no code, data, authentication, or deployment infrastructure with Atlas.

## Runtime

- `apps/web`: React 19 and Vite single-page application.
- `apps/server`: Fastify API, static web host, authorization, and background workers.
- `packages/database`: Drizzle schema plus ordered PostgreSQL migrations.
- `packages/shared`: types and normalization shared by browser and server.
- PostgreSQL is the durable source of truth. Redis contains rate-limit counters and short-lived distributed job locks only.
- Google OAuth tokens are encrypted with AES-256-GCM before being stored in PostgreSQL.

## Trust boundaries

The browser never receives Google credentials, verification-code hashes, quota decisions, capacities, or authorization claims. Every mutation requires a server session and matching CSRF token. Administrative routes re-check the database-backed role. Link allocation uses serializable transactions and row locks, so capacity remains authoritative under concurrency.

## Maintenance

The API process runs distributed-lock-protected jobs for expired assignments, stale sessions, verification expiry, Drive cleanup retries, and configured link-health checks. Multiple app replicas may run the jobs safely; PostgreSQL and Redis remain shared dependencies.
