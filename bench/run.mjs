import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BENCH_DIR, REPO_ROOT, ensureDir, rmrf, exists, timestampForPath, maskSession, summarize, round, sleep as utilSleep } from './lib/util.mjs';
import { DshHost, resolveDshBin } from './lib/host.mjs';
import { HeadlessChrome } from './lib/chrome.mjs';
import { measureOnce, bootstrapBlank } from './lib/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage: node bench/run.mjs --home <DSH_HOME> [options]

Options:
  --home <dir>          Isolated DSH_HOME (required; no user DSH_HOME is touched)
  --workspace <dir>     Workspace used by the host (default: three levels above this worktree)
  --samples <file>      Sample list JSON (default: bench/samples.local.json, else samples.example.json)
  --out <dir>           Result directory (default: bench/results/<timestamp>)
  --reps <n>            Override warm-scenario repetitions (default 10)
  --cold-reps <n>       Cold-host repetitions (default 5)
  --scenarios <list>    Comma list: cold-host,warm-host,cache-hit,cache-miss,plain
  --profile <mode>      plugin (default) or stock (profile must not load dsh-fastload)
  --host-env <K=V>      Extra environment variable for the DSH host (repeatable)
  --samples-filter <l>  Comma list of sample keys
  --host-port <port>    Default 3597
  --cdp-port <port>     Default 9337
  --dsh-bin <file>      @deepseek-ai/dsh/lib/bin.js
  --chrome <file>       chrome.exe / msedge.exe
  --keep                Keep host, Chrome and Chrome profile on exit (debug only)
  --help`;

function parseArgs(argv) {
  const opts = {
    home: null,
    workspace: null,
    samples: null,
    out: null,
    reps: 10,
    coldReps: 5,
    scenarios: ['cold-host', 'warm-host', 'cache-hit', 'cache-miss'],
    profile: 'plugin',
    hostEnv: [],
    sampleFilter: null,
    hostPort: 3597,
    cdpPort: 9337,
    dshBin: null,
    chrome: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error('missing value for ' + a); return argv[++i]; };
    if (a === '--home') opts.home = next();
    else if (a === '--workspace') opts.workspace = next();
    else if (a === '--samples') opts.samples = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--reps') opts.reps = Number(next());
    else if (a === '--cold-reps') opts.coldReps = Number(next());
    else if (a === '--scenarios') opts.scenarios = next().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--profile') { const v = next(); if (!['plugin', 'stock'].includes(v)) throw new Error('--profile must be plugin or stock'); opts.profile = v; }
    else if (a === '--host-env') { const v = next(); const i = v.indexOf('='); if (i <= 0) throw new Error('--host-env expects KEY=VALUE, got ' + v); opts.hostEnv.push([v.slice(0, i), v.slice(i + 1)]); }
    else if (a === '--samples-filter') opts.sampleFilter = next().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--host-port') opts.hostPort = Number(next());
    else if (a === '--cdp-port') opts.cdpPort = Number(next());
    else if (a === '--dsh-bin') opts.dshBin = next();
    else if (a === '--chrome') opts.chrome = next();
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else throw new Error('unknown argument ' + a);
  }
  if (!opts.home) throw new Error('--home is required');
  if (!Number.isFinite(opts.reps) || opts.reps < 1) throw new Error('--reps must be >= 1');
  if (!Number.isFinite(opts.coldReps) || opts.coldReps < 1) throw new Error('--cold-reps must be >= 1');
  return opts;
}

function norm(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

async function findSessionLog(root, sessionId) {
  const target = sessionId.startsWith('session-') ? sessionId : 'session-' + sessionId;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === target) {
          const file = path.join(p, 'session.v4.jsonl.zstd');
          if (await exists(file)) return file;
        }
        stack.push(p);
      }
    }
  }
  return null;
}

function analyzeLog(logPath) {
  if (!logPath) return { logFile: null, logCompressedBytes: null, logUncompressedBytes: null, logLines: null, logError: 'not found' };
  try {
    const compressed = fs.readFileSync(logPath);
    let raw;
    try { raw = zlib.zstdDecompressSync(compressed); } catch (e) { return { logFile: path.basename(logPath), logCompressedBytes: compressed.length, logUncompressedBytes: null, logLines: null, logError: 'zstd: ' + e.message }; }
    let lines = 0;
    for (const b of raw) if (b === 10) lines += 1;
    if (raw.length && raw[raw.length - 1] !== 10) lines += 1;
    return { logFile: path.basename(logPath), logCompressedBytes: compressed.length, logUncompressedBytes: raw.length, logLines: lines, logError: null };
  } catch (e) {
    return { logFile: path.basename(logPath), logCompressedBytes: null, logUncompressedBytes: null, logLines: null, logError: e.message };
  }
}

async function listCacheFiles(pagesDir) {
  try {
    const names = await fsp.readdir(pagesDir);
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json.zst')) continue;
      const p = path.join(pagesDir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st) out.push({ path: p, name, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out.sort((a, b) => b.size - a.size);
  } catch { return []; }
}

function cacheFileFromWrite(pagesDir, write) {
  if (!write || !write.hash) return null;
  const p = path.join(pagesDir, write.hash + '.json.zst');
  return fs.existsSync(p) ? p : null;
}

function pickLargestCache(files, sinceMs = 0) {
  const candidates = files.filter((f) => f.size > 2048 && f.mtimeMs >= sinceMs - 1000);
  return candidates.length ? candidates[0].path : null;
}

async function corruptCache(file) {
  const st = await fsp.stat(file);
  const before = st.size;
  if (before < 100) throw new Error('cache file too small to corrupt: ' + before);
  const keep = Math.max(16, Math.floor(before * 0.5));
  await fsp.truncate(file, keep);
  return { file, before, after: keep };
}

async function writeJson(p, value) {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(value, null, 2));
}

function versionOfDsh(bin) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(bin), '..', 'package.json'), 'utf8'));
    return { name: pkg.name, version: pkg.version };
  } catch { return { name: null, version: null }; }
}

function gitInfo() {
  try {
    return {
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0,
    };
  } catch { return { branch: null, head: null, dirty: null }; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = path.resolve(opts.home);
  await ensureDir(home);
  const samplesPath = path.resolve(opts.samples || (fs.existsSync(path.join(BENCH_DIR, 'samples.local.json')) ? path.join(BENCH_DIR, 'samples.local.json') : path.join(BENCH_DIR, 'samples.example.json')));
  const sampleDoc = readJson(samplesPath);
  const workspace = path.resolve(opts.workspace || sampleDoc.workspace || path.resolve(REPO_ROOT, '../../..'));
  let samples = (sampleDoc.samples || []).map((s, i) => ({
    key: s.key || 'sample' + (i + 1),
    label: s.label || s.key || 'sample' + (i + 1),
    kind: s.kind || 'unknown',
    sessionId: s.sessionId,
  }));
  if (opts.sampleFilter) samples = samples.filter((s) => opts.sampleFilter.includes(s.key));
  if (!samples.length) throw new Error('no samples selected');
  for (const s of samples) {
    if (!/^session-[0-9a-f-]{36}$/.test(s.sessionId)) throw new Error('bad sessionId for ' + s.key + ': ' + s.sessionId);
  }

  const runId = timestampForPath();
  const outDir = path.resolve(opts.out || path.join(BENCH_DIR, 'results', runId));
  await ensureDir(outDir);
  const runLogPath = path.join(outDir, 'run.log');
  const log = (msg) => {
    const line = '[' + new Date().toISOString() + '] ' + msg;
    console.log(line);
    fs.appendFileSync(runLogPath, line + '\n');
  };

  const dshBin = resolveDshBin(opts.dshBin);
  const dshVersion = versionOfDsh(dshBin);
  const pluginPkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const profileLink = path.join(home, 'profiles', 'web', 'node_modules', 'dsh-fastload');
  const profilePkg = readJson(path.join(home, 'profiles', 'web', 'package.json'));
  const profileBundles = profilePkg.dsh?.profile?.bundles || [];
  if (opts.profile === 'stock') {
    let linkPresent = false;
    try { linkPresent = fs.lstatSync(profileLink).isSymbolicLink() || fs.existsSync(profileLink); } catch {}
    if (linkPresent) throw new Error('stock profile still has dsh-fastload at ' + profileLink);
    if (profileBundles.includes('dsh-fastload')) throw new Error('stock profile bundles must not include dsh-fastload');
  } else {
    if (!(await exists(profileLink))) throw new Error('profile link missing: ' + profileLink + ' (create a junction to ' + REPO_ROOT + ')');
    const profileReal = fs.realpathSync(profileLink);
    if (norm(profileReal) !== norm(REPO_ROOT)) throw new Error('profile dsh-fastload resolves to ' + profileReal + ', not worktree ' + REPO_ROOT);
    if (!profileBundles.includes('dsh-fastload')) throw new Error('profile bundles do not include dsh-fastload');
  }

  const pagesDir = path.join(home, 'cache', 'dsh-fastload', 'pages');
  const cacheRoot = path.join(home, 'cache', 'dsh-fastload');
  const hostPort = opts.hostPort;
  const cdpPort = opts.cdpPort;
  const hostEnv = Object.fromEntries(opts.hostEnv);
  const host = new DshHost({ home, port: hostPort, workspace, dshBin, outDir, label: 'host', extraEnv: hostEnv });
  const chrome = new HeadlessChrome({ port: cdpPort, userDataDir: path.join(BENCH_DIR, '.chrome', runId), chromePath: opts.chrome, outDir });
  const raw = {
    meta: {
      tool: 'dsh-fastload stage0 bench',
      runId,
      startedAt: new Date().toISOString(),
      worktree: REPO_ROOT,
      home,
      workspace,
      outDir,
      samplesFile: path.basename(samplesPath),
      git: gitInfo(),
      profile: opts.profile,
      hostEnv: opts.hostEnv.map(([k, v]) => k + '=' + v),
      docStartJs: process.env.BENCH_DOC_START_JS || null,
      plugin: { name: pluginPkg.name, version: pluginPkg.version, loaded: opts.profile === 'plugin' },
      dsh: { bin: dshBin, ...dshVersion },
      chrome: { path: chrome.chromePath, version: null },
      node: process.version,
      os: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model || null, totalMemBytes: os.totalmem() },
      ports: { host: hostPort, cdp: cdpPort },
      reps: { cold: opts.coldReps, warm: opts.reps },
      scenarios: opts.scenarios,
    },
    samples: [],
    runs: [],
  };

  for (const s of samples) {
    const logPath = await findSessionLog(path.join(home, 'sessions'), s.sessionId);
    raw.samples.push({
      key: s.key,
      label: s.label,
      kind: s.kind,
      sessionId: s.sessionId,
      sessionIdMasked: maskSession(s.sessionId),
      ...analyzeLog(logPath),
    });
  }

  let blankSessionId = null;
  let stopped = false;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    if (!opts.keep) {
      await host.stop().catch(() => {});
      await chrome.stop().catch(() => {});
    }
    log('cleanup done' + (opts.keep ? ' (kept host/chrome)' : ''));
  };
  process.on('SIGINT', async () => { log('SIGINT'); await cleanup(); process.exit(130); });

  try {
    log('starting Chrome ' + chrome.chromePath);
    await chrome.start();
    raw.meta.chrome.version = chrome.version?.Browser || null;
    log('Chrome ' + raw.meta.chrome.version + ' on CDP ' + cdpPort);
    await writeJson(path.join(outDir, 'raw.json'), raw);

    const runRep = async ({ scenario, sample, rep, expectedCache = 'n/a', cacheFile: suppliedCacheFile = null }) => {
      const label = scenario + '-' + sample.key + '-' + String(rep).padStart(2, '0');
      const repStart = Date.now();
      let cacheFile = suppliedCacheFile;
      let corrupt = null;
      if (scenario === 'cache-hit' || scenario === 'cache-miss') {
        if (!cacheFile) {
          const files = await listCacheFiles(pagesDir);
          cacheFile = pickLargestCache(files, 0);
        }
        if (!cacheFile || !fs.existsSync(cacheFile)) throw new Error(scenario + ': primed page cache file missing for ' + sample.key);
        if (scenario === 'cache-miss') corrupt = await corruptCache(cacheFile);
      }
      const r = await measureOnce({
        chromePort: cdpPort,
        tokenUrl: host.tokenUrl,
        blankSessionId,
        targetSessionId: sample.sessionId,
        outDir,
        label,
        hostPid: host.pid,
        host,
        sampler: true,
        onBeforeClick: scenario === 'cache-miss' ? async () => {
          if (!cacheFile || !fs.existsSync(cacheFile)) throw new Error('cache-miss: corrupted cache file disappeared before click');
        } : null,
      });
      if (scenario === 'cache-miss' || scenario === 'warm-host' || scenario === 'cold-host') {
        const write = r.host?.stderr?.pageCacheWrite;
        const fromWrite = cacheFileFromWrite(pagesDir, write);
        if (fromWrite) cacheFile = fromWrite;
        else if (!cacheFile && scenario !== 'cold-host') {
          const files = await listCacheFiles(pagesDir);
          cacheFile = pickLargestCache(files, repStart);
        }
      }
      const observed = r.host?.hit ? 'hit' : (r.host?.liveAt ? 'miss' : 'unknown');
      r.scenario = scenario;
      r.sampleKey = sample.key;
      r.rep = rep;
      r.label = label;
      r.expectedCache = expectedCache;
      r.cacheObserved = observed;
      r.cacheMatchesExpectation = expectedCache === 'n/a' ? true : expectedCache === observed;
      r.cacheFile = cacheFile ? path.basename(cacheFile) : null;
      r.corrupt = corrupt;
      raw.runs.push(r);
      await writeJson(path.join(outDir, 'raw.json'), raw);
      log(scenario + '/' + sample.key + '#' + rep + ' click->row=' + (r.timings.clickToFirstRowMs ?? 'null') + 'ms snap=' + (r.frame.snapshotBytes ?? 'null') + 'B records=' + (r.frame.records ?? 'null') + ' cache=' + observed + (r.cacheMatchesExpectation ? '' : ' EXPECTED ' + expectedCache) + (r.ok ? '' : ' FAILED'));
      return r;
    };

    const primeOne = async (sample, labelPrefix) => {
      const label = labelPrefix + '-' + sample.key;
      const t0 = Date.now();
      const r = await measureOnce({
        chromePort: cdpPort,
        tokenUrl: host.tokenUrl,
        blankSessionId,
        targetSessionId: sample.sessionId,
        outDir,
        label,
        hostPid: host.pid,
        host,
        sampler: false,
      });
      await utilSleep(600);
      const write = r.host?.stderr?.pageCacheWrite;
      let file = cacheFileFromWrite(pagesDir, write);
      if (!file) {
        const files = await listCacheFiles(pagesDir);
        file = pickLargestCache(files, t0);
      }
      if (!file) throw new Error('prime did not produce a page cache file for ' + sample.key);
      log('primed ' + sample.key + ' -> ' + path.basename(file) + ' (' + fs.statSync(file).size + 'B), snapshot=' + r.frame.snapshotBytes + 'B');
      return { sample: sample.key, file, snapshotBytes: r.frame.snapshotBytes, records: r.frame.records, hostHit: r.host?.hit ?? null };
    };

    const primeSequence = async (prefix) => {
      await rmrf(pagesDir);
      const out = [];
      for (const s of samples) out.push(await primeOne(s, prefix));
      return out;
    };

    const scenarios = opts.scenarios;
    if (scenarios.includes('cold-host')) {
      log('=== cold-host: ' + opts.coldReps + ' reps/sample, fresh host + deleted fastload cache each rep ===');
      for (const s of samples) {
        for (let rep = 1; rep <= opts.coldReps; rep += 1) {
          await host.stop();
          await rmrf(cacheRoot);
          await host.start();
          await utilSleep(400);
          if (!blankSessionId) {
            const boot = await bootstrapBlank({ chromePort: cdpPort, tokenUrl: host.tokenUrl, outDir });
            blankSessionId = boot.blankSessionId;
            log('blank session: ' + maskSession(blankSessionId) + ', sidebar rows=' + boot.rows);
          }
          await runRep({ scenario: 'cold-host', sample: s, rep, expectedCache: 'miss' });
        }
      }
      await host.stop();
    }

    if (scenarios.includes('warm-host') || scenarios.includes('cache-hit') || scenarios.includes('cache-miss') || scenarios.includes('plain')) {
      log('=== starting warm host ===');
      await host.start();
      await utilSleep(500);
      if (!blankSessionId) {
        const boot = await bootstrapBlank({ chromePort: cdpPort, tokenUrl: host.tokenUrl, outDir });
        blankSessionId = boot.blankSessionId;
        log('blank session: ' + maskSession(blankSessionId) + ', sidebar rows=' + boot.rows);
      }

      if (scenarios.includes('plain')) {
        log('=== plain: warm host, direct open, no page-cache handling ===');
        for (const s of samples) {
          for (let rep = 1; rep <= opts.reps; rep += 1) {
            await runRep({ scenario: 'plain', sample: s, rep, expectedCache: 'n/a' });
          }
        }
      }

      if (scenarios.includes('warm-host')) {
        log('=== warm-host: prime scan cache, then delete page cache each rep ===');
        await primeSequence('prime-warm');
        await rmrf(pagesDir);
        for (const s of samples) {
          for (let rep = 1; rep <= opts.reps; rep += 1) {
            await rmrf(pagesDir);
            await runRep({ scenario: 'warm-host', sample: s, rep, expectedCache: 'miss' });
          }
        }
      }

      if (scenarios.includes('cache-hit')) {
        log('=== cache-hit: prime page cache once, then measure hits ===');
        const primes = await primeSequence('prime-hit');
        raw.primes = { hit: primes };
        await writeJson(path.join(outDir, 'raw.json'), raw);
        for (const s of samples) {
          const prime = primes.find((p) => p.sample === s.key);
          for (let rep = 1; rep <= opts.reps; rep += 1) {
            if (!fs.existsSync(prime.file)) throw new Error('primed cache file disappeared for ' + s.key);
            await runRep({ scenario: 'cache-hit', sample: s, rep, expectedCache: 'hit', cacheFile: prime.file });
          }
        }
      }

      if (scenarios.includes('cache-miss')) {
        log('=== cache-miss: prime then truncate the target cache entry before each click ===');
        const primes = await primeSequence('prime-miss');
        raw.primes = { ...(raw.primes || {}), miss: primes };
        await writeJson(path.join(outDir, 'raw.json'), raw);
        for (const s of samples) {
          const prime = primes.find((p) => p.sample === s.key);
          let cacheFile = prime ? prime.file : null;
          for (let rep = 1; rep <= opts.reps; rep += 1) {
            if (!cacheFile || !fs.existsSync(cacheFile)) {
              const files = await listCacheFiles(pagesDir);
              cacheFile = pickLargestCache(files, 0);
            }
            if (!cacheFile) throw new Error('cache-miss: no cache file to corrupt for ' + s.key);
            const r = await runRep({ scenario: 'cache-miss', sample: s, rep, expectedCache: 'miss', cacheFile });
            const write = r.host?.stderr?.pageCacheWrite;
            const rewritten = cacheFileFromWrite(pagesDir, write);
            if (rewritten) cacheFile = rewritten;
          }
        }
      }
      await host.stop();
    }

    raw.meta.endedAt = new Date().toISOString();
    raw.summary = buildSummary(raw);
    await writeJson(path.join(outDir, 'raw.json'), raw);
    await writeJson(path.join(outDir, 'summary.json'), { meta: raw.meta, samples: raw.samples, runs: raw.runs.length, summary: raw.summary });
    log('results: ' + outDir);
    log('groups: ' + Object.keys(raw.summary.groups).length + ', runs: ' + raw.runs.length);
  } finally {
    await cleanup();
  }
}

function buildSummary(raw) {
  const groups = {};
  const metricPaths = [
    'timings.clickToFollowMs',
    'timings.followToSnapshotMs',
    'timings.snapshotToFirstRowMs',
    'timings.clickToFirstRowMs',
    'timings.pageLoadMs',
    'frame.snapshotBytes',
    'frame.records',
    'frame.messages',
    'frame.turns',
    'frame.tools',
    'frame.wsInboundBytesClickToFirstRow',
    'frame.wsOutboundBytesClickToFirstRow',
    'page.domNodesAtFirstRow',
    'page.domNodesAfterSettle',
    'page.fcpAt',
    'page.domNodesAfterSettle',
    'page.longTasks.clickToFirstRow.over50Count',
    'page.longTasks.clickToFirstRow.over50TotalMs',
    'page.longTasks.pageLoad.over50Count',
    'page.longTasks.pageLoad.over50TotalMs',
    'page.reactCommit.afterClick',
    'page.reactCommit.firstAfterClickMs',
    'page.reactCommit.beforeFirstRow',
    'host.openToHitMs',
    'host.openToLiveMs',
    'host.stderr.pageCacheReadyMs',
    'host.stderr.firstFrameMs',
    'hostResources.cpuSeconds',
    'hostResources.avgCores',
    'hostResources.peakWorkingSetBytes',
    'hostResources.maxWorkingSetBytes',
  ];
  for (const run of raw.runs) {
    const key = run.scenario + '/' + run.sampleKey;
    const g = (groups[key] ||= { scenario: run.scenario, sampleKey: run.sampleKey, n: 0, ok: 0, cacheExpected: run.expectedCache, cacheObserved: {}, metrics: {}, failures: [] });
    g.n += 1;
    if (run.ok) g.ok += 1;
    else g.failures.push(run.label + ': ' + (run.pageErrors?.slice(0, 2).join('; ') || 'no first row'));
    g.cacheObserved[run.cacheObserved] = (g.cacheObserved[run.cacheObserved] || 0) + 1;
    for (const p of metricPaths) {
      const v = getPath(run, p);
      if (typeof v === 'number' && Number.isFinite(v)) (g.metrics[p] ||= []).push(v);
    }
  }
  for (const g of Object.values(groups)) {
    g.stats = {};
    for (const [p, vals] of Object.entries(g.metrics)) g.stats[p] = summarize(vals);
    delete g.metrics;
  }
  return { groups, metricPaths, runCount: raw.runs.length };
}

main().catch((e) => {
  console.error('BENCH FAILED:', e.stack || e.message);
  process.exitCode = 1;
});
