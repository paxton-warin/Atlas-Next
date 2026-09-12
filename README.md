# Atlas

An account-free browser portal. This project does not modify or depend on either existing Atlas application.

## Included

- Compact browser shell with sidebar/top tabs, a focus mode, and stable website frames.
- Lightly framed new-tab page with a large serif greeting, theme-colored glow, central search and shortcuts. The tab sidebar defaults to a 44px icon rail; expanding it is remembered on this device.
- Website favicons in both tab layouts, loaded through the selected proxy engine with dynamic updates and a globe fallback.
- Built-in AI chat with streaming, Markdown, local history and server-side provider configuration. See [AI setup](docs/AI.md).
- Four-step visitor wizard; six coordinated themes, light/dark/system, custom accents, backgrounds, wallpaper, density, motion, search preferences, shortcuts, favorites, history and settings import/export.
- Scramjet-LS-Bypass bootstrap/controller/helpers/WASM/HTTP transport copied unchanged from pinned commit `4f452fee`. Scramjet is the only browsing engine.
- Direct browsing nodes with point-and-attach pairing, weighted sticky assignments, owner controls and arbitrary frontend CloudFront aliases. See [node setup](docs/NODES.md).
- Searchable game catalog with built-in 2048, Snake and Tic Tac Toe, plus editable external entries.
- Anonymous, token-access support tickets, replies and status; no public user accounts.
- One administrator, Argon2id password, TOTP, one-use recovery codes, expiring HttpOnly sessions, CSRF checks, login limits and audit events.
- SQLite persistence; separate application and browsing hostnames in one Node process.

## Run locally

Node 24.12+ and pnpm 11 are required. Fetch the pinned upstream runtime after cloning; dependencies, runtime downloads, builds, and local data are not committed.

```sh
git clone https://github.com/paxton-warin/Atlas-Next.git
cd Atlas-Next
pnpm install --frozen-lockfile
pnpm runtime:fetch # needed on a fresh checkout
pnpm build
pnpm start
```

Open **http://localhost:4180**. The browsing runtime uses **http://127.0.0.1:4181**. Keep those hostnames distinct; differing ports alone do not isolate cookies.

Administrator setup:

```sh
pnpm admin:token
```

Open `http://localhost:4180/_control/atlas-owner`, enter the generated token and a password of at least 12 characters, enroll an authenticator, and save the displayed recovery codes. A token expires after 15 minutes. The path is configurable with `ADMIN_PATH`; the path is not the authentication mechanism.

Copy `.env.example` to `.env` for custom settings. `pnpm dev` currently builds and starts the app; it is not a hot-reload development server.

## Runtime fork and official comparison

```sh
pnpm runtime:fetch
pnpm build
# Optional: build the unchanged official demo used by comparison tests.
./scripts/build-upstream.sh
```

The optional official-baseline script checks out `e9ff92d1ec98ba140cb4bca840fb40c2b9b52ebf` and keeps its source unchanged. Upstream's own rewriter requires Rust nightly with rust-src, wasm32-unknown-unknown support, wasm-bindgen **0.2.105**, Binaryen wasm-opt and the r58playz wasm-snip fork. The initial local build used rustc 1.100.0-nightly (2026-08-19). Its normal development rewriter build is retained; no rewriter patch was made. The upstream declaration-generation plugin printed diagnostics even though browser bundles built; browser/runtime tests, rather than that plugin's log message, are the executable evidence.

The original demo is served at http://127.0.0.1:4182 only during tests. It is not the public Atlas interface.

The production runtime uses the fork's eight committed vendor artifacts, not a rebuild with new global replacements. `scripts/runtime-fork.json` pins their SHA-256 hashes and the corresponding source archive; a mismatch stops the build. The official demo remains only as a comparison fixture.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm test:browser
```

Playwright uses installed Google Chrome. On another OS, set `CHROME_PATH` to the Chrome executable. Tests start disposable servers/database and a local networking fixture. No website credentials are used. The fixture allows only its exact loopback destination. Production never enables that allowance.

Read [the compatibility register](docs/COMPATIBILITY.md). A passing desktop fixture is **not** a claim that Google authentication, ChatGPT authentication, Spotify playback, or Chromebook behavior has been verified.

Current measured result: **12 backend passes; 22 browser journey passes; 2 tracked upstream download failures; no unexpected failures**. Google and Spotify rendered logged-out interfaces in both Atlas and the baseline; ChatGPT showed a human-verification interstitial in both. Authentication, playback and physical Chromebook testing remain outstanding.

## Deployment

For your multi-CloudFront/direct-node setup, use [the node deployment guide](docs/NODES.md), `Dockerfile.node`, and the `nodes` branch. The legacy two-host direct deployment below remains available.

The Docker/Caddy configuration is provided but has not been run against a public deployment; the local Docker daemon was not running during verification.

Fetch and build the pinned fork first, then configure `.env` with public HTTPS origins on two distinct hostnames:

```dotenv
APP_HOST=atlas.example.com
RUNTIME_HOST=browse.example.com
APP_ORIGIN=https://atlas.example.com
RUNTIME_ORIGIN=https://browse.example.com
ADMIN_PATH=/_control/choose-a-long-random-slug
```

Point both DNS names at the server, then:

```sh
docker compose up -d --build
docker compose exec app node scripts/admin-token.mjs
```

Caddy terminates HTTPS and forwards WebSocket upgrades. Only Caddy publishes ports. Application and runtime secrets/session APIs stay off the browsing origin. Keep application and runtime on the same parent site for cross-origin frame storage compatibility; use separate hostnames, not ports. The host-local `data` folder and Docker `atlas-data` volume are different installations.

`data/master.key` encrypts the administrator TOTP secret. Back it up with the SQLite database. For a simple consistent backup, stop the app and copy the entire data directory/volume including WAL/SHM if present, then restart it. Restore to a stopped instance; preserve file permissions. Recovery codes work with the password. Losing both password and recovery materials needs operator recovery tooling, which is not included yet.

Proxy assets are bundled during build; there are no production startup downloads. Deploy by image tag and retain the prior image/data backup for rollback. Do not expose the test runner, baseline demo, or test fixture publicly.

## Source and licenses

Scramjet and the included Mercury Workshop components have their respective upstream license/source requirements. `THIRD_PARTY.md` links the exact source trees and licenses. Retain those notices and provide the corresponding source when distributing this application. Builds include `/source/atlas-source.tar.gz` and `/source/scramjet-source.tar.gz`, plus license and third-party notices. The archive script uses a fixed source allowlist and excludes databases, environment secrets, sessions and dependency folders.

## Development handoff

The repository is [paxton-warin/Atlas-Next](https://github.com/paxton-warin/Atlas-Next). Existing Atlas and Atlas-Link-Dispenser applications are separate projects. Commit source and example configuration only; keep live environment files, database volumes, origin keys, and local test artifacts out of Git.

`ROLLBACK.sh` is a narrowly scoped rehearsal tool for the startup entrypoint, not a whole-application downgrade. The previous worker-wrapper evidence is retained under `evidence/ui-refinement/`. `VERIFICATION.txt` records the original and modified SHA-256, exact probe commands, and a successful rollback on another copy. The active entrypoint remains fixed.

## Browsing startup correction

The earlier launcher spread the frontend configuration into `createRuntime`, inadvertently passing `staticDir=dist/web`. The runtime port therefore served the frontend again and tabs never received a ready message. The launcher now passes only the application/runtime origins, allowing `dist/runtime` to be served. Browser tests start **server/index.mjs itself**, not independently constructed app/runtime servers. The original failure and corrected HTTP results are reproduced by `scripts/entrypoint-probe.mjs` in disposable copies.
