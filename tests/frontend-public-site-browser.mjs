/** Account-free diagnostics through the ACTUAL default Main relay/controller.
 * No upstream response fixture or native frontend fetch fallback is used.
 * Output is metadata only: no response bodies, cookies, headers or URL tokens.
 * This local qualification does not stand in for affected-fleet acceptance. */
import fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(),
  target = process.argv[2] || "https://discord.com/";
if (
  ![
    "https://discord.com/",
    "https://discord.com/login",
    "https://chatgpt.com/",
    "https://orteil.dashnet.org/cookieclicker/",
    "https://mail.google.com/",
  ].includes(target)
)
  throw Error("Use an account-free qualification entry URL");
const evidence = join(root, "evidence/frontend-public-sites-20261016");
await fs.mkdir(evidence, { recursive: true });
const base = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
const start = base.indexOf("  const png ="),
  end = base.lastIndexOf("\n} finally {");
if (start < 0 || end < start)
  throw Error("Public-site qualification fixture changed");
let source = base.slice(0, start);
source = source.replace(
  "export {createFrontendBrowser} from './frontend-browser.ts';",
  "export {createFrontendBrowser} from './frontend-browser.ts';export {createSandboxRelayFetch} from './sandbox-relay.ts';",
);
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
source +=
  `
  const report=await page.evaluate(async target=>{
    const {createFrontendBrowser,createSandboxRelayFetch}=await import('/fixture.js');
    const stages=[],states=[];let failure;
    const safeURL=value=>{try{const u=new URL(value);return u.origin+u.pathname}catch{return 'invalid-url'}};
    const safeError=error=>({name:String(error?.name||'Error').slice(0,80),code:typeof error?.code==='string'?error.code.slice(0,120):undefined,directive:typeof error?.directive==='string'?error.directive.slice(0,80):undefined,message:String(error?.message||'').replace(/https?:[^\\s"'<>]+/g,'[URL]').replace(/[A-Za-z0-9_-]{40,}/g,'[REDACTED]').slice(0,240)});
    let controller;
    try{
      controller=await createFrontendBrowser({container:document.querySelector('main'),timeoutMs:30000,
        onState:state=>states.push({status:state.status,code:state.code}),
        components:{fetch:fixed=>{const actual=createSandboxRelayFetch(fixed);return async(request,context)=>{
          const stage={url:safeURL(request.url),destination:request.destination||'navigation-or-connect',preflight:context.preflight};
          stages.push(stage);
          try{const response=await actual(request,context);stage.status=response.status;stage.mime=response.headers.find(([name])=>name.toLowerCase()==='content-type')?.[1]?.split(';')[0];stage.bytes=response.body.byteLength;if(stage.mime==='text/html'&&response.body.byteLength<8*1024*1024){const inert=new DOMParser().parseFromString(new TextDecoder().decode(response.body),'text/html');const counts={};for(const element of inert.querySelectorAll('iframe,frame,object,embed,applet,base,form,video,audio,source,track,portal,template,svg,math,input[type=image],[srcset],[poster],[background]'))counts[element.localName]=(counts[element.localName]||0)+1;stage.unsupportedMarkup=counts;stage.originalLoadCounts={externalScripts:inert.querySelectorAll('script[src]').length,inlineScripts:inert.querySelectorAll('script:not([src])').length,stylesheets:inert.querySelectorAll('link[rel~=stylesheet]').length,images:inert.querySelectorAll('img').length};stage.inlineHandlerElements=[...inert.querySelectorAll('*')].filter(element=>[...element.attributes].some(attribute=>/^on/i.test(attribute.name))).length;stage.linkRelations=[...new Set([...inert.querySelectorAll('link[href]')].flatMap(element=>(element.getAttribute('rel')||'').toLowerCase().split(/ +/)))].filter(value=>['stylesheet','icon','manifest','preload','prefetch','modulepreload','preconnect','dns-prefetch','canonical','alternate','apple-touch-icon'].includes(value));}stage.policyDirectives=response.headers.filter(([name])=>name.toLowerCase()==='content-security-policy').flatMap(([,policy])=>policy.split(';').map(directive=>directive.trim().split(/ +/)[0]).filter(name=>/^[a-z-]{1,48}$/.test(name)));stage.executionPolicyKeywords=[...new Set(response.headers.filter(([name])=>name.toLowerCase()==='content-security-policy').flatMap(([,policy])=>policy.split(/[\\t\\n\\f\\r ;]+/).filter(value=>/^'(?:unsafe-eval|wasm-unsafe-eval|trusted-types-eval|unsafe-inline)'$/.test(value))))];stage.localPolicySources=response.headers.filter(([name])=>name.toLowerCase()==='content-security-policy').flatMap(([,policy])=>policy.split(';').map(directive=>directive.trim().split(/ +/)).map(([name,...values])=>({directive:name,localSources:values.filter(v=>/^(?:data|blob|filesystem|mediastream):$/.test(v)||/^'(?:strict-dynamic|unsafe-hashes)'$/.test(v))})).filter(v=>v.localSources.length));if(${JSON.stringify(process.env.ATLAS_PROBE_SOURCE_ONLY === "1")}&&stage.destination==='document')throw Object.assign(Error('Source metadata captured without resource traversal'),{code:'SOURCE_METADATA_CAPTURED'});return response}
          catch(error){stage.error=safeError(error);throw error}
        }}}});
      window.publicSiteController=controller;
      await controller.start(target);
    }catch(error){failure=safeError(error)}
    return {target:safeURL(target),states,stageCount:stages.length,stages:stages.length<=128?stages:[...stages.slice(0,64),...stages.slice(-64)],failure,assignment:controller?.assignment?{node:controller.assignment.node.name,generation:controller.assignment.generation}:undefined};
  },${JSON.stringify(target)});
  await page.waitForTimeout(2500);
  const document=page.frames().find(frame=>frame.url().startsWith(frontend+'/browse/frame/'));
  if(document)report.render=await document.evaluate(()=>({bodyElements:document.body?.querySelectorAll('*').length||0,textLength:document.body?.innerText?.trim().length||0,images:document.images.length,loadedImages:[...document.images].filter(image=>image.complete&&image.naturalWidth>0).length})).catch(()=>({documentUnavailable:true}));
  report.scope='Actual local Main/default transport and private controller; fresh profile; not affected-deployment/fleet acceptance';
  report.ready=report.states.at(-1)?.status==='ready'&&!report.failure&&report.render?.textLength>10;
  const file=${JSON.stringify(join(evidence, new URL(target).hostname.replaceAll(".", "-") + (new URL(target).pathname === "/login" ? "-login" : "") + (process.env.ATLAS_PROBE_SOURCE_ONLY === "1" ? "-source-only" : "") + ".json"))};
  await fs.writeFile(file,JSON.stringify(report,null,2)+'\\n');console.log(JSON.stringify(report));
  await page.evaluate(()=>window.publicSiteController?.dispose());
  if(!report.ready)process.exitCode=2;
` + base.slice(end);
const probe = join(evidence, "probe-" + process.pid + ".mjs");
await fs.writeFile(probe, source);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await fs.rm(probe, { force: true });
}
