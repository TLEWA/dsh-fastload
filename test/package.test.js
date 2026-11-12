import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const pkgUrl = new URL('../package.json', import.meta.url);
const clientUrl = new URL('../client.js', import.meta.url);

test('package exposes the web client half', async () => {
  const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'));
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.ok(pkg.files.includes('client.js'));
});

test('client registers a module and keeps the auto-fill contract', async () => {
  const source = await readFile(clientUrl, 'utf8');
  assert.match(source, /__ModuleLoader__\.load\(/);
  assert.match(source, /id: MODULE_ID/);
  assert.match(source, /data-fastload-autoloaded/);
  assert.match(source, /data-step-process-content/);
  assert.match(source, /conversation\.chat\.flow/);
  assert.match(source, /beginPaging|加载更早|Load older|olderButtonOf/);
});


test('the diagnostic layer is opt-in and silent on the default path', async () => {
  const source = await readFile(clientUrl, 'utf8');
  assert.match(source, /const DIAG_KEY = 'dsh-fastload\.diagnostics'/);
  // Same dual shape as the other switches, and the window flag must be exactly
  // true: a flag that merely exists (or a stale non-true value) must not turn
  // forensics on.
  assert.match(source, /localStorage\.getItem\(DIAG_KEY\) === '1'/);
  assert.match(source, /window\.__DSH_FASTLOAD_DIAGNOSTICS__ === true/);
  // The per-scan fiber sampler, the deep conversation/assembler snapshot, the
  // console wrapper and the probe API all sit behind the switch.
  assert.match(source, /if \(DIAG\) \{\s*try \{\s*flowSample\(\);/);
  assert.match(source, /if \(DIAG\) \{\s*window\.addEventListener\('error', onError\);\s*window\.addEventListener\('unhandledrejection', onRejection\);/);
  assert.match(source, /if \(DIAG\) window\.__DSH_FASTLOAD__ = diagnosticsApi;/);
  assert.match(source, /const remember = \(kind, value\) => \{\s*if \(!DIAG\) return;/);
  assert.match(source, /conversationProbe\(DIAG\)/);
  // Prototype patches are more invasive than reads, so they still need the
  // older debug switch on top of diagnostics.
  assert.match(source, /const INSTRUMENT = DIAG && DEBUG;/);
  assert.match(source, /if \(INSTRUMENT\) \{\s*for \(const delay of \[0, 40, 110, 250, 500, 900, 1500\]\)/);
});

test('the core paging rhythm and the unmount cleanup stay intact', async () => {
  const source = await readFile(clientUrl, 'utf8');
  const constant = (name) => {
    const match = source.match(new RegExp(name + '\\s*=\\s*(\\d+)'));
    assert.ok(match, name + ' is defined');
    return Number(match[1]);
  };
  assert.equal(constant('AUTOLOAD_DELAY_MS'), 900);
  assert.equal(constant('RETRY_MS'), 700);
  assert.equal(constant('MAX_ATTEMPTS'), 8);
  assert.equal(constant('INPUT_IDLE_MS'), 1500);
  assert.match(source, /setInterval\(scan, 500\)/);
  assert.match(source, /if \(DIAG\) \{\s*window\.addEventListener/);
  // Unmount must clear the polling interval, every pending timer, and every
  // listener this module added, including the diagnostic ones.
  const start = source.indexOf('return () => {\n              disposed = true;');
  assert.ok(start > 0, 'client returns a disposer');
  const body = source.slice(start);
  assert.match(body, /clearInterval\(interval\)/);
  assert.match(body, /for \(const timer of timers\) clearTimeout\(timer\)/);
  assert.match(body, /window\.removeEventListener\('error', onError\)/);
  assert.match(body, /console\.error === quietError/);
  assert.match(body, /restorePatches\(\)/);
});

test('the predictive prewarm stays a passive follow', async () => {
  const source = await readFile(clientUrl, 'utf8');
  // The web half needs the Remote session service to open a passive read.
  assert.match(source, /inject: \[[^\]]*remote\.session/);
  // A prewarm must never activate the Agent: the host only promotes on true.
  assert.match(source, /activate: false/);
  assert.match(source, /PREWARM_MAX_QUEUE/);
  assert.match(source, /dsh-fastload\.prewarm/);
});

const readmeZhUrl = new URL('../README.md', import.meta.url);
const readmeEnUrl = new URL('../README.en.md', import.meta.url);

// DSH_FASTLOAD_ENABLED=0 only turns off the host half; the web client still
// fills one page after the first paint. Both READMEs must scope the switch
// that way instead of promising a total disable (audit FL-02).
test('startup prewarm is opt-in with the opposite polarity of the hover warm', async () => {
  const source = await readFile(clientUrl, 'utf8');
  const start = source.indexOf('const restorePrewarmAllowed');
  assert.ok(start > 0, 'client defines restorePrewarmAllowed');
  const body = source.slice(start, source.indexOf('\n            };', start));
  // Stage 2's plan requires this hint to default off: an absent key must not
  // enable it, and the window override must be exactly true (not merely set).
  assert.match(body, /localStorage\.getItem\(RESTORE_PREWARM_KEY\) === '1'/);
  assert.match(body, /__DSH_FASTLOAD_RESTORE_PREWARM__ === true/);
  assert.doesNotMatch(body, /!== '0'/);
  assert.match(source, /RESTORE_PREWARM_KEY = 'dsh-fastload\.restore-prewarm'/);
});

test('startup prewarm validates the saved selection before touching the host', async () => {
  const source = await readFile(clientUrl, 'utf8');
  assert.match(source, /localStorage\.getItem\('dsh\.sessions\.current'\)/);
  // restoreSelection() sends any defined subagentAddress down the subagent
  // branch; this first version deliberately skips those targets.
  assert.match(source, /parsed\.subagentAddress !== undefined/);
  assert.match(source, /'invalid-json'/);
  assert.match(source, /'invalid-shape'/);
  assert.match(source, /'missing-session-id'/);
  assert.match(source, /'subagent'/);
  // The plugin observes the persisted selection; it must never write it or
  // navigate the page to it.
  assert.doesNotMatch(source, /setItem\(\s*['"]dsh\.sessions\.current/);
  assert.doesNotMatch(source, /\b(location\.(assign|replace|reload)|history\.(pushState|replaceState))/);
  // List readiness is only a bonus check; waiting on it would defeat the
  // startup overlap.
  assert.match(source, /phase !== 'ready'/);
});

test('startup prewarm shares the hover queue but cancels only its own stream', async () => {
  const source = await readFile(clientUrl, 'utf8');
  // One serial queue, one TTL map, but each entry remembers why it exists.
  assert.match(source, /prewarmQueue\.push\(\{\s*sid,\s*source: origin\s*\}\)/);
  assert.match(source, /entry\.source === 'restore'/);
  assert.match(source, /source === 'restore' \? 'restore' : 'hover'/);
  // The native open is observed through the live workspace service: the
  // persisted key already equals the target before restore happens.
  assert.match(source, /ctx\.get\('uiWorkspace'\)/);
  assert.match(source, /service\.selection\.subscribe/);
  assert.match(source, /mainReference/);
  assert.match(source, /queueMicrotask/);
  // Cancel path: only this plugin's restore-sourced passive follow is aborted.
  const start = source.indexOf('const cancelRestorePrewarm');
  assert.ok(start > 0, 'client defines cancelRestorePrewarm');
  const body = source.slice(start, source.indexOf('const armRestoreWatch', start));
  assert.match(body, /cancelQueuedPrewarm\(restorePrewarm\.sid, 'restore'\)/);
  assert.match(body, /prewarmActive\.source === 'restore'/);
  assert.match(body, /prewarmActive\.sid === restorePrewarm\.sid/);
  assert.match(body, /controller\.abort\(\)/);
  // No reliable signal means no warm: retries are bounded and give up.
  assert.match(source, /'cancel-signal-unavailable'/);
  assert.match(source, /RESTORE_SIGNAL_RETRIES/);
  // Reloading eagerly must not stack warmups: one success per tab per minute.
  assert.match(source, /sessionStorage\.setItem\(RESTORE_WARM_GUARD_KEY/);
  assert.match(source, /'recently-warmed'/);
  assert.match(source, /restorePrewarm: state\.restorePrewarm/);
});

test('READMEs document the startup warm as off by default', async () => {
  const zh = await readFile(readmeZhUrl, 'utf8');
  const en = await readFile(readmeEnUrl, 'utf8');
  for (const [name, text] of [['zh', zh], ['en', en]]) {
    assert.match(text, /dsh-fastload\.restore-prewarm/, name + ' documents the switch key');
    assert.match(text, /__DSH_FASTLOAD_RESTORE_PREWARM__/, name + ' documents the window override');
  }
  assert.match(zh, /默认关闭/);
  assert.match(en, /off by default/i);
});

test('READMEs document the opt-in diagnostics switch', async () => {
  const zh = await readFile(readmeZhUrl, 'utf8');
  const en = await readFile(readmeEnUrl, 'utf8');
  for (const [name, text] of [['zh', zh], ['en', en]]) {
    assert.match(text, /dsh-fastload\.diagnostics/, name + ' documents the switch key');
    assert.match(text, /__DSH_FASTLOAD_DIAGNOSTICS__/, name + ' documents the window override');
  }
});

test('READMEs scope DSH_FASTLOAD_ENABLED=0 to the host half', async () => {
  const zh = await readFile(readmeZhUrl, 'utf8');
  const en = await readFile(readmeEnUrl, 'utf8');
  const rowOf = (source) =>
    source.split('\n').find((line) => line.startsWith('| `DSH_FASTLOAD_ENABLED`'));
  const zhRow = rowOf(zh);
  const enRow = rowOf(en);
  assert.ok(zhRow, 'Chinese README documents DSH_FASTLOAD_ENABLED');
  assert.ok(enRow, 'English README documents DSH_FASTLOAD_ENABLED');
  assert.match(zhRow, /Host/);
  assert.match(zhRow, /Web/);
  assert.doesNotMatch(zhRow, /完全关闭/);
  assert.match(enRow, /Host/);
  assert.match(enRow, /Web client/);
});

test('the package ships the host sources and keeps client inject empty', async () => {
  const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'));
  assert.ok(pkg.files.includes('index.js'));
  assert.ok(pkg.files.includes('src'));
  assert.ok(pkg.files.includes('docs'));
  assert.deepEqual(pkg.dsh.client.inject, []);
  assert.equal(pkg.engines.dsh, '>=0.2.0-rc.1');
});

test('the idle cache refresh switch is documented in both READMEs', async () => {
  const zh = await readFile(readmeZhUrl, 'utf8');
  const en = await readFile(readmeEnUrl, 'utf8');
  const rowOf = (source) =>
    source.split('\n').find((line) => line.startsWith('| `DSH_FASTLOAD_IDLE_CACHE_REFRESH`'));
  const zhRow = rowOf(zh);
  const enRow = rowOf(en);
  assert.ok(zhRow, 'Chinese README documents DSH_FASTLOAD_IDLE_CACHE_REFRESH');
  assert.ok(enRow, 'English README documents DSH_FASTLOAD_IDLE_CACHE_REFRESH');
  assert.match(zhRow, /空闲/);
  assert.match(zhRow, /只读/);
  assert.match(zhRow, /revision/i);
  assert.match(enRow, /idle/i);
  assert.match(enRow, /read-only/i);
  assert.match(enRow, /revision/i);
});

test('config defaults the idle cache refresh to off and parses the switch', async () => {
  const { DEFAULTS, readConfig } = await import('../src/config.js');
  assert.equal(DEFAULTS.idleCacheRefresh, false);
  assert.equal(readConfig({}).idleCacheRefresh, false);
  assert.equal(readConfig({ DSH_FASTLOAD_IDLE_CACHE_REFRESH: '1' }).idleCacheRefresh, true);
  assert.equal(readConfig({ DSH_FASTLOAD_IDLE_CACHE_REFRESH: 'on' }).idleCacheRefresh, true);
  assert.equal(readConfig({ DSH_FASTLOAD_IDLE_CACHE_REFRESH: '0' }).idleCacheRefresh, false);
  assert.equal(readConfig({ DSH_FASTLOAD_IDLE_CACHE_REFRESH: 'off' }).idleCacheRefresh, false);
  // readBool only treats the documented false words as off; everything else
  // enables, matching the other switches in this repository.
  assert.equal(readConfig({ DSH_FASTLOAD_IDLE_CACHE_REFRESH: 'nonsense' }).idleCacheRefresh, true);
});
