import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, waitFor, round } from './util.mjs';

const PS1 = fileURLToPath(new URL('./host-sampler.ps1', import.meta.url));

export class HostSampler {
  constructor({ pid, outDir, label }) {
    this.pid = pid;
    this.outDir = outDir;
    this.label = label;
    this.samplesPath = path.join(outDir, label + '.samples.json');
    this.stopPath = path.join(outDir, label + '.stop');
    this.readyPath = path.join(outDir, label + '.ready');
  }

  async start() {
    await ensureDir(this.outDir);
    for (const p of [this.samplesPath, this.stopPath, this.readyPath]) await fsp.rm(p, { force: true }).catch(() => {});
    this.child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-TargetPid', String(this.pid),
      '-Out', this.samplesPath,
      '-Stop', this.stopPath,
      '-Ready', this.readyPath,
      '-IntervalMs', '50',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
    await waitFor(() => fs.existsSync(this.readyPath), { timeoutMs: 8000, intervalMs: 50, label: 'host sampler ready' });
    return this;
  }

  async stop() {
    await fsp.writeFile(this.stopPath, 'stop');
    await new Promise((resolve) => {
      if (!this.child || this.child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 5000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    let samples = [];
    try {
      const raw = await fsp.readFile(this.samplesPath, 'utf8');
      samples = JSON.parse(raw);
      if (!Array.isArray(samples)) samples = [samples];
    } catch {}
    const valid = samples.filter((s) => typeof s.cpu === 'number' && Number.isFinite(s.cpu));
    let result = { samples: samples.length, valid: valid.length, stderr: this.stderr.slice(0, 1000) };
    if (valid.length >= 2) {
      const first = valid[0];
      const last = valid[valid.length - 1];
      const wallMs = last.t - first.t;
      const cpuSeconds = last.cpu - first.cpu;
      result = {
        ...result,
        wallMs: round(wallMs, 1),
        cpuSeconds: round(cpuSeconds, 4),
        avgCores: wallMs > 0 ? round(cpuSeconds / (wallMs / 1000), 4) : null,
        startWorkingSetBytes: first.ws,
        peakWorkingSetBytes: Math.max(...valid.map((s) => Number(s.peak) || 0)),
        maxWorkingSetBytes: Math.max(...valid.map((s) => Number(s.ws) || 0)),
        sampleSeries: valid.map((s) => ({ t: s.t, cpu: s.cpu, ws: s.ws })),
      };
    }
    this.result = result;
    return result;
  }
}
