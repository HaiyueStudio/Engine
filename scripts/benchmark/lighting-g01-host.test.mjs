import test from 'node:test';
import assert from 'node:assert/strict';
import { parseG01ThermalStatus, validateG01HostSamples } from './lighting-g01-host.mjs';

const output = speed => `Note: No thermal warning level has been recorded\nCPU_Scheduler_Limit = 100\nCPU_Available_CPUs = 12\nCPU_Speed_Limit = ${speed}\n`;
const sample = (speed, time = '2026-09-25T04:40:23Z') => ({ command: 'pmset -g therm', observedAt: time, output: output(speed) });

test('no thermal warning does not override a reported CPU speed limit', () => {
  assert.equal(parseG01ThermalStatus(output(33)).ready, false);
  assert.equal(parseG01ThermalStatus(output(100)).ready, true);
});
test('missing, duplicate or malformed power observations fail closed', () => {
  for (const text of ['', output(100) + 'CPU_Speed_Limit = 100\n', output(-1), output('NaN'), output(100).replace('CPU_Scheduler_Limit = 100', 'CPU_Scheduler_Limit = 50')]) {
    assert.equal(parseG01ThermalStatus(text).ready, false);
  }
});
test('both sides of a capture need independently parsed timestamped host evidence', () => {
  assert.deepEqual(validateG01HostSamples([sample(100), sample(100)]), []);
  assert.ok(validateG01HostSamples([sample(100)]).length);
  assert.ok(validateG01HostSamples([sample(100), sample(33)]).length);
  assert.ok(validateG01HostSamples([sample(100), sample(100, 'invalid')]).length);
  assert.ok(validateG01HostSamples([sample(100), sample(100, '2026-09-24T00:00:00Z')]).length);
  const forged = { ...sample(33), ready: true };
  assert.ok(validateG01HostSamples([sample(100), forged]).length);
});
