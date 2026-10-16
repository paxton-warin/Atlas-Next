# Combined frontend-frame update — held candidate

This describes the **unreleased combined update**, not the currently deployed
legacy runtime. Implementation, public-site qualification, and fleet rollout are
distinct. The current evidence register is
`evidence/combined-update-20261015/RELEASE_READINESS.json`.

The user explicitly deferred further Discord work and requested the complete
current source change set be pushed on 2026-10-16. A source push does not change
the production activation setting or certify the deferred Discord journey.

## Frame hostname and traffic-node pinning

- Embedded website documents and popout wrappers use the frontend origin the
  visitor actually opened. Trusted runtime assets use that origin too.
- Website documents receive response-header and iframe sandboxing **without
  `allow-same-origin`**. Matching URL hostnames do not grant website scripts the
  frontend's security origin, DOM, browser storage, APIs, or administrator session.
  Direct visits receive the restrictive response headers as well.
- The trusted controller chooses and retains one traffic assignment. Remote-node
  payloads use that node's CloudFront WebSocket endpoint directly; Main does not
  forward their website bodies. Main can itself be the selected traffic node.
- The approved browser-native HTTPS resource exception uses **the same selected
  node**, not a separately randomized resource/frame host. Original CSP, CORS,
  resource purpose, document binding, and credential rules still apply. There is
  no direct-IP browser connection or new globally required browsing hostname.
- Temporary transport failures retain the assignment. An explicit successful
  replacement precedes release of the old connection; node changes are not
  automatic error recovery.

## Storage and document authority

The separate frontend-owned `atlas.browsing.v2` database contains fresh website
data keyed by logical website origin. Node, lease, frame, and renewal identifiers
do not choose a site's namespace. Website code never receives the trusted DB,
relay credentials, or unrestricted frontend networking capability. Document-bound
MessagePorts carry the narrow broker operations.

localStorage reads are prehydrated; ordered writes have persistence acknowledgements.
IndexedDB uses broker-owned native transactions with request/event ordering,
commit acknowledgement, liveness, and abort handling. Finite immediate whole-shell
reload, concurrent-tab, quota-failure, callback-chain, cursor, upgrade, abort,
blob, and committed-data-reload tests are required—not a claim that an asynchronous
mirror is universally native-equivalent.

Cache Storage has a separate fresh `atlas.browsing.cache.v2` database, also
fixed to the logical website origin. Native frontend IDB commits precede success
acknowledgements. Finite Cache API tests cover concurrent windows, whole-frontend
reload after commit, atomic batches, quotas, body disturbance, request matching,
and response clone taint. Opaque/opaqueredirect response caching explicitly fails
until protected payload handles are implemented; it is not native-equivalent
opaque caching. Cache bodies are bounded at 8 MiB and logical data at 64 MiB.

Website data starts empty on activation. There is **no migration wizard, import,
old-node retrieval, or legacy-data preservation flow**. Atlas preferences,
administrator sessions, backend databases, and VPS volumes are not cleared.
Different frontend origins or browser profiles remain distinct browser-storage
contexts; this update does not synchronize them.

## Sessions

The coordinator exposes explicit restore, renew, and new-session operations with
server time, separate deadlines, generations, and stable errors. Visible active
sessions renew every five minutes and validate on startup/resume/pageshow/online.
The twelve-hour idle policy remains. Ordinary expiry can create a fresh assignment
on the previous healthy node; temporary failures retry without recreating website
frames or silently changing nodes. Revocation is a separate state. Concurrent
windows and popouts reject stale responses. Established relay authorization is
renewable independently of the original upgrade ticket's age.

## Rewriter compatibility boundaries

Logical URLs, original response policy, and requested/final resource identities
must survive rewriting. Native Blob/module/worker creation, transformed CSS,
base URLs, form serialization, SRI, Trusted Types, cookies, SVG references, and
relative imports each require separate adaptation; replacing matched strings is
not an equivalent implementation.

The current finite implementation includes original-authorized base/forms,
inert noscript handling, static inline SVG, module contexts, native fonts,
responsive images, bounded media snapshots, and dedicated workers. Limits and
unsupported branches fail explicitly:

- Buffered script responses are at most 32 MiB; other response destinations remain
  at most 8 MiB. Relay retained payload accounting is 64 MiB with 8192 reads per
  response. This is **not** a total-heap bound: transport queues and coalescing
  add memory overhead. Graph traversal has separate count/byte bounds.
- Native media snapshot/range tests do not certify HLS, DASH, MSE, DRM, or the
  earlier legacy-runtime ESPN+ result under the new runtime.
- Blob dedicated workers inherit the parent's native compilation CSP. A worker
  response stricter than that parent fails closed before a grant; a stricter
  parent can conservatively deny compilation the original worker response permits.
  This is not native worker-response-policy equivalence. Shared/nested worker
  branches and worker Trusted Types are not generally qualified.
- Native CSS dependency preparation is finite and eager; it does not yet reproduce
  every browser's lazy/conditional resource activation. Conditional imports and
  oversized resource graphs remain explicit compatibility gates.
- The reviewed ChatGPT nested response-renderer adapter is integrated into the
  default runtime. Native fixture tests exercise static and dynamic declaration
  orders, original frame policy, per-hop module policy/CORS, one-shot helper
  provenance and live-parent/document-bound channels. This is not an actual
  authenticated ChatGPT reply-streaming result. General nested-frame/popup and
  authenticated-site journeys still need applicable acceptance checks.
- The observed Discord Cache Storage denial now has a real logical-site broker;
  the copied-runtime `contentDocument` hook now returns native null for
  inaccessible documents and still delegates all non-null cases to the existing
  subcontext denial. Neither correction weakens opaque isolation. However, the
  actual login probe still fails its sign-in-form check: it displays a failed
  dynamic chunk after retries. The marketing homepage's large eager CSS resource
  graph is a separate unresolved compatibility limit. Loading/ready status or
  the mere presence of visible error text is not a successful Discord result.

The closed-shadow **Isolate page structure (experimental)** implementation,
preference, messages, lifecycle paths, and controls are removed. Old
`atlas.document-surface.v1` preferences cannot reactivate it. This removal is
unrelated to the mandatory opaque-origin sandbox. Dynamic/game-detection work
remains paused.

## Single activation and rollout gate

`ATLAS_BROWSER_RUNTIME=held` is the default. Merely building assets or advertising
node protocol capabilities does not activate the update. The explicit
`opaque-v2` mode requires frontend relay mode, HTTPS, and the complete hash-checked
runtime asset set. That switch is an operational mechanism, **not evidence that
the release gates passed**.

Keep one versioned package for canary and fleet rollout. Do not publish a subset
because it is easier. Before deployment preserve applicable configuration and
database backups, release hashes, and rollback images; rehearse rollback without
destructive browser-storage cleanup. Preserve unrelated source and the shared
VPS2 dispenser configuration/services. Source-copy rollback evidence does not
replace production image/configuration/database rollback rehearsal.

No deployment command in the legacy update guide authorizes activation of this
held candidate. Consult the current evidence register for tested results and
the remaining release blockers.
