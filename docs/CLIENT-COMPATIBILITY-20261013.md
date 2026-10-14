# Client compatibility release — 2026-10-13

## Changes and measured limits

The upstream modified-fork HEAD was verified as `4f452feec4d6804730b903294d0f9bec8002a635`, identical to Atlas's starting pin. Development used an isolated worktree. The new local fork pin is recorded in `scripts/runtime-fork.json`; its delta bundle enables a fresh clone to fetch this unpublished commit. Local packaging and GitHub pushes remain separate from deployment. The goal follow-up staged a VPS 4 canary image without restarting its live service; the current qualification state is recorded in the follow-up verification report.

- Bootstrap and relay loaders remove only their own completed script elements, on success and error. Functional runtime globals/interfaces remain intact.
- Internal frontend engine labels use `runtime`; saved legacy labels normalize on import. The old cookie migrator loads only when an older controller database exists. The necessary legacy name remains in that migration chunk, rather than the normal startup bundle.
- Native prefix import-map addresses now end with a literal slash. A dedicated module route retains the module flag and initiator-origin metadata while the browser appends a suffix. Static and dynamic bare-specifier imports are exercised through the actual runtime. This fixes the supplied trailing-slash error, not every import-map/scopes combination. The [HTML Standard](https://html.spec.whatwg.org/multipage/webappapis.html#import-maps) requires matching trailing slashes.
- Startup messages wait for the runtime iframe's load, and compatibility configuration waits for its validated ready state. Source/origin checks remain in place.
- The build packages matching WASM/glue and validates all 20 imports. The Rust named-export visitor now traverses exported declarations, including Rspack module factories; the rebuilt WASM routes their dynamic imports and virtual globals. HTTP transport, controller and helper binaries are unchanged; no transport/IP/routing changes were made.

### Metadata controls

**Page compatibility → Adjust site metadata for this origin** defaults off. Reviewed host rules cover exact `poki.com`, `crazygames.com`, `coolmathgames.com`, and `y8.com` hosts and their `www` forms. Preferences are keyed to the exact scheme/hostname/port origin; subdomains do not inherit them. The rule changes only titles and nonessential description/OG/Twitter metadata. Atlas keeps the original title in its own tab/address interface.

**Restore page defaults** restores tracked values without reloading or changing the node/session. Dynamic values are retained, parser completion is respected, and nested documents have independent policies. Guards retain at most 16 documents per browsing tab; head scans, text-risk samples, and mutation batches are bounded and disposed on document removal.

The deduplicated notice reads **“Compatibility adjustments applied.”** Details include restore controls and remaining content risk. Fullscreen queues the notice until exit. Same-frontend popouts share exact-origin preferences; direct-node tabs use that origin's separate local preferences/storage.

The risk flag is a bounded game-content/canvas heuristic, **not an installed-filter classifier verdict**. Gameplay text, visible instructions, scripts, controls, canvas, cookies, authentication, and DRM are not altered by these metadata rules. These metadata rules do not change sandbox or CSP. The renderer-specific adaptation described below retains its opaque sandbox and adds only an exact hash for an originally authorized module; inherited engine behavior is not a new browser-security certification.

### Local diagnostics

Diagnostics are opt-in, local-only, capped at 128 events and five minutes. Export contains origin/category, method/status, cookie-header counts, document/navigation events, controller context, current worker state, and the loaded runtime source revision. That revision identifies the runtime bundle, not an independently retrieved worker-script hash. It contains no query strings, path contents, bearer tickets, credentials, page text, screenshots, or response bodies. Counts of Set-Cookie headers are observations, not a full cookie-processing verdict.

```sh
node scripts/fingerprint-audit.mjs evidence/client-compatibility-20261013/modified-audit.json
node scripts/analyze-compatibility-har.mjs INPUT.har OUTPUT.json
```

HAR analysis reads the original locally and writes allowlisted counts only; do not publish the authenticated HAR. A reusable investigation prompt:

> Compare navigation, document, worker-state, response-status and cookie-count sequences on one unchanged frontend/node. Separate retrieval, authentication, frame lifecycle and rendering failures. Propose a client patch only for a reproduced defect, with a regression fixture and rollback. Do not include credentials, query values or page contents in reports.

## Fingerprint audit

All 345 supplied expressions compile and receive an individual result in the JSON audit. Surface matches are not 345 independent blocking decisions. The harness separates engine names, ordinary utility matches, contextual heuristics and destination-content matches; extension image/canvas classification remains an untested separate surface.

Baseline and final build results are reported in `evidence/client-compatibility-20261013/VERIFICATION.txt`. The old `scramjet.*.wasm` runtime match disappears; the plain `scramjet` match remains only in the lazy legacy-cookie migration chunk. Broad utilities and genuine content matches remain. No installed-device classifier improvement is claimed: the reference snapshot is version `1.3.8.1788379673`, and the currently installed version was not qualified. Static regex absence is not live protection.

## ChatGPT evidence

The local-only HAR summary has 2,117 requests, two HTTP-200 SSE conversation responses with assistant envelopes/append events and completion markers, and five HTTP-503 response-renderer iframe requests. Those renderer requests have no service-worker timing. Their 65-byte response shape matches Atlas's uncontrolled-worker message; the user separately confirmed the exact text: **“Proxy worker is not controlling this page. Return home and retry.”**

The defect is reproduced in a native opaque-origin sandbox: Chromium does not give that child service-worker control. This is consistent with the [Service Worker client model](https://w3c.github.io/ServiceWorker/v1/). The baseline fixture never reaches ready; the modified fixture does.

The targeted v14 adapter loads the original document and its self-contained module through the same assigned controller/node and executes them in native `srcdoc`, retaining `sandbox="allow-scripts"` and the original restrictive CSP. Each inlined module receives an exact SHA-256 authorization only when its original URI was permitted. Original CORS rules and anonymous module credentials are checked. Unknown versions, dependent module graphs and unqualified integrity attributes retain the ordinary path and report an error. Broad script permissions, challenge deletion, native origin spoofing and transport/IP changes are not introduced.

Native message origins and explicitly transferred ports now remain native for this reviewed renderer; virtual-site messages still use the engine envelope. A local regression checks worker startup, null-origin ready, two-way transferred-channel data, denied parent-document/storage access, blocked unauthorized scripts, both iframe setup orders and navigation cleanup. The current logged-out public OpenAI v14 module also emits its original ready port. The operator subsequently reported **“Works!”** after reloading the updated Node 4 and checking the loop, icons and visible reply together. The operator then separately confirmed fresh sign-out/sign-in and a visible streaming reply with no blank screen or refresh loop.

Explicit `fetch` omit/same-origin credentials now govern outgoing Cookie and incoming Set-Cookie processing. String-URL and Request-object omit/include overrides now pass, including body/header retention, used-body promise rejection and single-read RequestInit getter conversion. Separate `No frame found`, controller-page URL restoration and challenge-endpoint errors remain symptoms to investigate if they recur after the renderer canary. No authenticated HAR/session credentials are reused.

To reproduce the optional public-module test without authenticated state:

```sh
node scripts/prepare-public-renderer-fixture.mjs
pnpm build
ATLAS_TEST_PUBLIC_RENDERER=1 pnpm exec playwright test tests/compatibility-routing.spec.ts
```

### Dynamic surface qualification

`tests/dynamic-fingerprint.spec.ts` scans all 345 patterns against actual document text, DOM attributes, global names, a native constructor name, inline scripts and resource paths in three fixture snapshots: default-off, opt-in plus SPA/nested-frame updates, and site-owned negative controls. All 345 scans complete in each snapshot. The default/off and SPA snapshots have no engine-signature matches; 30/31 broader expressions still match. Adding a deliberate site-owned `$scramjet` attribute produces three engine-pattern matches, and the attribute remains unchanged. Typed-array utility matches remain positive. Counts and offsets, not captured page contents, are saved in `evidence/goal-compatibility-20261013/dynamic-audit.json`.

These results neither reproduce the installed classifier nor qualify canvas/image classification. Genuine game instructions and gameplay remain visible. The reference extension snapshot is separate from authenticated-site compatibility testing.

## ESPN / ESPN+

Logged-out HTTP probes on the same existing VPSes found:

| Origin egress | ESPN homepage | Evidence                       |
| ------------- | ------------- | ------------------------------ |
| Node 2        | HTTP 202      | `x-amzn-waf-action: challenge` |
| Node 3        | HTTP 202      | `x-amzn-waf-action: challenge` |
| Node 4        | HTTP 200      | Homepage retrieval only        |
| Local Mac     | HTTP 200      | Homepage retrieval only        |

All three logged-out ChatGPT probes returned HTTP 403; this is not an authenticated-session test. No routing/IP/transport changes were applied. The initial logged-out HTTP probes did not qualify ESPN login or playback. Subsequent active-frame browser observations cover homepage links, visible article paragraphs and NBA scoreboard elements. On the updated Node 4 canary, the operator confirmed normal ESPN sign-in and entitled ESPN+ video/audio continuing for at least 30 seconds. This acceptance is specific to that canary and account; subscription/DRM checks remain unchanged.

## Build, canary and rollback

```sh
pnpm install --frozen-lockfile
pnpm runtime:fetch
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

For a deterministic JS-only fork rebuild, run inside the pinned fork:

```sh
pnpm install --frozen-lockfile
node scripts/build-atlas-client.mjs
node --test tests/bootstrap-cleanup.test.mjs tests/wasm-glue-match.test.mjs tests/wasm-export-rewrite.test.mjs
```

The helper uses its recorded epoch/parent source revision and the committed matching WASM/glue. Rust changes use `node scripts/build-atlas-wasm.mjs` first (debug-mode wasm-bindgen glue, then equal-length binary symbol replacements). The release verifier checks resulting hashes. See `docs/UPDATE-BROWSING-CONTROLS.md` for a single drained-node canary, remaining nodes including VPS 4, Main last, preserved deployment files and rollback. Do not treat local tests or a homepage status as authenticated-site acceptance.

### New Node 4 canary feedback: reload loop and icons

The operator observed root-path module 404s followed by ChatGPT’s explicit route-loader reload message. DevTools changes the symptom; viewport/timing causality is not yet established. A public ChatGPT Rspack bundle reproduced the exact named-export rewriter omission: its exported factory object was left unmodified. The Rust visitor fix rewrites all six executable computed dynamic imports in that captured public bundle; the remaining import text is inside a generated-script string, not an executable import expression. Its rewritten output passes native syntax checking. A real browser regression loads computed imports from an exported Rspack factory, ordinary classic/module scripts, a Function constructor and an inserted script.

The versioned URL codec also encoded native SVG symbol IDs. An actual external-symbol fixture rendered zero-width icons before correction. SVG/CSS resource routes now retain literal fragment IDs with explicit reversible route metadata; navigation’s normal fragment encoding remains unchanged. Parsed, attribute-set, property-set, namespaced and local-symbol paths are tested separately. The operator subsequently confirmed the combined real-session check on Node 4 works.

The supplied renderer CSP violation is investigated separately. The public renderer currently includes an additional Cloudflare-injected inline script which its own original policy does not authorize. The adapter retains that denial; it does not add arbitrary hashes or unsafe-inline. The approved bootstrap hash remains unchanged, and the public renderer still emits its native ready port in the local test. The exact blocked script bytes from the operator’s session were not captured, so identity with that additional public script is not asserted.

Node 4 was activated after the operator authorized a forced application-service restart; health and eight public asset hashes matched, with pairing, deployment files and the edge unchanged. The second canary addresses that feedback, and the operator confirmed the combined ChatGPT test works. At the canary stage, Nodes 2/3 and Main remained untouched. The operator has now confirmed fresh ChatGPT sign-out/sign-in with a visible streaming reply and ESPN sign-in with entitled ESPN+ video/audio. The owner/admin current-client selector has subsequently been implemented and verified before the final release rollout; live deployment receipts are kept separately from these site-test observations.

### Additional operator report: Coolmath category

The operator reports that Coolmath is flagged after page loading begins and that the filter’s displayed category is **Games**. This is separate from the now-confirmed ChatGPT rendering result. Loaded-page text/metadata and image/canvas classification are candidate inputs; the timing and category alone do not identify the exact classifier rule or exclude deferred URL classification. Metadata adjustments default off and are not an installed-filter qualification. At the initial report stage, Main still predated the new compatibility panel. Fleet deployment and GitHub publication receipts are recorded separately from these classifier observations. The live count/offset audit is kept separately in `evidence/goal-client-paths-20261013/coolmath-live-audit.json`.

A bounded read-only real Node 4 browser probe observes the public ESPN home, an article with 12 visible paragraphs, and the active NBA scoreboard document with scoreboard elements. A public clip page loads but contains no native playing video in that snapshot. This is rendering evidence, not a playback, sign-in or ESPN+ entitlement verdict. The earlier multi-frame diagnostic included inactive pages and is not the scoreboard acceptance measurement.

### Source-grounded Games classification investigation

The supplied repository was pinned at `a8f1087bbcecda67d919137ee4b9d5a0107ca886`. Its two CRXs are byte-identical Filter Helper snapshots, also matching the previously inspected local snapshot. The game detector sums weighted grid, game-title, navigation and corroborating signals, with final sensitivity thresholds 47/59/68. An isolated public-page reproduction scored Coolmath 78 (grid 40, titles 18, navigation 20), unchanged when only the input URL/hostname became neutral. Fifteen original-versus-normalized source/threshold/message tests pass. The helper forwards a game detection report to a separate main filter extension whose enforcement/category source is absent. This identifies the reference detector, not the installed device's final blocking branch; Coolmath is not claimed unblocked. The read-only report is `evidence/lightspeed-mechanism-20261013/REPORT.txt`.
