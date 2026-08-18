import assert from 'node:assert/strict';
import test from 'node:test';
import {
  benchmarkCompileSpineTimeline,
  benchmarkCreateSpineTimelineSamplerState,
  benchmarkFindSpineFrame,
  benchmarkSampleSpineColor,
  benchmarkSampleSpineTimeline,
  benchmarkSpineAnimationSample,
  benchmarkSpineVertexBuild,
  createSpineAnimationBenchmarkState,
} from '../dist/benchmark.js';

test('compiled Spine numeric timelines preserve linear, stepped, Bezier, and fallback sampling', () => {
  const linear = [{ time: 0, x: 0 }, { time: 1, x: 10 }];
  const stepped = [{ time: 0, x: 2, curve: 'stepped' }, { time: 1, x: 10 }];
  const bezier = [{ time: 0, x: 0, curve: [0.25, 0.25, 0.75, 0.75] }, { time: 1, x: 1 }];
  assert.equal(benchmarkCompileSpineTimeline(linear), 2);
  assert.equal(benchmarkSampleSpineTimeline(linear, -1, 'x', 7), 7);
  assert.equal(benchmarkSampleSpineTimeline(linear, 0.5, 'x', 7), 5);
  assert.equal(benchmarkSampleSpineTimeline(stepped, 0.75, 'x', 7), 2);
  assert.ok(Math.abs(benchmarkSampleSpineTimeline(bezier, 0.5, 'x', 7) - 0.5) < 0.001);
});

test('compiled Spine cursors handle forward playback, exact frames, and backward seeks', () => {
  const frames = Array.from({ length: 128 }, (_, index) => ({ time: index / 10, value: index }));
  const samplerA = benchmarkCreateSpineTimelineSamplerState();
  const samplerB = benchmarkCreateSpineTimelineSamplerState();
  assert.equal(benchmarkFindSpineFrame(frames, 0, samplerA), 0);
  assert.equal(benchmarkFindSpineFrame(frames, 8.75, samplerA), 87);
  assert.equal(benchmarkFindSpineFrame(frames, 1.25, samplerB), 12, 'a second runtime owns an independent cursor');
  assert.equal(benchmarkFindSpineFrame(frames, 8.8, samplerA), 88);
  assert.equal(benchmarkFindSpineFrame(frames, 1.25, samplerA), 12, 'backward seeks use binary search instead of a stale cursor');
  assert.equal(benchmarkSampleSpineTimeline(frames, 1.25, 'missing', -1, samplerA), 12.5);
});

test('compiled Spine color sampling parses once and reuses caller output', () => {
  const frames = [{ time: 0, color: '000000ff' }, { time: 1, color: 'ffffffff' }];
  const out = [0, 0, 0, 0];
  assert.equal(benchmarkSampleSpineColor(frames, 0.5, [1, 0, 1, 1], out), out);
  assert.deepEqual(out.map(value => Math.round(value * 1000) / 1000), [0.5, 0.5, 0.5, 1]);
  assert.equal(benchmarkSampleSpineColor(frames, 0.75, [1, 0, 1, 1], out), out);
});

test('Spine benchmark runtime exercises compiled pose sampling and cached vertex construction', () => {
  const state = createSpineAnimationBenchmarkState(16, 8, 32);
  assert.ok(state.runtime.timelineCompileStats.timelineCount > 0);
  assert.ok(Number.isFinite(benchmarkSpineAnimationSample(state)));
  assert.ok(benchmarkSpineVertexBuild(state) > 0);
  const vertices = state.runtime.vertexBuilder;
  const buildResult = state.runtime.vertexBuildResult;
  benchmarkSpineVertexBuild(state);
  const regions = new Map([...state.runtime.slotGeometryCache].map(([key, cache]) => [key, cache.vertices]));
  const batch = state.runtime.batches[0];
  const dirtyRanges = [...state.runtime.vertexDirtyRanges];
  const allocationStats = { ...state.runtime.allocationStats };
  for (let frame = 0; frame < 20; frame++) benchmarkSpineVertexBuild(state);
  assert.equal(state.runtime.vertexBuilder, vertices);
  assert.equal(vertices.length, 8 * 6 * 8);
  assert.equal(state.runtime.vertexBuildResult, buildResult);
  assert.equal(state.runtime.batches[0], batch);
  for (let index = 0; index < dirtyRanges.length; index++) {
    assert.equal(state.runtime.vertexDirtyRanges[index], dirtyRanges[index]);
  }
  assert.deepEqual(state.runtime.allocationStats, allocationStats);
  for (const [key, cache] of state.runtime.slotGeometryCache) assert.equal(cache.vertices, regions.get(key));
  state.component.debugMesh = true;
  benchmarkSpineVertexBuild(state);
  assert.ok(state.runtime.debugVertexBuilder.length > 0);
  state.component.debugMesh = false;
  benchmarkSpineVertexBuild(state);
  assert.equal(state.runtime.debugVertexBuilder.length, 0, 'disabled debug geometry must not draw retained region capacity');
});
