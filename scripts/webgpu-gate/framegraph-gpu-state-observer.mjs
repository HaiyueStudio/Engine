import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { resolve } from 'node:path';
import { GPU_STATE_FIELDS, GPU_STATE_PROTOCOL, parseGpuStateLine } from './framegraph-gpu-state-policy.mjs';

export async function startGpuStateObserver(path, { spawnProcess = spawn, executable = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/nvidia-smi.exe'), startupTimeoutMs = 10000 } = {}) {
  const writer = createWriteStream(path, { flags: 'wx' }), rows = [];
  let child, pending = '', error = '', stopRequested = false, stopped = false, unexpectedExit = false, closeInfo, stopPromise;
  const recordError = e => { error += String(e?.stack ?? e); };
  writer.on('error', recordError);
  const writerDone = finished(writer).catch(recordError);
  const startedAt = new Date().toISOString();
  let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopRequested = true;
      if (child && !stopped) child.kill();
      if (child) await closed;
      // Only the final incomplete line may be truncated by deliberate termination.
      writer.end(); await writerDone;
      return { startedAt, finishedAt: new Date().toISOString(), pid: child?.pid ?? null,
        intervalMs: GPU_STATE_PROTOCOL.intervalMs, rows: rows.length, stopped, stopRequested,
        unexpectedExit, error, closeInfo, truncatedFinalLine: pending || null };
    })(); return stopPromise;
  }
  try {
    child = spawnProcess(executable, [`--query-gpu=${GPU_STATE_FIELDS.join(',')}`, '--format=csv,noheader,nounits', '-lms', String(GPU_STATE_PROTOCOL.intervalMs)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', e => { recordError(e); stopped = true; unexpectedExit = true; resolveClosed(); });
    child.once('close', (code, signal) => { closeInfo = { code, signal }; stopped = true; if (!stopRequested) unexpectedExit = true; resolveClosed(); });
    child.stderr.on('data', b => recordError(b.toString()));
    child.stdout.on('data', bytes => {
      pending += bytes.toString(); let next;
      while ((next = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, next).trim(); pending = pending.slice(next + 1); if (!line) continue;
        try { const row = parseGpuStateLine(line, Date.now(), rows.length); rows.push(row); writer.write(JSON.stringify(row) + '\n'); }
        catch (e) { recordError(e); }
      }
    });
    const deadline = Date.now() + startupTimeoutMs;
    while (rows.length < 2 && !error && !stopped && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    if (rows.length < 2 || error || stopped) throw Error(`GPU telemetry did not start: ${error || 'missing rows/process exited'}`);
    return { rows, stop };
  } catch (e) {
    const observer = await stop(); e.observer = observer; throw e;
  }
}
