import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BenchmarkLifecycleError,
  runBenchmarkLifecycleSmoke,
  runStatisticalBenchmarks,
} from './harness.mjs';
import { createBenchmarkCases } from './suite.mjs';

test('benchmark lifecycle smoke reports case id and failing stage and always tears down', async () => {
  for (const stage of ['setup', 'run', 'metrics', 'teardown']) {
    let teardownCalls = 0;
    const benchmark = {
      id: `lifecycle.failure.${stage}`,
      setup() {
        if (stage === 'setup') throw new Error('setup exploded');
        return {};
      },
      run() {
        if (stage === 'run') throw new Error('run exploded');
      },
      metrics() {
        if (stage === 'metrics') throw new Error('metrics exploded');
        return {};
      },
      teardown() {
        teardownCalls++;
        if (stage === 'teardown') throw new Error('teardown exploded');
      },
    };
    await assert.rejects(
      runBenchmarkLifecycleSmoke([benchmark]),
      error => {
        assert.ok(error instanceof BenchmarkLifecycleError);
        assert.equal(error.caseId, benchmark.id);
        assert.equal(error.stage, stage);
        assert.match(error.message, new RegExp(`${benchmark.id}.*${stage}`));
        return true;
      },
    );
    assert.equal(teardownCalls, 1, `${stage} failure must execute teardown exactly once`);
  }
});

test('benchmark lifecycle smoke preserves the primary stage when teardown also fails', async () => {
  let teardownCalls = 0;
  await assert.rejects(
    runBenchmarkLifecycleSmoke([{
      id: 'lifecycle.double-failure',
      run() { throw new Error('run failed'); },
      teardown() { teardownCalls++; throw new Error('cleanup failed'); },
    }]),
    error => {
      assert.equal(error.stage, 'run');
      assert.match(error.message, /teardown also failed: cleanup failed/);
      assert.equal(error.teardownError.message, 'cleanup failed');
      return true;
    },
  );
  assert.equal(teardownCalls, 1);
});

test('statistical benchmark failures also execute teardown', async () => {
  let teardownCalls = 0;
  await assert.rejects(
    runStatisticalBenchmarks([{
      id: 'lifecycle.statistical-run-failure',
      run() { throw new Error('sample failed'); },
      teardown() { teardownCalls++; },
    }], { warmup: 1, samples: 1, iterations: 1 }),
    error => {
      assert.ok(error instanceof BenchmarkLifecycleError);
      assert.equal(error.caseId, 'lifecycle.statistical-run-failure');
      assert.equal(error.stage, 'run');
      return true;
    },
  );
  assert.equal(teardownCalls, 1);
});

test('all 51 CI benchmark cases complete one lifecycle smoke', { timeout: 180_000 }, async () => {
  const cases = createBenchmarkCases('ci');
  assert.equal(cases.length, 51);
  const results = await runBenchmarkLifecycleSmoke(cases);
  assert.equal(results.length, 51);
  assert.equal(new Set(results.map(result => result.id)).size, 51);
  assert.ok(results.every(result => (
    result.stages.join('/') === 'setup/run/metrics/teardown'
  )));
});

test('sub-millisecond control-path cases use normalized measurement windows', () => {
  const cases = createBenchmarkCases('full');
  assert.equal(
    cases.find(candidate => candidate.id === 'ecs.query-structure.4000')?.iterations,
    100,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'asset.upload-budget.16777216')?.iterations,
    10_000,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'asset.ktx2-header-parse.4x4')?.iterations,
    100_000,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'animation.gltf-sampling.2000')?.iterations,
    10_000,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'asset.image-mipmap-upload.1024')?.iterations,
    1_000,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'editor.export-binary-writer.16777216')?.iterations,
    5,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'render3d.real-frame.1000e.10pct.1v')?.iterations,
    5,
  );
  assert.equal(
    cases.find(candidate => candidate.id === 'animation.spine-timeline-sample.200b.120f')?.iterations,
    1_000,
  );
});
