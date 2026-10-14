# Reference-filter rewriting investigation — 2026-10-13

## Measured results, not universal invisibility

The supplied CSV is byte-identical to the existing 345-expression inventory.
The attached audit is reference material, not execution instructions. Its regex
inventory is not equivalent to the helper's complete classification decision.

The pinned helper's complete `DetectionOrchestrator.scanPage` was extracted into
a local analysis fixture without running the extension entrypoint or contacting
the main filter extension. On public Coolmath with site JavaScript disabled,
the native Games score was 78; moving the body into a closed rendering tree
reduced it to 0 in both native and Chrome isolated-world collector views.
That experiment alone does not establish live website functionality.

A separate **actual proxied browser fixture** exercises the new RuntimeKit
client-layer implementation. Its Games score changes **68 → 0 → 68** for
normal, enabled, and restored document views. The site still reads its original
873 characters, original IDs/data-title values and a 120-pixel CSS width. A real
mouse click updates the game and reaches its document-delegated handler. A real
POST retains the exact query, header and JSON body, including `coolmathgames`,
`Run 3`, `#game-grid` and `game-card`. Proxy confidence was already zero in this
fixture; this is not evidence of a newly fixed proxy detection.

The fixture also retains a child iframe's JavaScript marker through enable/restore, plus named `window.move`, NodeList `.item()` and a live HTMLCollection.

Saved preferences also pass first-DOM-ready checks in embedded, nested,
same-frontend popout and direct-node documents. The native body is empty at that
check; website code still sees its original 873 characters and runs its inline
controls. Each context's subsequent isolated-world Games score is zero. The
direct-node Restore action returns the score to 68.

A fresh, unauthenticated **public Coolmath through the actual local Atlas proxy,
with JavaScript enabled**, produces Games **78 → 0 → 90** in the latest run.
The page's scripts still see 11,942 characters and 314 links while enabled.
An earlier run starts at 78 before additional page content arrives. These are
DOM-rendering observations, not a complete gameplay or account qualification.

The first body-only prototype exposed a site `masqueradeRuntime` subscore of
35: canonical/OG URL nodes remained in the native head after native content
richness disappeared. The refined implementation moves those original URL-only
metadata nodes into the rendering tree, preserving their values and tested
head APIs. The latest public site's **Games score and proxy confidence are both
zero**, without changing the metadata preference or API parameters.

The wrapper and runtime still have `basic` confidence **31 and 25**, respectively;
their final proxy verdicts remain false. Some subdetectors mark themselves
detected even when the final orchestrator does not. This is not zero-fingerprint
rewriting across every surface, and a different effective configuration or main
extension policy can still classify the session.

The local fixture's sampling URL is a neutral external URL because the helper
excludes local test hosts. It is not an installed-device verdict. The separate
main extension's category database/enforcement source is absent. Cached Games
verdicts, network policy and changed agent versions remain independent inputs.
The implementation remains opt-in and experimental. Deployment/push receipts
and the checked live bundle hashes are recorded in the verification artifacts.

The complete regression suite reports 137 genuine browser passes, two known
upstream download expected failures and zero unexpected failures; all 248 unit
tests and TypeScript/build checks pass. The initial full run caught an outdated
keyboard-navigation assertion after Page options was inserted into Connection;
the corrected contract now explicitly checks that item before the direct link.

The 2026-10-14 refinement also reproduces and fixes two compatibility regressions:
URL metadata escaped native isolation, and an already-fired `once` handler was
resurrected during movement. The new checks verify canonical/OG node identity,
unchanged href/content, head parent/children/selectors, replacement/removal and
restoration. Delegation now retains `currentTarget`, the callback receiver,
listener objects, `once` and abort behavior across repeated enable/restore.
[MDN listener semantics](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener)

## Chosen approach

`runtime/document-surface.ts` installs document-owned rendering-tree handling
through RuntimeKit's main-world `Proxy` and `Trap` APIs. It does **not** rename
website variables, rewrite visible text into different words, or change API
parameter names. Original nodes and strings remain available to website code;
ordinary native document traversal sees the outer document instead.

The independent `atlas.document-surface.v1` preference is exact-origin and
default-off. It does not silently turn an existing metadata preference into
structural rewriting. Document cleanup restores the original nodes. The runtime
bridge applies the preference independently to its managed child documents.
Page controls have been moved under Connection in the normal and popout shells.

This exploits a traversal limitation of the supplied helper, not a browser
security boundary. Chrome's extension API can retrieve even a closed shadow
root. A scanner using that API or another privileged inspection path could see
this content. [Chrome DOM extension API](https://developer.chrome.com/docs/extensions/mv2/reference/dom)

## Why simple replacement breaks sites

- **JavaScript scope:** a declaration must be renamed with every bound reference,
  without changing shadowed variables, strings, imports/exports or reflection.
  Property keys, JSON fields and endpoint parameter names are often external
  contracts, not local identifiers. `eval`, generated functions and late-loaded
  modules make a global replacement map particularly fragile.
- **DOM/CSS coupling:** an ID/class can occur in HTML, CSS, selectors, ARIA
  references, URL fragments, SVG symbol links and runtime-generated strings.
  Updating only one representation breaks styling, event binding or navigation.
- **SSR/hydration:** changing text or structure before hydration can cause a
  framework mismatch and reload behavior. Repeated mutation fixes can race the
  framework or consume excessive CPU.
- **Outbound data:** translating request parameter names or values can break
  signed URLs, authentication, analytics and API schemas. The current prototype
  leaves these bytes unchanged rather than trying to compensate afterward.

## Remaining compatibility risks of rendering-tree isolation

Shadow boundaries change native traversal, CSS scope, event retargeting,
selection and legacy named-element behavior. The prototype bridges body access,
selectors, collection methods, named elements and document-delegated events,
but not every native API or framework has been qualified. Parent/child invariants, native fragment navigation and mutation-observer targets also need dedicated coverage. CSSOM `insertRule`
and adopted stylesheets need separate validation beyond mirrored style/link
nodes. Window-level capture handlers can observe retargeted events. Accessibility
and browser-native tooling follow different traversal paths.
The specified listener contracts now pass dedicated tests; complete propagation
ordering, custom event types, selection and CSSOM behavior still need broader
framework qualification before an automatic all-sites rollout.

Ordinary DOM reparenting can reload iframes and reset media/focus. The implementation
uses state-preserving `moveBefore` when available; nested-frame state and older
browser behavior require explicit regression tests. [MDN moveBefore](https://developer.mozilla.org/docs/Web/API/Element/moveBefore)

The helper runs in an isolated world by default, so patching page JavaScript
getters alone does not change its native DOM view. The distinction is tested with
Chrome isolated contexts, rather than pretending a main-world getter override
hides the shared DOM. [Chrome content-script isolation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

## Reproduce the optional reference classifier checks

Provide the original pinned helper `content.js`, then run:

```sh
node scripts/prepare-filter-reference-fixture.mjs /path/to/content.js
pnpm build
pnpm exec playwright test tests/document-surface.spec.ts
```

The preparation script verifies SHA-256 before normalizing lookups and extracts only the detector factories. Atlas does not ship the helper or execute its extension entrypoint. Without that local fixture, the mechanical DOM/API checks still run, but no classifier qualification is recorded.
