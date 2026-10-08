import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export async function captureFrameGraphWindowsHost(powerPolicy) {
  const before = cpus(); await new Promise(r => setTimeout(r, 1000)); const after = cpus();
  const sum = rows => rows.reduce((s, c) => { for (const [k, v] of Object.entries(c.times)) { s.total += v; if (k === 'idle') s.idle += v; } return s; }, { total: 0, idle: 0 });
  const x = sum(before), y = sum(after);
  const fields = ['name', 'driver_version', 'temperature.gpu', 'utilization.gpu', 'clocks.current.graphics', 'clocks_event_reasons.sw_thermal_slowdown', 'clocks_event_reasons.hw_thermal_slowdown', 'clocks_event_reasons.hw_power_brake_slowdown'];
  const telemetry = await exec('nvidia-smi', [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'], { windowsHide: true });
  const power = await exec('powercfg', ['/getactivescheme'], { windowsHide: true, encoding: 'buffer' });
  const powerSettings = powerPolicy ? JSON.parse((await exec('powershell.exe', ['-NoProfile', '-File', fileURLToPath(new URL('./framegraph-power-observation.ps1', import.meta.url))], { windowsHide: true })).stdout.replace(/^\uFEFF/, '')) : undefined;
  const rows = telemetry.stdout.trim().split(/\r?\n/).map(line => line.split(',').map(v => v.trim()));
  return { schemaVersion: 1, observedAt: new Date().toISOString(), hostname: hostname(), platform: process.platform,
    cpu: { model: after[0].model.trim(), logicalProcessors: after.length, reportedMHz: after.map(c => c.speed), loadPercent: 100 * (1 - (y.idle - x.idle) / (y.total - x.total)), thermalStatus: 'unavailable' },
    gpu: { fields, rows, stdout: telemetry.stdout },
    powerScheme: { id: power.stdout.toString().match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0], rawBase64: power.stdout.toString('base64') },
    ...(powerSettings ? { powerSettings } : {}),
    scope: 'Before/after observations only; not continuous clock stability or CPU thermal qualification' };
}
export function validateFrameGraphWindowsHost(samples, runner, powerPolicy) {
  if (!Array.isArray(samples) || samples.length !== 2) throw Error('Before/after Windows host observations required');
  for (const sample of samples) {
    if (sample.hostname !== runner.hostname || sample.platform !== runner.platform || sample.cpu.model !== runner.cpuModel ||
        !Number.isFinite(sample.cpu.loadPercent) || sample.cpu.loadPercent < 0 || sample.cpu.loadPercent > 100 || !sample.powerScheme.id)
      throw Error('Registered Windows host identity/observations mismatch');
    if (powerPolicy && (!sample.powerSettings || sample.powerSettings.schemaVersion !== 1 || sample.powerSettings.schemeId !== sample.powerScheme.id ||
        Object.entries(powerPolicy).some(([key, value]) => sample.powerSettings[key] !== value)))
      throw Error('Controlled Windows power conditions missing or changed (AC and CPU minimum/maximum 100% required)');
    const rows = sample.gpu.rows;
    if (rows.length !== 1 || rows[0].length !== 8 || rows[0][0] !== runner.gpuName || rows[0][1] !== runner.driverVersion || rows[0].slice(2, 5).some(v => !Number.isFinite(Number(v))) || rows[0].slice(5).some(v => v !== 'Not Active'))
      throw Error('Registered NVIDIA identity mismatch or observed thermal/power-brake slowdown');
    if (sample.cpu.loadPercent > runner.maxBackgroundCpuPercent || Number(rows[0][3]) > runner.maxBackgroundGpuPercent)
      throw Error(`Host busy: CPU ${sample.cpu.loadPercent.toFixed(1)}% (limit ${runner.maxBackgroundCpuPercent}%), GPU ${rows[0][3]}% (limit ${runner.maxBackgroundGpuPercent}%)`);
  }
  if (samples[0].powerScheme.id !== samples[1].powerScheme.id) throw Error('Windows power scheme changed during sampling');
  if (samples.some(s => !Number.isFinite(Date.parse(s.observedAt))) || Date.parse(samples[0].observedAt) > Date.parse(samples[1].observedAt)) throw Error('Invalid/reordered Windows host observation times');
}
