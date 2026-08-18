import type {
  PrecompiledShaderArtifactV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderPassV2,
  PrecompiledShaderStage,
  PrecompiledShaderUniformFieldV2,
} from './PrecompiledShaderArtifact.generated';
export type {
  PrecompiledShaderArtifactV2,
  PrecompiledShaderBindingLayoutV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderLayoutOwnerV2,
  PrecompiledShaderPassV2,
  PrecompiledShaderRenderTargetV2,
  PrecompiledShaderSourceMapEntryV2,
  PrecompiledShaderStage,
  PrecompiledShaderStageEntriesV2,
  PrecompiledShaderUniformBlockV2,
  PrecompiledShaderUniformFieldV2,
  PrecompiledShaderVaryingV2,
  PrecompiledShaderVertexAttributeV2,
  PrecompiledShaderVertexBufferV2,
} from './PrecompiledShaderArtifact.generated';

export type PrecompiledShaderArtifact = PrecompiledShaderArtifactV2;
export type PrecompiledShaderPass = PrecompiledShaderPassV2;

export interface PrecompiledShaderRuntimeOptions {
  /** Layouts owned by SceneFrame, object, material, or another renderer subsystem, keyed by physical group. */
  readonly rendererOwnedLayouts?: Readonly<Record<number, GPUBindGroupLayout>>;
}

export interface PrecompiledShaderPassRuntime {
  readonly pass: PrecompiledShaderPass;
  readonly module: GPUShaderModule;
  /** First layout retained for the Stage 6 single-group adapter. */
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroupLayouts: readonly GPUBindGroupLayout[];
  readonly pipelineLayout: GPUPipelineLayout;
}

interface RuntimeGroup {
  readonly physicalGroup: number;
  readonly owner: 'artifact' | 'renderer';
  readonly bindings: readonly PrecompiledShaderBindingV2[];
}

interface DeviceRuntimeCache {
  readonly modules: Map<string, GPUShaderModule>;
  readonly artifactLayouts: Map<string, GPUBindGroupLayout>;
  readonly runtimes: Map<string, PrecompiledShaderPassRuntime>;
  readonly rendererLayoutIds: WeakMap<object, number>;
  nextRendererLayoutId: number;
}

const deviceRuntimeCaches = new WeakMap<GPUDevice, DeviceRuntimeCache>();
const LOGICAL_RESOURCE_GROUPS = Object.freeze({ frame: 0, object: 1, material: 2, pass: 3 });
// WebGPU defines these flags as stable bit values. Keeping the immutable map
// local to the adapter also supports reflection tests without a browser global.
export const PRECOMPILED_SHADER_STAGE_FLAGS: Readonly<Record<PrecompiledShaderStage, GPUShaderStageFlags>> = Object.freeze({
  vertex: 0x1,
  fragment: 0x2,
  compute: 0x4,
});

/** Materializes immutable build output once per device/layout identity. No compiler or source generation runs here. */
export function getPrecompiledShaderPassRuntime(
  device: GPUDevice,
  artifact: PrecompiledShaderArtifact,
  passId: string,
  options: PrecompiledShaderRuntimeOptions = {},
): PrecompiledShaderPassRuntime {
  validateArtifact(artifact);
  const pass = artifact.passes[passId] as PrecompiledShaderPass | undefined;
  if (!pass) throw new Error(`Precompiled shader artifact does not contain pass ${passId}.`);
  const groups = runtimeGroups(pass);
  const cache = getDeviceCache(device);
  const baseKey = `${artifact.artifactHash}:${pass.canonicalHash}`;
  const layoutTokens = groups.map(group => {
    if (group.owner === 'artifact') return `artifact:${group.physicalGroup}`;
    const layout = options.rendererOwnedLayouts?.[group.physicalGroup];
    if (!layout) {
      throw new Error(`Precompiled pass ${pass.id} requires renderer-owned bind group layout ${group.physicalGroup}.`);
    }
    return `renderer:${rendererLayoutId(cache, layout)}`;
  });
  const runtimeKey = `${baseKey}:${layoutTokens.join('|')}`;
  const existing = cache.runtimes.get(runtimeKey);
  if (existing) return existing;

  let module = cache.modules.get(baseKey);
  if (!module) {
    module = device.createShaderModule({ label: `GeneratedShader.${pass.id}`, code: pass.code });
    cache.modules.set(baseKey, module);
  }
  const bindGroupLayouts = groups.map(group => {
    if (group.owner === 'renderer') return options.rendererOwnedLayouts![group.physicalGroup]!;
    const layoutKey = `${baseKey}:group:${group.physicalGroup}`;
    let layout = cache.artifactLayouts.get(layoutKey);
    if (!layout) {
      layout = device.createBindGroupLayout({
        label: `GeneratedShader.${pass.id}.group${group.physicalGroup}`,
        entries: group.bindings.map(bindingEntry),
      });
      cache.artifactLayouts.set(layoutKey, layout);
    }
    return layout;
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `GeneratedShader.${pass.id}.layout`,
    bindGroupLayouts,
  });
  const runtime = Object.freeze({
    pass,
    module,
    bindGroupLayout: bindGroupLayouts[0]!,
    bindGroupLayouts: Object.freeze(bindGroupLayouts),
    pipelineLayout,
  });
  cache.runtimes.set(runtimeKey, runtime);
  return runtime;
}

/** Reusable reflection-backed storage; setters perform no allocation after construction. */
export class PrecompiledUniformBlockWriter {
  readonly buffer: ArrayBuffer;
  private readonly _view: DataView;
  private readonly _fields: ReadonlyMap<string, PrecompiledShaderUniformFieldV2>;

  constructor(pass: PrecompiledShaderPass, blockId: string) {
    const block = pass.uniformBlocks.find(candidate => candidate.id === blockId);
    if (!block) throw new Error(`Precompiled pass ${pass.id} does not contain uniform block ${blockId}.`);
    this.buffer = new ArrayBuffer(block.byteSize);
    this._view = new DataView(this.buffer);
    this._fields = new Map(block.fields.map(field => [field.name, field]));
  }

  get byteLength(): number { return this.buffer.byteLength; }

  setF32(fieldName: string, component: number, value: number): void {
    const field = this._field(fieldName, 'f32', component);
    this._view.setFloat32(field.offset + component * 4, value, true);
  }

  setU32(fieldName: string, component: number, value: number): void {
    const field = this._field(fieldName, 'u32', component);
    this._view.setUint32(field.offset + component * 4, value, true);
  }

  setI32(fieldName: string, component: number, value: number): void {
    const field = this._field(fieldName, 'i32', component);
    this._view.setInt32(field.offset + component * 4, value, true);
  }

  private _field(fieldName: string, scalar: 'f32' | 'i32' | 'u32', component: number): PrecompiledShaderUniformFieldV2 {
    const field = this._fields.get(fieldName);
    if (!field) throw new Error(`Unknown reflected uniform field ${fieldName}.`);
    if (field.type !== scalar && !field.type.endsWith(`<${scalar}>`)) {
      throw new Error(`Reflected uniform field ${fieldName} is ${field.type}, not ${scalar}.`);
    }
    if (!Number.isInteger(component) || component < 0 || component * 4 >= field.size) {
      throw new RangeError(`Uniform field ${fieldName} component ${component} exceeds ${field.size} bytes.`);
    }
    return field;
  }
}

function getDeviceCache(device: GPUDevice): DeviceRuntimeCache {
  let cache = deviceRuntimeCaches.get(device);
  if (!cache) {
    cache = {
      modules: new Map(),
      artifactLayouts: new Map(),
      runtimes: new Map(),
      rendererLayoutIds: new WeakMap(),
      nextRendererLayoutId: 1,
    };
    deviceRuntimeCaches.set(device, cache);
  }
  return cache;
}

function rendererLayoutId(cache: DeviceRuntimeCache, layout: GPUBindGroupLayout): number {
  const object = layout as object;
  let id = cache.rendererLayoutIds.get(object);
  if (id === undefined) {
    id = cache.nextRendererLayoutId++;
    cache.rendererLayoutIds.set(object, id);
  }
  return id;
}

function runtimeGroups(pass: PrecompiledShaderPass): readonly RuntimeGroup[] {
  return pass.bindGroups;
}

function bindingEntry(binding: PrecompiledShaderBindingV2): GPUBindGroupLayoutEntry {
  const base = { binding: binding.binding, visibility: visibilityMask(binding.visibility) };
  switch (binding.layout.kind) {
    case 'texture':
      return { ...base, texture: {
        sampleType: binding.layout.sampleType,
        viewDimension: binding.layout.viewDimension,
        multisampled: binding.layout.multisampled,
      } };
    case 'sampler':
      return { ...base, sampler: { type: binding.layout.samplerType } };
    case 'buffer':
      return { ...base, buffer: {
        type: binding.layout.bufferType,
        hasDynamicOffset: binding.layout.hasDynamicOffset,
        minBindingSize: binding.layout.minBindingSize,
      } };
    case 'storage-texture':
      return { ...base, storageTexture: {
        access: binding.layout.access,
        format: binding.layout.format as GPUTextureFormat,
        viewDimension: binding.layout.viewDimension,
      } };
    case 'external-texture':
      return { ...base, externalTexture: {} };
  }
}

function visibilityMask(stages: readonly PrecompiledShaderStage[]): GPUShaderStageFlags {
  let result = 0;
  for (const stage of stages) result |= PRECOMPILED_SHADER_STAGE_FLAGS[stage];
  return result;
}

function validateArtifact(artifact: PrecompiledShaderArtifact): void {
  if (artifact.format !== 'haiyue-precompiled-shader-artifact' || artifact.version !== 2) {
    throw new Error('Unsupported precompiled shader artifact format; production runtime requires Artifact V2.');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.artifactHash)) {
    throw new Error('Precompiled shader artifact is missing stable provenance.');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.source.sha256)
    || !/^[a-f0-9]{64}$/.test(artifact.canonicalHash)
    || !/^[a-f0-9]{64}$/.test(artifact.typedModuleHash)) {
    throw new Error('Precompiled shader artifact v2 is missing stable provenance.');
  }
  for (const [id, pass] of Object.entries(artifact.passes)) {
    if (id !== pass.id || !/^[a-f0-9]{64}$/.test(pass.canonicalHash)) {
      throw new Error(`Precompiled shader artifact v2 has invalid pass identity ${id}.`);
    }
    if (pass.bindGroups.length === 0) {
      throw new Error(`Precompiled pass ${id} does not declare a pipeline layout.`);
    }
    for (let index = 0; index < pass.bindGroups.length; index++) {
      const group = pass.bindGroups[index]!;
      if (group.physicalGroup !== index || (group.owner !== 'artifact' && group.owner !== 'renderer')) {
        throw new Error(`Precompiled pass ${id} has an invalid physical group layout.`);
      }
      if (group.logicalGroup !== LOGICAL_RESOURCE_GROUPS[group.logicalSpace]) {
        throw new Error(`Precompiled pass ${id} has an invalid logical group for ${group.logicalSpace}.`);
      }
      const bindings = new Set<number>();
      for (const binding of group.bindings) {
        if (!Number.isInteger(binding.binding) || binding.binding < 0 || bindings.has(binding.binding)) {
          throw new Error(`Precompiled pass ${id} has an invalid binding in group ${index}.`);
        }
        if (binding.visibility.length === 0
          || binding.visibility.some(stage => stage !== 'vertex' && stage !== 'fragment' && stage !== 'compute')) {
          throw new Error(`Precompiled pass ${id} has invalid visibility for binding ${binding.binding}.`);
        }
        bindings.add(binding.binding);
      }
    }
  }
}
