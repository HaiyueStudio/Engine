import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU_STATE_PROTOCOL, GPU_STATE_FIELDS, gpuStatePlan, parseGpuStateLine, analyzeGpuStateTimeline, validateGpuStatePopulation } from './framegraph-gpu-state-policy.mjs';
const line = 'GPU-1234-abcd, NVIDIA GeForce GTX 1070 Ti, 582.78, P0, 1607, 4006, 55, 20, 10, 65.1, Not Active, Not Active, Not Active';
const identity = { name: 'NVIDIA GeForce GTX 1070 Ti', driver: '582.78' }, job = gpuStatePlan()[0];
function fixture() {
  const frames = Array.from({ length: 10200 }, (_, sequence) => ({ sequence, startMs: 1000 + sequence,
    completionObservedMs: 1001 + sequence, passSumMs: 6, spanMs: 6.1, cpuMs: .2, queueWaitMs: .01,
    passes: [1, 2, 3].map((durationMs, i) => ({ label: ['main', 'post', 'output'][i], durationMs })) }));
  const rows = Array.from({ length: 57 }, (_, i) => parseGpuStateLine(line, 800 + 200 * i, i));
  const observer = { stopped: true, stopRequested: true, unexpectedExit: false, error: '', rows: rows.length };
  return { frames, rows, observer };
}
const analyze = f => analyzeGpuStateTimeline(f.frames, 24000, f.rows, f.observer, job, identity);
test('single-light diagnosis is balanced, fixed, and cannot silently become a baseline', () => {
  assert.deepEqual(gpuStatePlan().map(j => j.variant), ['A0', 'B4', 'B4', 'A0', 'A0', 'B4']);
  assert.deepEqual(gpuStatePlan(true), gpuStatePlan().slice(0, 2));
  assert.equal(GPU_STATE_PROTOCOL.gpuSamples + GPU_STATE_PROTOCOL.gpuWarmup, 10200);
  const entries = gpuStatePlan().map(job => ({ job, status: 'passed', analysis: { frames: 10200, cpuFrames: 24000, identity: { uuid: 'same' }, performanceQualified: false, createsBaseline: false } }));
  assert.equal(validateGpuStatePopulation(entries).createsBaseline, false);
  assert.throws(() => validateGpuStatePopulation(entries.slice(1)), /population/);
  const different = structuredClone(entries); different[1].analysis.identity.uuid = 'different'; assert.throws(() => validateGpuStatePopulation(different), /Mixed/);
  entries[0].analysis.createsBaseline = true; assert.throws(() => validateGpuStatePopulation(entries), /Incomplete/);
});
test('GPU parser preserves unavailable power without fabricating zero and rejects missing clocks/identity', () => {
  assert.equal(Object.keys(parseGpuStateLine(line, 0, 0).fields).length, GPU_STATE_FIELDS.length);
  const unavailable = parseGpuStateLine(line.replace('65.1', '[N/A]'), 0, 0);
  assert.equal(unavailable.fields['power.draw'], '[N/A]');
  for (const bad of [line.replace('1607', 'N/A'), line.replace('GPU-1234-abcd', 'unknown'), line+', extra', line.replace('Not Active', 'unknown')]) assert.throws(() => parseGpuStateLine(bad, 0, 0));
});
test('all frames including warmup and last partial window remain visible with coarse telemetry bounds', () => {
  const f = fixture(), a = analyze(f);
  assert.equal(a.windows.length, 35); assert.equal(a.windows.reduce((n,w) => n+w.frames, 0), 10200);
  assert.equal(a.windows[0].phase, 'warmup'); assert.equal(a.windows.at(-1).frames, 180);
  assert.equal(a.telemetry.maximumGapMs, 200); assert.equal(a.performanceQualified, false);
  assert(a.windows.every(w => w.telemetry.bracketBeforeMs <= 200 && w.telemetry.bracketAfterMs <= 200));
  assert.match(a.interpretation, /not GPU execution timestamps/);
});
test('coverage holes, reversed clocks, changed adapters, and observer failures cannot be accepted', () => {
  for (const mutate of [f => { f.rows.splice(10, 6); f.rows.forEach((r, i) => r.sequence=i); f.observer.rows=f.rows.length; },
    f => { f.rows[4].receivedMs=f.rows[3].receivedMs; f.rows[4].receivedAt=f.rows[3].receivedAt; },
    f => { f.rows.shift(); f.rows.shift(); f.rows.forEach((r,i) => r.sequence=i); f.observer.rows=f.rows.length; },
    f => { f.rows[5].fields.uuid='GPU-4567'; }, f => { f.rows[5].fields.name='different'; },
    f => { f.observer.unexpectedExit=true; }, f => { f.observer.stopped=false; }, f => { f.observer.error='driver query failed'; }]) {
    const f=fixture(); mutate(f); assert.throws(() => analyze(f));
  }
});
test('slow GPU state is reported, never discarded or normalized using clocks', () => {
  const f=fixture();
  for(const r of f.rows) { r.fields.pstate='P8'; r.fields['clocks.current.graphics']='405'; }
  for(const frame of f.frames) { frame.passSumMs=12; frame.spanMs=12.1; frame.passes.forEach(p=>p.durationMs*=2); }
  const a=analyze(f); assert.equal(a.windows[1].passSum.p95, 12); assert.equal(a.telemetry.pstate.P8, a.telemetry.readings);
  assert.equal(a.telemetry.ranges['clocks.current.graphics'].min, 405);
});
