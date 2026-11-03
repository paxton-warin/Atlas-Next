import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {pathToFileURL} from "node:url";
import type{Pool}from"pg";
import {AppError}from"./errors.js";
import {hashSecret}from"./security.js";
const{registerHubIdentityRoutes}=process.env.ATLAS_HUB_IDENTITY_SOURCE
 ?await import(/* @vite-ignore */pathToFileURL(process.env.ATLAS_HUB_IDENTITY_SOURCE).href)
 :await import("./hubIdentity.js");
function fixture(){
 const sessionSecret="synthetic-support-admission-secret-0123456789",branchId=randomUUID(),secret="b".repeat(43),accounts=new Map<string,any>();let assigned=true,eligible=true,seen=0;
 const pool={query:async(sql:string,values:any[]=[])=>{
  if(sql.startsWith("SELECT b.*"))return{rows:[{id:branchId,secret_hash:hashSecret(secret,sessionSecret)}],rowCount:1};
  if(sql.startsWith("SELECT bs.*")){const row=accounts.get(values[0]);return{rows:row?[row]:[],rowCount:row?1:0};}
  if(sql.includes("SELECT 1 FROM hub_branches"))return{rows:assigned?[{}]:[],rowCount:assigned?1:0};
  if(sql.startsWith("UPDATE hub_branch_sessions")){seen++;return{rows:[],rowCount:1};}throw Error("UNEXPECTED_QUERY");
 }}as unknown as Pool;
 const app={get(){},post(){},put(){},delete(){}}as any;
 const identity=registerHubIdentityRoutes(app,{pool,sessionSecret,encryptionKey:"unused",requireUser:async()=>{throw Error("unused")},requireEligibleUser:async()=>{throw Error("unused")},requireAdmin:async()=>{throw Error("unused")},csrf(){},assertEligible:async()=>{if(!eligible)throw new AppError("FORBIDDEN","Suspended synthetic account",403)}});
 function request(index=1,path="/api/hub/branch/events",method="GET"){
  const token=String(index).padStart(43,"t"),key=hashSecret(token,sessionSecret);if(!accounts.has(key))accounts.set(key,{id:randomUUID(),user_id:randomUUID(),profile_id:randomUUID(),context_id:randomUUID(),branch_id:branchId,email:"synthetic@example.invalid",role:"user",status:"active",parent_session_id:randomUUID(),expires_at:new Date(Date.now()+3600000),parent_expires:new Date(Date.now()+3600000)});
  return{method,url:path,headers:{"x-atlas-branch-id":branchId,authorization:"Bearer "+secret,"x-atlas-branch-session":token},ip:"192.0.2.10"}as any;
 }
 return{identity,request,seen:()=>seen,accounts,denyAssignment:()=>assigned=false,suspend:()=>eligible=false};
}
describe("verified support activity admission",()=>{
 it("500 verified accounts can each open and acknowledge a global announcement without changing budgets",async()=>{
  const f=fixture(),id=randomUUID();for(let account=1;account<=500;account++){await f.identity.authenticate(f.request(account,"/api/hub/branch/announcements/"+id));await f.identity.authenticate(f.request(account,"/api/hub/branch/announcements/"+id+"/read","POST"));}expect(f.seen()).toBe(1000);
 });
 it("only exact UUID detail/read methods share support120; malformed/query/admin variants retain ordinary600",async()=>{
  const id=randomUUID();for(const[path,method]of[["/api/hub/branch/announcements/"+id+"?extra=1","GET"],["/api/hub/branch/announcements/no-id","GET"],["/api/hub/branch/announcements/"+id,"POST"],["/api/hub/branch/announcements/"+id+"/read","GET"],["/api/hub/branch/announcements/"+id+"/read/extra","POST"]]){const f=fixture();for(let i=0;i<600;i++)await f.identity.authenticate(f.request(1,path,method));await expect(f.identity.authenticate(f.request(1,path,method))).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429})}
  const f=fixture();for(let i=0;i<120;i++)await f.identity.authenticate(f.request(1,"/api/hub/branch/announcements/"+id+"/read","POST"));await expect(f.identity.authenticate(f.request(1))).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});
 });
 it("announcement routes do not give invalid sessions a verified allowance",async()=>{
  for(const method of["GET","POST"]){const f=fixture(),r=f.request(1,"/api/hub/branch/announcements/"+randomUUID()+(method==="POST"?"/read":""),method);f.accounts.clear();for(let i=0;i<600;i++)await expect(f.identity.authenticate(r)).rejects.toMatchObject({code:"HUB_SESSION_EXPIRED",status:401});await expect(f.identity.authenticate(r)).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});expect(f.seen()).toBe(0)}
 });
 it("500 ordinary accounts share one branch for realistic15s SSE auth+poll+connect/ready activity",async()=>{
  const f=fixture();for(let poll=0;poll<5;poll++)for(let account=1;account<=500;account++){await f.identity.authenticate(f.request(account));await f.identity.authenticate(f.request(account,"/api/hub/branch/notifications"));}expect(f.seen()).toBe(5000);
 });
 it("combined support budget is120 per verified account/profile, isolated from other accounts and lanes",async()=>{
  const f=fixture();for(let i=0;i<120;i++)await f.identity.authenticate(f.request(1,i%2?"/api/hub/branch/events":"/api/hub/branch/notifications"));await expect(f.identity.authenticate(f.request())).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});expect(f.seen()).toBe(120);await expect(f.identity.authenticate(f.request(2))).resolves.toHaveProperty("profileId");await expect(f.identity.authenticate(f.request(1,"/api/hub/branch/profile"))).resolves.toHaveProperty("profileId");await expect(f.identity.authenticate(f.request(1,"/api/hub/branch/session","POST"))).resolves.toHaveProperty("profileId");
 });
 it("aggregate support budget is12000/branch and does not consume general600 controls",async()=>{
  const f=fixture();for(let account=1;account<=100;account++)for(let i=0;i<120;i++)await f.identity.authenticate(f.request(account,i%2?"/api/hub/branch/events":"/api/hub/branch/notifications"));expect(f.seen()).toBe(12000);await expect(f.identity.authenticate(f.request(101))).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});for(let i=0;i<600;i++)await f.identity.authenticate(f.request(1,"/api/hub/branch/session","DELETE"));await expect(f.identity.authenticate(f.request(1,"/api/hub/branch/session","DELETE"))).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});
 });
 it("only exact GET events/notifications qualify, not query variants,prefixes or mutations",async()=>{
  for(const[path,method]of[["/api/hub/branch/events?extra=1","GET"],["/api/hub/branch/notifications/extra","GET"],["/api/hub/branch/notifications","POST"],["/api/hub/branch/events","DELETE"]]){const f=fixture();for(let i=0;i<600;i++)await f.identity.authenticate(f.request(1,path,method));await expect(f.identity.authenticate(f.request(1,path,method))).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});}
 });
 it("invalid or revoked sessions retain600 ordinary failures and never touch activity",async()=>{
  for(const path of["/api/hub/branch/events","/api/hub/branch/notifications"]){const f=fixture(),r=f.request(1,path);f.accounts.clear();for(let i=0;i<600;i++)await expect(f.identity.authenticate(r)).rejects.toMatchObject({code:"HUB_SESSION_EXPIRED",status:401});await expect(f.identity.authenticate(r)).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});expect(f.seen()).toBe(0);}
 });
 it("assignment/eligibility failure retains600 ordinary failures, not verified allowance",async()=>{
  for(const failure of["assignment","suspension"]){const f=fixture(),r=f.request();if(failure==="assignment")f.denyAssignment();else f.suspend();for(let i=0;i<600;i++)await expect(f.identity.authenticate(r)).rejects.toMatchObject({status:403});await expect(f.identity.authenticate(r)).rejects.toMatchObject({code:"HUB_RATE_LIMITED",status:429});expect(f.seen()).toBe(0);}
 });
 it("forged branch secrets fail before account classification",async()=>{const f=fixture(),r=f.request();r.headers.authorization="Bearer "+"x".repeat(43);await expect(f.identity.authenticate(r)).rejects.toMatchObject({code:"HUB_BRANCH_UNAUTHORIZED",status:401});expect(f.seen()).toBe(0);});
});
