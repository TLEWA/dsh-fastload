import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DshHost } from './lib/host.mjs';
import { HeadlessChrome } from './lib/chrome.mjs';
import { newPage, evalJs, waitFor, closeTarget } from './lib/cdp.mjs';

const ROOT='C:/Users/TLEWA/Desktop/DSHs/dsh-plugins';
const WT=ROOT+'/libs/.worktrees/stage4-revisit';
const HOME=WT+'/bench/.s4-matrix/home-standard';
const OUT=WT+'/bench/.s4-out/find-verify2';
const BIN=ROOT+'/libs/.worktrees/stage8-release/bench/.tools/dsh022/node_modules/@deepseek-ai/dsh/lib/bin.js';
const SID='session-262d33b1-bf51-49f2-bf29-7016ed1216a8';
const HPORT=11033, CPORT=9364;
fs.mkdirSync(OUT,{recursive:true});

const host=new DshHost({home:HOME,port:HPORT,workspace:ROOT,dshBin:BIN,outDir:OUT,label:'h'});
const chrome=new HeadlessChrome({port:CPORT,userDataDir:OUT+'/chrome-profile',chromePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',outDir:OUT});
const pages=[];
async function shot(cdp,name){
  const r=await cdp.send('Page.captureScreenshot',{format:'png'},20000);
  fs.writeFileSync(OUT+'/'+name, Buffer.from(r.data,'base64'));
}
function injectSource(mode,{delayIdle=false}={}){
  const g=mode==='permanent'?'true':'false';
  const pr=mode==='progressive'?'true':'false';
  return '(() => {\n'+
    'window.__DSH_FASTLOAD_DIAGNOSTICS__=true;\n'+
    'window.__DSH_FASTLOAD_LAZY_GROUPS__='+g+';\n'+
    'window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__='+pr+';\n'+
    (delayIdle?'(function(){var orig=window.requestIdleCallback;window.requestIdleCallback=function(cb,opts){return setTimeout(function(){orig(cb,opts);},4000);};})();\n':'')+
    'window.__FINDLOG__={beforematch:[],mut:[]};\n'+
    'document.addEventListener("beforematch",function(e){var t=e.target;var rec={t:performance.now(),tag:t.tagName,cls:String(t.className||"").slice(0,80),key:(t.getAttribute&&(t.getAttribute("data-chat-group-key")||t.getAttribute("data-fastload-lazy-key")))||"",hidden:t.getAttribute&&t.getAttribute("hidden"),lazy:document.querySelectorAll("[data-fastload-lazy-group]").length};window.__FINDLOG__.beforematch.push(rec);},true);\n'+
    'document.addEventListener("DOMContentLoaded",function(){var lastL=null,lastH=null;function tick(){var l=document.querySelectorAll("[data-fastload-lazy-group]").length;var h=document.querySelectorAll("[hidden=\\"until-found\\"]").length;if(l!==lastL||h!==lastH){lastL=l;lastH=h;window.__FINDLOG__.mut.push({t:performance.now(),lazy:l,hidden:h});}}var mo=new MutationObserver(tick);mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["hidden"]});tick();});\n'+
    '})();';
}
async function open(mode,{delayIdle=false,waitMs=2500}={}){
  const p=await newPage(CPORT,'about:blank');
  pages.push(p);
  const cdp=p.cdp;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  try{await cdp.send('Page.bringToFront',{},5000);}catch{}
  try{await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},5000);}catch{}
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:injectSource(mode,{delayIdle})});
  await cdp.send('Page.navigate',{url:host.tokenUrl});
  await waitFor(async()=>evalJs(cdp,'!!document.querySelector(\'[data-row-key^="session:"]\')').catch(()=>false),{timeoutMs:90000,intervalMs:250,label:'sidebar'});
  await evalJs(cdp,'document.querySelector('+JSON.stringify('[data-row-key="session:'+SID+'"]')+').click()');
  await waitFor(async()=>evalJs(cdp,'!!document.querySelector(\'[data-slot="conversation.chat.flow"] [data-chat-node-key]\')').catch(()=>false),{timeoutMs:90000,intervalMs:150,label:'flow'});
  await delay(waitMs);
  return {p,cdp,mode};
}
function stateExpr(token){
  const tk=JSON.stringify(token||'');
  return '(function(){var TOK='+tk+';'+
    'var ps=[].slice.call(document.querySelectorAll("[data-fastload-lazy-group]"));'+
    'var ns=[].slice.call(document.querySelectorAll("[data-chat-node-key]"));'+
    'var fls=[].slice.call(document.querySelectorAll("[data-slot]")).filter(function(e){return e.getAttribute("data-slot")==="conversation.chat.flow"});fls.sort(function(a,b){return (b.textContent||"").length-(a.textContent||"").length});var fl=fls[0];var sc=null;if(fl){var q=fl;while(q&&q!==document.body){if(q.scrollHeight>q.clientHeight+5){sc=q;break;}q=q.parentElement;}}'+
    'var tc=document.documentElement.textContent||"";var it=document.body.innerText||"";'+
    'function count(s){return TOK?s.split(TOK).length-1:0;}'+
    'var st=window.__DSH_FASTLOAD_CLIENT__;var lz=st&&st.lazyGroups;'+
    'var t0=window.__FIND_T0__||0;'+
    'return {t:Math.round(performance.now()*10)/10,dt:t0?Math.round((performance.now()-t0)*10)/10:null,'+
    'lazy:ps.length,hidden:document.querySelectorAll(\'[hidden="until-found"]\').length,nodes:document.querySelectorAll("*").length,'+
    'flowNodes:fl?fl.querySelectorAll("*").length:-1,phWithToken:TOK?ps.filter(function(e){return (e.textContent||"").indexOf(TOK)>=0}).length:0,'+
    'natWithToken:TOK?ns.filter(function(e){return (e.textContent||"").indexOf(TOK)>=0}).length:0,'+
    'textCount:count(tc),innerCount:count(it),textHas:!!TOK&&tc.indexOf(TOK)>=0,innerHas:!!TOK&&it.indexOf(TOK)>=0,'+
    'scrollTop:sc?Math.round(sc.scrollTop*10)/10:null,scrollHeight:sc?sc.scrollHeight:null,clientHeight:sc?sc.clientHeight:null,flowCount:fls.length,flowChars:fl?(fl.textContent||"").length:-1,'+
    'hit:(function(){if(!TOK)return null;var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);var n;while((n=w.nextNode())){var tx=n.nodeValue||"";var i=tx.indexOf(TOK);if(i<0)continue;var r=document.createRange();r.setStart(n,i);r.setEnd(n,i+TOK.length);var rc=r.getBoundingClientRect();var he=n.parentElement&&n.parentElement.closest("[hidden]");return {x:Math.round(rc.x),y:Math.round(rc.y),w:Math.round(rc.width),h:Math.round(rc.height),hidden:he?he.getAttribute("hidden"):null,parent:n.parentElement?n.parentElement.tagName+"."+String(n.parentElement.className).slice(0,30):""};}return null;})(),'+
    'aria:[].slice.call(document.querySelectorAll("button[data-process-activity]")).map(function(b){return b.getAttribute("aria-expanded")}),'+
    'prog:lz&&lz.progressive?JSON.parse(JSON.stringify(lz.progressive)):null,mode:lz&&lz.mode,lazyNodes:lz&&lz.lazyNodes,nativeNodes:lz&&lz.nativeNodes,'+
    'beforematch:(window.__FINDLOG__&&window.__FINDLOG__.beforematch||[]).map(function(e){return {dt:Math.round((e.t-t0)*10)/10,tag:e.tag,cls:e.cls,key:e.key,hidden:e.hidden,lazy:e.lazy};}),'+
    'mutations:(window.__FINDLOG__&&window.__FINDLOG__.mut||[]).slice(-30).map(function(m){return {dt:Math.round((m.t-t0)*10)/10,lazy:m.lazy,hidden:m.hidden};}),'+
    'sel:String(getSelection()).slice(0,100),active:document.activeElement&&document.activeElement.tagName};})()';
}
const state=(cdp,token)=>evalJs(cdp,stateExpr(token));
async function findOnce(cdp,token,label){
  await evalJs(cdp,'window.__FINDLOG__.beforematch=[];window.__FINDLOG__.mut=[];window.__FIND_T0__=performance.now();');
  const before=await state(cdp,token);
  await shot(cdp,label+'-before.png');
  const t0=Date.now(); let err=null,res=null;
  try{res=await cdp.send('FindInPage.findFirst',{query:token},15000);}catch(e){err=String(e&&e.message||e);}
  const callMs=Date.now()-t0;
  const s0=await state(cdp,token);
  await delay(60); const s60=await state(cdp,token);
  await delay(190); const s250=await state(cdp,token);
  await shot(cdp,label+'-at250.png');
  await delay(800); const s1050=await state(cdp,token);
  await shot(cdp,label+'-settled.png');
  return {label,token,res,err,callMs,before,s0,s60,s250,s1050};
}
async function navFind(cdp,label,fn){
  await evalJs(cdp,'window.__FINDLOG__.beforematch=[];window.__FINDLOG__.mut=[];window.__FIND_T0__=performance.now();');
  const t0=Date.now(); let err=null,res=null;
  try{res=await cdp.send('FindInPage.'+fn,{},15000);}catch(e){err=String(e&&e.message||e);}
  const callMs=Date.now()-t0;
  const s0=await state(cdp,'');
  await delay(120); const s120=await state(cdp,'');
  await shot(cdp,label+'.png');
  return {label,fn,res,err,callMs,s0,s120};
}
function tokensOf(text,min){
  const re=min>=8?/[A-Za-z0-9][A-Za-z0-9_.:\/-]{7,}/g:/[A-Za-z0-9_]{6,}/g;
  const out=[]; let m;
  while((m=re.exec(text))){const t=m[0];if(/[A-Za-z]/.test(t)&&/[0-9]/.test(t))out.push(t);}
  return out;
}
function tokenSet(map){const s=new Set();for(const k of Object.keys(map))for(const t of tokensOf(map[k],8))s.add(t);return s;}
function allText(map){return Object.keys(map).map(k=>map[k]).join('\n');}
function uniquePick(corpus,other,kind){
  const counts=new Map();
  for(const t of tokensOf(corpus,8))counts.set(t,(counts.get(t)||0)+1);
  const cands=[];
  for(const [t,c] of counts){ if(c!==1) continue; if(t.length<8||t.length>64) continue; if(other && other.indexOf(t)>=0) continue; cands.push(t); }
  cands.sort((a,b)=>a.length-b.length);
  return cands;
}
function occ(hay,needle){return needle?hay.split(needle).length-1:0;}

const R={startedAt:new Date().toISOString(),mode:'find-verify2',sid:SID};
let cdp=null;
try{
  await chrome.start(); await host.start();
  console.log('HOST_URL',!!host.tokenUrl);

  // ---- baselines ----
  const off=await open('off');
  cdp=off.cdp;
  const offMap=JSON.parse(await evalJs(cdp,'JSON.stringify((function(){var o={};document.querySelectorAll("[data-chat-node-key]").forEach(function(e){var k=e.getAttribute("data-chat-node-key");if(!(k in o))o[k]=e.textContent||""});return o;})())'));
  const offBase=await state(cdp,'');
  const offAll=await evalJs(cdp,'document.documentElement.textContent||""');
  const offInner=await evalJs(cdp,'document.body.innerText||""');
  const offFlow=await evalJs(cdp,'(function(){var fs=[].slice.call(document.querySelectorAll("[data-slot]")).filter(function(e){return e.getAttribute("data-slot")==="conversation.chat.flow"});fs.sort(function(a,b){return (b.textContent||"").length-(a.textContent||"").length});return fs[0]?(fs[0].textContent||""):"";})()');
  R.off={base:offBase,keys:Object.keys(offMap).length,textChars:offAll.length,flowChars:offFlow.length,innerChars:offInner.length};
  fs.writeFileSync(OUT+'/off-baseline.json',JSON.stringify({base:offBase,map:offMap,all:offAll,flow:offFlow,inner:offInner},null,2));
  console.log('OFF',JSON.stringify({nodes:offBase.nodes,lazy:offBase.lazy,hidden:offBase.hidden,scrollTop:offBase.scrollTop,keys:Object.keys(offMap).length}));

  const perm=await open('permanent');
  cdp=perm.cdp;
  const ph=JSON.parse(await evalJs(cdp,'JSON.stringify([].slice.call(document.querySelectorAll("[data-fastload-lazy-group]")).map(function(e){return {key:e.getAttribute("data-fastload-lazy-key"),text:e.textContent||""}}))'));
  const permBase=await state(cdp,'');
  const permAll=await evalJs(cdp,'document.documentElement.textContent||""');
  const permFlow=await evalJs(cdp,'(function(){var fs=[].slice.call(document.querySelectorAll("[data-slot]")).filter(function(e){return e.getAttribute("data-slot")==="conversation.chat.flow"});fs.sort(function(a,b){return (b.textContent||"").length-(a.textContent||"").length});return fs[0]?(fs[0].textContent||""):"";})()');
  R.permanent={base:permBase,placeholders:ph.length,phChars:ph.reduce((a,x)=>a+x.text.length,0),textChars:permAll.length,flowChars:permFlow.length};
  fs.writeFileSync(OUT+'/perm-baseline.json',JSON.stringify({base:permBase,placeholders:ph,all:permAll,flow:permFlow},null,2));
  console.log('PERM',JSON.stringify({nodes:permBase.nodes,lazy:permBase.lazy,hidden:permBase.hidden,scrollTop:permBase.scrollTop,ph:ph.length}));

  // coverage
  const phAllText=ph.map(x=>x.text).join('\n');
  const native8=tokenSet({flow:offFlow});
  const ph8=tokenSet({all:phAllText});
  const inter=[]; for(const t of native8) if(ph8.has(t)) inter.push(t);
  const native6=new Set(tokensOf(offFlow,6));
  const ph6=new Set(tokensOf(phAllText,6));
  let inter6=0; for(const t of native6) if(ph6.has(t)) inter6++;
  R.coverage={nativeToken8:native8.size,phToken8:ph8.size,common8:inter.length,tokenCov8:+(inter.length/native8.size*100).toFixed(2),nativeToken6:native6.size,common6:inter6,tokenCov6:+(inter6/native6.size*100).toFixed(2),offFlowChars:offFlow.length,phChars:phAllText.length,offAllChars:offAll.length};
  const missingCand=uniquePick(offFlow,phAllText,'missing');
  const extraCand=uniquePick(phAllText,offFlow,'extra');
  const commonCand=[];
  for(const t of inter){ if(occ(offFlow,t)===1 && occ(phAllText,t)>=1) commonCand.push(t); }
  commonCand.sort((a,b)=>a.length-b.length);
  R.tokens={common:commonCand.slice(0,8),extra:extraCand.filter(t=>phAllText.indexOf(t)>=0).slice(0,8),missing:missingCand.slice(0,8)};
  R.tokenDetail={common:commonCand.slice(0,8).map(t=>({t,off:occ(offFlow,t),ph:occ(phAllText,t),permFlow:occ(permFlow,t)})),extra:extraCand.slice(0,8).map(t=>({t,off:occ(offFlow,t),ph:occ(phAllText,t)})),missing:missingCand.slice(0,8).map(t=>({t,off:occ(offFlow,t),ph:occ(phAllText,t)}))};
  console.log('TOKENS',JSON.stringify(R.tokens));
  fs.writeFileSync(OUT+'/tokens.json',JSON.stringify(R.tokens,null,2));

  const common=commonCand[0];
  const extra=extraCand[0];
  const missing=missingCand[0];
  if(!common) throw new Error('no common token');

  // ---- permanent common / extra / missing ----
  for(const [kind,tok] of [['common',common],['extra',extra],['missing',missing]]){
    if(!tok){R[kind]={skipped:true};continue;}
    const pg=await open('permanent');
    cdp=pg.cdp;
    const r=await findOnce(cdp,tok,'perm-'+kind);
    R['perm_'+kind]=r;
    console.log('PERM_'+kind.toUpperCase(),JSON.stringify({token:tok,callMs:r.callMs,err:r.err,lazy:[r.before.lazy,r.s0.lazy,r.s60.lazy,r.s250.lazy,r.s1050.lazy],hidden:[r.before.hidden,r.s0.hidden,r.s250.hidden,r.s1050.hidden],nodes:[r.before.nodes,r.s0.nodes,r.s250.nodes,r.s1050.nodes],aria:r.s1050.aria,flow:[r.before.flowCount,r.before.flowChars],hit:[r.before.hit,r.s250.hit,r.s1050.hit],scroll:[r.before.scrollTop,r.s0.scrollTop,r.s250.scrollTop,r.s1050.scrollTop],inner:[r.before.innerHas,r.s0.innerHas,r.s250.innerHas,r.s1050.innerHas],text:[r.before.textHas,r.s1050.textHas],bm:r.s1050.beforematch.length,mut:r.s1050.mutations.length}));
    if(kind==='common'){
      const n1=await navFind(cdp,'perm-common-next','findNext');
      const p1=await navFind(cdp,'perm-common-prev','findPrev');
      R.perm_common_next=n1; R.perm_common_prev=p1;
      try{await cdp.send('FindInPage.stop',{},5000);}catch{}
      console.log('NAV',JSON.stringify({next:n1.s0.dt,prev:p1.s0.dt}));
    }
    try{await cdp.send('FindInPage.stop',{},5000);}catch{}
    try{await closeTarget(CPORT,pg.p.target.id);}catch{}
    try{pg.cdp.close();}catch{}
  }

  // ---- progressive natural ----
  const prog=await open('progressive');
  cdp=prog.cdp;
  const progBase=await state(cdp,'');
  const progAll=await evalJs(cdp,'document.documentElement.textContent||""');
  R.progressive_natural={base:progBase,textChars:progAll.length,sameTextAsOff:progAll.length===offAll.length};
  fs.writeFileSync(OUT+'/progressive-natural.json',JSON.stringify({base:progBase},null,2));
  console.log('PROG_NAT',JSON.stringify({lazy:progBase.lazy,nodes:progBase.nodes,hidden:progBase.hidden,prog:progBase.prog,scrollTop:progBase.scrollTop,chars:progAll.length,offChars:offAll.length}));
  try{await closeTarget(CPORT,prog.p.target.id);}catch{}
  try{prog.cdp.close();}catch{}

  // ---- progressive delayed: findFirst without keydown, then Ctrl+F rescue ----
  const pg2=await open('progressive',{delayIdle:true,waitMs:800});
  cdp=pg2.cdp;
  const pre=await state(cdp,common);
  const noKey=await findOnce(cdp,common,'prog-nokey');
  R.progressive_nokey={pre,find:noKey};
  console.log('PROG_NOKEY',JSON.stringify({prePending:pre.prog&&pre.prog.pending,preLazy:pre.lazy,textHas:noKey.before.textHas,innerHas:noKey.before.innerHas,s250inner:noKey.s250.innerHas,bm:noKey.s1050.beforematch.length,lazy:[noKey.s0.lazy,noKey.s1050.lazy],prog:noKey.s1050.prog}));
  // Ctrl+F rescue on the same page
  await evalJs(cdp,'window.__FIND_T0__=performance.now();window.__FINDLOG__.beforematch=[];window.__FINDLOG__.mut=[];');
  const k0=Date.now();
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',modifiers:2,key:'f',code:'KeyF',windowsVirtualKeyCode:70,nativeVirtualKeyCode:70},5000);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',modifiers:2,key:'f',code:'KeyF',windowsVirtualKeyCode:70,nativeVirtualKeyCode:70},5000);
  const keyImmediate=await state(cdp,common);
  const keyMs=Date.now()-k0;
  await delay(100); const key100=await state(cdp,common);
  const rescue=await findOnce(cdp,common,'prog-keydown');
  R.progressive_keydown_rescue={keyMs,immediate:keyImmediate,at100:key100,find:rescue};
  console.log('PROG_KEYDOWN',JSON.stringify({keyMs,immPending:keyImmediate.prog&&keyImmediate.prog.pending,immLazy:keyImmediate.lazy,immNodes:keyImmediate.nodes,reason:keyImmediate.prog&&keyImmediate.prog.revealReason,textHas:rescue.before.textHas,s250inner:rescue.s250.innerHas,bm:rescue.s1050.beforematch.length,prog:rescue.s1050.prog}));
  try{await closeTarget(CPORT,pg2.p.target.id);}catch{}
  try{pg2.cdp.close();}catch{}

  // ---- progressive delayed: keydown first on fresh page ----
  const pg3=await open('progressive',{delayIdle:true,waitMs:800});
  cdp=pg3.cdp;
  const pre3=await state(cdp,common);
  await evalJs(cdp,'window.__FIND_T0__=performance.now();');
  const k3=Date.now();
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',modifiers:2,key:'f',code:'KeyF',windowsVirtualKeyCode:70,nativeVirtualKeyCode:70},5000);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',modifiers:2,key:'f',code:'KeyF',windowsVirtualKeyCode:70,nativeVirtualKeyCode:70},5000);
  const k3imm=await state(cdp,common);
  const k3ms=Date.now()-k3;
  const k3find=await findOnce(cdp,common,'prog-keyfirst');
  R.progressive_keyfirst={pre:pre3,keyMs:k3ms,immediate:k3imm,find:k3find};
  console.log('PROG_KEYFIRST',JSON.stringify({prePending:pre3.prog&&pre3.prog.pending,keyMs:k3ms,immPending:k3imm.prog&&k3imm.prog.pending,immLazy:k3imm.lazy,immNodes:k3imm.nodes,immHidden:k3imm.hidden,reason:k3imm.prog&&k3imm.prog.revealReason,textHas:k3find.before.textHas,s250inner:k3find.s250.innerHas,bm:k3find.s1050.beforematch.length}));
  try{await closeTarget(CPORT,pg3.p.target.id);}catch{}
  try{pg3.cdp.close();}catch{}

  // ---- progressive delayed: synthetic beforematch flush ----
  const pg4=await open('progressive',{delayIdle:true,waitMs:800});
  cdp=pg4.cdp;
  const pre4=await state(cdp,common);
  await evalJs(cdp,'window.__FIND_T0__=performance.now();');
  const bm0=Date.now();
  const dispatched=await evalJs(cdp,'(function(){var b=document.querySelector(\'[hidden="until-found"]\');if(!b)return null;b.dispatchEvent(new Event("beforematch",{bubbles:true}));return {tag:b.tagName,cls:String(b.className||"").slice(0,60)};})()');
  const bmImm=await state(cdp,common);
  const bmMs=Date.now()-bm0;
  R.progressive_synthetic_beforematch={pre:pre4,dispatched,bmMs,immediate:bmImm};
  console.log('PROG_SYNTH_BM',JSON.stringify({dispatched,bmMs,pending:bmImm.prog&&bmImm.prog.pending,lazy:bmImm.lazy,nodes:bmImm.nodes,reason:bmImm.prog&&bmImm.prog.revealReason,textHas:bmImm.textHas}));
  try{await closeTarget(CPORT,pg4.p.target.id);}catch{}
  try{pg4.cdp.close();}catch{}

  // ---- data URL: duplicate token findNext/findPrev reveals hidden ----
  const html='<!doctype html><meta charset="utf-8"><style>body{font:16px monospace;margin:20px}div.gap{height:700px}p{white-space:pre-wrap}</style>'+
    '<p>top visible-alpha</p><p id="v">dup-token-777 visible copy</p><div class="gap"></div>'+
    '<p>middle</p><div id="h" hidden="until-found">hidden section dup-token-777 hidden copy</div><div class="gap"></div><p>end</p>';
  const url='data:text/html;charset=utf-8,'+encodeURIComponent(html);
  const dp=await newPage(CPORT,url); pages.push(dp); cdp=dp.cdp;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await evalJs(cdp,'window.__BM__=[];document.addEventListener("beforematch",function(e){window.__BM__.push({tag:e.target.tagName,id:e.target.id,hidden:e.target.getAttribute("hidden"),t:performance.now()});},true);');
  await delay(300);
  const dpre=await evalJs(cdp,'({scrollY:window.scrollY,hidden:document.getElementById("h").getAttribute("hidden")})');
  await cdp.send('FindInPage.findFirst',{query:'dup-token-777'},15000);
  await delay(120); const d1=await evalJs(cdp,'({scrollY:window.scrollY,hidden:document.getElementById("h").getAttribute("hidden"),bm:window.__BM__.slice()})'); await shot(cdp,'datadup-first.png');
  await cdp.send('FindInPage.findNext',{},15000);
  await delay(150); const d2=await evalJs(cdp,'({scrollY:window.scrollY,hidden:document.getElementById("h").getAttribute("hidden"),bm:window.__BM__.slice()})'); await shot(cdp,'datadup-next.png');
  await cdp.send('FindInPage.findPrev',{},15000);
  await delay(150); const d3=await evalJs(cdp,'({scrollY:window.scrollY,hidden:document.getElementById("h").getAttribute("hidden"),bm:window.__BM__.slice()})'); await shot(cdp,'datadup-prev.png');
  R.datadup={pre:dpre,first:d1,next:d2,prev:d3};
  console.log('DATADUP',JSON.stringify(R.datadup));
  try{await dp.cdp.close();}catch{}

  R.finishedAt=new Date().toISOString();
  fs.writeFileSync(OUT+'/result.json',JSON.stringify(R,null,2));
  console.log('DONE');
}catch(e){
  R.error=String(e&&e.stack||e);
  fs.writeFileSync(OUT+'/result.json',JSON.stringify(R,null,2));
  console.error('FAIL',e&&e.stack||e); process.exitCode=2;
}finally{
  for(const p of pages){try{p.cdp.close();}catch{}}
  await chrome.stop().catch(()=>{}); await host.stop().catch(()=>{});
  console.log('cleaned');
}