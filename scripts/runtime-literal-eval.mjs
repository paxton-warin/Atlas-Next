import {createHash} from 'node:crypto';
import {isPureLiteralEval} from './runtime-pure-literal-eval.ts';
const qualified=new Set(["dfcdf83e3edbd811b9a76051d905e2d18551ac5551ba33bb953fdd68eb1199fa","387d93b3b85cbf5f8f4caac1923f7f711347608f20a1e42769e56cce8cafc338","f8824cbeef281f7bbb5d050bd7d038a6d82aabcd75f4b9a61fcee728a44362d5","ae3a242f6c299bfc4a6e150f201cf2db5cb3f02fadcfb2c96218aadd117eacf6"]);
/** Recognized literals still execute as ORIGINAL bytes through native eval.
 * All other input follows the unchanged rewrite path; no site-specific cases. */
export function adaptLiteralEval(bytes){
 if(!qualified.has(createHash('sha256').update(bytes).digest('hex')))throw Error('Pure literal eval requires a qualified runtime artifact');
 let source=bytes.toString();
 const helper=isPureLiteralEval.toString().replace('isPureLiteralEval','atlasPureLiteralEval');
 const edits=[
 ['function s(e){let t=e.global.eval,r=new Proxy(e.global.eval,',helper+'function s(e){let t=e.global.eval,r=new Proxy(e.global.eval,'],
 ['"string"!=typeof t)?t:(0,i.o)(t,"(direct eval proxy)",e.context,e.meta)','"string"!=typeof t||atlasPureLiteralEval(t))?t:(0,i.o)(t,"(direct eval proxy)",e.context,e.meta)'],
 ['"string"!=typeof a)?a:t((0,i.o)(a,"(indirect eval proxy)",e.context,e.meta))','"string"!=typeof a)?a:t(atlasPureLiteralEval(a)?a:(0,i.o)(a,"(indirect eval proxy)",e.context,e.meta))']
 ];
 for(const [a,b]of edits){if(source.split(a).length!==2)throw Error('Pure literal eval seam changed');source=source.replace(a,b);}
 return Buffer.from(source);
}
