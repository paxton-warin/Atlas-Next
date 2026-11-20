/* Authored, inert SDK-shaped measurement-frame fixture. It contains only the
 * qualified public factory and SafeHTML helper shapes, not the full ad SDK.
 * The browser harness owns the measurement endpoint and every reported state. */
var fixtureVersion="h.3.797.1",fixtureBridgeVersion="bridge3.797.1_";
var Pj=globalThis.trustedTypes,Qj;
function Rj(){var a=null;if(!Pj)return a;try{var b=function(c){return c};a=Pj.createPolicy("goog#html",{createHTML:b,createScript:b,createScriptURL:b})}catch(c){}return a}
function Sj(){Qj===void 0&&(Qj=Rj());return Qj}
var ek=function(a){this.h=a};ek.prototype.toString=function(){return this.h+""};
function fk(a){var b=Sj();a=b?b.createHTML(a):a;return new ek(a)}function gk(a){if(a instanceof ek)return a.h;throw Error("");}
var hB={},lB={},fixtureLastFrame;
function tq(){return !!globalThis.fixtureAlternateElementFactory}
function uq(){return 0}
function fixtureElement(tag){var doc=globalThis.fixtureCreateInChild&&tag==="SCRIPT"&&fixtureLastFrame?fixtureLastFrame.contentDocument:document;var el=doc.createElement(tag.toLowerCase());if(tag==="IFRAME")fixtureLastFrame=el;return el}
function Mk(tag){return fixtureElement(tag)}
function ql(tag,attrs){var el=fixtureElement(tag);Object.keys(attrs||{}).forEach(function(key){el.setAttribute(key,attrs[key])});return el}
function A(step){var state={j:1,h:function(p,label){this.j=label;return Promise.resolve(p).then(function(){return step(state)})},return:function(value){return Promise.resolve(value)}};return step(state)}
function jk(script,url){var policy=Sj();script.src=policy?policy.createScriptURL(url):url;var nonceSource=document.querySelector("script[nonce]");if(nonceSource)script.setAttribute("nonce",nonceSource.nonce||nonceSource.getAttribute("nonce")||"")}
function ul(frame){return frame.contentWindow}
function JM(win){return win.omidSessionInterface||null}
var FM=globalThis.fixtureMeasurementURL||"https://measurement.fixture.test/omsdk.js",GM=FM,HM=FM,IM=FM;
function KM(a){var b,c,d,e,f,g;return A(function(h){if(h.j==1)return tq(hB)?(b=Mk("IFRAME"),b.style.visibility="hidden",b.style.width="0",b.style.height="0",b.style.position="absolute",b.style.left="0",b.style.top="0",b.title="Advertisement"):b=ql("IFRAME",{style:"visibility: hidden; width: 0; height: 0; position: absolute; left: 0; top: 0;",title:"Advertisement"}),c=new Promise(function(k){b.addEventListener("load",function(){k()})}),a.appendChild(b),h.h(c,2);d=tq(hB)?Mk("SCRIPT"):ql("SCRIPT");e= 
LM();jk(d,e);f=new Promise(function(k,l){d.addEventListener("load",function(){var n=ul(b);n&&JM(n)?k(b):l()})});g=b.contentDocument||b.contentWindow.document;g.head.appendChild(d);return h.return(f)})}
function LM(){switch(uq(lB)){case 0:return FM;case 1:return GM;case 2:return HM;case 3:return IM;default:return FM}}
globalThis.fixtureCreateMeasurementFrame=KM;
