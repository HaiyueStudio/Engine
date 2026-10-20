import test from 'node:test';
import assert from 'node:assert/strict';
import {waitG05Cooldown} from './deferred-g05-cooldown.mjs';

test('early timer wakeups cannot shorten the frozen 120-second interval', async () => {
 let time = 1000;
 const requests = [];
 const elapsed = await waitG05Cooldown(120000, {
  now: () => time,
  delay: async ms => { requests.push(ms); time += ms - 0.1; },
 });
 assert.equal(requests.length, 5);
 assert.equal(requests.at(-1), 1);
 assert.ok(elapsed >= 120000);
 assert.equal(elapsed, time - 1000);
});

test('late wakeup reports the actual elapsed time without unnecessary delays', async () => {
 let time = 0, calls = 0;
 const elapsed = await waitG05Cooldown(120000, {
  now: () => time,
  delay: async () => { calls++; time += 120123.75; },
 });
 assert.equal(calls, 1);
 assert.equal(elapsed, 120123.75);
});

test('zero-length smoke cooldown does not sleep', async () => {
 assert.equal(await waitG05Cooldown(0, {delay: () => assert.fail('unexpected sleep')}), 0);
});

test('invalid durations and timer failures fail closed', async () => {
 for (const duration of [-1, NaN, Infinity]) await assert.rejects(waitG05Cooldown(duration), /Invalid/);
 await assert.rejects(waitG05Cooldown(1, {delay: async () => { throw Error('timer failed'); }}), /timer failed/);
});
