import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const { registerHubSupportRoutes } = process.env.ATLAS_HUB_SUPPORT_SOURCE
 ? await import(/* @vite-ignore */pathToFileURL(process.env.ATLAS_HUB_SUPPORT_SOURCE).href) : await import("./hubSupport.js");
const { publishSupportBroadcast, supportEventBus } = process.env.ATLAS_HUB_SUPPORT_EVENTS_SOURCE
 ? await import(/* @vite-ignore */pathToFileURL(process.env.ATLAS_HUB_SUPPORT_EVENTS_SOURCE).href) : await import("./hubSupportEvents.js");
const database = process.env.TEST_DATABASE_URL, suite = database ? describe : describe.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i=0;i<300;i++) { if(check())return;await delay(10); } throw Error("Expected transactional event"); }
suite("Global announcements, owned reads and immutable history", () => {
 const schema="announcements_"+randomUUID().replaceAll("-",""), user=randomUUID(),other=randomUUID(),admin=randomUUID();
 const emails=new Map([[user,"reader-one@example.invalid"],[other,"reader-two@example.invalid"],[admin,"admin@example.invalid"]]);
 const app=Fastify(),peer=Fastify();let pool:Pool,maintenance:Pool;
 const headers=(id=user,csrf=true)=>({"x-test-user":id,...(csrf?{"x-test-csrf":"yes"}:{})});
 const authenticate=async(req:any)=>{const id=req.headers["x-test-user"];if(!emails.has(id))throw Object.assign(Error("Unauthorized"),{statusCode:401});return{id,role:id===admin?"admin" as const:"user" as const}};
 const request=(method:any,url:string,payload?:any,id=user,csrf=true)=>app.inject({method,url,headers:headers(id,csrf),...(payload!==undefined?{payload}:{})});
 const publish=async(title="New document link",body="The new document is ready.",id=randomUUID())=>{const r=await request("POST","/api/admin/hub/announcements",{id,title,body},admin);expect(r.statusCode,r.body).toBe(200);return r.json().announcement};
 beforeAll(async()=>{
  if(!new URL(database!).pathname.endsWith("_test"))throw Error("Dedicated test DB required");
  maintenance=new Pool({connectionString:database});await maintenance.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:8});
  await pool.query("CREATE TABLE users(id uuid PRIMARY KEY,email text,status text NOT NULL DEFAULT 'active'); CREATE TABLE audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),admin_id uuid REFERENCES users(id),action text,target_type text,target_id text,after jsonb,created_at timestamptz DEFAULT now())");
  for(const f of["0011_hub_support_metrics.sql","0023_hub_announcements.sql","0024_hub_support_media.sql"])await pool.query(await readFile(new URL("../../../packages/database/migrations/"+f,import.meta.url),"utf8"));
  for(const[id,email]of emails)await pool.query("INSERT INTO users(id,email)VALUES($1,$2)",[id,email]);
  const options={pool,requireUser:authenticate,requireAdmin:async(req:any)=>{const u=await authenticate(req);if(u.role!=="admin")throw Object.assign(Error("Forbidden"),{statusCode:403});return u},csrf:(req:any)=>{if(req.headers["x-test-csrf"]!=="yes")throw Object.assign(Error("CSRF"),{statusCode:403})}};
  await registerHubSupportRoutes(app,options);await registerHubSupportRoutes(app,{...options,userPrefix:"/api/hub/branch",includeAdmin:false});await registerHubSupportRoutes(peer,{...options,includeAdmin:false});await app.ready();await peer.ready();
 });
 beforeEach(async()=>{await pool.query("TRUNCATE hub_announcements,hub_tickets,audit_events CASCADE")});
 afterAll(async()=>{await app.close();await peer.close();await pool?.end();await maintenance?.query(`DROP SCHEMA ${schema} CASCADE`);await maintenance?.end()});
 it("authenticates admin history/publish, denies ordinary users and requires CSRF",async()=>{
  expect((await app.inject("/api/hub/notifications")).statusCode).toBe(401);expect((await app.inject("/api/admin/hub/announcements")).statusCode).toBe(401);
  expect((await request("GET","/api/admin/hub/announcements")).statusCode).toBe(403);expect((await request("POST","/api/admin/hub/announcements",{title:"Test",body:"Message"})).statusCode).toBe(403);
  expect((await request("POST","/api/admin/hub/announcements",{title:"Test",body:"Message"},admin,false)).statusCode).toBe(403);expect((await pool.query("SELECT count(*)::int n FROM hub_announcements")).rows[0].n).toBe(0);
 });
 it("validates bounded plain text, UUIDs and history cursors before publication",async()=>{
  for(const v of[{title:"x".repeat(121),body:"text"},{title:"Valid",body:"x".repeat(5001)},{title:" ",body:"text"},{title:"Valid",body:"bad\0text"},{id:"bad",title:"Valid",body:"text"}])expect((await request("POST","/api/admin/hub/announcements",v,admin)).statusCode).toBeGreaterThanOrEqual(400);
  for(const q of["?limit=0","?limit=101","?limit=1.5","?cursor=oops","?cursor=9223372036854775808"])expect((await request("GET","/api/admin/hub/announcements"+q,undefined,admin)).statusCode).toBe(400);
 });
 it("creates one publication for500 users without notification/read fanout; GET never reads",async()=>{
  await pool.query("INSERT INTO users(id) SELECT gen_random_uuid() FROM generate_series(1,500)");const a=await publish("Global notice","Plain <b>text</b> & https://example.invalid/");
  expect((await pool.query("SELECT count(*)::int n FROM hub_announcements")).rows[0].n).toBe(1);expect((await pool.query("SELECT count(*)::int n FROM hub_notifications")).rows[0].n).toBe(0);
  for(const id of[user,other]){const feed=(await request("GET","/api/hub/notifications",undefined,id)).json();expect(feed.unread).toBe(1);expect(feed.notifications[0]).toMatchObject({id:a.notification_id,kind:"announcement",announcement_id:a.id,subject:"Global notice",ticket_id:null,message_id:null,read_at:null});expect(feed.notifications[0]).not.toHaveProperty("body");const d=(await request("GET","/api/hub/announcements/"+a.id,undefined,id)).json().announcement;expect(d.body).toContain("<b>text</b>");expect(d.read_at).toBeNull();expect(d.created_at).toBe(d.published_at);expect(d).not.toHaveProperty("published_by")}
  expect((await pool.query("SELECT count(*)::int n FROM hub_announcement_reads")).rows[0].n).toBe(0);
 });
 it("replays a stableUUID exactly, audits once and rejects content mutation",async()=>{
  const id=randomUUID(),a=await publish("First","Original message",id),again=await request("POST","/api/admin/hub/announcements",{id,title:"First",body:"Original message"},admin);expect(again.json().replayed).toBe(true);expect(again.json().announcement.notification_id).toBe(a.notification_id);
  expect((await request("POST","/api/admin/hub/announcements",{id,title:"First",body:"Changed message"},admin)).statusCode).toBe(409);expect((await request("PUT","/api/admin/hub/announcements/"+id,{body:"Changed"},admin)).statusCode).toBe(404);expect((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='hub.announcement.publish'")).rows[0].n).toBe(1);
 });
 it("concurrent lost-response retries publish one row and one audit event",async()=>{
  const id=randomUUID(),responses=await Promise.all(Array.from({length:5},()=>request("POST","/api/admin/hub/announcements",{id,title:"Once only",body:"Concurrent publication retry"},admin)));
  expect(responses.every(r=>r.statusCode===200)).toBe(true);expect(new Set(responses.map(r=>r.json().announcement.notification_id)).size).toBe(1);expect((await pool.query("SELECT count(*)::int n FROM hub_announcements")).rows[0].n).toBe(1);expect((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='hub.announcement.publish'")).rows[0].n).toBe(1);
 });
 it("explicit read is CSRF-protected/idempotent and cannot mark another account read",async()=>{
  const a=await publish();expect((await request("POST","/api/hub/announcements/"+a.id+"/read",{},user,false)).statusCode).toBe(403);for(let i=0;i<2;i++)expect((await request("POST","/api/hub/announcements/"+a.id+"/read",{userId:other})).json()).toEqual({ok:true});
  expect((await request("GET","/api/hub/notifications")).json().unread).toBe(0);expect((await request("GET","/api/hub/notifications",undefined,other)).json().unread).toBe(1);const reads=(await pool.query("SELECT user_id FROM hub_announcement_reads")).rows;expect(reads).toEqual([{user_id:user}]);
 });
 it("withdraws once, removes public feed/detail/unread, retains immutable admin history and reads",async()=>{
  const a=await publish();await request("POST","/api/hub/announcements/"+a.id+"/read",{});expect((await request("POST","/api/admin/hub/announcements/"+a.id+"/withdraw",{},other)).statusCode).toBe(403);expect((await request("POST","/api/admin/hub/announcements/"+a.id+"/withdraw",{},admin,false)).statusCode).toBe(403);
  const x=(await request("POST","/api/admin/hub/announcements/"+a.id+"/withdraw",{},admin)).json().announcement,y=(await request("POST","/api/admin/hub/announcements/"+a.id+"/withdraw",{},admin)).json().announcement;expect(y.withdrawn_at).toBe(x.withdrawn_at);
  expect((await request("GET","/api/hub/announcements/"+a.id)).statusCode).toBe(404);expect((await request("POST","/api/hub/announcements/"+a.id+"/read",{})).statusCode).toBe(404);expect((await request("GET","/api/hub/notifications",undefined,other)).json()).toEqual({notifications:[],unread:0});
  const history=(await request("GET","/api/admin/hub/announcements",undefined,admin)).json().announcements;expect(history).toHaveLength(1);expect(history[0].withdrawn_at).toBeTruthy();expect((await pool.query("SELECT count(*)::int n FROM hub_announcement_reads")).rows[0].n).toBe(1);expect((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='hub.announcement.withdraw'")).rows[0].n).toBe(1);
  expect((await request("POST","/api/admin/hub/announcements",{id:a.id,title:a.title,body:a.body},admin)).json().announcement.withdrawn_at).toBe(x.withdrawn_at);
 });
 it("read/withdraw races settle without cross-account receipts or an active unread ghost",async()=>{
  const a=await publish(),responses=await Promise.all([request("POST","/api/hub/announcements/"+a.id+"/read",{},user),request("POST","/api/hub/announcements/"+a.id+"/read",{},other),request("POST","/api/admin/hub/announcements/"+a.id+"/withdraw",{},admin)]);
  expect([200,404]).toContain(responses[0].statusCode);expect([200,404]).toContain(responses[1].statusCode);expect(responses[2].statusCode).toBe(200);for(const id of[user,other])expect((await request("GET","/api/hub/notifications",undefined,id)).json()).toEqual({notifications:[],unread:0});
  expect((await pool.query("SELECT user_id FROM hub_announcement_reads")).rows.every(r=>r.user_id===user||r.user_id===other)).toBe(true);
 });
 it("paginates numeric immutable history without gaps or duplicate rows",async()=>{
  const all=[];for(let i=0;i<5;i++)all.push(await publish("Notice "+i,"Message "+i));const seen=[];let cursor:string|null=null;
  do{const p:any=(await request("GET","/api/admin/hub/announcements?limit=2"+(cursor?"&cursor="+cursor:""),undefined,admin)).json();seen.push(...p.announcements.map((a:any)=>a.id));cursor=p.nextCursor}while(cursor);expect(seen).toEqual(all.reverse().map(a=>a.id));expect(new Set(seen).size).toBe(5);
 });
 it("unread-first bounded feeds reveal older notices after100 newer rows without a GET acknowledgment",async()=>{
  const oldest=await publish("Oldest unread","Keep this notice reachable");
  for(let i=0;i<100;i++)await publish("Newer "+i,"A newer announcement");
  const before=(await request("GET","/api/hub/notifications")).json();expect(before.notifications).toHaveLength(100);expect(before.unread).toBe(101);expect(before.notifications.some((n:any)=>n.announcement_id===oldest.id)).toBe(false);
  expect((await pool.query("SELECT count(*)::int n FROM hub_announcement_reads")).rows[0].n).toBe(0);
  const newest=before.notifications[0];await request("GET","/api/hub/announcements/"+newest.announcement_id);expect((await request("GET","/api/hub/notifications")).json().unread).toBe(101);
  expect((await request("POST","/api/hub/announcements/"+newest.announcement_id+"/read",{})).json()).toEqual({ok:true});
  const after=(await request("GET","/api/hub/notifications")).json();expect(after.notifications).toHaveLength(100);expect(after.unread).toBe(100);expect(after.notifications.some((n:any)=>n.announcement_id===oldest.id&&n.read_at===null)).toBe(true);expect(after.notifications.every((n:any)=>n.read_at===null)).toBe(true);
  expect((await request("GET","/api/hub/notifications",undefined,other)).json().unread).toBe(101);expect((await pool.query("SELECT count(*)::int n FROM hub_announcements")).rows[0].n).toBe(101);
 });
 it("shares numeric support IDs, hides private notes and restricts requester/author email to admins",async()=>{
  const a=await publish(),created=await request("POST","/api/hub/tickets",{subject:"Need assistance",body:"User message for support"}),ticket=created.json().ticket.id;
  await request("POST","/api/admin/hub/tickets/"+ticket+"/messages",{body:"Private admin note",public:false},admin);await request("POST","/api/admin/hub/tickets/"+ticket+"/messages",{body:"Public support reply"},admin);const b=await publish("Latest notice","Another message"),feed=(await request("GET","/api/hub/notifications")).json();expect(feed.notifications.map((n:any)=>n.kind)).toEqual(["announcement","support","announcement"]);expect(feed.unread).toBe(3);const ids=feed.notifications.map((n:any)=>BigInt(n.id));expect(ids[0]>ids[1]&&ids[1]>ids[2]).toBe(true);expect(ids[0]).toBe(BigInt(b.notification_id));expect(ids[2]).toBe(BigInt(a.notification_id));
  const d=(await request("GET","/api/hub/tickets/"+ticket)).json();expect(d.messages.map((m:any)=>m.body)).not.toContain("Private admin note");expect(d.ticket).not.toHaveProperty("requester_email");expect(d.messages.every((m:any)=>!Object.hasOwn(m,"author_email"))).toBe(true);expect((await request("GET","/api/hub/tickets/"+ticket,undefined,other)).statusCode).toBe(404);
  const ad=(await request("GET","/api/admin/hub/tickets/"+ticket,undefined,admin)).json();expect(ad.ticket.requester_email).toBe(emails.get(user));expect(ad.messages.find((m:any)=>m.author==="user").author_email).toBe(emails.get(user));expect(ad.messages.some((m:any)=>m.body==="Private admin note")).toBe(true);expect((await request("GET","/api/admin/hub/tickets",undefined,admin)).json().tickets[0].requester_email).toBe(emails.get(user));expect((await request("GET","/api/hub/tickets")).json().tickets[0]).not.toHaveProperty("requester_email");
 });
 it("returns honest null identity for legacy unclaimed tickets",async()=>{
  const t=(await pool.query("INSERT INTO hub_tickets(subject,category,legacy_source,legacy_id)VALUES('Legacy question','Other','old','fixture') RETURNING id")).rows[0];await pool.query("INSERT INTO hub_ticket_messages(ticket_id,author,body)VALUES($1,'user','Legacy body')",[t.id]);const d=(await request("GET","/api/admin/hub/tickets/"+t.id,undefined,admin)).json();expect(d.ticket.requester_email).toBeNull();expect(d.messages[0].author_email).toBeNull();
 });
 it("uses the same authenticated read receipts through the Browser branch prefix",async()=>{
  const a=await publish();expect((await request("GET","/api/hub/branch/announcements/"+a.id,undefined,other)).statusCode).toBe(200);expect((await request("POST","/api/hub/branch/announcements/"+a.id+"/read",{},other)).json()).toEqual({ok:true});expect((await request("GET","/api/hub/branch/notifications",undefined,other)).json().unread).toBe(0);expect((await request("GET","/api/hub/notifications")).json().unread).toBe(1);
 });
 it("broadcasts committed invalidations through shared listeners without any publication content",async()=>{
  const bus=await supportEventBus(app,pool),remote=await supportEventBus(peer,pool),events:any[]=[],peerEvents:any[]=[];const off=[bus.listen(user,(e:any)=>events.push(e)),bus.listen(other,(e:any)=>events.push(e)),remote.listen(other,(e:any)=>peerEvents.push(e))];
  try{const c=await pool.connect();try{await c.query("BEGIN");await publishSupportBroadcast(c,"987654");await c.query("ROLLBACK")}finally{c.release()}await delay(40);expect(events).toHaveLength(0);await publish("Private publication title","Private publication body");await until(()=>events.length===2&&peerEvents.length===1);for(const e of[...events,...peerEvents]){expect(Object.keys(e).sort()).toEqual(["revision","type"]);expect(e.type).toBe("support.changed");expect(e.revision).toMatch(/^\d+$/)}expect(JSON.stringify(events)).not.toContain("publication")}
  finally{for(const fn of off)fn()}
 });
});
