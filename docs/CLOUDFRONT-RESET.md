# Replace CloudFront links — keep the three existing VPS installations

This procedure creates **103 new distributions**. It does not reinstall Atlas, change Caddy, replace origin keys, detach nodes, or delete old AWS distributions.

| New links | Origin | Purpose |
|---|---|---|
| 100 | `vps-1.internals.paxton.co` | Atlas frontend/API links; first is the stable owner/control URL |
| 1 | `vps-2.internals.paxton.co` | Existing paired Node 2 |
| 1 | `vps-3.internals.paxton.co` | Existing paired Node 3 |
| 1 | `atlas-dispenser-vps-b.internals.paxton.co` | Dispenser on VPS 2 |

**Main remains in `LOCAL_RELAY_MODE=frontend`.** When Main is selected, its relay uses the visitor's frontend link and VPS 1's egress. The runtime frame remains isolated on an existing remote node. When Node 2/3 is selected, browsing uses that node's dedicated link/egress. Atlas API calls stay on the frontend URL. There is no additional Main runtime distribution in this procedure.

VPS 2's existing combined `Caddyfile.node`, `compose.dispenser.yaml`, shared Docker network and dispenser services stay in place. Do not replace those files with repository defaults or run `docker compose down`.

## 1. Mac: choose your AWS profile and create a private batch

Prerequisites: Node 24.12+, AWS CLI v2, jq, and SSH access to the existing servers. No npm install is needed for these helpers. AWS credentials stay in your local AWS profile; origin keys stay in the private batch directory outside Git.

```bash
export AWS_PROFILE=atlas                 # use your existing configured profile name
export AWS_REGION=us-east-1
export AWS_PAGER=""
aws --version
aws sts get-caller-identity

export ATLAS="$HOME/Repositories/Atlas-Next"
export DISPENSER="$HOME/Repositories/Atlas-Link-Dispenser"
export CFDIR="$HOME/atlas-cloudfront-20260925"
export SSH_USER=root
umask 077

cd "$ATLAS"
node scripts/cloudfront-reset.mjs init --dir "$CFDIR" --frontends 100
node scripts/cloudfront-reset.mjs plan --dir "$CFDIR"
```

If the profile does not exist, configure credentials for your AWS account first (`aws configure --profile atlas`, or your organization's SSO setup). [Official CLI setup](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-quickstart.html).

Run `init` **once**. Keep the directory and resume it; using a new directory creates a different batch. Plan output should show 100 frontend + 1 node2 + 1 node3 + 1 dispenser = 103.

The helper uses AWS CLI `create-function`, `publish-function`, and `create-distribution-with-tags`. It needs those permissions plus `DescribeFunction`, `ListDistributions`, `GetDistribution`, and `TagResource`. It records the AWS account, resource IDs, and stable caller references so an interrupted create can resume. Explicit throttling errors get bounded, visible retries rather than a new batch; permanent errors stop. [AWS distribution creation](https://docs.aws.amazon.com/cli/latest/reference/cloudfront/create-distribution-with-tags.html).

Two viewer-request Functions are used: one for 100 frontends and another for two nodes. AWS's published limit is 100 distributions associated with one Function. Existing resources also count toward your account quotas; new distributions generate normal AWS usage charges. [AWS quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html).

## 2. Mac: copy the EXISTING edge origin keys, then create

These commands read the existing running Caddy containers' keys without printing them. They do not rotate keys or edit `.env`.

```bash
ssh "$SSH_USER@vps-1.internals.paxton.co" \
  'docker exec atlas-main-edge-1 printenv ORIGIN_KEY' > "$CFDIR/main.key"
ssh "$SSH_USER@vps-2.internals.paxton.co" \
  'docker exec atlas-node-edge-1 printenv ORIGIN_KEY' > "$CFDIR/node2.key"
ssh "$SSH_USER@vps-3.internals.paxton.co" \
  'docker exec atlas-node-edge-1 printenv ORIGIN_KEY' > "$CFDIR/node3.key"
chmod 600 "$CFDIR"/*.key

cd "$ATLAS"
node scripts/cloudfront-reset.mjs create --dir "$CFDIR" --apply
node scripts/cloudfront-reset.mjs wait --dir "$CFDIR"
jq '{frontendOrigin,node2Origin,node3Origin,dispenserOrigin}' "$CFDIR/urls.json"
wc -l "$CFDIR/frontend-import.txt"       # expected: 100
```

If SSH uses a non-root account, use that account's authorized `sudo docker` access. If the container names differ, inspect `docker ps` and substitute the actual edge names. Empty/missing key files cause creation to stop before AWS mutations.

The generated configs use HTTPS origin port 443, the actual VPS hostname for origin Host/TLS, all seven HTTP methods, `CachingDisabled`, and `AllViewerExceptHostHeader`. The Atlas Function forwards the viewer host/IP/protocol; cookies, query strings and WebSocket headers are forwarded. No iframe-blocking response policy or error-to-index rewrite is installed. The dispenser uses its existing independent Caddy site, without an Atlas origin key/Function. [AWS origin policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policy-all-viewer-except-host-header), [WebSocket support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html).

### If AWS says `Throttling`, or the old helper looks frozen

The updated helper spaces new creations by **5 seconds** and retries explicit throttling up to **8 total attempts**, with jittered exponential delays capped at **60 seconds**. It prints the operation/attempt and delay before waiting. Each AWS subprocess has a 75-second wall-clock limit, 10-second connect timeout and 30-second read timeout. The helper owns retries (`standard` mode, one attempt inside each CLI invocation), so SDK retries do not silently multiply the delays. Hard quotas, bad credentials, interrupts and unknown-outcome timeouts stop for review instead of an endless retry. [AWS CLI retry behavior](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html).

If the old invocation is still running, stop that invocation with **Ctrl+C**. Keep the original batch directory. Resume with:

```bash
cd "$ATLAS"
node scripts/cloudfront-reset.mjs unlock --dir "$CFDIR"
node scripts/cloudfront-reset.mjs create --dir "$CFDIR" --create-delay-seconds 5 --apply
node scripts/cloudfront-reset.mjs wait --dir "$CFDIR"
```

`unlock` uses `lsof` to check the lock's open file descriptor and removes it only if no process holds it; an active or unverifiable lock is left intact. It also recognizes locks left by the older script. It does not edit the saved distribution list. Do not manually delete an active lock or run `init` again.

Saved items are checked, not recreated. The same batch/caller references also recover creates completed by AWS before a local receipt was written. If the full throttling retry budget is exhausted, wait a few minutes and resume the same command; `--create-delay-seconds 10` is an optional slower pace. No AWS limit is bypassed.

`wait` now prints each deployment check and pending status every 30 seconds rather than hiding the AWS waiter's long polling. It stops after 80 checks on an individual still-pending distribution; rerun `wait` to continue. [AWS waiter behavior](https://docs.aws.amazon.com/cli/latest/reference/cloudfront/wait/distribution-deployed.html).

`state.json` and generated distribution configs contain operational data; the configs include origin keys. Keep the entire directory private.

## 3. Mac: verify the new endpoints before changing pairing records

```bash
curl -fsS "$(jq -r .frontendOrigin "$CFDIR/urls.json")/health"; echo
curl -fsS "$(jq -r .node2Origin "$CFDIR/urls.json")/health"; echo
curl -fsS "$(jq -r .node3Origin "$CFDIR/urls.json")/health"; echo
curl -fsS "$(jq -r .dispenserOrigin "$CFDIR/urls.json")/health/ready"; echo
```

Atlas main should return `{"status":"ok","database":"ready"}`; nodes should return `{"status":"ok"}`. The dispenser readiness endpoint must return HTTP 200. Check its response rather than expecting the Atlas JSON format. Health checks alone do not establish a successful browsing or authentication session.

For 403, check origin key and viewer Function. For 502/TLS errors, check the existing origin DNS/certificate/Caddy logs. A dispenser TLS error is not fixed by overwriting the combined Caddy file. Keep old distributions available through the cutover and rollback window.

## 4. Mac: inspect existing node identities and generate exact migration plans

**Do not delete/re-add nodes in the owner panel.** Their current IDs and pairing secrets must survive. The main database stores their public endpoints; each node stores the stable frontend URL used for heartbeats. Both references need updating.

The following read-only commands export IDs/URLs only, not secrets. They assume the previously observed Compose container names.

```bash
ssh "$SSH_USER@vps-1.internals.paxton.co" \
  'docker exec -i atlas-main-app-1 node --input-type=module' > "$CFDIR/main-before.json" <<'JS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/data/atlas.sqlite', {readOnly:true});
console.log(JSON.stringify(db.prepare('SELECT id,name,endpoint,state FROM nodes ORDER BY id').all()));
db.close();
JS

ssh "$SSH_USER@vps-2.internals.paxton.co" \
  'docker exec -i atlas-node-node-1 node --input-type=module' > "$CFDIR/node2-before.json" <<'JS'
import { readFileSync } from 'node:fs';
const {id,control} = JSON.parse(readFileSync('/data/node.json','utf8'));
console.log(JSON.stringify({id,control}));
JS

ssh "$SSH_USER@vps-3.internals.paxton.co" \
  'docker exec -i atlas-node-node-1 node --input-type=module' > "$CFDIR/node3-before.json" <<'JS'
import { readFileSync } from 'node:fs';
const {id,control} = JSON.parse(readFileSync('/data/node.json','utf8'));
console.log(JSON.stringify({id,control}));
JS

node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const dir=process.env.CFDIR;
const read=name=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
const write=(name,data)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2)+'\n',{mode:0o600});
const urls=read('urls'), main=read('main-before'), changes=[];
for(const role of ['node2','node3']) {
  const node=read(`${role}-before`), row=main.find(r=>r.id===node.id);
  if(!row || row.id==='local' || !node.control) throw Error(`Missing existing paired identity for ${role}`);
  changes.push({id:node.id,from:row.endpoint,to:urls[`${role}Origin`]});
  write(`${role}-plan`,{id:node.id,fromControl:node.control,toControl:urls.frontendOrigin});
}
if(changes[0].id===changes[1].id) throw Error('Node 2 and Node 3 unexpectedly share one identity');
write('main-plan',{changes});
console.log('PLANS_READY: main-plan.json, node2-plan.json, node3-plan.json');
JS

cat "$CFDIR/main-plan.json"
```

Review those old→new endpoints. The helper will reject an unexpected current ID/URL, not guess or attach a different node. A plan already applied is a no-op.

Upload **only these migration files**, not the deployment/Caddy templates:

```bash
export ATLAS CFDIR SSH_USER
bash <<'BASH'
set -euo pipefail
for spec in 'main vps-1.internals.paxton.co' 'node2 vps-2.internals.paxton.co' 'node3 vps-3.internals.paxton.co'; do
  read -r role host <<< "$spec"
  ssh "$SSH_USER@$host" 'mkdir -p /opt/atlas/cloudfront-retarget && chmod 700 /opt/atlas/cloudfront-retarget'
  scp "$ATLAS/scripts/retarget-cloudfront.mjs" "$ATLAS/scripts/apply-cloudfront-retarget.sh" \
    "$SSH_USER@$host:/opt/atlas/cloudfront-retarget/"
  scp "$CFDIR/$role-plan.json" "$SSH_USER@$host:/opt/atlas/cloudfront-retarget/plan.json"
  scp "$CFDIR/urls.json" "$SSH_USER@$host:/opt/atlas/cloudfront-retarget/urls.json"
done
BASH
```

## 5. VPS cutover: preserve node identity and existing deployment

Use a maintenance window. Existing browsing sessions need **Connection → Reconnect** after endpoint changes, and website sign-ins may need repeating because browser storage belongs to the old node origin. First set Node 2 and Node 3 to **Draining** in the current owner panel; those stored states are preserved by the migration. Do not disable or remove their records.

The wrapper runs a dry-run, stops **only** the selected existing app/node container, backs up its complete `/data` tree, applies the narrow change, and starts that same container/image. It does not rebuild, re-pair, alter Caddy/networks, or restart the dispenser. If apply fails, it leaves the selected service stopped for inspection and prints the backup location.

**VPS 1:**

```bash
cd /opt/atlas/cloudfront-retarget
sudo bash apply-cloudfront-retarget.sh main plan.json
sudo bash apply-cloudfront-retarget.sh main plan.json --apply
```

**VPS 2, then VPS 3:** run this on each:

```bash
cd /opt/atlas/cloudfront-retarget
sudo bash apply-cloudfront-retarget.sh node plan.json
sudo bash apply-cloudfront-retarget.sh node plan.json --apply
sudo docker logs --tail=40 atlas-node-node-1
```

Backups are under the `backups` directory printed by the wrapper. They contain pairing/master secrets; retain privately. Allow at least 15–30 seconds for heartbeats after both ends are updated. Sign into the **new first frontend** owner URL using your existing credentials; set both remote nodes back to **Active**, weight 1. Set **Main server Active** if you want its third egress IP too. Leave `LOCAL_RELAY_MODE=frontend` enabled. Do not use pairing codes for these already-paired nodes.

### Update the canonical application URLs (without overwriting `.env`)

On **VPS 1**, edit the existing main environment file used by the running deployment, normally `/opt/atlas/.env`:

```dotenv
APP_ORIGIN=https://NEW_FIRST_FRONTEND.cloudfront.net
LOCAL_BROWSING=true
LOCAL_RELAY_MODE=frontend
```

Substitute `frontendOrigin` from `/opt/atlas/cloudfront-retarget/urls.json`; leave all other secrets/settings intact. The frontend-relay configuration leaves `RUNTIME_HOST` and `RUNTIME_ORIGIN` unset.

On **VPS 2**, update the dispenser's existing environment file, **not** `/opt/atlas/.env` belonging to the node:

```dotenv
APP_URL=https://NEW_DISPENSER.cloudfront.net
GOOGLE_REDIRECT_URI=https://NEW_DISPENSER.cloudfront.net/api/admin/google/callback
```

Use `dispenserOrigin` from `urls.json`. Add that exact callback to the same Google OAuth client's authorized redirect URIs before reconnecting Google Drive. Keep the old callback during the rollback window. Keep all existing Google/client secrets, database settings and sessions/data. No new database is created.

Before editing, save a private copy (`umask 077; cp EXISTING_ENV EXISTING_ENV.before-cloudfront`). To locate each existing Compose stack without printing environment secrets:

```bash
# VPS 1: atlas-main-app-1. VPS 2 dispenser: atlas-link-dispenser-app-1.
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' CONTAINER
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' CONTAINER
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' CONTAINER
```

Recreate only that app service with its **same ordered Compose files**, project and environment-file selection. Do not run a bare `docker compose up` from an arbitrary directory. This Bash function recovers the recorded stack and leaves dependencies/edge alone:

```bash
# Paste in a Bash shell on the relevant VPS after saving the environment edit.
recreate_existing_app() {
  local cid=$1 work project configs envs service file
  local -a cmd files
  work=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid") || return
  project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$cid") || return
  service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$cid") || return
  configs=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid") || return
  envs=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$cid") || return
  [[ -d "$work" && "$service" == app && -n "$configs" && "$configs" != '<no value>' ]] || return 1
  cmd=(docker compose --project-directory "$work" -p "$project")
  IFS=',' read -r -a files <<< "$configs"
  for file in "${files[@]}"; do
    [[ "$file" = /* ]] || file="$work/$file"
    [[ -f "$file" ]] || return 1
    cmd+=(-f "$file")
  done
  if [[ -n "$envs" && "$envs" != '<no value>' && "$envs" != '<nil>' ]]; then
    IFS=',' read -r -a files <<< "$envs"
    for file in "${files[@]}"; do
      [[ "$file" = /* ]] || file="$work/$file"
      [[ -f "$file" ]] || return 1
      cmd+=(--env-file "$file")
    done
  fi
  (cd "$work" && "${cmd[@]}" config --quiet && \
    "${cmd[@]}" up -d --no-deps --force-recreate --no-build --pull never app)
}

# VPS 1 only:
recreate_existing_app atlas-main-app-1

# VPS 2 only (run separately there):
# recreate_existing_app atlas-link-dispenser-app-1
```

If the original dispenser stack used `ATLAS_ENV_FILE` as a shell variable, export its same path before recreation. `environment_file` records Compose's `--env-file`; it does not recover arbitrary shell variables. Inspect the existing Compose `env_file` setting without printing secrets and use the intended file.

## 6. Replace the dispenser's old link pool

Only do this after browsing works through the new links and the new dispenser URL is working. **The import contains the 100 frontend links only. Never put node/dispenser URLs in the visitor link pool.**

First, on **VPS 2**, make and check a full PostgreSQL backup. The JSON downloaded by the browser helper is an additional link list, not a database backup:

```bash
umask 077
mkdir -p "$HOME/atlas-dispenser-backups"
BACKUP="$HOME/atlas-dispenser-backups/before-link-reset-$(date +%Y%m%d-%H%M%S).dump"
docker exec atlas-link-dispenser-postgres-1 \
  pg_dump -U atlas_dispenser -d atlas_dispenser -Fc > "$BACKUP"
test -s "$BACKUP" && docker exec -i atlas-link-dispenser-postgres-1 \
  pg_restore --list < "$BACKUP" >/dev/null
printf 'DATABASE_BACKUP=%s\n' "$BACKUP"
```

`pg_restore --list` verifies that the archive is readable; it is not a full restore rehearsal.

Then, on your **Mac**:

```bash
pbcopy < "$DISPENSER/scripts/replace-links.browser.js"
open "$(jq -r .dispenserOrigin "$CFDIR/urls.json")/?admin"
```

1. Sign in as the existing active dispenser administrator.
2. Open DevTools → Console and paste the copied helper source. Review the source first; it uses only the dispenser's existing same-origin admin API.
3. Click **Choose frontend-import.txt**, choose `$CFDIR/frontend-import.txt`, and save the downloaded old-link snapshot.
4. Review the counts. Type the exact `REPLACE <old-deletions> WITH 100` confirmation only after the database backup is saved.

The helper imports first, verifies all replacement links exist and are enabled, then deletes only old snapshot link IDs absent from the replacement list. It preserves overlapping links and unrelated links added after the snapshot. It stops on a failed request/429 and reports partial progress; rerunning takes a fresh snapshot and skips already-imported URLs.

**Deleting old link records also deletes their assignment/report/health history and restores associated weekly quota usage.** It does not delete users, Google credentials or AWS distributions. Newly imported links receive the existing bulk-import defaults (enabled, weight 1, unlimited capacity, monitoring on); adjust those in the Links panel if needed.

## 7. Final checks and retirement of old links

- Open at least two new frontend links. UI/API requests must remain on the chosen frontend origin.
- Verify Node 2 and Node 3 are Online/Active, Main is eligible, and existing node IDs are unchanged.
- Test sticky browsing, Connection → Reconnect, popout and WebSocket-dependent sites. Main's egress is VPS 1; remote nodes' egress is their respective VPS. Health checks alone do not test this.
- Verify the dispenser issues only new frontend URLs, admin login works, and Google Drive callback works through its new URL.
- Browser local settings/chat history/cookies from an old origin do not automatically transfer to a new one. Export/import supported local settings as needed.
- Keep old AWS distributions until the migration, OAuth and rollback window are complete. Removing them from the dispenser is separate from disabling/deleting them in AWS. This helper deliberately does not retire them.

### Rollback

Keep old distributions enabled for rollback. Before restoring data, stop the affected service and preserve its current state too. The retarget helper's backup includes the **entire** previous `/data` tree, not just `node.json`/the SQLite main file; preserve associated WAL/master-key files together. Restore into an empty service data volume using a temporary container with the same existing image and the recorded backup bind mount, retain the volume root, and copy `backup/data/.` with ownership preserved. Never merge SQLite files from different snapshots or restore a main backup into a node volume.

Restore both sides of the node migration (main endpoint rows plus each node's control URL) together, restore the previous environment files, and recreate only the affected app services using their original Compose stacks. Alternatively, generate inverse endpoint/control plans from the saved pre-migration JSON and run the same offline helper; this preserves unrelated later database changes. Reconnect clients afterward.

To roll back a dispenser link deletion with its original history, restore the PostgreSQL dump while the dispenser app is stopped; re-importing the link JSON alone does not recover deleted assignments/reports. A full database restore also reverts changes since that dump. Test a restore separately before relying on it.

## Local verification of these helpers

```bash
cd "$ATLAS"
node --test tests/cloudfront-reset.test.mjs tests/cloudfront-throttling.test.mjs tests/retarget-cloudfront.test.mjs tests/apply-cloudfront-retarget.test.mjs
cd "$DISPENSER"
node --test scripts/replace-links.browser.test.mjs
```

These are isolated/mocked tests. They do not create distributions, access production data, or establish that live AWS credentials/DNS/certificates are correct.
