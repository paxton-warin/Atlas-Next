# Atlas: exact three-VPS setup

## Layout

Use **Ubuntu 24.04 LTS** on all three VPSs for the commands below. Substitute your actual public IPs, SSH user and AWS-assigned distribution hostnames. These are installation instructions, not a claim that your servers have been deployed.

| VPS | DNS A record → public IP                | Runs                                                   | CloudFront origin               |
| --- | --------------------------------------- | ------------------------------------------------------ | ------------------------------- |
| 1   | `vps-1.internals.paxton.co` → `VPS1_IP` | Atlas frontend, API, owner panel, database, Main relay | Every frontend distribution     |
| 2   | `vps-2.internals.paxton.co` → `VPS2_IP` | Browsing node 2                                        | One dedicated node distribution |
| 3   | `vps-3.internals.paxton.co` → `VPS3_IP` | Browsing node 3                                        | One dedicated node distribution |

```text
Visitor → any frontend CloudFront link → VPS 1 (UI, API, assignment)
Main assignment: visitor → current frontend CloudFront link /relay/* → VPS 1 → website
Node 2/3 assignment: visitor → assigned node CloudFront link → VPS 2 OR VPS 3 → website
Main frame/static runtime: visitor → one pinned, paired node hostname (isolated from Atlas)
```

This layout provides **three browsing egress IPs** when all three nodes are Active. Main-assigned website traffic uses whichever frontend URL the visitor opened. Node 2/3 traffic goes directly to those nodes, bypassing VPS 1. All Atlas API calls stay on the current frontend link. Rewriting runs in the visitor's browser; each egress server supplies outbound connections and bandwidth. A single session does not combine multiple servers' bandwidth.

Use **three distributions total**: one frontend plus two nodes. Add more frontend distributions with the same VPS 1 origin/configuration. No fourth runtime distribution or frontend alias allowlist is needed. Main's isolated website iframe and static runtime files are hosted on one of the existing nodes, while its actual website HTTP/WebSocket traffic uses VPS 1. Both choices stay pinned until Reconnect. At least one updated paired node must be online for Main to accept new sessions.

Keep one stable frontend distribution for owner access and node heartbeats. Visitor settings/admin sessions are not shared across different frontend URLs.

**Routine application/runtime update?** Use [Update browsing controls](UPDATE-BROWSING-CONTROLS.md), which preserves the running Compose stack and leaves Caddy/dispenser untouched.

**Initial relay migration on an existing installation?** Follow [Update to frontend relay](UPDATE-FRONTEND-RELAY.md) instead of overwriting `.env` or recreating node identities. Update both nodes before Main.

## 0. Prepare the current source

Use the current `main` branch from [paxton-warin/Atlas-Next](https://github.com/paxton-warin/Atlas-Next). The same `main` checkout contains the frontend and node images. Select `compose.node.yaml` for nodes; no separate branch or worktree is needed.

The misplaced main frontend was moved from web/public/src back to web/src after all 17 files matched the last verified snapshot; the original layout is backed up. The preparation command below checks that its entry point is present before building.

On your Mac, with Node 24.12+ and pnpm 11.15.0 installed:

```sh
cd /Users/paxton/Repositories/Atlas-Next
test -f web/src/main.tsx || { echo 'Restore or locate the main frontend source first'; exit 1; }
pnpm install --frozen-lockfile
pnpm runtime:fetch
pnpm build

```

Keep the prepared `upstream/scramjet-ls-bypass/app/vendor` files and `web/public/source` archives in the upload. Docker builds verify these pinned runtime assets. The connection dropdown is **Connection**; internal engine identifiers and pinned runtime filenames remain unchanged. The main navigation item stays Browser; the dropdown displays status and node details without an engine label.

## 1. DNS, ports and Docker

Create the three DNS A records above. They must resolve publicly despite the `internals` label. If using another DNS provider's proxy, use DNS-only records for these origin hostnames. Add AAAA records only if IPv6 actually reaches the same server.

Allow inbound **TCP 80 and 443** on every VPS, plus your SSH port from your management address. Allow outbound DNS/HTTPS and website connections. Do not publish application ports 4180, 4181 or 4183. Caddy obtains the origin certificate using the public DNS name; leave its ACME challenge reachable. CloudFront's HTTPS origin must have a valid certificate matching that origin hostname. [AWS origin TLS requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-cloudfront-to-custom-origin.html), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

On **each fresh Ubuntu VPS**, install Docker and Compose:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl rsync
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/atlas
```

Use Docker's existing-install migration procedure instead if these machines already have conflicting Docker/containerd packages. [Official Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/).

## 2. Upload the correct worktree to each server

**Fresh servers only.** The raw upload below installs standard Caddy/Compose files. For an existing server—especially VPS 2 with the dispenser—use `scripts/upload-update.sh` and [the update guide](UPDATE-FRONTEND-RELAY.md) instead; they preserve live routing and stage new templates separately.

On your Mac, replace `deploy` with your actual SSH user:

```sh
SSH_USER=deploy
rsync -az --exclude=.git --exclude=node_modules --exclude=.env --exclude=.origin-key --exclude='.env.*' --exclude=data --exclude=node-data --exclude=evidence --exclude=test-results --exclude=playwright-report --exclude=upstream/scramjet --exclude=upstream/demo-original --exclude=target \
  /Users/paxton/Repositories/Atlas-Next/ "$SSH_USER@vps-1.internals.paxton.co:/opt/atlas/"
rsync -az --exclude=.git --exclude=node_modules --exclude=.env --exclude=.origin-key --exclude='.env.*' --exclude=data --exclude=node-data --exclude=evidence --exclude=test-results --exclude=playwright-report --exclude=upstream/scramjet --exclude=upstream/demo-original --exclude=target \
  /Users/paxton/Repositories/Atlas-Next/ "$SSH_USER@vps-2.internals.paxton.co:/opt/atlas/"
rsync -az --exclude=.git --exclude=node_modules --exclude=.env --exclude=.origin-key --exclude='.env.*' --exclude=data --exclude=node-data --exclude=evidence --exclude=test-results --exclude=playwright-report --exclude=upstream/scramjet --exclude=upstream/demo-original --exclude=target \
  /Users/paxton/Repositories/Atlas-Next/ "$SSH_USER@vps-3.internals.paxton.co:/opt/atlas/"
```

The build's source-archive script also expects the non-secret example env files and three historical source-evidence files. Copy those explicitly after the main upload (commands provided in the next block). No database, master key, live `.env`, admin credentials or paired-node data is transferred.

```sh
export SSH_USER
bash <<'BASH'
for spec in 'Atlas-Next vps-1.internals.paxton.co' 'Atlas-Next vps-2.internals.paxton.co' 'Atlas-Next vps-3.internals.paxton.co'; do
  set -- $spec
  src="/Users/paxton/Repositories/$1"; host="$2"
  ssh "$SSH_USER@$host" 'mkdir -p /opt/atlas/evidence/ui-refinement/original/server'
  scp "$src/.env.example" "$src/.env.node.example" "$SSH_USER@$host:/opt/atlas/"
  scp "$src/evidence/ORIGINAL-sw.js" "$src/evidence/DIFF.patch" "$SSH_USER@$host:/opt/atlas/evidence/"
  scp "$src/evidence/ui-refinement/original/server/index.mjs" "$SSH_USER@$host:/opt/atlas/evidence/ui-refinement/original/server/"
done
BASH
```

## 3. Generate one origin key per VPS

On each VPS:

```sh
cd /opt/atlas
umask 077
openssl rand -hex 32 > .origin-key
cat .origin-key
```

Record each value for the next step. These are **three different infrastructure secrets**, not node pairing codes. Preserve an existing key on an already configured installation instead of replacing it.

## 4. Create the CloudFront distributions

Create standard custom-origin distributions, not S3 distributions. Use this table:

| Distribution | Origin domain               | Origin custom header             |
| ------------ | --------------------------- | -------------------------------- |
| Frontend     | `vps-1.internals.paxton.co` | `X-Atlas-Origin-Key` = VPS 1 key |
| Node 2       | `vps-2.internals.paxton.co` | `X-Atlas-Origin-Key` = VPS 2 key |
| Node 3       | `vps-3.internals.paxton.co` | `X-Atlas-Origin-Key` = VPS 3 key |

For **each distribution**:

1. Origin type: custom/other. Origin path: **empty**. Origin protocol: **HTTPS only**, port **443**, minimum origin TLS **TLSv1.2**.
2. Default behavior `*`: viewer protocol **Redirect HTTP to HTTPS**; allowed methods **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE**; no signed-viewer URL requirement.
3. Cache policy: **CachingDisabled** (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`). Origin request policy: **AllViewerExceptHostHeader** (`b689b0a8-53d0-40ab-baf2-68738e2966ac`). This forwards cookies, query strings and viewer headers other than Host; CloudFront supplies the origin hostname as Host. [AWS cache policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled), [AWS origin request policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policy-all-viewer-except-host-header).
4. Response headers policy: **None** initially; Atlas supplies its own CSP, origin and session headers. Do not add an iframe-blocking policy to nodes. Default root object: **empty**. No error-to-`/index.html` rewrite. Set supported error-cache TTLs to **0** for these dynamic distributions. [AWS error caching](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html). Keep standard/real-time access logging off initially: runtime relay URLs contain short-lived tickets.
5. Create one **CloudFront Function**, runtime **JavaScript 2.0**, paste `scripts/cloudfront-viewer.js`, publish it, then associate its **LIVE** version with **Viewer request** on each default behavior. Copy its exact contents; it preserves the viewer host/IP in trusted custom headers. [AWS function event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html).
6. Keep WebSocket headers forwarded. The selected origin policy forwards them; CloudFront automatically supports WebSocket upgrades, which use HTTP/1.1. [AWS WebSocket requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html).
7. Save and wait for deployment. Record the actual assigned frontend, node-2 and node-3 `*.cloudfront.net` domains. Their origins start in the next step; errors before then are expected.

Repeat the frontend configuration for additional frontend links, reusing VPS 1's origin key and the same function. There is no need to list those viewer domains in Atlas. Keep each node distribution pointing at its own VPS, not VPS 1.

## 5. Start VPS 1: main application

SSH to VPS 1. Replace `FRONTEND_CF` with your actual first frontend distribution hostname (without `https://`). Use this stable distribution for owner access.

```sh
cd /opt/atlas
FRONTEND_CF=REPLACE_WITH_FRONTEND.cloudfront.net
umask 077
cat > .env <<EOF
HOST=0.0.0.0
NODE_ENV=production
APP_ORIGIN=https://$FRONTEND_CF
LOCAL_BROWSING=true
LOCAL_RELAY_MODE=frontend
ADMIN_PATH=/_control/atlas-owner
ORIGIN_HOST=vps-1.internals.paxton.co
ORIGIN_KEY=$(cat .origin-key)
EOF
sudo docker compose -p atlas-main -f compose.cloudfront.yaml config --quiet
sudo docker compose -p atlas-main -f compose.cloudfront.yaml up -d --build
sudo docker compose -p atlas-main -f compose.cloudfront.yaml ps
sudo docker compose -p atlas-main -f compose.cloudfront.yaml logs --tail=60 edge app
```

This uses `Caddyfile.cloudfront`, not the direct-host `Caddyfile`. `TRUST_PROXY` and `/data` are set in Compose. In frontend-relay mode, leave `RUNTIME_ORIGIN` and `RUNTIME_HOST` unset. Caddy sends `/relay/*` and `/wisp/*` to port 4181; the frontend, API and owner panel still use 4180 on **every frontend alias**. The isolated iframe uses a paired node origin, not the frontend page. Browsing becomes available after nodes are attached. Main remains Setup required until a healthy paired node advertises frontend-relay support.

On an existing database, `LOCAL_BROWSING=true` does not override a saved Disabled state. Enable Main in the owner panel after updating and attaching the nodes. Do not add Main as a separate paired node.

After CloudFront and origin TLS are ready:

```sh
curl -fsS "https://$FRONTEND_CF/health"
sudo docker compose -p atlas-main -f compose.cloudfront.yaml exec app node scripts/admin-token.mjs
```

Expected health: `{"status":"ok","database":"ready"}`. Open `https://FRONTEND_CF/_control/atlas-owner`, enter the generated one-use token, choose a password of at least 12 characters, enroll TOTP and save recovery codes. The token lasts 15 minutes. The URL path itself is not verification. Existing owners should sign in instead of generating enrollment tokens.

## 6. Start VPS 2 and VPS 3: nodes

On VPS 2 use `ORIGIN=vps-2.internals.paxton.co`; on VPS 3 use `ORIGIN=vps-3.internals.paxton.co`. Run the rest unchanged on each machine:

```sh
cd /opt/atlas
ORIGIN=vps-2.internals.paxton.co  # use vps-3.internals.paxton.co on VPS 3
umask 077
cat > .env <<EOF
ORIGIN_HOST=$ORIGIN
ORIGIN_KEY=$(cat .origin-key)
EOF
sudo docker compose -p atlas-node -f compose.node.yaml config --quiet
sudo docker compose -p atlas-node -f compose.node.yaml up -d --build
sudo docker compose -p atlas-node -f compose.node.yaml ps
sudo docker compose -p atlas-node -f compose.node.yaml logs --tail=40 node edge
```

Look for `ATLAS_NODE_READY` and the most recent `NODE_PAIRING_CODE=...`. Codes expire in ten minutes and rotate while unattached. To read the latest code again:

```sh
sudo docker compose -p atlas-node -f compose.node.yaml logs --tail=100 node | grep NODE_PAIRING_CODE | tail -1
```

Check each actual node distribution with `curl -fsS https://NODE_CF/health`; expected `{"status":"ok"}`. `/node/health` is authenticated and a bare request should return 401; use `/health` for this public reachability check.

## 7. Point → attach in the owner panel

On the **stable frontend CloudFront URL**, open **Owner panel → Browsing nodes**:

1. Name: `Node 2`; endpoint: `https://YOUR_NODE2.cloudfront.net`; pairing code: latest code from VPS 2; click **Attach node**.
2. Name: `Node 3`; endpoint: `https://YOUR_NODE3.cloudfront.net`; pairing code: latest code from VPS 3; click **Attach node**.
3. Wait for both to show **Online**. Set both **Active**, **weight 1**. Set **Main server Active**, **weight 1**, after it shows ready. Its endpoint label should read **Current frontend URL · Main server relay**.
4. Save nothing by hand in the node database. Pairing exchanges Atlas credentials; each node's Docker data volume retains its own identity.

Equal weights give capacity-weighted sticky assignment using session/connection counts—not measured CPU or Mbps. Increase the stronger node's weight proportionally if the VPS capacities differ. Draining stops new assignments but keeps current sessions; Reconnect explicitly allows a different node/IP. Keep the stable frontend distribution online because nodes heartbeat through the control URL saved during attachment.

For built-in chat, configure the chosen provider endpoint, protocol, model and API key in **Owner panel → AI provider**; see [AI setup](AI.md). Browsing nodes do not need that key.

## 8. Verify the actual deployment

- Open the frontend. Open **Connection**: new assignments should include Main server, Node 2 and Node 3. Existing sticky sessions do not move automatically.
- Open DevTools → Network: `/api/...` stays on that frontend CloudFront host; for Node 2/3, runtime/relay traffic goes directly to that node. For Main, the frame is on a paired node but the transport WebSocket uses the current frontend host's `/relay/` route. VPS 1 should only carry website bytes for Main-assigned sessions.
- Reload and open additional tabs: the assigned node should stay the same. Use a different browser profile to observe a separate assignment; perfect alternation is not expected.
- Use **Connection → Reconnect node**: the node may change. Cookies/storage are tied to node origin, so moving nodes can require signing in again.
- Test your real Google login/CAPTCHA, ChatGPT and Spotify flows on your Chromebook. Local fixture passes do not establish those authenticated journeys.
- Check owner node counts, heartbeat health and actual network throughput on each VPS before adding all frontend links.

## Troubleshooting and updates

- **403 from origin:** check matching origin key and viewer-request function. Direct origin access without the key returning 403 is intentional.
- **502 through CloudFront:** check origin DNS, valid TLS certificate, TCP 443, Caddy logs, and that origin Host is not replaced with the viewer hostname.
- **Node attaches then goes offline:** check both directions: main → node `/node/*`; node → the saved frontend `/api/nodes/heartbeat`. Keep cookies, query strings and Authorization forwarded, caching disabled, and interactive viewer challenges off those machine-to-machine routes.
- **Wrong main page from node endpoint:** that node distribution is pointing to VPS 1 or port 4180. It must reach that node's Caddy → node:4183.
- **Existing session remains on an offline/draining node:** this is intentional stickiness. Ask that visitor to Reconnect; do not silently switch their browsing IP.
- **UI still shows the old label:** rebuild the intended frontend source and refresh. Do not change internal `scramjet` identifiers or worker paths to `proxy`.

Update by uploading the matching current source and rebuilding with the same Compose project name and data volumes. Update nodes one at a time after draining; keep the second node available. Do not use `docker compose down -v`: it deletes persistent volumes. Before upgrading, stop the affected service and back up its full named volume; preserve the main database/master key and each node's distinct `node.json`. Restore data only while the corresponding service is stopped. Retain the previous image and deployment files for rollback.

### Optional dedicated main runtime (legacy mode)

The default above needs no fourth distribution. To retain a previous dedicated runtime instead, explicitly set `LOCAL_RELAY_MODE=isolated`, `RUNTIME_ORIGIN=https://RUNTIME_CF` and `RUNTIME_HOST=RUNTIME_CF`. Its distribution must point to the same VPS 1 origin; `Caddyfile.cloudfront` routes that viewer hostname to port 4181. Every other frontend hostname continues to serve port 4180. Application and runtime hostnames must differ.

An iframe error containing `frame-ancestors 'none'` means that iframe URL served the frontend (or an edge policy added a denial), not the intended isolated runtime. Preserve the frontend's anti-framing headers. In frontend-relay mode, remove the obsolete runtime variables, update both nodes, recreate **app and edge**, then Reconnect. Check that CloudFront has no response-headers policy adding a framing denial to node responses.
