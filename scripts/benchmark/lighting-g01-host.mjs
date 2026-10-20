// G01's two frozen adapters are on macOS. This is host evidence, not GPU timing.
export function parseG01ThermalStatus(output) {
  const read = name => {
    const matches = [...output.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, 'gm'))];
    return matches.length === 1 ? Number(matches[0][1]) : null;
  };
  const cpuSpeedLimit = read('CPU_Speed_Limit');
  const cpuSchedulerLimit = read('CPU_Scheduler_Limit');
  const availableCpus = read('CPU_Available_CPUs');
  const reasons = [];
  if (cpuSpeedLimit !== 100) reasons.push('CPU speed limit is reduced or unavailable');
  if (cpuSchedulerLimit !== 100) reasons.push('CPU scheduler limit is reduced or unavailable');
  if (!(availableCpus > 0)) reasons.push('Available CPU count is missing');
  return { cpuSpeedLimit, cpuSchedulerLimit, availableCpus, ready: reasons.length === 0, reasons };
}

export function validateG01HostSamples(samples) {
  if (!Array.isArray(samples) || samples.length !== 2) return ['missing before/after host samples'];
  const errors = [];
  for (const [index, sample] of samples.entries()) {
    if (sample?.command !== 'pmset -g therm' || typeof sample?.output !== 'string' ||
        !Number.isFinite(Date.parse(sample?.observedAt))) {
      errors.push(`invalid host sample ${index}`);
      continue;
    }
    const parsed = parseG01ThermalStatus(sample.output);
    if (!parsed.ready) errors.push(`host sample ${index}: ${parsed.reasons.join('; ')}`);
  }
  if (Date.parse(samples[1]?.observedAt) < Date.parse(samples[0]?.observedAt)) errors.push('host sample time order');
  return errors;
}
