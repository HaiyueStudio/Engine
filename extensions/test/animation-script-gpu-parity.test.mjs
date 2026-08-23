import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, loadG09Modules, runtimeLimits, shaderFixture } from './animation-script-parity-fixture.mjs';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

const { runtime } = await loadG09Modules();

test('WGSL validator accepts isolated custom vertex and fragment entrypoints with exact binding reflection', () => {
  const shader = shaderFixture();
  const validated = runtime.validateSandboxedWgsl(shader, runtimeLimits());
  assert.equal(validated.module, shader);
  assert.equal(validated.bindingNames.get(0), 'params');
  assert.ok(validated.sourceBytes > 0);
  assert.ok(validated.tokenCount > 0);
  const cacheIdentity = JSON.parse(validated.canonicalKey);
  assert.deepEqual(cacheIdentity.slice(0, 5), [shader.id, shader.vertexEntryPoint, shader.fragmentEntryPoint, shader.targetFormat, shader.source]);
  assert.notEqual(
    runtime.validateSandboxedWgsl(shaderFixture({ source: shader.source.replace('params.color', 'params.color * 0.5') }), runtimeLimits()).canonicalKey,
    validated.canonicalKey,
  );
  assert.notEqual(
    runtime.validateSandboxedWgsl(shaderFixture({ bindings: [{ ...shader.bindings[0], visibility: 'vertex-fragment' }] }), runtimeLimits()).canonicalKey,
    validated.canonicalKey,
  );
  assert.ok(Object.isFrozen(validated));
});

test('malicious WGSL storage, compute, duplicate vertex, loops, groups, bindings and unterminated comments fail exactly', () => {
  const cases = [
    ['storage', 'var<storage, read_write> values: array<u32>;', 'E_SHADER_VALIDATION'],
    ['compute', '@compute @workgroup_size(1) fn attack() {}', 'E_SHADER_VALIDATION'],
    ['duplicate-vertex', '@vertex fn attack() -> @builtin(position) vec4<f32> { return vec4(0.0); }', 'E_SHADER_VALIDATION'],
    ['loop', 'fn attack() { loop {} }', 'E_SHADER_VALIDATION'],
    ['atomic', 'var<workgroup> a: atomic<u32>;', 'E_SHADER_VALIDATION'],
    ['preprocessor', '#include "private.wgsl"', 'E_SHADER_VALIDATION'],
    ['comment', '/* never closed', 'E_SHADER_VALIDATION'],
  ];
  for (const [label, suffix, code] of cases) {
    const shader = shaderFixture({ source: `${shaderFixture().source}\n${suffix}` });
    assert.throws(() => runtime.validateSandboxedWgsl(shader, runtimeLimits()), error => error.code === code, label);
  }

  const group = shaderFixture({ source: shaderFixture().source.replace('@group(0)', '@group(1)') });
  assert.throws(() => runtime.validateSandboxedWgsl(group, runtimeLimits()), error => error.code === 'E_SHADER_BINDING');

  const missing = shaderFixture({ bindings: [] });
  assert.throws(() => runtime.validateSandboxedWgsl(missing, runtimeLimits()), error => error.code === 'E_SHADER_BINDING');

  const kind = shaderFixture({ bindings: [{ binding: 0, kind: 'sampled-texture', visibility: 'fragment' }] });
  assert.throws(() => runtime.validateSandboxedWgsl(kind, runtimeLimits()), error => error.code === 'E_SHADER_BINDING');

  const comments = shaderFixture({ source: `${shaderFixture().source}\n// @compute loop var<storage> atomic\n/* @group(9) */` });
  assert.doesNotThrow(() => runtime.validateSandboxedWgsl(comments, runtimeLimits()));
});

test('shader token, source, binding, texture, uniform, pipeline and draw budgets fail before allocation', async () => {
  const shader = shaderFixture();
  assert.throws(() => runtime.validateSandboxedWgsl(shader, runtimeLimits({ maxShaderSourceBytes: 10 })), error => error.code === 'E_SHADER_BUDGET');
  assert.throws(() => runtime.validateSandboxedWgsl(shader, runtimeLimits({ maxShaderTokens: 5 })), error => error.code === 'E_SHADER_BUDGET');
  assert.throws(() => runtime.validateSandboxedWgsl(shader, runtimeLimits({ maxUniformBytes: 8 })), error => error.code === 'E_SHADER_BUDGET');
  const textureDeclarations = Array.from({ length: 17 }, (_, index) => `@group(0) @binding(${index + 1}) var texture${index}: texture_2d<f32>;`).join('\n');
  const textures = shaderFixture({
    source: shader.source.replace('@vertex fn', `${textureDeclarations}\n@vertex fn`),
    bindings: [
      ...shader.bindings,
      ...Array.from({ length: 17 }, (_, index) => ({ binding: index + 1, kind: 'sampled-texture', visibility: 'fragment' })),
    ],
  });
  assert.throws(() => runtime.validateSandboxedWgsl(textures, runtimeLimits()), error => error.code === 'E_SHADER_BUDGET');

  const device = fakeDevice();
  const owner = new runtime.CustomShaderOwner(device, runtimeLimits({ maxPipelines: 1, maxDrawsPerFrame: 1, maxUniformBytes: 16 }));
  await owner.compile(shader);
  const second = shaderFixture({ id: 'second-fragment', source: shader.source.replace('params.color', 'params.color + vec4<f32>(0.0)') });
  await assert.rejects(owner.compile(second), error => error.code === 'E_SHADER_BUDGET');
  assert.throws(() => owner.createUniformBuffer(17), error => error.code === 'E_SHADER_BUDGET');
  owner.beginFrame(); owner.recordDraw();
  assert.throws(() => owner.recordDraw(), error => error.code === 'E_SHADER_BUDGET');
  owner.dispose();
});

test('pipeline cache, buffer ownership, device loss and idempotent dispose leave zero residuals', async () => {
  const device = fakeDevice();
  const owner = new runtime.CustomShaderOwner(device, runtimeLimits({ maxUniformBytes: 16 }));
  const first = await owner.compile(shaderFixture());
  const second = await owner.compile(shaderFixture());
  assert.equal(first, second);
  assert.equal(device.pipelineCalls, 1);
  const buffer = owner.createUniformBuffer(16);
  assert.equal(owner.stats().buffers, 1);
  assert.equal(owner.stats().uniformBytes, 16);
  assert.throws(() => owner.createUniformBuffer(1), error => error.code === 'E_SHADER_BUDGET');
  owner.releaseBuffer(buffer);
  owner.releaseBuffer(buffer);
  assert.equal(buffer.destroyed, 1);
  const residual = owner.createUniformBuffer(16);
  device.lose.resolve({ reason: 'destroyed', message: 'test loss' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(residual.destroyed, 1);
  assert.equal(owner.stats().deviceLost, true);
  assert.equal(owner.stats().pipelines, 0);
  assert.equal(owner.stats().buffers, 0);
  assert.throws(() => owner.recordDraw(), error => error.code === 'E_SHADER_DEVICE_LOST');

  const recovered = fakeDevice();
  owner.replaceDevice(recovered);
  await owner.compile(shaderFixture());
  assert.equal(owner.stats().deviceLost, false);
  owner.dispose(); owner.dispose();
  assert.deepEqual(owner.stats(), { generation: 4, pipelines: 0, buffers: 0, uniformBytes: 0, draws: 0, deviceLost: false, disposed: true });
});

test('late pipeline creation cannot cross a replaced device generation', async () => {
  const pipelineGate = deferred();
  const firstDevice = fakeDevice({ pipelineGate });
  const secondDevice = fakeDevice();
  const owner = new runtime.CustomShaderOwner(firstDevice, runtimeLimits(), { pipelineTimeoutMs: 1_000 });
  const pending = owner.compile(shaderFixture());
  await waitFor(() => firstDevice.pipelineCalls === 1);
  owner.replaceDevice(secondDevice);
  pipelineGate.resolve({ id: 'late-pipeline' });
  await assert.rejects(pending, error => error.code === 'E_SHADER_DEVICE_LOST');
  assert.equal(owner.stats().pipelines, 0);
  await owner.compile(shaderFixture());
  assert.equal(owner.stats().pipelines, 1);
  owner.dispose();
});

test('shader compilation diagnostics retain stable virtual location without exposing host paths', async () => {
  const device = fakeDevice({ compilationMessages: [{ type: 'error', lineNum: 4, linePos: 7, message: 'bad shader at C:\\secret\\file' }] });
  const owner = new runtime.CustomShaderOwner(device, runtimeLimits());
  await assert.rejects(owner.compile(shaderFixture()), error => (
    error.code === 'E_SHADER_VALIDATION'
    && error.message.includes('tint-fragment:4:7')
    && !error.diagnostic.message.includes('C:\\secret')
    && error.diagnostic.path === 'shader.source'
    && JSON.stringify(error.diagnostic.location) === JSON.stringify({ sourceId: 'shader/tint-fragment.wgsl', line: 4, column: 7 })
  ));
  owner.dispose();
});

function fakeDevice(options = {}) {
  const lose = deferred();
  const buffers = [];
  return {
    lose,
    lost: lose.promise,
    pipelineCalls: 0,
    buffers,
    createShaderModule(descriptor) {
      return {
        descriptor,
        async getCompilationInfo() { return { messages: options.compilationMessages ?? [] }; },
      };
    },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
    createRenderPipelineAsync(descriptor) {
      this.pipelineCalls++;
      if (options.pipelineGate) return options.pipelineGate.promise;
      return Promise.resolve({ descriptor, id: `pipeline-${this.pipelineCalls}` });
    },
    createBuffer(descriptor) {
      const buffer = { descriptor, destroyed: 0, destroy() { this.destroyed++; } };
      buffers.push(buffer);
      return buffer;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for GPU condition');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
