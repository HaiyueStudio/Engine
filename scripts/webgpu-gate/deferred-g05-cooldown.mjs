import {setTimeout as sleep} from 'node:timers/promises';

// Timers can wake early. Qualify the measured monotonic interval, not the sum
// of requested delays; never round or clamp evidence up to the required value.
export async function waitG05Cooldown(durationMs, {
 now = () => performance.now(), delay = sleep, onProgress = () => {},
} = {}) {
 if (!Number.isFinite(durationMs) || durationMs < 0) throw Error('Invalid cooldown duration');
 const started = now();
 let elapsed = 0;
 while (elapsed < durationMs) {
  const remaining = durationMs - elapsed;
  onProgress(remaining);
  await delay(Math.ceil(Math.min(30000, remaining)));
  elapsed = now() - started;
 }
 return elapsed;
}
