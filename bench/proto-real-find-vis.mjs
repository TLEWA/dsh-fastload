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
const HPORT=11034, CPORT=9365;
fs.mkdirSync(OUT,{recursive:true});
const host=new DshHost({home:HOME,port:HPORT,workspace:ROOT,dshBin:BIN,outDir:OUT,label:'h2'});
const chrome=new HeadlessChrome({port:CPORT,userDataDir:OUT+'/chrome-profile2',chromePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',outDir:OUT});
let cdp=null;
async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'},20000);fs.writeFileSync(OUT+'/'+name,Buffer.from(r.data,'base64'));}
async function open(){
  const p=await newPage(CPORT,'about:blank'); cdp=p.cdp;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.__DSH_FASTLOAD_DIAGNOSTICS__=true;window.__DSH_FASTLOAD_LAZY_GROUPS__=true;'});
  await cdp.send('Page.navigate',{url:host.tokenUrl});
  await waitFor(async()=>evalJs(cdp,'!!document.querySelector(\'[data-row-key^="session:"]\')').catch(()=>false),{timeoutMs:90000,intervalMs:250,label:'sidebar'});
  await evalJs(cdp,'document.querySelector('+JSON.stringify('[data-row-key="session:'+SID+'"]')+').click()');
  await waitFor(async()=>evalJs(cdp,'!!document.querySelector(\'[data-slot="conversation.chat.flow"] [data-chat-node-key]\')').catch(()=>false),{timeoutMs:90000,intervalMs:150,label:'flow'});
  await delay(2500);
  return p;
}
const locateExpr=(tok)=>'(function(){var T='+JSON.stringify(tok)+';var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);var out=[];var n;while((n=w.nextNode())){var txt=n.nodeValue||"";var i=txt.indexOf(T);if(i<0)continue;var r=document.createRange();r.setStart(n,i);r.setEnd(n,i+T.length);var rc=r.getBoundingClientRect();var cs=getComputedStyle(n.parentElement);out.push({txt:txt.slice(Math.max(0,i-30),i+T.length+30),rect:{x:Math.round(rc.x),y:Math.round(rc.y),w:Math.round(rc.width),h:Math.round(rc.height)},vis:cs.visibility,disp:cs.display,hidden:n.parentElement.closest("[hidden]")?n.parentElement.closest("[hidden]").getAttribute("hidden"):null,parent:n.parentElement.tagName+"."+String(n.parentElement.className).slice(0,40)});if(out.length>=12)break;}var sc=[];[].slice.call(document.querySelectorAll("[data-slot],[class*=scroll]")).filter(function(e){return e.getAttribute("data-slot")==="conversation.chat.flow"||String(e.className).indexOf("scroll")>=0}).forEach(function(e){if(e.scrollHeight>e.clientHeight+5)sc.push({cls:String(e.className).slice(0,40),top:Math.round(e.scrollTop),h:e.scrollHeight,ch:e.clientHeight});});return {hits:out,scrolls:sc.slice(0,6),winY:window.scrollY,ih:innerHeight};})()';
let p;
try{
  await chrome.start(); await host.start();
  p=await open();
  await shot('vis-before.png');
  for(const [label,tok] of [['stop','已停止'],['common','bug6-res.json'],['extra','scans:22']]){
    if(label!=='stop'){ try{await closeTarget(CPORT,p.target.id);}catch{} try{p.cdp.close();}catch{} p=await open(); }
    await shot('vis-'+label+'-pre.png');
    const t0=Date.now(); let err=null; try{await cdp.send('FindInPage.findFirst',{query:tok},15000);}catch(e){err=String(e&&e.message||e);}
    await delay(300);
    const at=await evalJs(cdp,locateExpr(tok));
    await shot('vis-'+label+'-at300.png');
    console.log(label,JSON.stringify({tok,callMs:Date.now()-t0,err,hits:at.hits.length,first:at.hits[0],scrolls:at.scrolls,winY:at.winY},null,1).slice(0,3000));
    try{await cdp.send('FindInPage.stop',{},5000);}catch{}
  }
}catch(e){console.log('FAIL',e&&e.stack||e);}finally{
  try{await host.stop();}catch{} try{await chrome.stop();}catch{} console.log('cleaned');
}
