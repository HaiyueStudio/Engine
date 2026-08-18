import { COMPUTE_SHADER_ARTIFACT } from '/engine/dist/internal/compute-shader-artifact.js';
import { getPrecompiledShaderPassRuntime } from '/engine/dist/internal/precompiled-shader-runtime.js';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
try {
  const result = await runFixture();
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  resultNode.dataset.status = 'failed';
}

async function runFixture() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');
  if (COMPUTE_SHADER_ARTIFACT.version !== 2 || COMPUTE_SHADER_ARTIFACT.compilerVersion !== 'shader-language-stage13') {
    throw new Error('Invalid compute artifact identity');
  }

  const counts = { shaderModules: 0, bindGroupLayouts: 0, pipelineLayouts: 0 };
  const trackedDevice = new Proxy(device, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'createShaderModule') return descriptor => { counts.shaderModules++; return target.createShaderModule(descriptor); };
      if (property === 'createBindGroupLayout') return descriptor => { counts.bindGroupLayouts++; return target.createBindGroupLayout(descriptor); };
      if (property === 'createPipelineLayout') return descriptor => { counts.pipelineLayouts++; return target.createPipelineLayout(descriptor); };
      return value.bind(target);
    },
  });

  const runtimes = new Map();
  const pipelines = new Map();
  const compilationErrors = [];
  const moduleHashes = new Set();
  const irHashes = new Set();
  for (const [passId, pass] of Object.entries(COMPUTE_SHADER_ARTIFACT.passes)) {
    const moduleHash = pass.code.match(/haiyue:compute-module ([a-f0-9]{64})/)?.[1];
    const irHash = pass.code.match(/haiyue:compute-ir ([a-f0-9]{64})/)?.[1];
    if (!moduleHash || !irHash) throw new Error(`${passId} is missing compute provenance`);
    moduleHashes.add(moduleHash);
    irHashes.add(irHash);
    const runtime = getPrecompiledShaderPassRuntime(trackedDevice, COMPUTE_SHADER_ARTIFACT, passId);
    const info = await runtime.module.getCompilationInfo();
    for (const message of info.messages) if (message.type === 'error') compilationErrors.push(`${passId}:${message.lineNum}:${message.linePos} ${message.message}`);
    const pipeline = await trackedDevice.createComputePipelineAsync({
      label: `stage13-${passId}`,
      layout: runtime.pipelineLayout,
      compute: { module: runtime.module, entryPoint: runtime.pass.entryPoints.compute },
    });
    runtimes.set(passId, runtime);
    pipelines.set(passId, pipeline);
  }
  if (compilationErrors.length > 0) throw new Error(`Compute WGSL failed:\n${compilationErrors.join('\n')}`);
  if (moduleHashes.size !== 1 || irHashes.size !== 5) throw new Error(`Invalid family hashes: modules=${moduleHashes.size}, IR=${irHashes.size}`);

  const drawCommand = await executeDrawCommand(device, runtimes.get('gpu-draw-command'), pipelines.get('gpu-draw-command'));
  const bitonicSort = await executeBitonicSort(device, runtimes.get('gpu-sort-bitonic'), pipelines.get('gpu-sort-bitonic'));
  const instancedCull = await executeInstancedCull(device, runtimes.get('instanced-cull'), pipelines.get('instanced-cull'));
  assertArray(drawCommand.indexed, [6, 3, 0, 0, 7], 'draw indexed output');
  assertArray(drawCommand.draw, [4, 3, 0, 7], 'draw output');
  assertArray(bitonicSort.keys, [1, 2, 3, 4], 'sort keys');
  assertArray(bitonicSort.indices, [1, 3, 2, 0], 'sort indices');
  assertArray(instancedCull, [1, 0], 'cull counter/visible');

  const validationError = await device.popErrorScope();
  if (validationError || uncapturedErrors.length > 0) throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  device.destroy();
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage13-compute',
    status: 'passed',
    artifactVersion: 2,
    compilerVersion: 'shader-language-stage13',
    abiVersion: 1,
    passCount: Object.keys(COMPUTE_SHADER_ARTIFACT.passes).length,
    executedPassCount: 3,
    computeModuleHash: [...moduleHashes][0],
    computeIrHashCount: irHashes.size,
    compilationErrorCount: 0,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    drawCommand,
    bitonicSort,
    instancedCull,
    cache: counts,
  };
}

async function executeDrawCommand(device, runtime, pipeline) {
  const commands = gpuBuffer(device, new Uint32Array([11, 22, 33, 3, 6, 4, 0, 0, 7]), GPUBufferUsage.STORAGE);
  const indexed = emptyBuffer(device, 20, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const draw = emptyBuffer(device, 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const params = gpuBuffer(device, new Uint32Array([1, 0, 0, 0]), GPUBufferUsage.UNIFORM);
  const bindGroup = device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
    { binding: 0, resource: { buffer: commands } }, { binding: 1, resource: { buffer: indexed } },
    { binding: 2, resource: { buffer: draw } }, { binding: 3, resource: { buffer: params } },
  ] });
  dispatch(device, pipeline, [bindGroup]);
  const result = { indexed: await readU32(device, indexed, 5), draw: await readU32(device, draw, 4) };
  for (const value of [commands, indexed, draw, params]) value.destroy();
  return result;
}

async function executeBitonicSort(device, runtime, pipeline) {
  const keys = gpuBuffer(device, new Uint32Array([4, 1, 3, 2]), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const indices = gpuBuffer(device, new Uint32Array([0, 1, 2, 3]), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const passes = [[1, 2], [2, 4], [1, 4]].map(([j, k]) => gpuBuffer(device, new Uint32Array([4, 4, j, k, 1, 0, 0, 0]), GPUBufferUsage.STORAGE));
  const bindGroups = passes.map(params => device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
    { binding: 0, resource: { buffer: keys } }, { binding: 1, resource: { buffer: indices } }, { binding: 2, resource: { buffer: params } },
  ] }));
  dispatch(device, pipeline, bindGroups);
  const result = { keys: await readU32(device, keys, 4), indices: await readU32(device, indices, 4) };
  keys.destroy(); indices.destroy(); for (const value of passes) value.destroy();
  return result;
}

async function executeInstancedCull(device, runtime, pipeline) {
  const transforms = new Float32Array(32);
  for (const base of [0, 16]) { transforms[base] = 1; transforms[base + 5] = 1; transforms[base + 10] = 1; transforms[base + 15] = 1; }
  transforms[28] = 100;
  const frustum = new Float32Array([1,0,0,10, -1,0,0,10, 0,1,0,10, 0,-1,0,10, 0,0,1,10, 0,0,-1,10]);
  const params = new ArrayBuffer(32);
  new Uint32Array(params)[0] = 2;
  new Float32Array(params).set([0, 0, 0, 1], 4);
  const transformBuffer = gpuBuffer(device, transforms, GPUBufferUsage.STORAGE);
  const visible = emptyBuffer(device, 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const counter = emptyBuffer(device, 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const frustumBuffer = gpuBuffer(device, frustum, GPUBufferUsage.UNIFORM);
  const paramsBuffer = gpuBuffer(device, new Uint8Array(params), GPUBufferUsage.UNIFORM);
  const bindGroup = device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
    { binding: 0, resource: { buffer: transformBuffer } }, { binding: 1, resource: { buffer: visible } },
    { binding: 2, resource: { buffer: counter } }, { binding: 3, resource: { buffer: frustumBuffer } }, { binding: 4, resource: { buffer: paramsBuffer } },
  ] });
  dispatch(device, pipeline, [bindGroup]);
  const count = await readU32(device, counter, 1);
  const indices = await readU32(device, visible, 1);
  for (const value of [transformBuffer, visible, counter, frustumBuffer, paramsBuffer]) value.destroy();
  return [count[0], indices[0]];
}

function dispatch(device, pipeline, bindGroups) {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  for (const bindGroup of bindGroups) { pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1); }
  pass.end();
  device.queue.submit([encoder.finish()]);
}

function gpuBuffer(device, value, usage) {
  const buffer = device.createBuffer({ size: Math.max(4, value.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, value);
  return buffer;
}
function emptyBuffer(device, size, usage) { return device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST }); }
async function readU32(device, source, count) {
  const staging = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, count * 4);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const result = [...new Uint32Array(staging.getMappedRange()).slice(0, count)];
  staging.unmap(); staging.destroy();
  return result;
}
function assertArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
