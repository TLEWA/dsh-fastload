import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { installProbe } from './probe.mjs';
import { newPage, closeTarget, evalJs, sleep } from './cdp.mjs';
import { waitFor, round, readFrom } from './util.mjs';
import { HostSampler } from './sampler.mjs';

const TARGET_ROW_SELECTOR = (sid) => '[data-row-key="session:' + sid + '"]';

function countRecordTypes(records) {
  const events = Object.create(null);
  let messages = 0;
  let turns = 0;
  let tools = 0;
  for (const rec of records || []) {
    const type = rec && rec.type;
    if (type !== 'event') continue;
    const ev = rec.event || {};
    const et = ev.type || '?';
    events[et] = (events[et] || 0) + 1;
    if (et === 'assistant/message' || et === 'user/message') messages += 1;
    else if (et === 'turn/start') turns += 1;
    else if (et === 'tool/call') tools += 1;
  }
  return { messages, turns, tools, events };
}

function longTaskStats(tasks, from, to) {
  const picked = (tasks || []).filter((t) => t.start >= from && t.start < to);
  const over = picked.filter((t) => t.duration > 50);
  return {
    count: picked.length,
    over50Count: over.length,
    over50TotalMs: round(over.reduce((s, t) => s + t.duration, 0), 3),
    maxMs: round(picked.reduce((m, t) => Math.max(m, t.duration), 0), 3),
  };
}

function parseServeLog(text, { pid, sid, startMs, endMs }) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+p=(\d+)\s+(\S+)\s+sid=(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || at < startMs - 3000 || at > endMs + 5000) continue;
    if (pid && Number(m[2]) !== pid) continue;
    if (sid && m[4] !== sid) continue;
    entries.push({ at, wall: m[1], event: m[3], rest: m[5].trim() });
  }
  const open = entries.find((e) => e.event === 'open' && /initial=true/.test(e.rest));
  const hit = entries.find((e) => e.event === 'hit');
  const live = entries.find((e) => e.event === 'live');
  const store = entries.find((e) => e.event === 'store');
  const replay = entries.find((e) => e.event === 'replay');
  const num = (re, src) => { const x = re.exec(src || ''); return x ? Number(x[1]) : null; };
  return {
    entries,
    hit: Boolean(hit),
    openAt: open ? open.at : null,
    hitAt: hit ? hit.at : null,
    liveAt: live ? live.at : null,
    storeAt: store ? store.at : null,
    replayAt: replay ? replay.at : null,
    openToHitMs: open && hit ? round(hit.at - open.at, 3) : null,
    openToLiveMs: open && live ? round(live.at - open.at, 3) : null,
    openToStoreMs: open && store ? round(store.at - open.at, 3) : null,
    records: num(/records=(\d+)/, (hit || live || store || open || {}).rest),
    cursor: num(/cursor=(\d+)/, (hit || live || store || open || {}).rest),
    hasMore: /hasMore=true/.test((hit || live || store || open || {}).rest || '') ? true : (/hasMore=false/.test((hit || live || store || open || {}).rest || '') ? false : null),
    openRest: open ? open.rest : null,
  };
}

function parseHostStderr(text, { targetRecords }) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const frames = [];
  const served = [];
  const ready = [];
  const writes = [];
  const cacheEvents = [];
  for (const line of lines) {
    let m;
    if ((m = /\[fl\] first frame ([\d.]+)ms records=(\d+)/.exec(line))) frames.push({ ms: Number(m[1]), records: Number(m[2]), line });
    if ((m = /\[fl\] page cache ready ([\d.]+)ms/.exec(line))) ready.push({ ms: Number(m[1]), line });
    if ((m = /\[fl\] page cache served cursor=(\d+) records=(\d+)/.exec(line))) served.push({ cursor: Number(m[1]), records: Number(m[2]), line });
    if ((m = /\[fl\] page cache write ([0-9a-f]+) (\d+)B rev=/.exec(line))) writes.push({ hash: m[1], bytes: Number(m[2]), line });
    if (/\[fl\] page cache/.test(line) && !/page cache (ready|served|write|hit)/.test(line)) cacheEvents.push(line);
  }
  const frame = targetRecords == null ? frames[frames.length - 1] : [...frames].reverse().find((f) => f.records === targetRecords);
  const servedTarget = targetRecords == null ? served[served.length - 1] : [...served].reverse().find((s) => s.records === targetRecords);
  let readyTarget = null;
  if (servedTarget) {
    const idx = lines.lastIndexOf(servedTarget.line);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const m = /\[fl\] page cache ready ([\d.]+)ms/.exec(lines[i]);
      if (m) { readyTarget = { ms: Number(m[1]), line: lines[i] }; break; }
    }
  }
  const write = writes.length ? writes.reduce((a, b) => (a.bytes >= b.bytes ? a : b)) : null;
  return {
    firstFrameMs: frame ? frame.ms : null,
    pageCacheReadyMs: readyTarget ? readyTarget.ms : null,
    pageCacheServed: servedTarget || null,
    pageCacheWrite: write,
    cacheEvents,
    lines: lines.slice(0, 200),
  };
}

function summarize(pageSummary, net, hostLog, stderrLog, { clickWall, navWall, appReadyWall, pageEpochOffset }) {
  const s = pageSummary || {};
  const clickAt = s.clickAt;
  const followAt = s.followSentAt;
  const snapAt = s.targetSnapshotAt;
  const firstAt = s.firstRowAt;
  const inWindow = net.frames.filter((f) => f.dir === 'in' && f.at >= clickWall && (firstAt == null || f.at <= clickWall + (firstAt - clickAt) + 50));
  const outWindow = net.frames.filter((f) => f.dir === 'out' && f.at >= clickWall && (firstAt == null || f.at <= clickWall + (firstAt - clickAt) + 50));
  const snapshot = net.snapshot;
  const records = snapshot ? snapshot.records : null;
  const counts = snapshot ? countRecordTypes(records) : { messages: null, turns: null, tools: null };
  const commitsAfterClick = (s.commits || []).filter((t) => t >= (clickAt ?? Infinity));
  return {
    timings: {
      clickToFollowMs: clickAt != null && followAt != null ? round(followAt - clickAt, 3) : null,
      followToSnapshotMs: followAt != null && snapAt != null ? round(snapAt - followAt, 3) : null,
      snapshotToFirstRowMs: snapAt != null && firstAt != null ? round(firstAt - snapAt, 3) : null,
      clickToFirstRowMs: clickAt != null && firstAt != null ? round(firstAt - clickAt, 3) : null,
      pageLoadMs: appReadyWall != null && navWall != null ? round(appReadyWall - navWall, 3) : null,
      pageReadyToClickMs: clickAt != null && pageEpochOffset != null ? round(pageEpochOffset + clickAt - appReadyWall, 3) : null,
    },
    page: {
      clickAt,
      followSentAt: followAt,
      targetSnapshotAt: snapAt,
      firstRowAt: firstAt,
      timeoutAt: s.timeoutAt ?? null,
      preClick: s.preClick ?? null,
      firstRow: s.firstRow ?? null,
      domNodesAtFirstRow: s.domNodesAtFirstRow ?? null,
      domNodesAfterSettle: s.domNodesAfterSettle ?? null,
      flowChildrenAtFirstRow: s.flowChildrenAtFirstRow ?? null,
      fcpAt: s.fcpAt ?? null,
      errors: s.errors ?? [],
      longTasks: {
        pageLoad: longTaskStats(s.longTasks, 0, clickAt ?? Infinity),
        clickToFirstRow: longTaskStats(s.longTasks, clickAt ?? 0, (firstAt ?? clickAt ?? 0) + 1),
        clickToSettled: longTaskStats(s.longTasks, clickAt ?? 0, Infinity),
      },
      reactCommit: {
        total: (s.commits || []).length,
        afterClick: commitsAfterClick.length,
        firstAfterClickMs: commitsAfterClick.length ? round(commitsAfterClick[0] - clickAt, 3) : null,
        beforeFirstRow: firstAt != null ? commitsAfterClick.filter((t) => t <= firstAt).length : null,
        lastAfterClickMs: commitsAfterClick.length ? round(commitsAfterClick[commitsAfterClick.length - 1] - clickAt, 3) : null,
      },
    },
    frame: {
      snapshotBytes: snapshot ? snapshot.bytes : null,
      snapshotChars: snapshot ? snapshot.chars : null,
      records: records ? records.length : null,
      messages: counts.messages,
      turns: counts.turns,
      tools: counts.tools,
      cursor: snapshot ? snapshot.cursor : null,
      hasMore: snapshot ? snapshot.hasMore : null,
      id: snapshot ? snapshot.id : null,
      wsInboundBytesClickToFirstRow: inWindow.reduce((sum, f) => sum + f.bytes, 0),
      wsOutboundBytesClickToFirstRow: outWindow.reduce((sum, f) => sum + f.bytes, 0),
      wsInboundFramesClickToFirstRow: inWindow.length,
      wsOutboundFramesClickToFirstRow: outWindow.length,
      totalInboundFrames: net.frames.filter((f) => f.dir === 'in').length,
      totalOutboundFrames: net.frames.filter((f) => f.dir === 'out').length,
      snapshotBeforeFirstRow: snapshot && firstAt != null ? snapshot.at <= clickWall + (firstAt - clickAt) + 50 : null,
    },
    host: {
      ...hostLog,
      stderr: stderrLog,
    },
  };
}

export async function measureOnce({
  chromePort,
  tokenUrl,
  blankSessionId,
  targetSessionId,
  outDir,
  label,
  hostPid,
  host,
  sampler = true,
  probeTimeoutMs = 90000,
  onBeforeClick = null,
}) {
  const startedWall = Date.now();
  const { target, cdp } = await newPage(chromePort, 'about:blank');
  const net = { frames: [], snapshot: null, targetSid: targetSessionId };
  let navWall = null;
  let appReadyWall = null;
  let pageEpochOffset = null;
  let samplerHandle = null;
  let serveOffset = 0;
  let stderrOffset = 0;
  let hostLog = { entries: [] };
  let stderrLog = {};
  let pageSummary = null;
  const pageErrors = [];

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(' + installProbe.toString() + ')(' + JSON.stringify({
        blankSessionId,
        targetSessionId,
        reactHook: true,
        timeoutMs: probeTimeoutMs,
      }) + ')',
    });

    cdp.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception');
    });
    cdp.on('Network.webSocketFrameSent', (p) => {
      try {
        const payload = p.response?.payloadData;
        if (typeof payload !== 'string') return;
        net.frames.push({ dir: 'out', at: Date.now(), bytes: Buffer.byteLength(payload, 'utf8'), kind: payload.includes('session/follow') ? 'follow' : 'other' });
      } catch {}
    });
    cdp.on('Network.webSocketFrameReceived', (p) => {
      try {
        const payload = p.response?.payloadData;
        if (typeof payload !== 'string') return;
        const at = Date.now();
        const bytes = Buffer.byteLength(payload, 'utf8');
        net.frames.push({ dir: 'in', at, bytes, kind: payload.includes('"type":"snapshot"') ? 'snapshot' : 'other' });
        if (payload.length > 80 && payload.slice(0, 64).includes('"type":"item"') && payload.includes('"type":"snapshot"')) {
          const msg = JSON.parse(payload);
          if (msg && msg.type === 'item' && msg.value && msg.value.type === 'snapshot' && msg.value.header && msg.value.header.id === targetSessionId) {
            if (!net.snapshot) {
              net.snapshot = {
                at,
                bytes,
                chars: payload.length,
                id: msg.value.header.id,
                cursor: msg.value.cursor,
                hasMore: msg.value.hasMore,
                records: msg.value.records || [],
              };
            }
          }
        }
      } catch (e) {
        pageErrors.push('network frame parse: ' + e.message);
      }
    });

    if (host) {
      serveOffset = await host.currentServeOffset();
      stderrOffset = await host.currentStderrOffset();
    }

    navWall = Date.now();
    const nav = await cdp.send('Page.navigate', { url: tokenUrl }, 60000);
    if (nav.errorText) throw new Error('Page.navigate failed: ' + nav.errorText);
    await waitFor(async () => {
      const state = await evalJs(cdp, 'document.readyState', { timeoutMs: 5000 });
      return state === 'complete';
    }, { timeoutMs: 45000, intervalMs: 100, label: 'page load' });
    await waitFor(async () => {
      const n = await evalJs(cdp, 'document.querySelectorAll(\'[data-row-key^="session:"]\').length', { timeoutMs: 5000 });
      return n > 0;
    }, { timeoutMs: 45000, intervalMs: 100, label: 'sidebar rows' });
    const targetPresent = await evalJs(cdp, 'Boolean(document.querySelector(' + JSON.stringify(TARGET_ROW_SELECTOR(targetSessionId)) + '))', { timeoutMs: 5000 });
    if (!targetPresent) {
      const body = await evalJs(cdp, 'document.body.innerText.slice(0, 1600)', { timeoutMs: 5000 }).catch(() => '');
      throw new Error('target session row not rendered; workspace/sidebar mismatch. body=' + body);
    }
    appReadyWall = Date.now();
    pageEpochOffset = await evalJs(cdp, 'Date.now() - performance.now()', { timeoutMs: 5000 });

    if (onBeforeClick) await onBeforeClick();

    if (sampler && host && host.pid) {
      samplerHandle = new HostSampler({ pid: host.pid, outDir, label });
      await samplerHandle.start();
    }

    const clickWall = Date.now();
    await evalJs(cdp, '(() => { const row = document.querySelector(' + JSON.stringify(TARGET_ROW_SELECTOR(targetSessionId)) + '); if (!row) throw new Error("row gone"); row.scrollIntoView({ block: "center" }); row.click(); return true; })()', { timeoutMs: 10000 });

    let first;
    try {
      first = await evalJs(cdp, 'window.__BENCH__.firstRowPromise', { awaitPromise: true, timeoutMs: probeTimeoutMs + 30000 });
    } catch (e) {
      pageErrors.push('firstRowPromise: ' + e.message);
      first = await evalJs(cdp, 'window.__BENCH__ ? window.__BENCH__.summary() : null', { timeoutMs: 10000 }).catch(() => null);
    }
    pageSummary = first;
    await sleep(900);
    const settled = await evalJs(cdp, '(() => { const s = window.__BENCH__.summary(); s.domNodesAfterSettle = document.getElementsByTagName("*").length; return s; })()', { timeoutMs: 15000 }).catch(() => null);
    if (settled && pageSummary) {
      pageSummary.domNodesAfterSettle = settled.domNodesAfterSettle;
      pageSummary.longTasks = settled.longTasks || pageSummary.longTasks;
      pageSummary.commits = settled.commits || pageSummary.commits;
      pageSummary.errors = settled.errors || pageSummary.errors;
    }
    if (samplerHandle) await samplerHandle.stop();
    await sleep(400);

    if (host) {
      const serve = await readFrom(host.serveLogPath, serveOffset);
      hostLog = parseServeLog(serve.text, { pid: host.pid, sid: targetSessionId, startMs: clickWall - 2000, endMs: Date.now() });
      const err = await readFrom(host.stderrPath, stderrOffset);
      stderrLog = parseHostStderr(err.text, { targetRecords: net.snapshot ? net.snapshot.records.length : null });
    }

    const summary = summarize(pageSummary, net, hostLog, stderrLog, { clickWall, navWall, appReadyWall, pageEpochOffset });
    return {
      ok: Boolean(summary.timings.clickToFirstRowMs != null && summary.frame.snapshotBytes != null),
      startedWall,
      finishedWall: Date.now(),
      clickWall,
      navWall,
      appReadyWall,
      pageEpochOffset,
      targetSessionId,
      targetCacheFile: null,
      ...summary,
      pageErrors,
      hostResources: samplerHandle ? samplerHandle.result : null,
    };
  } finally {
    await closeTarget(chromePort, target.id).catch(() => {});
    cdp.close();
  }
}

export async function bootstrapBlank({ chromePort, tokenUrl, outDir }) {
  const { target, cdp } = await newPage(chromePort, 'about:blank');
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const nav = await cdp.send('Page.navigate', { url: tokenUrl }, 60000);
    if (nav.errorText) throw new Error('bootstrap navigate: ' + nav.errorText);
    await waitFor(async () => {
      const state = await evalJs(cdp, 'document.readyState', { timeoutMs: 5000 });
      return state === 'complete';
    }, { timeoutMs: 45000, intervalMs: 100, label: 'bootstrap load' });
    await waitFor(async () => {
      const n = await evalJs(cdp, 'document.querySelectorAll(\'[data-row-key^="session:"]\').length', { timeoutMs: 5000 });
      return n > 0;
    }, { timeoutMs: 45000, intervalMs: 100, label: 'bootstrap rows' });
    const readStored = () => evalJs(cdp, 'localStorage.getItem("dsh.sessions.current")', { timeoutMs: 5000 });
    const before = await readStored();
    const clicked = await evalJs(cdp, '(() => { const nodes = Array.from(document.querySelectorAll("button,[role=button]")); const b = nodes.find((x) => (x.textContent || "").trim() === "新会话"); if (!b) return false; b.click(); return true; })()', { timeoutMs: 5000 });
    if (!clicked) {
      if (!before) throw new Error('no stored session and no 新会话 button');
    } else {
      await waitFor(async () => {
        const v = await readStored();
        return v != null && v !== before;
      }, { timeoutMs: 15000, intervalMs: 100, label: 'new blank session' });
    }
    const raw = await readStored();
    let sid = null;
    try { sid = JSON.parse(raw).sessionId; } catch {}
    if (!sid) throw new Error('cannot parse dsh.sessions.current: ' + raw);
    const rows = await evalJs(cdp, 'document.querySelectorAll(\'[data-row-key^="session:"]\').length', { timeoutMs: 5000 });
    return { blankSessionId: sid, rows };
  } finally {
    await closeTarget(chromePort, target.id).catch(() => {});
    cdp.close();
  }
}
