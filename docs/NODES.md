# Direct browsing nodes

For the complete three-server procedure, see [Three VPS setup](THREE-VPS-SETUP.md).

## Traffic

```text
100 frontend CloudFront distributions → vps-main.internals.paxton.co
                                      → frontend + Atlas API + owner panel
Browser → assigned node CloudFront endpoint → VPS node → destination websites
```

Atlas API requests remain relative `/api/...` on the frontend domain the visitor opened. Website requests, downloads and WebSocket traffic use the assigned node directly; the main server does not relay this data. Scramjet rewriting runs in the browser. The node supplies outbound connections and its public IP/bandwidth, not server-side rendering. The frontend address remains unchanged; the node origin is visible in network tools.

There is no frontend domain allowlist or per-alias app configuration. Same-origin checks use the actual request origin, with forwarded headers accepted only from `TRUST_PROXY`. Keep one browser-runtime CloudFront endpoint per node. Do not map a node's endpoint to the main frontend service.

## Point → attach

1. On a node, start the `nodes` branch deployment. A fresh node prints `NODE_PAIRING_CODE=...` in its logs. The code lasts ten minutes; an unattached node prints a replacement when it expires.
2. On the main app, open **Owner panel → Browsing nodes**.
3. Enter a name, the node's CloudFront URL, and its pairing code. Click **Attach node**.
4. Atlas exchanges credentials over the node connection, saves them, checks reachability and displays **Online**. No hand-edited Atlas node IDs, shared tokens, or domain lists.

The one-time pairing code prevents someone else claiming a newly started public node. Node credentials persist in `/data/node.json` (0600). Restarting preserves the attachment. The main app stores its copy encrypted using its existing master key. Copying or cloning a paired node's data to a different server is not a way to add a second node: start with an empty volume and attach it separately.

Standalone local node process (after building):

```sh
pnpm node:start
```

Node deployment:

```sh
cp .env.node.example .env
# Set ORIGIN_HOST and ORIGIN_KEY for this node's CloudFront origin.
docker compose -f compose.node.yaml up -d --build
docker compose -f compose.node.yaml logs node
```

`ORIGIN_HOST` is your real VPS hostname, e.g. `vps-2.internals.paxton.co`; `ORIGIN_KEY` is the same random secret configured as CloudFront's `X-Atlas-Origin-Key` origin custom header. Infrastructure still needs DNS, origin TLS and a CloudFront distribution; the Attach button handles Atlas registration, not creation of AWS infrastructure.

## One reusable CloudFront setup

Apply the same configuration to every frontend and node distribution:

- Origin domain: the corresponding VPS hostname; HTTPS to origin, with a valid certificate for that hostname.
- Viewer policy: redirect HTTP to HTTPS. Allow all HTTP methods.
- Start with caching disabled. Forward all query strings, cookies, Authorization, Origin and WebSocket headers using **AllViewerExceptHostHeader**.
- Associate `scripts/cloudfront-viewer.js` as a **viewer-request CloudFront Function** (JavaScript runtime 2.0). It copies the viewer hostname into a custom header and copies the trusted viewer IP, overwriting viewer-supplied values. This keeps shared CloudFront edge IPs from collapsing all visitors into one rate-limit bucket.
- Set the origin custom header `X-Atlas-Origin-Key`. Use the supplied Caddy origin template: it verifies this value, maps the viewer hostname into `X-Forwarded-Host`, and proxies to Atlas.
- Do not enable shared caching for `/api/*`, `/runtime-config`, `/node/*`, `/relay/*`, `/wisp/*`, proxy URL paths, worker scripts or HTML with dynamic CSP. Runtime relay paths contain short-lived session capabilities: keep access logs off or redact these paths; never cache or publish them. Static versioned assets can be optimized separately after deployment testing.

This preserves the origin Host/SNI as `vps-*.internals.paxton.co`, while Atlas receives the actual CloudFront viewer origin through a trusted local proxy. It avoids needing certificates or hostname rules for your 100 distribution domains. The CloudFront Function deliberately does not set the restricted `X-Forwarded-Proto` header.

Sources: [AWS WebSocket support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html), [origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-request-understand-origin-request-policy.html), [origin TLS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-cloudfront-to-custom-origin.html), [edge header restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html).

On main, use `Caddyfile.cloudfront` in place of the direct-host Caddyfile. Keep the existing main application network/`TRUST_PROXY` setting. Set `APP_ORIGIN` to the main HTTPS origin as a fallback; it is not an alias allowlist. For a coordinator-only main, set `LOCAL_BROWSING=false` on first startup; otherwise disable **Main server** in the owner panel. If main also carries browsing traffic, give its runtime (port 4181) its own CloudFront distribution and set `RUNTIME_ORIGIN` to that endpoint. Never route website traffic through port 4180.

## Assignment and owner controls

- Healthy, **Active** nodes are ranked by `(pinned sessions + reported open relay connections) / weight`. Allocation reserves a SQLite lease before returning it, preventing simultaneous clients from all choosing an unreserved node. This is a practical load signal, not measured bandwidth or CPU utilization.
- **Weight** controls relative capacity (1–100). **Draining** stops new assignments and preserves current leases. **Disabled** rejects new connections and closes existing relay connections once its control state arrives.
- Nodes heartbeat every 15 seconds; the backend also probes their endpoint. At 45 seconds without a valid control update, a node rejects new connections. Ordered control revisions prevent late updates overwriting newer assignments. Relay authorizations are rechecked every five seconds, so revocation and stale control state also close existing relay connections.
- A session is pinned in SQLite and reused across app reloads. Offline nodes do not trigger silent failover. **Reconnect** explicitly ends the old assignment and permits a new IP. Browser cookies/storage are origin-bound; switching nodes may require signing in again.
- Idle leases expire after 12 hours; tickets also last 12 hours. A refresh after expiry asks for Reconnect instead of silently moving sessions. Sessions are per browser profile/frontend origin, not shared automatically across all 100 frontend URLs.
- Node IDs, names, health, connection/session counts, weights and drain/disable/remove controls appear in the owner panel. Public visitors receive their node label and connection ticket, not the node's control credential.
- Preserve the same node endpoint-to-VPS mapping for the lifetime of pinned sessions. Changing a CloudFront origin underneath a node can change its IP despite application stickiness.

## Verification boundary

Local tests cover 100 frontend host aliases, pairing, owner/CSRF checks, weighted allocation, direct browser-to-node WebSockets, cookie continuity on the same node, draining, offline behavior and invalid tickets. The actual CloudFront distributions, deployed TLS/Caddy configuration, multi-VPS throughput and physical Chromebook have not been exercised from this workspace. No measured bandwidth increase or universal site compatibility is claimed.
