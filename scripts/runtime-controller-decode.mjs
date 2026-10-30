import{createHash}from'node:crypto';
export const CONTROLLER_INJECT_SHA256='984fb3413d7db21ede4f6d7340713caf46e39ba53f369e1c15ad1360fba9171c';
/** Decode the exact pinned Latin-1 Wasm bytes without allocating an iterator
 * element and invoking a JS callback for every byte in every child document.
 * This changes no compiler input, policy, worker global, storage or protocol. */
export function adaptControllerDecode(bytes){
 if(createHash('sha256').update(bytes).digest('hex')!==CONTROLLER_INJECT_SHA256)throw Error('Controller decode requires the verified source artifact');
 const before='Uint8Array.from(atob(self.WASM),e=>e.charCodeAt(0))';
 const after='(()=>{const e=atob(self.WASM),t=new Uint8Array(e.length);for(let o=0;o<e.length;o++)t[o]=e.charCodeAt(o);return t})()';
 const source=bytes.toString();if(source.split(before).length!==2)throw Error('Controller Wasm decode seam changed');return Buffer.from(source.replace(before,after));
}
