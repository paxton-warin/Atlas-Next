import {provisionBackupCatalogTestIndexes} from './hubBackupsV2Readiness.js';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import Fastify from "fastify";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  encodePortableValue,
  decodePortableValue,
  hubNamespace,
  canonicalBackupJson,
  backupManifestIdentity,
  type BackupCheckpointV2,
} from "@atlas-link-dispenser/shared";
import {
  registerHubBackupsV2Routes,
  runBackupMaintenanceSlice,
  withBackupTransaction,
} from "./hubBackupsV2.js";
import { profileUsage } from "./hubProfilePolicy.js";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import {
  registerHubLegacyConversionRoutes,
  runLegacyConversionJob,
} from "./hubBackupsV2Legacy.js";
import {
  runBackupAccountingSlice,
  runBackupAccountingActivation,
} from "./hubBackupsV2Accounting.js";
import { encrypt } from "./security.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const url = process.env.TEST_DATABASE_URL,
  run = url && existsSync(new URL('../../../../package.json',import.meta.url)) ? describe : describe.skip;
run("Real Chrome → Main proxy → Hub → PostgreSQL integration", () => {
  let admin: Pool, pool: Pool, app: ReturnType<typeof Fastify>;
  let browser:any;const mainApps:ReturnType<typeof Fastify>[]=[];
  const evidence=fileURLToPath(new URL('../../../../test-results/hub/backup-v2-full-stack/',import.meta.url));
  const report:any={command:'TEST_DATABASE_URL=<dedicated-loopback> pnpm exec vitest run src/hubBackupsV2Browser.integration.test.ts',productionChanged:false,checks:{},requests:[]};
  const schema = "backupv2_" + randomUUID().replaceAll("-", ""),
    user = randomUUID(),
    profile = randomUUID(),
    branch = randomUUID(),
    session = randomUUID(),
    context = randomUUID();
  const namespace = {
      kind: "idb" as const,
      origin: "https://save.example",
      name: "saves",
    },
    master = "isolated-fixture-master",
    key = "isolated-fixture-profile";
  const sessionValue = {
    protocol: 1,
    userId: user,
    profileId: profile,
    branchId: branch,
    sessionId: session,
    contextId: context,
    expiresAt: Date.now() + 86400000,
    grantExpiresAt: Date.now() + 86400000,
  };
  const root = "/api/hub/branch/profile/backups/v2";
  beforeAll(async () => {
    if (
      !["localhost", "127.0.0.1"].includes(new URL(url!).hostname) ||
      !new URL(url!).pathname.endsWith("_test")
    )
      throw Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: url });
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({
      connectionString: url,
      max: 6,
      options: "-c search_path=" + schema + ",public",
    });
    await pool.query(
      "CREATE TABLE users(id uuid PRIMARY KEY,email text,normalized_email text);CREATE TABLE links(id uuid PRIMARY KEY);CREATE TABLE sessions(id uuid PRIMARY KEY);CREATE TABLE audit_events(id serial PRIMARY KEY,admin_id uuid,action text,target_type text,target_id text,after jsonb)",
    );
    for (const file of [
      "0009_hub_core.sql",
      "0013_hub_writer_handoff.sql",
      "0015_hub_profile_recovery.sql",
      "0016_hub_profile_policy.sql",
      "0018_hub_stream_budget.sql",
      "0019_hub_profile_delete_refs.sql",
      "0025_hub_backups_v2.sql",
      "0026_hub_backup_catalog_scalability.sql",
    ])
      await pool.query(
        await readFile(
          new URL(
            "../../../packages/database/migrations/" + file,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await provisionBackupCatalogTestIndexes(pool);
    await pool.query("INSERT INTO users VALUES($1,$2,$2)", [
      user,
      "member@example.test",
    ]);
    await pool.query("INSERT INTO links VALUES($1)", [branch]);
    await pool.query("INSERT INTO sessions VALUES($1)", [session]);
    await pool.query(
      "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$1,$2,$3)",
      [branch, "https://branch.example", "0".repeat(64)],
    );
    await pool.query(
      "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,$3,true)",
      [profile, user, encrypt(key, master)],
    );
    app = Fastify({ logger: false });
    app.setErrorHandler((e: any, _r: any, reply: any) =>
      reply
        .code(e.status || e.statusCode || 500)
        .send({ error: { code: e.code, message: e.message, ...(e.details?{details:e.details}:{}) } }),
    );
    registerHubBackupsV2Routes(app, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
      maintenance: false,
    });
    registerHubLegacyConversionRoutes(app, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
      startWorker: false,
    });
    registerHubProfileRoutes(app, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
    });
    await app.ready();
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE hub_backup_catalog_pages,hub_backup_replicas,hub_backup_parts,hub_backup_jobs,hub_streams,hub_profile_recoveries,hub_profile_chunk_refs,hub_chunks,hub_commits,hub_writers CASCADE",
    );
    await pool.query(
      "UPDATE hub_profiles SET bytes=0,backup_v2_bytes=0,backup_v2_staging_bytes=0,backup_v2_migration_credit=0,backup_v1_canonical_bytes=0,backup_v1_staging_bytes=0,backup_v1_staging_chunks=0,backup_accounting_version=1,backup_accounting_epoch=0",
    );
    await pool.query(
      "INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '1 day') ON CONFLICT(id) DO NOTHING",
      [session, user, profile, branch, "1".repeat(64), context],
    );
    await pool.query(
      "UPDATE hub_profile_policy_defaults SET profile_bytes=$1",
      [256 * 1024 * 1024],
    );
  });
  afterAll(async () => {
    await browser?.close();for(const main of mainApps)await main.close();
    await mkdir(evidence,{recursive:true});
    await writeFile(resolve(evidence,'FULL_STACK_BROWSER.json'),JSON.stringify(report,null,2)+'\n');
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      await admin.end();
    }
  });

  it('restores65 namespaces through compressed HTTP, keeps local IO independent of held backup, and restores published changes at a second origin',async()=>{
    const namespaceCount=Number(process.env.TEST_BACKUP_STACK_NAMESPACES||65);if(![65,256,1024].includes(namespaceCount))throw Error('UNQUALIFIED_STACK_FIXTURE_SIZE');
    const mainRoot=fileURLToPath(new URL('../../../../',import.meta.url));
    const require=createRequire(resolve(mainRoot,'package.json'));
    const {chromium}=require('@playwright/test');
    const {build}=createRequire(require.resolve('vite'))('esbuild');
    const bundle=async(contents:string)=>(await build({bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',stdin:{resolveDir:resolve(mainRoot,'runtime'),contents}})).outputFiles[0].text;
    const api=await bundle(`import '../web/src/profile-client.ts';export{getLocalFirstProfile,getProfileStatus}from'../web/src/profile-client.ts';export{initializeHubCloud,setHubSession}from'../web/src/hub-client-state.ts';export*from'./profile-context.ts';export{createLocalStorageOwnerV2}from'./sandbox-local-owners-v2.ts';export{createSandboxStorageFacades,rebindSandboxStorageFacades}from'./sandbox-local-storage.ts';`);
    const scripts:Record<string,string>={'/api.js':api,'/runtime/backup-v2-worker.ts':await bundle(`import './backup-v2-worker.ts';const set=self.setTimeout.bind(self),clear=self.clearTimeout.bind(self);const held=new Map();let id=-1;self.setTimeout=(fn,ms,...args)=>{if(ms>=55000&&ms<=900000){const key=id--;held.set(key,()=>fn(...args));return key;}return set(fn,ms,...args)};self.clearTimeout=key=>{if(!held.delete(key))clear(key)};`),'/runtime/replica-native-control-worker-v2.ts':await bundle(`import './replica-native-control-worker-v2.ts';`),'/runtime/receipt-probe-worker-v2.ts':await bundle(`import './receipt-probe-worker-v2.ts';`),'/storage.js':await bundle(`import './storage-native-worker-v2.ts';`)};
    const hubOrigin=await app.listen({host:'127.0.0.1',port:0});
    const {installBackupV2Proxy}=await import(pathToFileURL(resolve(mainRoot,'server/hub-backups-v2-proxy.mjs')).href);
    let hold=false,publishSeen=false,release:()=>void=()=>{};
    async function mainApp(label:string){const main=Fastify({logger:false});main.setErrorHandler((e:any,_q,r)=>r.code(e.status||e.statusCode||500).send({error:{code:e.code,message:e.message}}));
      main.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Real backup stack '+label+'</title><input id="draft"><iframe id="site" srcdoc="<title>Website fixture</title>"></iframe><script type="module">import * as api from "/api.js";window.api=api;</script>'));
      for(const[path,source]of Object.entries(scripts))main.get(path,(_q,r)=>r.type('application/javascript').send(source));
      main.get('/favicon.ico',(_q,r)=>r.code(204).send());
      installBackupV2Proxy(main,{enabled:true,requireSession:async()=>({token:'synthetic',grant:{profileId:profile},branch:{id:branch,secret:'synthetic'}}),csrf:()=>{},hubOrigin,fail:(message:string,statusCode:number,code:string)=>Object.assign(Error(message),{statusCode,code}),requestFetch:async(url:string,init:any)=>{report.requests.push({origin:label,method:init.method,path:new URL(url).pathname});if(hold&&url.endsWith('/publish')){publishSeen=true;await new Promise<void>((resolve,reject)=>{const abort=()=>reject(init.signal.reason||Error('aborted'));init.signal.addEventListener('abort',abort,{once:true});release=()=>{init.signal.removeEventListener('abort',abort);resolve();};if(init.signal.aborted)abort();});}return fetch(url,init);}});
      main.all('/api/hub/profile/*',(_q,r)=>r.code(410).send({error:{code:'PROFILE_LEGACY_SYNC_RETIRED'}}));mainApps.push(main);return main.listen({host:'127.0.0.1',port:0});}
    const origins=await Promise.all([mainApp('A'),mainApp('B')]);
    const remote=async(path:string,method='GET',body?:any)=>{const r=await fetch(hubOrigin+root+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const data=await r.json();expect(r.status,JSON.stringify(data)).toBe(200);return data;};
    const seed={replicaId:randomUUID(),incarnation:randomUUID()};await remote('/replicas','POST',{...seed,label:'Seed synthetic sites'});
    let sequence=0,parent:string|null=null;const nsRows:any[]=[],partBodies=new Map<string,Buffer>();
    for(let n=0;n<namespaceCount;n++){
      const atlas=n===namespaceCount-1,namespace:any=atlas?{kind:'atlas'}:{kind:'local',origin:`https://site${n}.example`};const namespaceVersionId=randomUUID();
      const schemaRecord={operation:'schema',store:'',generation:1,storeEpoch:1,value:await encodePortableValue({format:'atlas-local-schema-v2',kind:atlas?'atlas':'local',version:1,stores:[]})};
      const valueRecord={operation:'put',store:'',key:{t:'string',v:atlas?'atlas.settings':'save'},generation:1,storeEpoch:1,value:await encodePortableValue(atlas?'{"theme":"slate"}':'seed-'+n)};
      const records=[];for(const value of [schemaRecord,valueRecord]){const raw=Buffer.from(canonicalBackupJson(value));const recordId=hash(canonicalBackupJson({namespace,store:value.store,key:(value as any).key||null,operationKey:value.operation==='schema'?'schema':'record'}));records.push({recordId,index:0,count:1,totalBytes:raw.length,sha256:hash(raw),data:raw.toString('base64')});}
      const bytes=Buffer.from(JSON.stringify({format:'atlas-record-page-v2',namespaceVersionId,records})),parts=[{ordinal:0,sha256:hash(bytes),bytes:bytes.length}];partBodies.set(parts[0].sha256,bytes);
      nsRows.push({namespace,namespaceVersionId,parentNamespaceVersionId:null,localCut:1,schemaEpoch:1,kind:'baseline',coverage:'complete-at-cut',rootDigest:hash(canonicalBackupJson(parts)),parts});
    }
    for(let start=0;start<nsRows.length;start+=32){const manifest:any={format:'atlas-checkpoint-v2',checkpointId:randomUUID(),...seed,sequence:++sequence,parentCheckpointId:parent,adoptedThrough:sequence-1,namespaces:nsRows.slice(start,start+32)};manifest.manifestDigest=hash(backupManifestIdentity(manifest));const prepared=await remote('/replicas/'+seed.replicaId+'/checkpoints','POST',manifest);
      for(const sha of prepared.missingParts){const r=await fetch(hubOrigin+root+'/staging/'+manifest.checkpointId+'/parts/'+sha,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:Uint8Array.from(partBodies.get(sha)!).buffer});expect(r.status,await r.text()).toBe(200);}
      let receipt:any;for(let tries=0;tries<100;tries++){receipt=await remote('/staging/'+manifest.checkpointId+'/publish','POST',{});if(receipt.acknowledged)break;await new Promise(r=>setTimeout(r,10));}expect(receipt.acknowledged).toBe(true);parent=manifest.checkpointId;await remote('/replicas/'+seed.replicaId+'/adopt','POST',{adoptedThrough:sequence,checkpointId:parent,manifestDigest:manifest.manifestDigest,incarnation:seed.incarnation});}
    report.checks.seed={namespaces:namespaceCount,parts:namespaceCount,publications:sequence};
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
    const context=await browser.newContext(),a=await context.newPage();let gzip=0;const legacy:string[]=[];a.on('response',async(r:any)=>{if(r.url().includes('/parts/')&&(await r.allHeaders())['content-encoding']==='gzip')gzip++;});
    const state={enabled:true,authenticated:true,csrf:'synthetic',grant:{...sessionValue,expiresAt:'2099-01-01T00:00:00Z',grantExpiresAt:'2099-01-01T00:00:00Z'}};
    async function attach(page:any){await page.waitForFunction(()=>!!(window as any).api);await page.evaluate(async(s:any)=>{const w=window as any;w.state=s;w.api.setHubSession(s);w.start=()=>w.api.initializeHubCloud(s);w.bind=async()=>{await w.api.prepareProfileDocument('https://site0.example');w.profile=w.api.getLocalFirstProfile();w.owner=await w.api.createLocalStorageOwnerV2({workerURL:'/storage.js',localAuthority:w.profile.authority});const id='stack_'+crypto.randomUUID().replaceAll('-',''),b=await w.owner.bind({documentId:id,website:'https://site0.example',sessionId:'fixture_session_0123456789'});const facades=await w.api.createSandboxStorageFacades({documentId:id,endpoint:b.endpoint,port:b.port,window,localOnly:true});w.api.rebindSandboxStorageFacades(facades,document.querySelector('iframe')!.contentWindow!);w.storage=(document.querySelector('iframe')!.contentWindow as any).localStorage;};},state);}
    a.on('request',(req:any)=>{if(/\/api\/hub\/profile\/(commits|writers|stream)(?:$|[/?])/.test(req.url()))legacy.push(req.url());});
    await a.goto(origins[0]);await attach(a);const begin=Date.now();await a.evaluate(()=>(window as any).start());await a.evaluate(()=>(window as any).bind());expect(await a.evaluate(()=>(window as any).storage.getItem('save'))).toBe('seed-0');expect(gzip).toBeGreaterThan(0);
    report.checks.cold={elapsedMs:Date.now()-begin,gzipParts:gzip,loadedWithoutManualChoice:true,pagedNamespaces:report.requests.filter((r:any)=>r.path.endsWith('/namespaces')).length};
    await a.evaluate(()=>{const w=window as any;w.frameIdentity=document.querySelector('iframe')!.contentWindow;w.draft=document.querySelector('input');w.draft.value='unsent draft';w.draft.focus();for(let n=0;n<300;n++)w.storage.setItem('save','source-'+n);});await a.waitForTimeout(600);
    hold=true;await a.evaluate(()=>{const w=window as any;w.flushing=w.profile.retry();});for(let i=0;i<300&&!publishSeen;i++)await new Promise(r=>setTimeout(r,10));expect(publishSeen).toBe(true);
    const during=await a.evaluate(()=>{const w=window as any,start=performance.now();for(let n=0;n<100;n++)w.storage.setItem('while-held','local-'+n);return {value:w.storage.getItem('while-held'),frameSame:w.frameIdentity===document.querySelector('iframe')!.contentWindow,draft:w.draft.value,focus:document.activeElement===w.draft,elapsedMs:performance.now()-start};});expect(during.value).toBe('local-99');expect(during.frameSame&&during.focus).toBe(true);expect(during.draft).toBe('unsent draft');report.checks.localDuringHeldUpload=during;
    hold=false;release();await a.evaluate(()=>(window as any).flushing);await a.waitForTimeout(600);await a.evaluate(()=>(window as any).profile.retry());
    const latest=await remote('/checkpoints/latest?catalog=paged');expect(latest.catalog.namespaceCount).toBe(namespaceCount);report.checks.newCheckpoint={checkpointId:latest.checkpoint.checkpointId,namespaceCount:latest.catalog.namespaceCount};
    const b=await context.newPage();await b.goto(origins[1]);await attach(b);await b.evaluate(()=>(window as any).start());await b.evaluate(()=>(window as any).bind());expect(await b.evaluate(()=>(window as any).storage.getItem('save'))).toBe('source-299');expect(await b.evaluate(()=>(window as any).storage.getItem('while-held'))).toBe('local-99');expect(await a.evaluate(()=>(window as any).draft.value)).toBe('unsent draft');
    report.checks.secondOrigin={restored:'source-299',heldWriteRestored:'local-99',sourceDraftPreserved:true};expect(legacy).toEqual([]);report.checks.legacyRequests=legacy.length;report.result='PASS';await context.close();
  },120000);
});
