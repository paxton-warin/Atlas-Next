import {createHash} from 'node:crypto';

/** The pinned WASM static-import writer resolves paths against the source module
 * URL, but also incorrectly uses that URL's origin as the fetch initiator. This
 * private scope changes only the origin import used DURING that synchronous
 * WASM rewrite. URL resolution and the original source-map construction remain
 * inside WASM; no browser global or already-rewritten source is modified. */
export function createModuleInitiatorScope(NativeURL) {
  let current = null;
  return {
    run(value, isModule, operation) {
      let next = null;
      if (isModule && value !== undefined && value !== null) {
        if (typeof value !== 'string') throw new TypeError('Invalid module initiator origin');
        const parsed = new NativeURL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value ||
            parsed.username || parsed.password)
          throw new TypeError('Invalid module initiator origin');
        next = parsed.origin;
      }
      const previous = current;
      current = next;
      try { return operation(); }
      finally { current = previous; }
    },
    origin(value) { return current === null ? value.origin : current; },
  };
}

/** Fetch metadata keeps the source URL as the resolution base. Only a native
 * client inside the SAME controller prefix supplies the logical environment
 * origin. A propagated origin is used solely when no native client exists. */
export function createModuleIdentityContext(NativeURL) {
  const parse = value => { try { return new NativeURL(value); } catch { return undefined; } };
  const origin = value => {
    const parsed = parse(value);
    return parsed && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.origin : undefined;
  };
  const canonical = value => typeof value === 'string' && origin(value) === value ? value : undefined;
  return {
    origin,
    request(request, context, parsed) {
      if (!parsed.isModule) return undefined;
      if (request.rawClientUrl) {
        const prefix = parse(context.prefix), client = parse(request.rawClientUrl);
        if (!prefix || !client || client.origin !== prefix.origin ||
            !prefix.pathname.endsWith('/') || !client.pathname.startsWith(prefix.pathname)) return undefined;
        return origin(parsed.clientUrl);
      }
      return canonical(parsed.fetchInitiatorOrigin);
    },
  };
}

export const MODULE_IDENTITY_INPUTS = {
  'runtimekit.js': 'cf2f5e3465b27f2a11872a497c9395656480a434f1ffc4c3f8696a8b22d4ba49',
  'runtimekit-normal.js': 'ceb12d65e394bfbe8000dc9e2afb035526217af055bc1fbc3a7e89c7f2057784',
  'runtimekit-worker.js': 'e777b2866bb822ae7eadbc890d4a2c56ed6231f67444c855141de3187a841095',
};
export const MODULE_IDENTITY_OUTPUTS = {
  "runtimekit.js": "b8bb8122b4c62c514993c533848507481db1046d63ef4dd1e126739562672be3",
  "runtimekit-normal.js": "097f33ad8311a730131d833a57e6fb7291ac86cb34e1c63cf3bfa416aeea735a",
  "runtimekit-worker.js": "62e142acd283833a547bf95a29102b13b53ce69ced5494dd660345f330d69e16"
};
/** Explicit compatibility path for the observed live release. This entrypoint
 * applies ONLY module identity and does not introduce the newer cancellation
 * protocol, fetch hooks, transport signals or controller RPC adaptations. */
export const MODULE_IDENTITY_PRE_CANCELLATION_INPUTS = {
  'runtimekit.js': '9c5798c30098d753d85dbdcf8286452ac0184aac774831b89de99eeea509ff37',
  'runtimekit-normal.js': '8af727441170c86385c71fa1ee08640dbe9012482f32b62301fc16f97f9b3bf5',
  'runtimekit-worker.js': '243fb4ee3beff746f9dd571297c9dcad6fc2a006f81880f322a28e5209b72d4f',
};
export const MODULE_IDENTITY_PRE_CANCELLATION_OUTPUTS = {
  "runtimekit.js": "98e911b2fb905c2e71055a83ea0231c7d218b399f84e02c567e76790ab33c20e",
  "runtimekit-normal.js": "187c11a659aeb9de042d969b42ea8201b1b9c407ac1a5e536262f5c7b90c0489",
  "runtimekit-worker.js": "125b454a92ed3ff06fa747fe9bb0e8425abad8070dafc4f71836a392c9ca2f50"
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Module identity build seam changed');
  return source.replace(before, after);
}
export function adaptModuleIdentity(bytes) {
  const input = sha(bytes), kind = Object.keys(MODULE_IDENTITY_INPUTS).find(k => MODULE_IDENTITY_INPUTS[k] === input);
  if (!kind) throw Error('Module identity requires qualified post-cancellation core');
  const output = applyModuleIdentityEdits(bytes);
  if (sha(output) !== MODULE_IDENTITY_OUTPUTS[kind]) throw Error('Module identity output hash mismatch');
  return output;
}

export function adaptModuleIdentityForPreCancellationRelease(bytes) {
  const input = sha(bytes), kind = Object.keys(MODULE_IDENTITY_PRE_CANCELLATION_INPUTS).find(k => MODULE_IDENTITY_PRE_CANCELLATION_INPUTS[k] === input);
  if (!kind) throw Error('Module identity requires qualified pre-cancellation release core');
  const output = applyModuleIdentityEdits(bytes);
  if (sha(output) !== MODULE_IDENTITY_PRE_CANCELLATION_OUTPUTS[kind])
    throw Error('Pre-cancellation module identity output hash mismatch');
  return output;
}

function applyModuleIdentityEdits(bytes) {
  let source = bytes.toString();
  source = replaceOnce(source, 'var i,n,o,s,a,A,l={8770',
    'const atlasModuleIdentityContext=(' + createModuleIdentityContext.toString() + ')(URL);var i,n,o,s,a,A,l={8770');
  source = replaceOnce(source,
    'for(let e of(0,o.BR)(r.config.flags))u[e]=(0,i.U5)(e,r,a.base);',
    'for(let e of(0,o.BR)(r.config.flags))u[e]=(0,i.U5)(e,r,a.base);u.atlasModuleInitiator=a.moduleInitiator??atlasModuleIdentityContext.origin(a.origin);');
  source = replaceOnce(source,
    'return e.rawClientUrl&&(y.clientUrl=new i.xP((0,n.v2)(e.rawClientUrl,t.context))),y',
    'return e.rawClientUrl&&(y.clientUrl=new i.xP((0,n.v2)(e.rawClientUrl,t.context))),y.meta.moduleInitiator=atlasModuleIdentityContext.request(e,t.context,y),y');
  source = replaceOnce(source,
    'this.meta={get origin(){return r.url},get base()',
    'this.meta={get origin(){return r.url},get moduleInitiator(){return atlasModuleIdentityContext.origin(r.url)},get base()');
  source = replaceOnce(source, 'class w{__destroy_into_raw()',
    'const atlasModuleIdentityScope=(' + createModuleInitiatorScope.toString() + ')(URL);class w{__destroy_into_raw()');
  source = replaceOnce(source,
    'rewrite_js(e,t,r,n,o,s,a){let A=',
    'rewrite_js(e,t,r,n,o,s,a){return atlasModuleIdentityScope.run(t.atlasModuleInitiator,a,()=>{let A=');
  source = replaceOnce(source,
    'return f(m[0])}rewrite_js_bytes(e,t,r,n,o,a,A){let l,',
    'return f(m[0])})}rewrite_js_bytes(e,t,r,n,o,a,A){return atlasModuleIdentityScope.run(t.atlasModuleInitiator,A,()=>{let l,');
  source = replaceOnce(source,
    'return f(y[0])}constructor(){const e=i.rewriter_new();',
    'return f(y[0])})}constructor(){const e=i.rewriter_new();');
  source = replaceOnce(source,
    '__wbg_origin_af09d36f59ea0c32=function(e,t){let r=h(t.origin,',
    '__wbg_origin_af09d36f59ea0c32=function(e,t){let r=h(atlasModuleIdentityScope.origin(t),');
  const output = Buffer.from(source);
  return output;
}
