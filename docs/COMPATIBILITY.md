# Compatibility acceptance register

Target: Chrome on an actual Chromebook. Desktop Chrome is the development harness, not Chromebook certification.

## Current selected runtime — 2026-09-12

Atlas now uses https://github.com/paxton-warin/Scramjet-LS-Bypass at `4f452feec4d6804730b903294d0f9bec8002a635`. Eight shipped assets are hash-verified and copied unchanged; Atlas calls the shipped `loadRest` bootstrap with its HTTP transport. The routed prefix is `/~/app/`, globals use `$runtimekit`, and the worker is `/worker.js`. The old `/sw.js` becomes a transition wrapper. Atlas is Scramjet-only.

A real Chrome same-origin upgrade from the previous build preserved cookies and localStorage, activated the new worker, retained the legacy cookie database for rollback, and confirmed logout remained effective after another reload. The adapter copies legacy cookies only when the new cookie record is absent; it does not overwrite an existing fork jar.

Current local suite: 12 backend passes, 22 browser passes including point-and-attach/direct-node/cookie continuity, 2 tracked download failures, zero unexpected failures. The fork's own app tests have 11 passes and 2 stale HTML/default-URL assertion failures; those are recorded separately, not hidden by edits to its source. Source and evidence are under `evidence/fork-migration/` and `evidence/node-pool/`.

CloudFront deployment, authenticated Google/ChatGPT/Spotify and physical Chromebook remain unqualified. The following historical sections describe the previous official build unless explicitly updated.

## Official comparison baseline

Scramjet source: https://github.com/MercuryWorkshop/scramjet/tree/e9ff92d1ec98ba140cb4bca840fb40c2b9b52ebf/packages/demo

The core, controller, helper plugins and WASM are built from one source checkout. The published helpers 0.0.3 target a different controller/core pair; Atlas deliberately uses the source-built helpers rather than editing their version assertion. Source hashes are in `evidence/UPSTREAM-SHA256.txt`; output hashes are generated in `runtime/public/manifest.json`.

The baseline demo sources remain unchanged. Its build receives only `VITE_WISP_URL=ws://127.0.0.1:4182/wisp/`. The baseline uses the same Wisp implementation and fixture as the app. Atlas tests now spawn the actual production entrypoint with temporary test configuration. This is a baseline of the UI/runtime integration, not an independent production network qualification.

## Observed local results — 2026-09-10

Chrome 152.0.7977.83 on macOS; **not a physical Chromebook**.

- Backend: 8 passing tests.
- Browser: 22 actually passing journeys, 2 expected failures (the same download journey in Atlas and the stock demo), 0 unexpected failures. Playwright counts expected failures in its overall “passed” total; `evidence/browser-summary.txt` separates them explicitly.
- Passing fixture journeys: Scramjet HTTP, persistent/HttpOnly cookies, logout, storage, POST fetch, WebSocket, form POST, popup shell, multi-tab session sharing, app reload, stable frames during theme/layout changes, whole-runtime data clearing; wizard/settings/mobile layout; support conversations; admin enrollment/TOTP/recovery/catalog/reply/logout.
- The fixture initially mishandled libcurl's h2c upgrade offer. Fixing its Node HTTP upgrade selection restored ordinary POST body parsing for both engines; the Scramjet source was not patched.
- Google: logged-out page rendered in both.
- Spotify: logged-out interface rendered in both; no audio or account journey tested.
- ChatGPT: a human-verification interstitial appeared in both; no challenge interaction or sign-in was performed.
- Download link with an empty `download` attribute: both returned the unexpected filename `http___127.0.0.txt`; a separate stock-demo byte-stream check reported `download.createReadStream: canceled`. This is an open workflow failure, not evidence of working downloads. Expected-failure tests will flag an unexpected pass if the upstream behavior changes.
- Docker and public HTTPS deployment were not exercised: the local Docker daemon was not running. Configuration files are supplied but are not deployment certification.

Favicon coverage: Scramjet load relative icons with a base URL, reflect dynamic icon changes, use website-session cookies for protected icons, retain icons across tab-layout changes, reload icons on restored tabs, and use a globe or `/favicon.ico` when an explicit icon is missing. Icon requests remain inside the proxy runtime; no external favicon lookup service is used.

Evidence: `evidence/favicons/check.log`, `evidence/favicons/VERIFICATION.txt`, `evidence/check.log`, `evidence/browser-results.json`, `evidence/browser-summary.txt`, `evidence/public-smoke.json`, and `VERIFICATION.txt`.

## Release gate

For each journey, record the actual ChromeOS/Chrome version, source commit, date, deployment, transport, account type (not account identifier), and separate baseline/Atlas outcomes. Use PASS, INTEGRATION_REGRESSION, UPSTREAM_FAILURE, or NOT_TESTED. Never count an HTTP 200, a login-page screenshot, or a successful unit test as an authenticated-site pass.

| Journey             | Manual pass definition                                                                     | Current authenticated/real-device status                               |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Chromebook          | Cold start, keyboard/trackpad, 1366×768/1280×720 layouts, sleep/wake, restart              | NOT_TESTED                                                             |
| Google sign-in      | Account chooser, credentials, MFA, redirects/popup, consent, return to requesting site     | NOT_TESTED                                                             |
| ChatGPT             | Sign-in including Google, streaming reply, history, attachment, reload persistence         | NOT_TESTED                                                             |
| Spotify             | Sign-in, real audio, playlists, next/seek, background-tab audio, restart                   | NOT_TESTED                                                             |
| Cookies             | First-party/HttpOnly/expiry/logout; domain/path/SameSite behavior; shared tabs and restart | Local fixture results in browser-results.json; public sites NOT_TESTED |
| General demo parity | HTTP/S, forms, fetch, storage, WebSocket, popup, download, navigation, worker update       | See automated results; remaining journeys NOT_TESTED                   |

Run authenticated checks in a dedicated test browser profile with a person entering their own credentials. Do not record passwords, codes, cookies, authorization headers, or authenticated HAR/traces. Tests do not import a person's normal Chrome profile. No third-party accounts are created.

Google documents embedded-user-agent conditions at https://developers.google.com/identity/protocols/oauth2/policies#use-secure-browsers. Spotify documents protected-content/browser requirements at https://support.spotify.com/us/article/web-player-help/. Provider rejection is recorded, not represented as a working flow.

## Intentional differences from the demo

- The React interface contains no proxy rewriter modifications.
- One runtime controller lives on a distinct hostname; multiple website frames are maintained within it.
- The runtime accepts narrowly typed, source-and-origin-checked navigation messages from the shell. It sends URL/title/load/error events and bounded, rasterized PNG favicons back.
- The parent iframe remains sandboxed without top-navigation permission. An Atlas controller plugin routes JavaScript, link and form popups into internal tabs; local fixtures cover opener messaging, close/focus, named reuse, blank-window navigation, POST redirects and multipart uploads. Native context-menu windows still use the standalone runtime shell. Real provider OAuth flows remain unverified.
- The current fork uses its shipped bootstrap/controller/runtime paths, with unchanged hash-verified upstream assets. Atlas integration hooks live in `runtime/host.ts` and `runtime/page-bridge.ts`; no global string rewriting of upstream code.
- Production egress rejects internal IP ranges, metadata, local/private/IPv6-mapped addresses, app hostnames and ports other than 80/443. Test allowance is limited to 127.0.0.1:4199 and exists only in the test runner.
- Stable frames survive theme/layout changes and navigation to settings. No automatic tab suspension is implemented.

## Known outstanding work

- Real Chromebook and authenticated Google/ChatGPT/Spotify qualification.
- Authenticated popup return/opener parity, expiry, worker updates, and multi-window storage partition behavior.
- The shared upstream download-attribute failure described above.
- Per-site storage deletion UI (current UI supports whole-runtime website data clear).
- Long-duration performance/load testing and production deployment verification.
- One-time setup/TOTP/recovery API tests exist; public deployment and secure-cookie behavior need HTTPS testing.
- No attachment upload for support; plain-text conversations only.
- Settings export contains preferences only, never website sessions or ticket access tokens.

## Startup regression found and corrected

The initial direct-factory test harness missed a launcher bug: `server/index.mjs` passed the frontend `staticDir` to `createRuntime`. The running preview consequently served frontend HTML on port 4181 and returned 404 for controller assets. A real-entrypoint probe reproduces `RUNTIME_DOCUMENT=FRONTEND; CONTROLLER_HTTP=404` before the correction, and `RUNTIME_DOCUMENT=RUNTIME; CONTROLLER_HTTP=200` afterward. The browser suite now exercises the actual launcher. Its new coverage includes a dropped-ready handshake, compact/focus layouts and native AI workflows.

Native AI tests use a local fixture, not a real language model. Both Responses and Chat Completions adapters have been exercised across test runs. A provider/model/key must be configured by the administrator before live AI chat is available. See `docs/AI.md`.

## New-tab refinement — 2026-09-11

The new tab restores large serif typography and an unobstructed theme background while removing the outer panel border and duplicate browser toolbar. The sidebar defaults to a 44px icon rail and remembers expansion; accessible names and icon tooltips remain available. Ctrl/Cmd+K focuses the new-tab search. Browser navigation, AI, support, settings and proxy engines are unchanged.

Latest automated suite: 8 backend passes, 22 browser passes, 2 tracked upstream download failures, 0 unexpected failures. New coverage checks compact/expanded rail persistence, border removal, keyboard focus, returning to an existing website frame, appearance customization, light mode, reduced-motion layout and 1366×768/390×844/360×640 viewport bounds. These are desktop Chrome viewport tests, not physical Chromebook testing. Evidence: `evidence/newtab/check.log`, `evidence/newtab/VERIFICATION.txt`.

### Thin-border follow-up

The current new tab uses 1px theme-aware outlines on the main panel, tab rail, navigation and shortcuts; the main panel/search/shortcut corners are 12px. The 44px default rail, 80px desktop greeting, 52px shortcuts, transparent background and absence of a duplicate home toolbar are retained. The new-tab test now checks these thin borders and unchanged control dimensions. Evidence: `evidence/newtab-borders/check.log` and `evidence/newtab-borders/VERIFICATION.txt`.

## Scramjet-only navigation follow-up — 2026-09-12

The interface, setup wizard, settings, owner configuration and saved-tab migration now select Scramjet only. The connection dropdown reports the engine and pinned node, with an explicit reconnect action. Removed-engine packages, workers, routes and vendor assets are no longer shipped; migration retires the old worker without deleting website cookies.

The top navigation is centered at desktop and mobile widths. The address bar exposes existing autocomplete and selects its current URL on Cmd+K (Apple) or Ctrl+K (Windows/ChromeOS/Linux), including focus from nested website frames. Popup tabs share the existing runtime and pinned node; opening a popup does not reconnect or change the browsing IP.

Controlled tests cover native Enter GET submission, Google-shaped textarea Enter handling (including Shift/IME/default-prevented cases), nested callback POST/303 plus HttpOnly cookie retention, popup POST and multipart/submitter overrides. The textarea fixture is mocked, not a real Google search or solved CAPTCHA. A live logged-out Google probe separately reached Google's challenge page after Enter. No challenge was solved; real post-CAPTCHA return and authenticated Google/ChatGPT/Spotify success remain unverified. Evidence and test totals are recorded in `evidence/google-navigation/VERIFICATION.txt`.
