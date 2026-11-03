import {describe,it,expect} from 'vitest';
import Fastify from 'fastify';
import{registerHubAtlasControlRoutes}from'./hubAtlasControl.js';
const admin={id:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',role:'admin'};
async function fixture(key?:string,authorized=true){
 const app=Fastify(),calls:Array<{url:string,init:RequestInit}>=[];
 await registerHubAtlasControlRoutes(app,{
  pool:{query:async()=>({rows:[]})},requireUser:async()=>admin,requireAdmin:async()=>{if(!authorized)throw Object.assign(Error('Unauthorized'),{statusCode:401});return admin},csrf:()=>{},
  coordinatorOrigin:'https://coordinator.example',coordinatorOriginKey:key,serviceSecret:'service-private-token-00000000000000',
  fetch:async(url:any,init:any)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({nodes:[]}),{status:200,headers:{'content-type':'application/json'}})}
 } as any);
 return{app,calls};
}
describe('stable coordinator private edge routing',()=>{
 it('uses only the fixed coordinator and both required private headers without exposing them to the browser',async()=>{
  const f=await fixture('main-origin-private-key-00000');try{
   const r=await f.app.inject({url:'/api/admin/hub/atlas'});expect(r.statusCode).toBe(200);expect(f.calls).toHaveLength(1);
   expect(f.calls[0]!.url).toBe('https://coordinator.example/api/internal/hub/control');
   expect(f.calls[0]!.init.headers).toMatchObject({authorization:'Bearer service-private-token-00000000000000','x-atlas-origin-key':'main-origin-private-key-00000'});
   expect(f.calls[0]!.init.redirect).toBe('error');expect(r.body).not.toContain('private');
  }finally{await f.app.close()}
 });
 it('retains prior behavior when no edge routing key is configured',async()=>{
  const f=await fixture();try{await f.app.inject({url:'/api/admin/hub/atlas'});expect(f.calls[0]!.init.headers).not.toHaveProperty('x-atlas-origin-key')}finally{await f.app.close()}
 });
 it('requires administrator authorization before making any credential-bearing call',async()=>{
  const f=await fixture('main-origin-private-key-00000',false);try{expect((await f.app.inject({url:'/api/admin/hub/atlas'})).statusCode).toBe(401);expect(f.calls).toHaveLength(0)}finally{await f.app.close()}
 });
 it('never turns an arbitrary command or URL into a privileged proxy',async()=>{
  const f=await fixture('main-origin-private-key-00000');try{
   const r=await f.app.inject({method:'POST',url:'/api/admin/hub/atlas/command',payload:{operation:'fetch',input:{url:'https://untrusted.example'}}});expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(f.calls).toHaveLength(0);
  }finally{await f.app.close()}
 });
 it('rejects invalid routing header bytes before serving requests',async()=>{
  await expect(fixture('private-key-value\r\nforged:value')).rejects.toThrow('Coordinator origin routing key is invalid.');
 });
});
