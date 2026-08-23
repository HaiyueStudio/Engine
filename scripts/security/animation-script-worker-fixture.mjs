import { CustomShaderOwner, ScriptSandboxOwner } from '/g09/script-runtime/index.js';

const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const limits = {
    maxInstructionsPerInvocation: 10_000,
    maxInstructionsPerScope: 100_000,
    maxHeapBytes: 1_000_000,
    maxCallDepth: 32,
    maxOutputCommands: 64,
    maxEventsPerInvocation: 32,
    maxTimers: 16,
    maxPendingPromises: 8,
    maxWallTimeMs: 100,
    maxShaderSourceBytes: 32_768,
    maxShaderTokens: 8_192,
    maxShaderBindings: 4,
    maxTextures: 16,
    maxUniformBytes: 1_024,
    maxStorageBytes: 67_108_864,
    maxPipelines: 4,
    maxDrawsPerFrame: 8,
  };
  const program = {
    id: 'browser-converter',
    protocol: 'converter',
    sourceRevisionSha256: 'b99f06310ba0e09c3402dd2be37d8447dd63ee980e7d42dd7396e26117cea661',
    constants: [],
    functions: [{
      id: 'convert-fn', parameters: 0, registers: 5,
      instructions: [
        { op: 'load-input', to: 0, name: 'handle' },
        { op: 'capability', to: 1, capability: 'data.read', arguments: [0] },
        { op: 'random', to: 2 },
        { op: 'load-context', to: 3, path: ['clockMicros'] },
        { op: 'make-list', to: 4, values: [1, 2, 3] },
        { op: 'return', value: 4 },
      ],
    }],
    entrypoints: { convert: 'convert-fn' },
    capabilities: ['data.read'],
  };
  const owner = new ScriptSandboxOwner({
    workerFactory: () => new Worker('./animation-script-worker-entry.mjs', { type: 'module', name: 'haiyue-animation-sandbox' }),
    programs: [program], limits,
    capabilityPort: {
      calls: 0,
      invoke(request) { this.calls++; return request.arguments[0].id === 'score' ? 7 : 0; },
      disposeScope() {},
    },
  });
  const handle = owner.createHandle('view-model', 'score', ['read']);
  const request = invocation => ({
    invocationId: invocation,
    programId: program.id,
    entrypoint: 'convert',
    arguments: [],
    inputs: { handle },
    context: { clockMicros: 123_456, seed: [1, 2, 3, 4], data: { score: 7 } },
  });
  progress.textContent = 'worker';
  const first = await owner.invoke(request('browser-1'));
  const second = await owner.invoke(request('browser-2'));
  if (JSON.stringify(first.value) !== JSON.stringify(second.value) || first.value[0] !== 7 || first.value[2] !== 123_456) {
    throw new Error(`worker replay mismatch: ${JSON.stringify({ first, second })}`);
  }
  const malicious = {
    ...program,
    id: 'malicious',
    functions: [{ id: 'convert-fn', parameters: 0, registers: 1, instructions: [{ op: 'global-get', to: 0 }, { op: 'return', value: 0 }] }],
  };
  await owner.replacePrograms([malicious]);
  let escapeCode = null;
  try {
    await owner.invoke({ ...request('malicious-1'), programId: malicious.id, inputs: {} });
  } catch (error) {
    escapeCode = error.code;
  }
  if (escapeCode !== 'E_SCRIPT_PROTOCOL') throw new Error(`escape instruction was not rejected: ${escapeCode}`);
  await owner.dispose();

  progress.textContent = 'webgpu';
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const uncaptured = [];
  device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? 'uncaptured'));
  device.pushErrorScope('validation');
  const shader = {
    id: 'browser-tint', vertexEntryPoint: 'vertexMain', fragmentEntryPoint: 'fragmentMain', targetFormat: 'rgba8unorm',
    source: `
struct Params { color: vec4<f32> }
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4(positions[index], 0.0, 1.0);
  output.uv = output.position.xy * vec2(0.5, -0.5) + vec2(0.5);
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return params.color * vec4<f32>(input.uv, 1.0, 1.0);
}`,
    bindings: [{ binding: 0, kind: 'uniform-buffer', visibility: 'fragment', maxBytes: 16 }],
  };
  const gpuOwner = new CustomShaderOwner(device, limits, { pipelineTimeoutMs: 2_000 });
  const pipeline = await gpuOwner.compile(shader);
  const uniform = gpuOwner.createUniformBuffer(16);
  device.queue.writeBuffer(uniform, 0, new Float32Array([0.8, 0.4, 0.2, 1]));
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
  const target = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  gpuOwner.beginFrame(); gpuOwner.recordDraw();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [2, 2]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const pixel = [...new Uint8Array(readback.getMappedRange()).slice(260, 264)];
  readback.unmap(); readback.destroy(); target.destroy();
  gpuOwner.releaseBuffer(uniform); gpuOwner.dispose();
  const validationError = await device.popErrorScope();
  if (validationError || uncaptured.length || pixel[3] !== 255 || pixel[0] === 0) {
    throw new Error(`GPU evidence mismatch: ${JSON.stringify({ pixel, validationError: validationError?.message, uncaptured })}`);
  }
  const evidence = {
    schema: 'haiyue-animation-script-browser-evidence@1',
    deterministicReplay: JSON.stringify(first.value) === JSON.stringify(second.value),
    workerStats: owner.stats(),
    escapeCode,
    instructionCount: first.stats.instructions,
    peakHeapBytes: first.stats.peakHeapBytes,
    gpuPixel: pixel,
    officialWgslCandidate: {
      evidenceClass: 'candidate-documentation-trace',
      source: 'https://rive.app/docs/scripting/wgsl-shaders',
      retrievedAt: '2026-08-23',
      vertexEntryPoint: shader.vertexEntryPoint,
      fragmentEntryPoint: shader.fragmentEntryPoint,
      customVertexExecuted: true,
    },
    gpuOwnerResidual: gpuOwner.stats(),
    validationErrorCount: validationError ? 1 : 0,
    uncapturedErrorCount: uncaptured.length,
    unclassifiedFailureCount: 0,
  };
  progress.textContent = 'complete';
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify(evidence);
} catch (error) {
  resultNode.dataset.status = 'failed';
  resultNode.textContent = JSON.stringify({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
}
