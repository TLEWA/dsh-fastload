import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DshHost } from './lib/host.mjs';
import { HeadlessChrome } from './lib/chrome.mjs';
import { bootstrapBlank, measureOnce } from './lib/measure.mjs';

const ROOT = 'C:/Users/TLEWA/Desktop/DSHs/dsh-plugins';
const WORK = ROOT + '/libs/.worktrees/stage4-revisit';
const HOME = WORK + '/bench/.s4-matrix/home-standard';
const BIN = ROOT + '/libs/.worktrees/stage8-release/bench/.tools/dsh022/node_modules/@deepseek-ai/dsh/lib/bin.js';
const PRESET = process.env.PRESET || 'standard';
const COLLAPSE = process.env.COLLAPSE || 'completion';
const FOLDED = process.env.FOLDED || 'all';
const SESSION_KIND = process.env.SESSION || 'long';
const REPS = Number(process.env.REPS || 5);
const WARMUPS = Number(process.env.WARMUPS || 2);
const OUT = WORK + '/bench/.s4-out/matrix-' + PRESET + '-' + COLLAPSE + '-' + FOLDED + '-' + SESSION_KIND;
const SIDS = {
  normal: 'session-f03b9395-d0bc-47e1-b500-ae5f2f8abc38',
  long: 'session-262d33b1-bf51-49f2-bf29-7016ed1216a8',
};
const SID = SIDS[SESSION_KIND];
if (!SID) throw new Error('unknown SESSION ' + SESSION_KIND);

fs.mkdirSync(OUT, { recursive: true });
const patch = [
  '# stage4-revisit matrix overlay',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
  '- id: ui-chat',
  '  name: "@deepseek-ai/dsh-client-ui-chat"',
  '  config:',
  '    transcriptView: ' + PRESET,
  '    collapseTiming: ' + COLLAPSE,
  '    foldedReplies: ' + FOLDED,
  '',
].join('\n');
fs.writeFileSync(HOME + '/profiles/web/cordis.patch.yml', patch);

const host = new DshHost({ home: HOME, port: 11031, workspace: ROOT, dshBin: BIN, outDir: OUT, label: 'host' });
const chrome = new HeadlessChrome({ port: 9361, userDataDir: OUT + '/chrome-profile', chromePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', outDir: OUT });
const effectiveConfig = (() => {
  try {
    const text = execFileSync(process.execPath, [BIN, '--profile', 'web', '--dump-config'], { cwd: ROOT, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 60000 });
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes("name: '@deepseek-ai/dsh-client-ui-chat'"));
    return at >= 0 ? lines.slice(at, at + 6).join('\n') : null;
  } catch (e) { return 'ERR ' + e.message; }
})();
console.log('EFFECTIVE_CONFIG ' + JSON.stringify(effectiveConfig));
const rows = [];
const agg = (mode) => {
  const xs = rows.filter((r) => r.mode === mode && r.ok);
  const picks = (fn) => xs.map(fn).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const med = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const heap = picks((r) => r.page.domExtra && r.page.domExtra.jsHeapUsed);
  const click = picks((r) => r.timings.clickToFirstRowMs);
  const snap = picks((r) => r.timings.snapshotToFirstRowMs);
  const dom = picks((r) => r.page.domNodesAfterSettle);
  const domFirst = picks((r) => r.page.domNodesAtFirstRow);
  const lt = picks((r) => r.page.longTasks.clickToSettled.over50TotalMs);
  const ltFirst = picks((r) => r.page.longTasks.clickToFirstRow.over50TotalMs);
  const lazy = picks((r) => r.page.lazyState && r.page.lazyState.lazyNodes);
  const native = picks((r) => r.page.lazyState && r.page.lazyState.nativeNodes);
  return { mode, n: xs.length, clickMedian: med(click), clickMean: avg(click), clickMin: click.length ? Math.min(...click) : null, clickMax: click.length ? Math.max(...click) : null, snapshotMedian: med(snap), domFirstMedian: med(domFirst), domSettledMedian: med(dom), longTaskFirstMedian: med(ltFirst), longTaskSettledMedian: med(lt), lazyMedian: med(lazy), nativeMedian: med(native), heapMedian: med(heap), wsPeakMedian: med(picks((r) => r.hostResources && r.hostResources.peakWorkingSetBytes)), cpuAvgMedian: med(picks((r) => r.hostResources && r.hostResources.avgCores)) };
};

try {
  await chrome.start();
  await host.start();
  const boot = await bootstrapBlank({ chromePort: 9361, tokenUrl: host.tokenUrl, outDir: OUT });
  const run = async (mode, label) => {
    process.env.BENCH_DOC_START_JS = 'window.__DSH_FASTLOAD_DIAGNOSTICS__=true;window.__DSH_FASTLOAD_LAZY_GROUPS__=' + (mode === 'lazy' ? 'true' : 'false') + ';';
    const r = await measureOnce({ chromePort: 9361, tokenUrl: host.tokenUrl, blankSessionId: boot.blankSessionId, targetSessionId: SID, outDir: OUT, label: PRESET + '-' + SESSION_KIND + '-' + mode + '-' + label, host, sampler: true });
    rows.push({ mode, label, ok: r.ok, timings: r.timings, page: r.page, host: r.host, hostResources: r.hostResources, pageErrors: r.pageErrors });
    fs.writeFileSync(OUT + '/rows.json', JSON.stringify(rows, null, 2));
    console.log('RUN', mode, label, 'ok=' + r.ok, 'click=' + r.timings.clickToFirstRowMs, 'snap=' + r.timings.snapshotToFirstRowMs, 'dom=' + r.page.domNodesAfterSettle, 'lazy=' + (r.page.lazyState && r.page.lazyState.lazyNodes), 'lt=' + JSON.stringify(r.page.longTasks.clickToSettled));
  };
  for (let i = 0; i < WARMUPS; i += 1) {
    await run(i % 2 === 0 ? 'off' : 'lazy', 'warm-' + i);
  }
  rows.length = 0;
  for (let i = 0; i < REPS; i += 1) {
    const order = i % 2 === 0 ? ['off', 'lazy'] : ['lazy', 'off'];
    for (const mode of order) await run(mode, String(i + 1));
  }
  const summary = { preset: PRESET, collapse: COLLAPSE, folded: FOLDED, session: SESSION_KIND, sid: SID, reps: REPS, warmups: WARMUPS, effectiveConfig, off: agg('off'), lazy: agg('lazy'), rows: rows.length };
  fs.writeFileSync(OUT + '/summary.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await chrome.stop().catch(() => {});
  await host.stop().catch(() => {});
}
