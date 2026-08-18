import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseRenderer,
  EngineErrorCode,
  OutlineMaskRenderer,
  PipelineWarmupPlan,
  createComputePipelineAsync,
  createRenderPipelineAsync,
} from '../dist/experimental.js';

class TestRenderer extends BaseRenderer {
  prepare() {}

  contributePipelineWarmup() {}

  contribute(plan, device, key = 'main') {
    this.addPipelineWarmup(plan, key, 'Test pipeline', () => ({ label: 'test' }), device);
  }

  lookup(key, create) {
    return this.getCachedPipeline(key, create);
  }

  contributeCompute(plan, device, key = 'compute') {
    this.computePipeline ??= null;
    this.addComputePipelineWarmup(
      plan,
      key,
      'Test compute pipeline',
      () => ({ label: 'test compute' }),
      device,
      () => this.computePipeline,
      pipeline => { this.computePipeline = pipeline; },
    );
  }

  lookupCompute(key, device) {
    this.computePipeline ??= null;
    return this.getCachedComputePipeline(
      key,
      () => this.computePipeline,
      () => device.createComputePipeline({ label: 'fallback compute' }),
      pipeline => { this.computePipeline = pipeline; },
    );
  }
}

test('PipelineWarmupPlan deduplicates tasks, limits concurrency, and reports progress', async () => {
  const plan = new PipelineWarmupPlan('unit warmup');
  const statuses = [];
  let active = 0;
  let maxActive = 0;
  const addTask = id => plan.add({
    id,
    label: `pipeline ${id}`,
    compile: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
    },
  });
  addTask('a');
  addTask('b');
  addTask('c');
  addTask('a');
  const unsubscribe = plan.subscribe(progress => statuses.push(progress.status));

  const result = await plan.run({ concurrency: 2 });
  unsubscribe();

  assert.equal(result.status, 'completed');
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(maxActive, 2);
  assert.ok(statuses.includes('running'));
  assert.equal(statuses.at(-1), 'completed');
  assert.equal(await plan.run(), result);
});

test('PipelineWarmupPlan can tolerate selected task failures without hiding required failures', async () => {
  const toleratedPlan = new PipelineWarmupPlan('degraded warmup');
  const optionalFailure = new Error('optional shader failed');
  const handled = [];
  let requiredCompiled = false;
  toleratedPlan.add({
    id: 'OptionalRenderer#1:main',
    label: 'Optional renderer',
    owner: 'OptionalRenderer',
    compile: async () => { throw optionalFailure; },
  });
  toleratedPlan.add({
    id: 'RequiredRenderer#1:main',
    label: 'Required renderer',
    owner: 'RequiredRenderer',
    compile: async () => { requiredCompiled = true; },
  });

  const toleratedResult = await toleratedPlan.run({
    onTaskError(error, task) {
      handled.push([error.cause, task.owner]);
      return task.owner === 'OptionalRenderer';
    },
  });

  assert.equal(toleratedResult.status, 'completed');
  assert.equal(toleratedResult.failed, 1);
  assert.equal(toleratedResult.error, null);
  assert.equal(requiredCompiled, true);
  assert.deepEqual(handled, [[optionalFailure, 'OptionalRenderer']]);

  const requiredPlan = new PipelineWarmupPlan('required warmup');
  requiredPlan.add({
    id: 'RequiredRenderer#2:main',
    label: 'Required renderer',
    owner: 'RequiredRenderer',
    compile: async () => { throw new Error('required shader failed'); },
  });
  await assert.rejects(requiredPlan.run({ onTaskError: () => false }), /Failed to compile render pipeline/);
  assert.equal(requiredPlan.snapshot().status, 'failed');
});

test('async warmup populates the synchronous renderer cache and records diagnostics', async () => {
  const pipeline = { label: 'compiled' };
  let asyncCreates = 0;
  const device = {
    async createRenderPipelineAsync(descriptor) {
      asyncCreates++;
      assert.equal(descriptor.label, 'test');
      return pipeline;
    },
  };
  const renderer = new TestRenderer();
  const plan = new PipelineWarmupPlan();
  renderer.contribute(plan, device);

  await plan.run();
  let synchronousCreates = 0;
  const cached = renderer.lookup('main', () => {
    synchronousCreates++;
    return { label: 'unexpected' };
  });

  assert.equal(cached, pipeline);
  assert.equal(asyncCreates, 1);
  assert.equal(synchronousCreates, 0);
  assert.deepEqual(renderer.getPipelineCacheDiagnostics(), {
    hits: 1,
    misses: 1,
    synchronousCreates: 0,
    asynchronousCreates: 1,
    failures: 0,
    pending: 0,
    totalCreateTimeMs: renderer.getPipelineCacheDiagnostics().totalCreateTimeMs,
    lastCreateTimeMs: renderer.getPipelineCacheDiagnostics().lastCreateTimeMs,
    size: 1,
  });
});

test('warmup deduplication does not merge caches owned by separate renderer instances', async () => {
  let creates = 0;
  const device = {
    async createRenderPipelineAsync() {
      creates++;
      return { id: creates };
    },
  };
  const first = new TestRenderer();
  const second = new TestRenderer();
  const plan = new PipelineWarmupPlan();
  first.contribute(plan, device, 'shared-key');
  second.contribute(plan, device, 'shared-key');

  assert.equal(plan.snapshot().total, 2);
  await plan.run();
  assert.equal(creates, 2);
  assert.equal(first.getPipelineCacheDiagnostics().size, 1);
  assert.equal(second.getPipelineCacheDiagnostics().size, 1);
});

test('OutlineMaskRenderer warmup captures immutable MSAA and reverse-Z variants', async () => {
  ensureOutlineGpuGlobals();
  const descriptors = [];
  const device = createOutlineWarmupDevice(descriptors);
  const engine = {
    device,
    format: 'bgra8unorm',
    getDepthFormat: reverseZ => reverseZ ? 'depth32float' : 'depth24plus',
  };
  const renderer = new OutlineMaskRenderer();
  renderer.prepare(engine);
  const plan = new PipelineWarmupPlan();

  renderer.reverseZ = false;
  renderer.msaaSamples = 1;
  renderer.contributePipelineWarmup(plan);
  renderer.reverseZ = true;
  renderer.msaaSamples = 4;
  renderer.contributePipelineWarmup(plan);

  await plan.run();
  assert.deepEqual(
    descriptors
      .map(descriptor => [descriptor.multisample.count, descriptor.depthStencil.depthCompare])
      .sort((left, right) => left[0] - right[0]),
    [
      [1, 'less-equal'],
      [1, 'less-equal'],
      [4, 'greater-equal'],
      [4, 'greater-equal'],
    ],
  );
  renderer.destroy();
});

test('pipeline compilation failures use a structured retryable EngineError', async () => {
  const cause = new Error('invalid WGSL');
  const device = {
    async createRenderPipelineAsync() {
      throw cause;
    },
  };

  await assert.rejects(
    createRenderPipelineAsync(device, {}, { renderer: 'TestRenderer', key: 'bad', label: 'Broken shader' }),
    error => {
      assert.equal(error.code, EngineErrorCode.RenderPipelineCompilationFailed);
      assert.equal(error.recovery, 'retry');
      assert.equal(error.cause, cause);
      assert.equal(error.context.renderer, 'TestRenderer');
      assert.equal(error.context.key, 'bad');
      return true;
    },
  );
});

test('renderer-owned compute pipelines use async warmup and the same cache diagnostics', async () => {
  const pipeline = { label: 'compiled compute' };
  let asynchronousCreates = 0;
  let synchronousCreates = 0;
  const device = {
    async createComputePipelineAsync(descriptor) {
      asynchronousCreates++;
      assert.equal(descriptor.label, 'test compute');
      return pipeline;
    },
    createComputePipeline() {
      synchronousCreates++;
      return { label: 'unexpected' };
    },
  };
  const renderer = new TestRenderer();
  const plan = new PipelineWarmupPlan();
  renderer.contributeCompute(plan, device);

  await plan.run();
  assert.equal(renderer.lookupCompute('compute', device), pipeline);
  assert.equal(asynchronousCreates, 1);
  assert.equal(synchronousCreates, 0);
  assert.deepEqual(
    {
      ...renderer.getPipelineCacheDiagnostics(),
      totalCreateTimeMs: 0,
      lastCreateTimeMs: 0,
    },
    {
      hits: 1,
      misses: 1,
      synchronousCreates: 0,
      asynchronousCreates: 1,
      failures: 0,
      pending: 0,
      totalCreateTimeMs: 0,
      lastCreateTimeMs: 0,
      size: 1,
    },
  );
});

test('compute pipeline compilation failures preserve structured owner context', async () => {
  const cause = new Error('invalid compute WGSL');
  const device = {
    async createComputePipelineAsync() {
      throw cause;
    },
  };

  await assert.rejects(
    createComputePipelineAsync(device, {}, { owner: 'GpuCull', key: 'main', label: 'GPU culling' }),
    error => {
      assert.equal(error.code, EngineErrorCode.RenderPipelineCompilationFailed);
      assert.equal(error.recovery, 'retry');
      assert.equal(error.cause, cause);
      assert.equal(error.context.owner, 'GpuCull');
      assert.equal(error.context.key, 'main');
      assert.match(error.message, /compute pipeline/);
      return true;
    },
  );
});

test('pipeline warmup falls back to synchronous creation when async WebGPU is unavailable', async () => {
  const pipeline = { label: 'fallback' };
  const device = {
    createRenderPipeline(descriptor) {
      assert.equal(descriptor.label, 'fallback descriptor');
      return pipeline;
    },
  };

  assert.equal(
    await createRenderPipelineAsync(
      device,
      { label: 'fallback descriptor' },
      { renderer: 'FallbackRenderer', key: 1, label: 'Fallback pipeline' },
    ),
    pipeline,
  );
});

function ensureOutlineGpuGlobals() {
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2 };
}

function createOutlineWarmupDevice(descriptors) {
  return {
    limits: {
      minUniformBufferOffsetAlignment: 256,
      maxBufferSize: 1 << 28,
      maxUniformBufferBindingSize: 1 << 20,
    },
    queue: { writeBuffer() {} },
    createBindGroupLayout: descriptor => ({ descriptor }),
    createBindGroup: descriptor => ({ descriptor }),
    createBuffer: descriptor => ({ ...descriptor, destroy() {} }),
    createPipelineLayout: descriptor => ({ descriptor }),
    createShaderModule: descriptor => ({
      descriptor,
      async getCompilationInfo() { return { messages: [] }; },
    }),
    async createRenderPipelineAsync(descriptor) {
      descriptors.push(descriptor);
      return { descriptor };
    },
  };
}
