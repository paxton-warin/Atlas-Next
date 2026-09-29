# Compatibility acceptance register

Target: Chrome on an actual Chromebook. Desktop Chrome is the development harness, not Chromebook certification.

## Fullscreen games and minimized mode — 2026-09-14

Minimized/focus mode hides both horizontal and sidebar tabs while keeping the URL bar and **Exit focus mode** button. Escape dismisses Atlas menus/dialogs, but no longer exits focus mode.

When a website inside the browsing runtime enters native fullscreen, the top-level Atlas page requests `navigator.keyboard.lock(["Escape"])`. Short Escape presses remain available to the focused game; other browser shortcuts are not captured by Atlas. Exiting fullscreen releases the lock. Atlas does not simulate key events, repeatedly force fullscreen, or modify the pinned runtime assets. In Chrome, hold Escape for about two seconds to use the browser's fullscreen escape hatch; the game's own exit-fullscreen control also works. [Chrome Keyboard Lock documentation](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock).

This applies to a website's **Fullscreen API** mode, not browser-window fullscreen entered with F11 or an OS shortcut. Browser support and browser/site policy still determine whether the lock succeeds; unsupported or rejected requests leave native fullscreen available and report that Escape may exit it. A panic shortcut explicitly configured to Escape still takes priority. Physical Chromebook input, long-hold Escape, and an authenticated GeForce NOW game require a deployed manual check; a loopback fixture is not that qualification.

The **Pop out tab** button beside Focus mode (also available under **Connection → Open in new browser tab**) opens the current website in the assigned runtime's standalone page, using the existing node ticket and egress assignment. It does not allocate a new node or close the original Atlas tab. The destination and ticket are carried in the URL fragment, not an HTTP query string; treat the link as private and session-limited. The direct tab has its own address bar, reload/back controls and Return to Atlas link, and uses the same fullscreen Escape handling. When Main supplies egress through a paired runtime node, this retains Main's relay rather than silently changing IP.

Opening directly loads a new page; it does not move a running game or copy unsaved page state. Browser storage partitioning can separate a top-level node tab's website cookies/storage from those of the embedded runtime, so signing in again may be necessary. Session expiry asks the user to return to Atlas and reconnect; an expired ticket is never silently replaced. Deploy the updated runtime bundle to attached nodes as well as the updated frontend on Main.

## YouTube ad blocker — 2026-09-14

**Setup wizard → Browser** and **Settings → Browser → Search & browsing** share the **YouTube ad blocker** switch. It defaults to on for new and existing settings; an explicit opt-out persists across reload, settings export/import, and Atlas's Pop out tab action. Reload existing YouTube tabs after changing it. Popped-out tabs retain the preference they launched with; reopen them from Atlas to pick up later changes.

The Atlas runtime plugin removes known player ad arrays from initial player data and recognized JSON player responses, hides narrow ad-only card elements, and intercepts ad-only requests initiated by YouTube. Normal video stream hosts, player data, captions, account/sign-in endpoints, and unrelated websites are not blanket-blocked. Malformed, unfamiliar, oversized, or slow JSON responses pass through unchanged. The player ad-field selection is informed by the maintained [uAssets YouTube filters](https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters.txt); Atlas implements its own bounded runtime hooks rather than loading remote scripts or modifying the pinned engine.

The video-ad follow-up also filters direct player-response entries in array-shaped watch responses and JSON-only `get_watch`, `watch`, and `playlist` routes. Initial player globals retain their object identity and suppress later writes to known ad arrays, including writes through references held by page scripts. It does not replace `JSON.parse`, rewrite arbitrary HTML, or block all video-CDN requests.

A YouTube-only player observer clicks visible, enabled official Skip ad controls inside a player explicitly marked as showing an ad, including controls/player elements replaced during navigation. For the separately identified `SSAP, AD` diagnostic, it can complete a finite short ad through the player's own progress/seek API; a normal-video diagnostic does not trigger seeking. The observer does not write a media element's currentTime, rate, volume or mute state, and suspends on pagehide. Unknown player states pass through rather than guessing from video duration alone. The recognized server-ad diagnostic is also used by [maintained uAssets quick fixes](https://github.com/uBlockOrigin/uAssets/blob/86cfbcf0112f6685d0bcc8a35578e6ea0a1f7101/filters/quick-fixes.txt).

This is targeted filtering, not a full browser-extension filter engine or SponsorBlock. Server-stitched ads and future YouTube changes may still show ads. Real YouTube playback/ad delivery has not been qualified by the local fixtures. Disable the switch and reload if a YouTube rollout causes playback trouble.

Build and deploy both Main's frontend and each browsing node's runtime for this change. Updating Main alone does not update runtime JavaScript hosted by the other VPSs. No new server environment variable, public endpoint, subscription, or API key is required.

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

## Frontend relay and AI math — 2026-09-13

CloudFront mode supports a split Main assignment: the current frontend origin carries its authenticated relay WebSocket; an updated paired node hosts the isolated website frame/static runtime. Node 2/3 assignments retain direct egress. Main/API/owner anti-framing headers remain unchanged. The lease pins both egress and frame host, rejects wrong-purpose tickets, and requires explicit reconnect if either becomes unavailable.

Controlled Chrome tests exercise a real Scramjet-rewritten fixture over this split route, POST/fetch, WebSocket echo, cookie continuity after reload/reopening a tab, and no host-node relay socket. Backend fixtures exercise multiple frontend aliases, balanced allocation, revocation, and draining/disabled frame hosts. A real local Caddy probe checks origin-key rejection, frontend/API routing and relay upgrades. Docker image deployment, public AWS configuration, authenticated websites and VPS throughput still need deployment verification.

AI tests cover inline/display LaTeX, local KaTeX font loading, narrow-screen bounds and blocked trusted commands. Delimiter unit tests preserve Markdown code and incomplete streamed input. See [existing deployment update commands](UPDATE-FRONTEND-RELAY.md).

## Session restoration and runtime compatibility — 2026-09-28

### Fresh launch versus active browsing

A fresh Atlas launch first resumes the saved node lease. If the server reports that the saved lease has expired (HTTP 409), Atlas requests a replacement once, saves it, and then restores the website tabs without a reconnect dialog. A valid lease remains pinned. Network errors, unavailable nodes and rate limits do not trigger automatic reassignment. Concurrent startup on the same frontend origin is serialized where Web Locks are available.

An already-open browsing session still asks before reconnecting after expiry or revocation: it must not silently change the browsing IP. A fresh replacement may use a different node, and website cookies/storage remain tied to that runtime origin. Restoring saved URLs does not migrate website logins between nodes. Reconnecting a tab releases its own active lease, not a different lease recently written to storage by another tab.

### Cookies, streaming and cold-load changes

The pinned upstream HTTP cache rebuilt responses through the browser's native `Response`, which removes raw `Set-Cookie` headers. A Chrome probe reproduced lost authentication cookies, cached dynamic session responses and delayed stream delivery. Atlas now leaves the original network response intact and caches only bounded, explicitly public static assets. Documents, authentication, redirects, APIs, streams, media, credentialed requests and responses setting cookies bypass that cache.

Node DNS resolution now coalesces concurrent lookups, briefly reuses validated addresses, bounds pending work and passes those same addresses to the socket. Private-address rejection remains intact. Runtime builds also generate lossless Brotli/gzip variants and preload independent startup scripts without changing their execution order. The eight pinned assets total 3,328,429 bytes uncompressed versus 1,032,915 bytes with Brotli (69.0% smaller); this is an asset-size measurement, not a measured production latency improvement. The first uncached DNS lookup and remote-site response time still apply.

### Popouts and destination labels

The outer popout tab is titled **Atlas**. New rewritten destination paths and popout fragments use a versioned URL-safe encoding; existing escaped paths and `#goto` links remain readable. The actual destination remains visible in Atlas's address field. This is not encryption or a claim of invisibility to extensions: page content and upstream initiator/referrer metadata can still contain destination names. Blind replacement of those fields would break origin, cookie and navigation behavior. The reported classifier is investigated below; its blocking behavior has not been verified as resolved.

### Live results and update order

On the supplied public frontend, ESPN returned an upstream CDN HTTP 403 through two assigned nodes. Instrumentation observed that 403 before rewriting, while a direct Mac control returned 200. This remains unresolved; the evidence does not establish whether the rejection depends on egress reputation, request characteristics or another CDN rule. Anonymous ChatGPT reached a challenge page; authenticated ChatGPT sign-in was not exercised. The local cookie fix is not certification of either site's live login/playback flow.

Update **both browsing nodes first, then Main** so the runtimes understand the new popout fragment before the frontend generates it. Use the [routine update guide](UPDATE-BROWSING-CONTROLS.md), preserving existing Caddy/Compose overrides, pairing and data volumes. No CloudFront, origin-key, database or routing migration is required. Reload Atlas after the services are updated. Local verification and rollback evidence are in `evidence/compatibility-20260928/VERIFICATION.txt`; these changes have not been deployed by the local tests.

### Follow-up: navigation, popouts and real browser storage

Two additional integration defects were reproduced and corrected:

- In a standalone popout, closing an internal sign-in window left its opener hidden. The opener is now restored with its draft, address and message callback intact. Back, Reload and address entry operate on the visible child instead of the hidden root frame. Embedded Atlas tab handling is unchanged.
- The pinned engine added an `Origin` header to ordinary GET document navigation, unlike native Chrome. A narrowly scoped Atlas plugin removes that extra header for GET/HEAD navigation only. POST, CORS fetches, WebSocket requests, cookies and referrers are left intact. Native-versus-proxied GET/POST fixtures verify the behavior against the [Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header). This is not a general removal of origin checks.

**A node lease is not a website-storage session.** Normal Chrome partitions a cross-site iframe's IndexedDB/localStorage by its top-level site. Atlas's virtual website cookies live in the runtime's IndexedDB. Consequently, a direct-node popout and the embedded runtime can have different website logins even with the same node/IP/ticket; a different frontend CloudFront alias can also create a different partition. Synthetic HTTPS CloudFront fixtures reproduced this separation without accessing real accounts. Same-site subdomain controls shared the expected partition.

The toolbar's **Pop out tab** now opens `/popout` on the exact frontend origin the visitor is using. This thin shell embeds the same isolated runtime and resumes the specific existing lease, keeping the top-level storage partition stable. It has compact address/navigation controls and no sidebar or setup wizard. Opening it does not overwrite the original tab list or allocate a different node. Expired/missing leases show a return-to-Atlas action rather than silently switching IPs. Session handoffs remain in the URL fragment, not HTTP query strings; the API supplies the runtime origin and transport ticket, not a caller-controlled URL.

**Connection → Open direct node tab** retains the previous behavior as a separate option. The thin wrapper also exposes this option, with a sign-in/storage caveat. A direct node tab still changes the top-level site and may require a separate login. Keeping the partition does not guarantee all provider logins work or synchronize arbitrary in-memory page state; the original page and its unsent draft are retained separately.

Playwright 1.63 disables `ThirdPartyStoragePartitioning` in its default launch arguments. The follow-up probe removes only that override and compares both modes; the wrapper regression also enables native partitioning explicitly. Ordinary suite passes alone must not be interpreted as proof of production cross-context login continuity. No website credentials were transferred between partitions. This explains context-switching sign-in differences, not a verified explanation of ChatGPT or Twitter/X refreshing within one unchanged context. Real authenticated ChatGPT and Twitter/X journeys remain untested.

**ESPN:** an identical ordinary Node TLS/HTTP request returned 200 directly from the Mac and 403 through Node 3's authenticated relay. The control website returned 200 through both paths. The relay test does not execute Scramjet's page rewriting. The remaining rejection therefore involves the node-side destination/network path; its precise CDN rule is unknown. Atlas does not silently change a session's IP on HTTP 403.

**Classifier findings:** the user-supplied [extension snapshot](https://github.com/garrett-warin/hi-im-a-cat-and-i-love-lightspeed/tree/a8f1087bbcecda67d919137ee4b9d5a0107ca886) declares all-frame content scripts and examines DOM text, script/resource URLs and page structure. Top-level and subframe scoring/attribution differ, and positive verdicts can be cached. Generic paths/titles are not a verified fix for its content-based classification. The snapshot's version, installed policy and external block duration have not been matched to the affected device. No extension code was installed/executed, no filtering services were contacted, and the engine's origin/referrer metadata was not blindly removed.

Follow-up evidence: `evidence/compatibility-followup-20260928/VERIFICATION.txt`, `espn-transport.json`, `storage-partition.json`, and `detector-findings.md`.
