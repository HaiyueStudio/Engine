import { deferredTileBypassReason } from './DeferredTileSelection';
import type { DeferredLightSource, DeferredLightView } from '../frame/DeferredLightTable';
import type { DeferredLightingRecordInput } from './DeferredLightingBackendPort';
import { DeferredImmutableBufferArena } from './DeferredLightGpuTable';
import { DeferredTileResources, planDeferredTiles, type DeferredTileOptions, type DeferredTilePlan } from './DeferredTileResources';
import { getSceneFrameGpuArena } from './SceneFrameGpuArena';
import { getPrecompiledShaderPassRuntime, type PrecompiledShaderPassRuntime } from '../shader/PrecompiledShaderRuntime';
import { DEFERRED_TILED_SHADER_ARTIFACT } from '../shaders/generated/deferred-tiled-artifact.generated';

const compilationChecks = new WeakMap<GPUShaderModule, Promise<GPUCompilationInfo>>();

interface LightBindings { source: GPUBufferBinding; header: GPUBufferBinding; indices: GPUBufferBinding }
export class DeferredTileCuller {
  readonly resources: DeferredTileResources;
  private readonly _parameters: DeferredImmutableBufferArena;
  private readonly _parameterKeys = new Map<string, Uint8Array<ArrayBuffer>>();
  private readonly _groups = new Map<string, GPUBindGroup>();
  private readonly _frames = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly _ids = new WeakMap<object, number>();
  private _nextId = 1;
  private _runtime: PrecompiledShaderPassRuntime | undefined;
  private _pipeline: GPUComputePipeline | undefined;
  private _empty: GPUBindGroup[] = [];
  private _destroyed = false;
  lastBypassReason: string | null = null;
  lastPlan: DeferredTilePlan | undefined;
  lastBinding: GPUBufferBinding | undefined;
  constructor(private readonly _device: GPUDevice, private readonly _options: DeferredTileOptions) {
    this.resources = new DeferredTileResources(_device);
    this._parameters = new DeferredImmutableBufferArena(_device, 'DeferredTiles.parameters', 32, GPUBufferUsage.UNIFORM);
  }
  resolveRuntime(frameLayout: GPUBindGroupLayout): PrecompiledShaderPassRuntime {
    return getPrecompiledShaderPassRuntime(this._device, DEFERRED_TILED_SHADER_ARTIFACT, 'deferred-tiled', { rendererOwnedLayouts: { 0: frameLayout } });
  }
  async initialize(): Promise<void> {
    planDeferredTiles(this._device, 1, 1, this._options);
    const runtime = getPrecompiledShaderPassRuntime(this._device, DEFERRED_TILED_SHADER_ARTIFACT, 'deferred-tile-cull');
    let compilation = compilationChecks.get(runtime.module);
    if (!compilation) { compilation = runtime.module.getCompilationInfo(); compilationChecks.set(runtime.module, compilation); }
    const info = await compilation;
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(errors.map(e => `Deferred cull:${e.lineNum}: ${e.message}`).join('\n'));
    const pipeline = await this._device.createComputePipelineAsync({ label: 'DeferredTiles.cull', layout: runtime.pipelineLayout,
      compute: { module: runtime.module, entryPoint: 'cs_main' } });
    if (this._destroyed) throw new Error('Deferred tile initialization cancelled.');
    this._runtime = runtime; this._pipeline = pipeline;
    this._empty = [1, 2].map(i => this._device.createBindGroup({ layout: runtime.bindGroupLayouts[i]!, entries: [] }));
  }
  select(input: DeferredLightingRecordInput, source: DeferredLightSource, view: DeferredLightView): string | null {
    if (input.context.viewFamily) this.resources.retain(new Set(input.context.viewFamily.views.map(candidate => candidate.key)));
    this.lastBypassReason = this._options.forceCulling ? null : deferredTileBypassReason(source, view, input.sceneFrame, input.view.reverseZ);
    return this.lastBypassReason;
  }
  prepare(input: DeferredLightingRecordInput, lights: LightBindings, frameOffset: number, bypass = false, reservation?: { reservedBytes: number; maxTileRecords: number }) {
    if (this._destroyed || !this._runtime || !this._pipeline) throw new Error('Deferred tile culler unavailable.');
    if (input.context.viewFamily) this.resources.retain(new Set(input.context.viewFamily.views.map(view => view.key)));
    const plan = planDeferredTiles(this._device, input.view.width, input.view.height, bypass ? { ...this._options, maxTileRecords: 0 } : this._options, reservation);
    const tiles = this.resources.acquire(input.view.key, plan, input.context);
    this.lastPlan = plan; this.lastBinding = tiles;
    const key = `${plan.columns}:${plan.rows}:${plan.storedTiles}:${plan.tileCapacity}:${input.view.width}:${input.view.height}`;
    let bytes = this._parameterKeys.get(key);
    if (!bytes) {
      bytes = new Uint8Array(32);
      new Uint32Array(bytes.buffer, 0, 4).set([plan.columns, plan.rows, plan.tileCapacity, plan.storedTiles]);
      new Float32Array(bytes.buffer, 16, 4).set([0, 0, input.view.width, input.view.height]);
      if (this._parameterKeys.size >= 32) this._parameterKeys.delete(this._parameterKeys.keys().next().value!);
      this._parameterKeys.set(key, bytes);
    }
    const parameters = this._parameters.acquire(bytes, bytes, input.context);
    const extraEntries: GPUBindGroupEntry[] = [{ binding: 15, resource: tiles }, { binding: 16, resource: parameters }];
    const bindingKey = [lights.source, lights.header, lights.indices, tiles, parameters].map(b => this.bindingKey(b)).join('|');
    if (bypass) return { extraEntries, bindingKey, record: undefined };
    let group = this._groups.get(bindingKey);
    if (!group) {
      group = this._device.createBindGroup({ label: 'DeferredTiles.pass', layout: this._runtime.bindGroupLayouts[3]!, entries: [
        { binding: 0, resource: lights.source }, { binding: 1, resource: lights.header }, { binding: 2, resource: lights.indices }, ...extraEntries,
      ] });
      if (this._groups.size >= 128) this._groups.delete(this._groups.keys().next().value!);
      this._groups.set(bindingKey, group);
    }
    const frameBuffer = getSceneFrameGpuArena(this._device).buffer;
    let frameGroup = this._frames.get(frameBuffer);
    if (!frameGroup) {
      frameGroup = this._device.createBindGroup({ layout: this._runtime.bindGroupLayouts[0]!, entries: [{ binding: 0, resource: { buffer: frameBuffer, size: 272 } }] });
      this._frames.set(frameBuffer, frameGroup);
    }
    return { extraEntries, bindingKey, record: () => {
      const pass = input.context.encoder.beginComputePass({ label: 'DeferredTiles.cull' });
      try {
        pass.setPipeline(this._pipeline!); pass.setBindGroup(0, frameGroup!, [frameOffset]);
        pass.setBindGroup(1, this._empty[0]!); pass.setBindGroup(2, this._empty[1]!); pass.setBindGroup(3, group!);
        pass.dispatchWorkgroups(plan.columns, plan.rows);
      } finally { pass.end(); }
    } };
  }
  private bindingKey(binding: GPUBufferBinding): string {
    let id = this._ids.get(binding.buffer);
    if (!id) { id = this._nextId++; this._ids.set(binding.buffer, id); }
    return `${id}:${binding.offset ?? 0}:${binding.size ?? 0}`;
  }
  destroy(abandon = false): void {
    this._destroyed = true; this.resources.destroy(abandon);
    if (abandon) this._parameters.abandon(); else this._parameters.destroy();
    this._groups.clear(); this._parameterKeys.clear(); this._empty = [];
    this.lastBinding = undefined; this.lastPlan = undefined;
  }
}
