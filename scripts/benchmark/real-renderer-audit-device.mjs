export const GPU_MOCK_CAPABILITY_CONTRACT = Object.freeze({
  schema: 'haiyue-gpu-mock-capability-contract',
  version: 1,
  capabilities: Object.freeze([
    'buffer',
    'texture',
    'sampler',
    'shader-module',
    'bind-group-layout',
    'bind-group',
    'pipeline-layout',
    'render-pipeline',
    'compute-pipeline',
    'command-encoder',
    'query-set',
    'queue',
  ]),
});

export const GPU_MOCK_CAPABILITIES = Object.freeze({
  ALL: GPU_MOCK_CAPABILITY_CONTRACT.capabilities,
  RESOURCE_UPLOAD: Object.freeze(['buffer', 'texture', 'command-encoder', 'queue']),
  RENDER: Object.freeze([
    'buffer', 'texture', 'sampler', 'shader-module', 'bind-group-layout', 'bind-group',
    'pipeline-layout', 'render-pipeline', 'command-encoder', 'queue',
  ]),
  COMPUTE: Object.freeze([
    'buffer', 'texture', 'sampler', 'shader-module', 'bind-group-layout', 'bind-group',
    'pipeline-layout', 'compute-pipeline', 'command-encoder', 'queue',
  ]),
});

const AUDIT = Symbol('haiyue.audit-gpu-device');
const KNOWN_CAPABILITIES = new Set(GPU_MOCK_CAPABILITY_CONTRACT.capabilities);

export class GpuMockCapabilityError extends Error {
  constructor(capability, method, enabledCapabilities) {
    super(
      `Mock GPUDevice capability "${capability}" is unavailable for ${method}() `
      + `(contract ${GPU_MOCK_CAPABILITY_CONTRACT.schema}@${GPU_MOCK_CAPABILITY_CONTRACT.version}; `
      + `enabled: ${enabledCapabilities.join(', ') || 'none'}).`,
    );
    this.name = 'GpuMockCapabilityError';
    this.capability = capability;
    this.method = method;
    this.contractVersion = GPU_MOCK_CAPABILITY_CONTRACT.version;
  }
}

export function ensureRealRendererGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
    INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256,
    QUERY_RESOLVE: 512,
  };
  globalThis.GPUTextureUsage ??= {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
  };
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
  globalThis.GPUColorWrite ??= { ALL: 15 };
}

export function composeGpuMockCapabilities(...parts) {
  const result = new Set();
  for (const part of parts) {
    if (!part) continue;
    const entries = Array.isArray(part) || part instanceof Set
      ? part
      : Object.entries(part).filter(([, enabled]) => enabled).map(([name]) => name);
    for (const capability of entries) {
      if (!KNOWN_CAPABILITIES.has(capability)) {
        throw new RangeError(`Unknown Mock GPUDevice capability "${capability}".`);
      }
      result.add(capability);
    }
  }
  return Object.freeze([...result]);
}

/**
 * Deterministic CPU-side GPUDevice with an explicit, versioned capability surface.
 * `behaviors` can replace individual default operations while retaining auditing;
 * keys use the audited method name (for example `buffer.mapAsync` or `queue.submit`).
 */
export function createAuditGpuDevice(options = {}) {
  ensureRealRendererGpuConstants();
  const capabilities = new Set(composeGpuMockCapabilities(
    options.capabilities ?? GPU_MOCK_CAPABILITIES.ALL,
  ));
  const enabledCapabilities = [...capabilities];
  const behaviors = options.behaviors ?? {};
  const recordLimit = nonNegativeInteger(options.recordLimit, 4_096);
  let nextId = 0;
  let sequence = 0;

  const calls = [];
  const callCounts = new Map();
  const uploadsByLabel = new Map();
  const resources = new Map();
  for (const type of ['buffer', 'texture', 'sampler', 'shader-module', 'bind-group-layout',
    'bind-group', 'pipeline-layout', 'render-pipeline', 'compute-pipeline', 'command-encoder',
    'command-buffer', 'query-set']) {
    resources.set(type, { created: 0, destroyed: 0, live: 0, maxLive: 0 });
  }

  const audit = {
    contract: GPU_MOCK_CAPABILITY_CONTRACT,
    enabledCapabilities: Object.freeze(enabledCapabilities),
    calls,
    callCounts,
    uploadsByLabel,
    resources,
    uploadCalls: 0,
    uploadBytes: 0,
    unknownUploadByteCalls: 0,
    droppedCallRecords: 0,
    getCallCount(method) { return callCounts.get(method) ?? 0; },
    getUploadCount(label) { return uploadsByLabel.get(label)?.calls ?? 0; },
    snapshot() {
      return {
        schema: GPU_MOCK_CAPABILITY_CONTRACT.schema,
        version: GPU_MOCK_CAPABILITY_CONTRACT.version,
        enabledCapabilities: [...enabledCapabilities],
        calls: [...calls],
        callCounts: Object.fromEntries(callCounts),
        uploads: {
          calls: audit.uploadCalls,
          bytes: audit.uploadBytes,
          unknownByteCalls: audit.unknownUploadByteCalls,
          byLabel: [...uploadsByLabel].map(([label, value]) => ({ label, ...value })),
        },
        resources: Object.fromEntries(
          [...resources].map(([type, value]) => [type, { ...value }]),
        ),
        droppedCallRecords: audit.droppedCallRecords,
      };
    },
    reset() {
      calls.length = 0;
      callCounts.clear();
      uploadsByLabel.clear();
      audit.uploadCalls = 0;
      audit.uploadBytes = 0;
      audit.unknownUploadByteCalls = 0;
      audit.droppedCallRecords = 0;
      for (const value of resources.values()) {
        value.created = 0;
        value.destroyed = 0;
        value.maxLive = value.live;
      }
    },
  };

  function requireCapability(capability, method) {
    if (!capabilities.has(capability)) {
      throw new GpuMockCapabilityError(capability, method, enabledCapabilities);
    }
  }

  function record(capability, method, details = {}) {
    requireCapability(capability, method);
    const count = (callCounts.get(method) ?? 0) + 1;
    callCounts.set(method, count);
    const entry = { sequence: ++sequence, capability, method, ...details };
    if (calls.length < recordLimit) calls.push(entry);
    else audit.droppedCallRecords++;
    options.onCall?.(entry, audit);
    return entry;
  }

  function invokeBehavior(method, context, defaultImplementation) {
    const behavior = behaviors[method];
    return behavior
      ? behavior({ ...context, audit, defaultImplementation })
      : defaultImplementation();
  }

  function resource(type, descriptor = {}) {
    const stats = resources.get(type);
    if (stats) {
      stats.created++;
      stats.live++;
      stats.maxLive = Math.max(stats.maxLive, stats.live);
    }
    return {
      id: ++nextId,
      type,
      label: descriptor?.label ?? '',
      descriptor,
    };
  }

  function destroyResource(value, capability, method) {
    record(capability, method, { resourceId: value.id, label: value.label });
    if (value.destroyed) return;
    value.destroyed = true;
    const stats = resources.get(value.type);
    if (stats) {
      stats.destroyed++;
      stats.live = Math.max(0, stats.live - 1);
    }
  }

  function createBuffer(descriptor = {}) {
    record('buffer', 'device.createBuffer', { label: descriptor.label ?? '', size: descriptor.size ?? 0 });
    const value = resource('buffer', descriptor);
    value.size = descriptor.size ?? 0;
    value.usage = descriptor.usage ?? 0;
    value.mapState = descriptor.mappedAtCreation ? 'mapped' : 'unmapped';
    value.destroyed = false;
    let mappedRange = null;
    value.mapAsync = (...args) => {
      record('buffer', 'buffer.mapAsync', { resourceId: value.id, label: value.label });
      return invokeBehavior('buffer.mapAsync', { resource: value, args }, () => {
        value.mapState = 'mapped';
        return Promise.resolve();
      });
    };
    value.getMappedRange = (...args) => {
      record('buffer', 'buffer.getMappedRange', { resourceId: value.id, label: value.label });
      return invokeBehavior('buffer.getMappedRange', { resource: value, args }, () => {
        mappedRange ??= new ArrayBuffer(Math.max(0, value.size));
        return mappedRange;
      });
    };
    value.unmap = (...args) => {
      record('buffer', 'buffer.unmap', { resourceId: value.id, label: value.label });
      return invokeBehavior('buffer.unmap', { resource: value, args }, () => { value.mapState = 'unmapped'; });
    };
    value.destroy = (...args) => invokeBehavior(
      'buffer.destroy',
      { resource: value, args },
      () => destroyResource(value, 'buffer', 'buffer.destroy'),
    );
    return value;
  }

  function createTexture(descriptor = {}) {
    record('texture', 'device.createTexture', { label: descriptor.label ?? '' });
    const value = resource('texture', descriptor);
    const size = normalizeExtent(descriptor.size);
    value.width = size[0];
    value.height = size[1];
    value.depthOrArrayLayers = size[2];
    value.format = descriptor.format;
    value.dimension = descriptor.dimension ?? '2d';
    value.mipLevelCount = descriptor.mipLevelCount ?? 1;
    value.sampleCount = descriptor.sampleCount ?? 1;
    value.destroyed = false;
    value.createView = (viewDescriptor = {}) => {
      record('texture', 'texture.createView', { resourceId: value.id, label: value.label });
      return { ...resource('texture-view', viewDescriptor), texture: value };
    };
    value.destroy = (...args) => invokeBehavior(
      'texture.destroy',
      { resource: value, args },
      () => destroyResource(value, 'texture', 'texture.destroy'),
    );
    return value;
  }

  function createPipeline(type, capability, descriptor = {}) {
    const method = `device.create${type === 'render-pipeline' ? 'Render' : 'Compute'}Pipeline`;
    record(capability, method, { label: descriptor.label ?? '' });
    const value = resource(type, descriptor);
    value.getBindGroupLayout = index => {
      record('bind-group-layout', `${type}.getBindGroupLayout`, { resourceId: value.id, index });
      return resource('bind-group-layout', {
        label: `${descriptor.label ?? type}.auto.${index}`,
      });
    };
    return value;
  }

  function renderPass(encoder, descriptor) {
    record('command-encoder', 'commandEncoder.beginRenderPass', {
      resourceId: encoder.id,
      label: descriptor?.label ?? '',
    });
    const value = { id: ++nextId, type: 'render-pass', descriptor };
    for (const name of [
      'setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'setViewport',
      'setScissorRect', 'setBlendConstant', 'setStencilReference', 'draw', 'drawIndexed',
      'drawIndirect', 'drawIndexedIndirect', 'executeBundles', 'beginOcclusionQuery',
      'endOcclusionQuery', 'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker', 'end',
    ]) {
      value[name] = (...args) => {
        record('command-encoder', `renderPass.${name}`, { resourceId: value.id });
        return invokeBehavior(`renderPass.${name}`, { resource: value, args }, () => undefined);
      };
    }
    return value;
  }

  function computePass(encoder, descriptor) {
    record('command-encoder', 'commandEncoder.beginComputePass', {
      resourceId: encoder.id,
      label: descriptor?.label ?? '',
    });
    const value = { id: ++nextId, type: 'compute-pass', descriptor };
    for (const name of [
      'setPipeline', 'setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect',
      'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker', 'end',
    ]) {
      value[name] = (...args) => {
        record('command-encoder', `computePass.${name}`, { resourceId: value.id });
        return invokeBehavior(`computePass.${name}`, { resource: value, args }, () => undefined);
      };
    }
    return value;
  }

  const queue = {};
  for (const name of ['writeBuffer', 'writeTexture', 'copyExternalImageToTexture', 'submit', 'onSubmittedWorkDone']) {
    queue[name] = (...args) => {
      const method = `queue.${name}`;
      const buffer = name === 'writeBuffer' ? args[0] : null;
      const bytes = uploadByteLength(name, args);
      record('queue', method, {
        ...(buffer ? { resourceId: buffer.id, label: buffer.label ?? '' } : {}),
        ...(bytes === null ? {} : { bytes }),
      });
      if (name === 'writeBuffer' || name === 'writeTexture' || name === 'copyExternalImageToTexture') {
        const label = buffer?.label ?? args[0]?.texture?.label ?? '(unlabelled)';
        audit.uploadCalls++;
        if (bytes === null) audit.unknownUploadByteCalls++;
        else audit.uploadBytes += bytes;
        const current = uploadsByLabel.get(label) ?? { calls: 0, bytes: 0, unknownByteCalls: 0 };
        current.calls++;
        if (bytes === null) current.unknownByteCalls++;
        else current.bytes += bytes;
        uploadsByLabel.set(label, current);
      }
      return invokeBehavior(method, { resource: queue, args }, () => (
        name === 'onSubmittedWorkDone' ? Promise.resolve() : undefined
      ));
    };
  }

  const device = {
    features: new Set(options.features ?? ['indirect-first-instance']),
    limits: {
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
      maxBufferSize: 256 * 1024 * 1024,
      maxUniformBufferBindingSize: 64 * 1024,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 2048,
      maxBindGroups: 4,
      ...options.limits,
    },
    lost: new Promise(() => {}),
    queue,
    createBuffer,
    createTexture,
    createSampler(descriptor = {}) {
      record('sampler', 'device.createSampler', { label: descriptor.label ?? '' });
      return resource('sampler', descriptor);
    },
    createShaderModule(descriptor = {}) {
      record('shader-module', 'device.createShaderModule', { label: descriptor.label ?? '' });
      const value = resource('shader-module', descriptor);
      value.getCompilationInfo = async () => ({ messages: [] });
      return value;
    },
    createBindGroupLayout(descriptor = {}) {
      record('bind-group-layout', 'device.createBindGroupLayout', { label: descriptor.label ?? '' });
      return resource('bind-group-layout', descriptor);
    },
    createBindGroup(descriptor = {}) {
      record('bind-group', 'device.createBindGroup', { label: descriptor.label ?? '' });
      return resource('bind-group', descriptor);
    },
    createPipelineLayout(descriptor = {}) {
      record('pipeline-layout', 'device.createPipelineLayout', { label: descriptor.label ?? '' });
      return resource('pipeline-layout', descriptor);
    },
    createRenderPipeline(descriptor = {}) {
      return createPipeline('render-pipeline', 'render-pipeline', descriptor);
    },
    createRenderPipelineAsync(descriptor = {}) {
      record('render-pipeline', 'device.createRenderPipelineAsync', { label: descriptor.label ?? '' });
      return Promise.resolve(createPipelineResource('render-pipeline', descriptor));
    },
    createComputePipeline(descriptor = {}) {
      return createPipeline('compute-pipeline', 'compute-pipeline', descriptor);
    },
    createComputePipelineAsync(descriptor = {}) {
      record('compute-pipeline', 'device.createComputePipelineAsync', { label: descriptor.label ?? '' });
      return Promise.resolve(createPipelineResource('compute-pipeline', descriptor));
    },
    createQuerySet(descriptor = {}) {
      record('query-set', 'device.createQuerySet', { label: descriptor.label ?? '' });
      const value = resource('query-set', descriptor);
      value.destroyed = false;
      value.destroy = () => destroyResource(value, 'query-set', 'querySet.destroy');
      return value;
    },
    createCommandEncoder(descriptor = {}) {
      record('command-encoder', 'device.createCommandEncoder', { label: descriptor.label ?? '' });
      const value = resource('command-encoder', descriptor);
      value.beginRenderPass = passDescriptor => renderPass(value, passDescriptor);
      value.beginComputePass = passDescriptor => computePass(value, passDescriptor);
      for (const name of [
        'copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture',
        'clearBuffer', 'resolveQuerySet', 'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker',
      ]) {
        value[name] = (...args) => {
          record('command-encoder', `commandEncoder.${name}`, { resourceId: value.id });
          return invokeBehavior(`commandEncoder.${name}`, { resource: value, args }, () => undefined);
        };
      }
      value.finish = (...args) => {
        record('command-encoder', 'commandEncoder.finish', { resourceId: value.id });
        return resource('command-buffer', args[0] ?? {});
      };
      return value;
    },
  };

  function createPipelineResource(type, descriptor) {
    const value = resource(type, descriptor);
    value.getBindGroupLayout = index => {
      record('bind-group-layout', `${type}.getBindGroupLayout`, { resourceId: value.id, index });
      return resource('bind-group-layout', { label: `${descriptor.label ?? type}.auto.${index}` });
    };
    return value;
  }

  Object.defineProperty(device, AUDIT, { value: audit });
  Object.defineProperty(device, '__gpuMockCapabilityContract', {
    value: GPU_MOCK_CAPABILITY_CONTRACT,
  });
  return device;
}

export function getAuditGpuDeviceState(device) {
  const audit = device?.[AUDIT];
  if (!audit) throw new TypeError('Expected a GPUDevice created by createAuditGpuDevice().');
  return audit;
}

/** Backward-compatible name retained for existing real-renderer scenarios. */
export function createRealRendererAuditDevice(options = {}) {
  return createAuditGpuDevice(options);
}

function normalizeExtent(size) {
  if (Array.isArray(size)) return [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1];
  if (typeof size === 'number') return [size, 1, 1];
  return [
    size?.width ?? 1,
    size?.height ?? 1,
    size?.depthOrArrayLayers ?? 1,
  ];
}

function uploadByteLength(name, args) {
  if (name === 'copyExternalImageToTexture') return null;
  if (name === 'writeBuffer') {
    if (Number.isFinite(args[4])) return Math.max(0, args[4]);
    const byteLength = args[2]?.byteLength ?? 0;
    return Math.max(0, byteLength - (args[3] ?? 0));
  }
  const data = args[1];
  return Math.max(0, data?.byteLength ?? 0);
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
