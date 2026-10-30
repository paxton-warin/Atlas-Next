/** Revision-checked private endpoint rotation; browsing credentials never change. */
import { createHash,timingSafeEqual } from 'node:crypto';
import { requestOrigin } from './request-origin.mjs';
import { coordinatorEndpointSnapshot } from './hub-endpoint-snapshot.mjs';
const failure=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const same=(left,right)=>{if(typeof left!=='string'||typeof right!=='string')return false;const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);};
function origin(raw){let u;try{u=new URL(raw);}catch{throw failure('A valid HTTPS endpoint is required.');}if(u.protocol!=='https:'||u.origin!==raw||u.username||u.password)throw failure('A valid HTTPS endpoint origin is required.');return u.origin;}
export async function installHubEndpoints(app,{config,store,pool,fetch:requestFetch=globalThis.fetch}){
 const currentHub=store.get('hubCurrentOrigin');if(currentHub)config.hubOrigin=origin(currentHub);
 app.get('/api/internal/hub/endpoints',async(req,reply)=>{
  if(!config.hubServiceSecret||config.hubServiceSecret.length<32)throw failure('Endpoint control is not configured.',503);
  if(req.headers.origin!==undefined||!same(req.headers.authorization,'Bearer '+config.hubServiceSecret))throw failure('Service authorization required.',401);
  if(req.url!=='/api/internal/hub/endpoints')throw failure('Invalid endpoint snapshot request.');
  reply.header('Cache-Control','private, no-store').header('Vary','Authorization, X-Atlas-Origin-Key');
  return coordinatorEndpointSnapshot({config,store,requestOrigin:requestOrigin(req,config.appOrigin)});
 });
 for(const method of ['POST','DELETE'])app.route({method,url:'/api/internal/hub/qualification-aliases',handler:async(req,reply)=>{
  if(!config.hubServiceSecret||config.hubServiceSecret.length<32)throw failure('Endpoint control is not configured.',503);
  if(req.headers.origin!==undefined||!same(req.headers.authorization,'Bearer '+config.hubServiceSecret))throw failure('Service authorization required.',401);
  if(!pool.qualification)throw failure('Qualification routing is unavailable.',503);
  reply.header('Cache-Control','private, no-store');
  return method==='POST'?pool.qualification.stage(req.body):pool.qualification.remove(req.body);
 }});
 app.post('/api/internal/hub/endpoints',async req=>{
  if(!config.hubServiceSecret||config.hubServiceSecret.length<32)throw failure('Endpoint control is not configured.',503);
  if(req.headers.origin||!same(req.headers.authorization,'Bearer '+config.hubServiceSecret))throw failure('Service authorization required.',401);
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||!Number.isSafeInteger(b.generation)||b.generation<1||Object.keys(b).some(k=>!['generation','hubOrigin','previousHubOrigin','nodes'].includes(k)))throw failure('Invalid endpoint operation.');
  const nodes=b.nodes??[];if(!Array.isArray(nodes)||nodes.length>32||(!b.hubOrigin&&!nodes.length))throw failure('Specify Hub or node endpoints.');
  const seen=new Set();for(const n of nodes){if(!n||typeof n.id!=='string'||n.id==='local'||seen.has(n.id)||Object.keys(n).some(k=>!['id','previousEndpoint','endpoint'].includes(k)))throw failure('Invalid node endpoint operation.');seen.add(n.id);origin(n.endpoint);origin(n.previousEndpoint);}
  if(b.hubOrigin){origin(b.hubOrigin);origin(b.previousHubOrigin);}
  const hash=createHash('sha256').update(JSON.stringify({generation:b.generation,hubOrigin:b.hubOrigin,previousHubOrigin:b.previousHubOrigin,nodes})).digest('hex');
  let current=store.get('hubEndpointRevision')??{generation:0,hash:''};if(b.generation===current.generation&&hash===current.hash)return{ok:true,generation:current.generation,replayed:true};if(b.generation!==current.generation+1)throw failure('Endpoint generation is stale.',409);
  if(b.hubOrigin&&config.hubOrigin!==b.previousHubOrigin)throw failure('Hub endpoint changed.',409);
  for(const n of nodes){const old=store.db.prepare('SELECT id,endpoint,credential FROM nodes WHERE id=?').get(n.id);if(!old||old.endpoint!==n.previousEndpoint)throw failure('Node endpoint changed.',409);let response;try{response=await requestFetch(n.endpoint+'/node/health',{headers:{authorization:'Bearer '+store.unseal(old.credential)},signal:AbortSignal.timeout(5000),redirect:'error'});}catch{throw failure('Replacement node is unavailable.',503);}let health;try{health=await response.json();}catch{}if(!response.ok||health?.id!==n.id)throw failure('Replacement node identity did not match.',409);}
  if(b.hubOrigin){let response;try{response=await requestFetch(b.hubOrigin+'/health/ready',{signal:AbortSignal.timeout(5000),redirect:'error'});}catch{throw failure('Replacement Hub is unavailable.',503);}if(!response.ok)throw failure('Replacement Hub is not healthy.',503);}
  store.db.exec('BEGIN IMMEDIATE');try{current=store.get('hubEndpointRevision')??{generation:0,hash:''};if(b.generation!==current.generation+1)throw failure('Endpoint generation changed.',409);for(const n of nodes)pool.updateEndpoint(n);if(b.hubOrigin)store.set('hubCurrentOrigin',b.hubOrigin);store.set('hubEndpointRevision',{generation:b.generation,hash});store.audit('hub.endpoints.rotate',String(b.generation));store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
  if(b.hubOrigin)config.hubOrigin=b.hubOrigin;return{ok:true,generation:b.generation,hubOrigin:config.hubOrigin,nodes:nodes.map(n=>({id:n.id,endpoint:n.endpoint}))};
 });
}
