// Route-level prototype only: do not activate this as the general browser until
// the complete opaque-runtime/storage release gates are qualified.
export const SANDBOX_FRAME_PATH = "/browse/frame/";
export const SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'";
// Four core ports plus explicitly named optional capabilities form a one-shot grant.
// The bootstrap runs before any website script. It consumes the grant event;
// ordinary website postMessage listeners never receive those ports again.
const CAPABILITY_BOOTSTRAP_TEMPLATE = `(()=>{
  const documentId=location.pathname.split('/').pop(),nonce=__ATLAS_BOOTSTRAP_NONCE__,owner=location.origin;
  let bound=false;const offer=new MessageChannel();
  offer.port1.onmessage=function bind(event){
    if(bound||event.data?.protocol!==2||event.data?.type!=='bind-capabilities'||event.data?.documentId!==documentId||event.data?.nonce!==nonce)return;
    const extras=event.data.capabilities??(event.ports.length===5?['cookies']:[]);
    if(!Array.isArray(extras)||extras.length>4||new Set(extras).size!==extras.length||extras.some(v=>!['cookies','webSocket','nativeResources','caches'].includes(v))||event.ports.length!==4+extras.length)return;
    bound=true;offer.port1.onmessage=null;offer.port1.close();
    const [control,storage,indexedDB,network]=event.ports,optional=Object.fromEntries(extras.map((key,index)=>[key,event.ports[4+index]]));control.start();
    dispatchEvent(new CustomEvent('atlas:document-capabilities',{detail:{documentId,control,storage,indexedDB,network,...optional}}));
    control.postMessage({protocol:2,documentId,type:'bound'});
  };offer.port1.start();
  const ready=()=>{let target=top;for(let i=0;i<__ATLAS_CONTROLLER_OPENER_DEPTH__;i++)target=target?.opener?.top;if(target&&target!==window)target.postMessage({protocol:2,documentId,nonce,type:'sandbox-ready'},owner,[offer.port2]);};
  if(document.readyState==='complete')ready();else addEventListener('load',ready,{once:true});
})();`;
export const SANDBOX_CAPABILITY_BOOTSTRAP =
  CAPABILITY_BOOTSTRAP_TEMPLATE.replace(
    "__ATLAS_BOOTSTRAP_NONCE__",
    "location.hash.slice(1)",
  ).replace("__ATLAS_CONTROLLER_OPENER_DEPTH__", "0");
export function installSandboxFramePrototype(
  app,
  {
    capabilities = false,
    trustedBootstrap = "",
    storageEndpointOrigin,
    cookieEndpointOrigin,
    bootstrapURL,
    nativeResourceOrigin,
    rendererHelperPrefix,
    nestedFramePolicy,
    documentOrigin = "opaque",
  } = {},
) {
  if (!["opaque", "same-origin"].includes(documentOrigin))
    throw TypeError("Invalid frame document origin mode.");
  const serveFrame = (req, reply) => {
    if (!/^[a-zA-Z0-9_-]{16,96}$/.test(req.params.id))
      return reply.code(404).send();
    const endpointOrigin =
      typeof storageEndpointOrigin === "function"
        ? storageEndpointOrigin(req)
        : storageEndpointOrigin;
    const csp =
      capabilities && endpointOrigin
        ? SANDBOX_CSP.replace(
            "connect-src 'none'",
            "connect-src " +
              new URL("/browse/storage/commit/", endpointOrigin).href,
          )
        : SANDBOX_CSP;
    const cookieOrigin =
      typeof cookieEndpointOrigin === "function"
        ? cookieEndpointOrigin(req)
        : cookieEndpointOrigin;
    let finalCSP =
      capabilities && cookieOrigin
        ? csp.replace(
            /connect-src [^;]+/,
            "connect-src " +
              [
                new URL("/browse/cookies/result/", cookieOrigin).href,
                ...(endpointOrigin
                  ? [new URL("/browse/storage/commit/", endpointOrigin).href]
                  : []),
              ].join(" "),
          )
        : csp;
    let bootstrapScript = `<script>${trustedBootstrap.replaceAll("</script", "<\\/script")}</script>`;
    if (capabilities) finalCSP += "; worker-src blob:";
    if (bootstrapURL) {
      const raw =
        typeof bootstrapURL === "function" ? bootstrapURL(req) : bootstrapURL;
      const url = new URL(raw);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        !/^\/browse\/assets\/document-[a-f0-9]{16}\.js$/.test(url.pathname) ||
        url.search ||
        url.hash
      )
        throw TypeError("Invalid trusted document bootstrap URL");
      finalCSP = finalCSP
        .replace(
          "script-src 'unsafe-inline'",
          "script-src 'unsafe-inline' 'unsafe-eval' blob: " + url.href,
        )
        .replace(
          "style-src 'unsafe-inline'",
          "style-src 'unsafe-inline' blob:",
        );
      bootstrapScript = `<script crossorigin="anonymous"${documentOrigin === "same-origin" ? ' data-atlas-document-origin="same-origin"' : ""} src="${url.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></script>`;
    }
    const resourceOrigin =
      capabilities && nativeResourceOrigin?.(req, req.params.id);
    if (resourceOrigin) {
      const resource = new URL(resourceOrigin);
      if (
        resource.protocol !== "https:" ||
        resource.href !== resource.origin + "/" ||
        resourceOrigin !== resource.origin
      )
        throw TypeError("Invalid reserved native resource origin");
      const prefix = resource.origin + "/native-resource/v1/";
      finalCSP = finalCSP
        .replace(
          /script-src ([^;]+)/,
          (_all, value) => "script-src " + value + " " + prefix + "resource/",
        )
        .replace(
          /style-src ([^;]+)/,
          (_all, value) => "style-src " + value + " " + prefix + "resource/",
        )
        .replace(
          /img-src ([^;]+)/,
          (_all, value) =>
            "img-src " +
            value +
            " " +
            prefix +
            "resource/ " +
            prefix +
            "enroll/",
        );
      finalCSP += "; media-src blob: " + prefix + "resource/";
      finalCSP += "; font-src blob:";
    }
    const nested = capabilities && nestedFramePolicy?.(req, req.params.id);
    if (req.url.startsWith("/browse/popup/") && nested?.kind !== "popup")
      return reply.code(404).send();
    if (nested)
      finalCSP = finalCSP.replace(
        "sandbox allow-scripts;",
        "sandbox allow-scripts allow-popups;",
      );
    const capabilitiesBootstrap = CAPABILITY_BOOTSTRAP_TEMPLATE.replace(
      "__ATLAS_BOOTSTRAP_NONCE__",
      nested?.bootstrapNonce
        ? JSON.stringify(nested.bootstrapNonce)
        : "location.hash.slice(1)",
    ).replace(
      "__ATLAS_CONTROLLER_OPENER_DEPTH__",
      String(nested?.controllerOpenerDepth ?? 0),
    );
    const rendererPrefix =
      capabilities && rendererHelperPrefix?.(req, req.params.id);
    if (rendererPrefix) {
      const u = new URL(rendererPrefix),
        owner = new URL(
          typeof bootstrapURL === "function" ? bootstrapURL(req) : bootstrapURL,
        );
      if (
        u.origin !== owner.origin ||
        u.pathname !== "/browse/renderer/v1/" + req.params.id + "/" ||
        u.search ||
        u.hash ||
        u.username ||
        u.password
      )
        throw TypeError("Invalid reserved renderer prefix");
      finalCSP +=
        "; frame-src " + u.href + (nested?.prefix ? " " + nested.prefix : "");
    }
    if (nested?.prefix && !rendererPrefix)
      finalCSP += "; frame-src " + nested.prefix;
    // Opaque ancestors cannot match frame-ancestors 'self'/XFO SAMEORIGIN.
    // Only authenticated controller reservations may opt into nested embedding;
    // the immutable sandbox and one-document port bootstrap remain mandatory.
    if (nested?.nested)
      finalCSP = finalCSP.replace(/; frame-ancestors 'self'/, "");
    if (nested?.nested) reply.removeHeader("X-Frame-Options");
    else reply.header("X-Frame-Options", "SAMEORIGIN");
    // This explicit profile runtime shares the frontend's physical origin.
    // Its profile ports remain, but no opaque sandbox/CSP boundary is claimed.
    if (documentOrigin === "same-origin") {
      reply.removeHeader("Content-Security-Policy");
      reply.header("X-Atlas-Document-Origin", "same-origin");
    } else reply.header("Content-Security-Policy", finalCSP);
    return reply
      .header("Cache-Control", "no-store")
      .header("Vary", "Host, Origin")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(
        capabilities
          ? `<!doctype html><meta charset="utf-8"><title>Atlas website</title>${bootstrapScript}<script>${capabilitiesBootstrap}</script>`
          : `<!doctype html><meta charset="utf-8"><title>Atlas sandbox capability prototype</title><script>
      (()=>{
        const documentId=location.pathname.split('/').pop();
        const nonce=location.hash.slice(1);
        let bound=false;
        addEventListener('message',function bind(event){
          if(bound||event.source!==parent||event.data?.protocol!==2||event.data?.type!=='bind'||event.data?.documentId!==documentId||event.data?.nonce!==nonce||event.ports.length!==1)return;
          bound=true; removeEventListener('message',bind);
          const port=event.ports[0];port.start();
          port.postMessage({protocol:2,documentId,type:'bound'});
        });
        if(parent!==window)parent.postMessage({protocol:2,documentId,nonce,type:'sandbox-ready'},location.origin);
      })();
      </script>`,
      );
  };
  app.get("/browse/frame/:id", serveFrame);
  app.get("/browse/popup/:id", serveFrame);
}
