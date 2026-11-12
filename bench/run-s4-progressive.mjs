import fs from 'node:fs';
import { DshHost } from './lib/host.mjs';
import { HeadlessChrome } from './lib/chrome.mjs';
import { measureOnce, bootstrapBlank } from './lib/measure.mjs';
const ROOT='C:/Users/TLEWA/Desktop/DSHs/dsh-plugins';
const HOME=ROOT+'/libs/bench/home-s4';
const OUT=ROOT+'/libs/.worktrees/stage4-revisit/bench/.s4-out/'+(process.env.S4_OUT||'progressive');
const BIN=ROOT+'/libs/.worktrees/stage8-release/bench/.tools/dsh022/node_modules/@deepseek-ai/dsh/lib/bin.js';
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const SESSION=process.env.S4_SID||'session-262d33b1-bf51-49f2-bf29-7016ed1216a8';
const MODES=(process.env.S4_MODES||'progressive').split(',');
const REPS=Number(process.env.S4_REPS||1);
fs.mkdirSync(OUT,{recursive:true});
const host=new DshHost({home:HOME,port:11031,workspace:ROOT,dshBin:BIN,outDir:OUT,label:'prog-host'});
const chrome=new HeadlessChrome({port:9361,userDataDir:OUT+'/chrome-profile',chromePath:CHROME,outDir:OUT});
const rows=[];
const median=xs=>{const a=[...xs].sort((x,y)=>x-y),n=a.length;return n?(n%2?a[(n-1)/2]:Math.round(((a[n/2-1]+a[n/2])/2)*1000)/1000):null;};
const stat=xs=>({n:xs.length,median:median(xs),min:xs.length?Math.min(...xs):null,max:xs.length?Math.max(...xs):null,mean:xs.length?Math.round(xs.reduce((a,b)=>a+b,0)/xs.length*1000)/1000:null});
function pick(r,mode,rep,warmup){const t=r.timings,p=r.page,h=r.host;const st=p.lazyState||{},rep2=st.report||{},prog=rep2.progressive||p.progressiveAtFirst&&p.progressiveAtFirst.progressive||{};
 return {mode,rep,warmup,ok:r.ok,clickToFirstRowMs:t.clickToFirstRowMs,snapshotToFirstRowMs:t.snapshotToFirstRowMs,followToSnapshotMs:t.followToSnapshotMs,
 domFirstRow:p.domNodesAtFirstRow,domSettled:p.domNodesAfterSettle,flowChildren:p.flowChildrenAtFirstRow,
 commitsAfterClick:p.reactCommit.afterClick,commitsBeforeFirst:p.reactCommit.beforeFirstRow,
 longTasksFirstRow:p.longTasks.clickToFirstRow.over50Count,longTaskMsFirstRow:p.longTasks.clickToFirstRow.over50TotalMs,
 longTasksSettled:p.longTasks.clickToSettled.over50Count,longTaskMsSettled:p.longTasks.clickToSettled.over50TotalMs,
 lazyAtFirst:p.progressiveAtFirst?p.progressiveAtFirst.lazyDom:null,domAtFirst:p.progressiveAtFirst?p.progressiveAtFirst.dom:null,
 lazySettled:st.lazyDom,progMode:rep2.mode||null,progress:prog,
 errors:(rep2.errors||[]).slice(0,5),pageErrors:p.errors.slice(0,4),
 hostCpuPeak:r.hostResources?r.hostResources.avgCores:null,hostWsPeak:r.hostResources?r.hostResources.peakWorkingSetBytes:null,
 serveRecords:h.records,pageCacheReadyMs:h.pageCacheReadyMs};
}
let stopped=false;
const cleanup=async()=>{if(stopped)return;stopped=true;await chrome.stop().catch(()=>{});await host.stop().catch(()=>{});};
process.on('SIGINT',async()=>{await cleanup();process.exit(130);});
try{
 await chrome.start(); await host.start();
 const boot=await bootstrapBlank({chromePort:9361,tokenUrl:host.tokenUrl,outDir:OUT});
 console.log('blank',boot.blankSessionId,'rows',boot.rows);
 const runOne=async(mode,rep,warmup)=>{
  process.env.BENCH_DOC_START_JS=(mode==='progressive'?'window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__=true;':mode==='permanent'?'window.__DSH_FASTLOAD_LAZY_GROUPS__=true;':'')+'window.__DSH_FASTLOAD_DIAGNOSTICS__=true;';
  const r=await measureOnce({chromePort:9361,tokenUrl:host.tokenUrl,blankSessionId:boot.blankSessionId,targetSessionId:SESSION,outDir:OUT,label:mode+'-'+rep,hostPid:host.pid,host,sampler:true});
  const row=pick(r,mode,rep,warmup);rows.push(row);console.log(JSON.stringify(row));return row;
 };
 for(const mode of MODES){await runOne(mode,0,true);}
 for(let i=1;i<=REPS;i++)for(const mode of MODES)await runOne(mode,i,false);
 fs.writeFileSync(OUT+'/rows.json',JSON.stringify(rows,null,2));
 const summary={};for(const mode of MODES){const rs=rows.filter(r=>r.mode===mode&&!r.warmup&&r.ok);summary[mode]={n:rs.length,click:stat(rs.map(r=>r.clickToFirstRowMs).filter(v=>v!=null)),snap:stat(rs.map(r=>r.snapshotToFirstRowMs).filter(v=>v!=null)),domFirst:stat(rs.map(r=>r.domFirstRow).filter(v=>v!=null)),domSettled:stat(rs.map(r=>r.domSettled).filter(v=>v!=null)),lazyFirst:stat(rs.map(r=>r.lazyAtFirst).filter(v=>v!=null)),lazySettled:stat(rs.map(r=>r.lazySettled).filter(v=>v!=null)),ltFirst:stat(rs.map(r=>r.longTaskMsFirstRow).filter(v=>v!=null)),ltSettled:stat(rs.map(r=>r.longTaskMsSettled).filter(v=>v!=null)),progressDone:rs.map(r=>r.progress&&r.progress.done),progressMs:rs.map(r=>r.progress&&r.progress.doneAt&&r.progress.startedAt?Math.round((r.progress.doneAt-r.progress.startedAt)*1000)/1000:null)};}
 fs.writeFileSync(OUT+'/summary.json',JSON.stringify(summary,null,2));console.log('SUMMARY '+JSON.stringify(summary));console.log('OK');
}catch(e){console.error('FAIL',e&&e.stack||e);process.exitCode=2;}
finally{await cleanup();console.log('cleaned');}
