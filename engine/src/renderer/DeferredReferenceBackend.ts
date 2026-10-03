import { frameGraphCacheScope } from '../core/frameGraphCacheScope';
import { acquireSequentialAttachments, releaseSequentialAttachments } from '../rtt/TransientAttachmentSequence';
import type { PostProcessSceneTextures } from '../postprocess/PostProcessPass';
import { DeferredAmbientOcclusion } from './DeferredAmbientOcclusion';
import { getDeferredAllocationBudget, DeferredSharedAllocationLease, type DeferredAllocationBudget } from './DeferredAllocationBudget';
import { DEFERRED_SHARED_RESERVE_BYTES, planDeferredViewMemory } from './DeferredViewMemory';
import { InstancedMesh3D } from '../components/InstancedMesh3D';
import { isEntityDisabledInHierarchy } from '../ecs/utils/hierarchy';
import { DeferredFullForward } from './DeferredFullForward';
import type { DeferredTileCuller } from './DeferredTileCuller';
import type { DeferredTileOptions } from './DeferredTileResources';
import type { IEngine } from '../core/IEngine';
import { PbrMaterial } from '../material/PbrMaterial';
import { getDeferredWorldLights } from '../frame/DeferredWorldLights';
import { createDeferredReferenceView, DeferredLightingCapabilityError, type DeferredLightSource, type DeferredLightView } from '../frame/DeferredLightTable';
import { TransientRenderTargetPool, TransientAttachmentCapacityError, releaseTransientAttachments, retainTransientAttachmentScopes } from '../rtt/TransientRenderTargetPool';
import { getPrecompiledShaderPassRuntime, type PrecompiledShaderPassRuntime } from '../shader/PrecompiledShaderRuntime';
import { DEFERRED_LIGHTING_SHADER_ARTIFACT } from '../shaders/generated/deferred-lighting-artifact.generated';
import { Render3DFramePlan } from '../systems/Render3DFramePlan';
import { DeferredImmutableBufferArena, DeferredLightGpuTable } from './DeferredLightGpuTable';
import { validateDeferredDevice, validateDeferredViewConfiguration } from './DeferredLightingCapabilities';
import type { DeferredLightingBackendPort, DeferredLightingRecordInput } from './DeferredLightingBackendPort';
import { getPbrDeferredSurfacePort, type PbrDeferredSurfacePort } from './PbrDeferredSurfacePort';
import type { PbrRenderer } from './PbrRenderer';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';

export interface DeferredReferenceOptions { readonly failurePolicy: 'strict' | 'forward'; readonly tiled?: DeferredTileOptions }

// Shader modules are immutable and shared by the precompiled runtime. Check each once,
// including across profile reactivation (some native drivers stall repeated info requests).
const compilationChecks = new WeakMap<GPUShaderModule, Promise<void>>();
function checkCompilation(runtime: PrecompiledShaderPassRuntime): Promise<void> {
  let pending = compilationChecks.get(runtime.module);
  if (!pending) {
    pending = runtime.module.getCompilationInfo().then(info => {
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(e => `${runtime.pass.id}:${e.lineNum}: ${e.message}`).join('\n'));
    });
    compilationChecks.set(runtime.module, pending);
  }
  return pending;
}

function cancellable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Lazy provider. Render3D owns recording/output; this provider owns only its Deferred resources. */
export class DeferredReferenceBackend implements DeferredLightingBackendPort {
  private readonly _device: GPUDevice;
  private readonly _ambientOcclusion: DeferredAmbientOcclusion;
  private readonly _pool: TransientRenderTargetPool;
  private readonly _plan = new Render3DFramePlan('view-local', 'deferred');
  private readonly _views = new WeakMap<DeferredLightSource, DeferredLightView>();
  private readonly _parameters = new Map<string, Float32Array<ArrayBuffer>>();
  private readonly _bindGroups = new Map<string, GPUBindGroup>();
  private readonly _resourceIds = new WeakMap<object, number>();
  private _nextResourceId = 1;
  private readonly _opaqueForwardIndices: number[] = [];
  private _port: PbrDeferredSurfacePort | undefined;
  private _fullForward: DeferredFullForward | undefined;
  private _tiles: DeferredTileCuller | undefined;
  private _geometry: PrecompiledShaderPassRuntime | undefined;
  private _resolve: PrecompiledShaderPassRuntime | undefined;
  private _lights: DeferredLightGpuTable | undefined;
  private _params: DeferredImmutableBufferArena | undefined;
  private _frame: SceneFrameGpuBinding | undefined;
  private _emptyGroups: GPUBindGroup[] = [];
  private _pipelines: Partial<Record<GPUTextureFormat, GPURenderPipeline>> = {};
  private _destroyed = false;
  private _initialized = false;
  private readonly _initialization = new AbortController();
  lastSource: DeferredLightSource | undefined;
  lastAttachments: { readonly textures: readonly GPUTexture[]; readonly views: readonly GPUTextureView[] } | undefined;
  private readonly _allocationBudget: DeferredAllocationBudget;
  private readonly _sharedAllocation: DeferredSharedAllocationLease;
  private readonly _attachmentLimits: { maxViews: number; maxLiveGenerations: number; reserveBytes: (bytes: number) => () => void };
  diagnostics: { requested: 'deferred-reference' | 'deferred-tiled'; effective: 'deferred-reference' | 'deferred-tiled' | 'forward'; completeCoverage: boolean; reason: string | null } = {
    requested: 'deferred-reference', effective: 'forward', completeCoverage: false, reason: 'not-initialized',
  };

  constructor(engine: IEngine, private readonly _options: DeferredReferenceOptions) {
    this._device = engine.device;
    this._allocationBudget = getDeferredAllocationBudget(this._device);
    this._sharedAllocation = new DeferredSharedAllocationLease(this._allocationBudget, DEFERRED_SHARED_RESERVE_BYTES);
    this._attachmentLimits = { maxViews: 4, maxLiveGenerations: 2, reserveBytes: bytes => this._allocationBudget.reserve(bytes) };
    try { this._ambientOcclusion = new DeferredAmbientOcclusion(this._device); }
    catch (error) { this._sharedAllocation.destroy(true); throw error; }
    this._pool = new TransientRenderTargetPool(engine);
    if (_options.tiled) this.diagnostics.requested = 'deferred-tiled';
  }

  async initialize(renderer: PbrRenderer, signal?: AbortSignal): Promise<void> {
    const check = () => { if (this._destroyed || signal?.aborted) throw signal?.reason ?? new Error('Deferred initialization cancelled.'); };
    check();
    if (this._initialized) return;
    validateDeferredDevice(this._device);
    const abort = () => this._initialization.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this._port = getPbrDeferredSurfacePort(renderer);
      this._fullForward = new DeferredFullForward(this._device, this._port);
      this._geometry = getPrecompiledShaderPassRuntime(this._device, DEFERRED_LIGHTING_SHADER_ARTIFACT, 'deferred-gbuffer', {
        rendererOwnedLayouts: Object.fromEntries(this._port.layouts.map((layout, i) => [i, layout])),
      });
      this._frame = getSceneFrameGpuArena(this._device).createBinding();
      if (this._options.tiled) {
        const { DeferredTileCuller } = await import('./DeferredTileCuller');
        check();
        this._tiles = new DeferredTileCuller(this._device, this._options.tiled);
        await cancellable(this._tiles.initialize(), this._initialization.signal);
        check();
      }
      this._resolve = this._tiles?.resolveRuntime(this._frame.bindGroupLayout) ?? getPrecompiledShaderPassRuntime(this._device, DEFERRED_LIGHTING_SHADER_ARTIFACT, 'deferred-reference', {
        rendererOwnedLayouts: { 0: this._frame.bindGroupLayout },
      });
      for (const runtime of [this._geometry, this._resolve, ...this._fullForward.runtimes]) {
        await cancellable(checkCompilation(runtime), this._initialization.signal);
        check();
      }
      {
        const runtime = this._resolve, pipelines = this._pipelines;
        for (const depthFormat of ['depth24plus', 'depth32float'] as const) {
          const pipeline = await cancellable(this._device.createRenderPipelineAsync({
            label: `${this._tiles ? 'DeferredTiles' : 'DeferredReference'}.resolve:${depthFormat}`, layout: runtime.pipelineLayout,
            vertex: { module: runtime.module, entryPoint: 'vs_main' },
            fragment: { module: runtime.module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'always' },
          }), this._initialization.signal);
          check(); pipelines[depthFormat] = pipeline;
        }
      }
      this._emptyGroups = [1, 2].map(i => this._device.createBindGroup({ layout: this._resolve!.bindGroupLayouts[i]!, entries: [] }));
      this._lights = new DeferredLightGpuTable(this._device);
      this._params = new DeferredImmutableBufferArena(this._device, 'DeferredReference.parameters', 32, GPUBufferUsage.UNIFORM);
      check(); this._initialized = true;
    } catch (error) { this.destroy(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  record(input: DeferredLightingRecordInput): boolean {
    if (!this._initialized || this._destroyed) throw new Error('Deferred reference backend is not initialized or was destroyed.');
    try {
      if (input.context.device !== this._device) throw new DeferredLightingCapabilityError('device-generation', 0, 1);
      validateDeferredViewConfiguration(this._device, input.view.width, input.view.height, input.view.sampleCount);
      const memory = planDeferredViewMemory(input.view.width, input.view.height, this._ambientOcclusion.countSources(input.ambientOcclusion));
      // Independently recorded instance draws still use the bounded Forward light ABI.
      // Reject the complete view rather than claiming full-light coverage for only its Mesh3D subset.
      for (const entity of input.world.iterQueryCandidates({ all: [InstancedMesh3D] })) {
        if (!input.view.excludedEntityIds?.has(entity.id) && !isEntityDisabledInHierarchy(entity)) {
          throw new DeferredLightingCapabilityError('unsupported-instance-surface', 1, 0);
        }
      }
      if (input.helperCount) throw new DeferredLightingCapabilityError('unsupported-forward-surface', input.helperCount, 0);
      if (input.transparentCount && (input.transparentItems?.length !== input.transparentCount
        || input.transparentItems.some(item => !(item.material instanceof PbrMaterial) || item.material.constructor !== PbrMaterial))) {
        throw new DeferredLightingCapabilityError('unsupported-forward-surface', input.transparentCount, 0);
      }
      this._opaqueForwardIndices.length = 0;
      for (const [index, item] of input.opaqueItems.entries()) {
        const material = item.material;
        if (!(material instanceof PbrMaterial) || material.constructor !== PbrMaterial || material.alphaMode === 'blend'
          || material.transmissionFactor > 0) {
          throw new DeferredLightingCapabilityError('unsupported-material-surface', 1, 0);
        }
        if (material.clearcoatFactor > 0 || material.ior !== 1.5
          || material.specularFactor !== 1 || material.specularColorFactor.some(v => v !== 1)
          || material.specularTexture || material.specularColorTexture || material.sheenColorFactor.some(v => v !== 0)
          || material.sheenColorTexture || material.sheenRoughnessTexture) {
          this._opaqueForwardIndices.push(index);
        }
      }
      this._sharedAllocation.retain(input.context);
      this.lastSource = getDeferredWorldLights(input.context.frameData ?? input.world.frameData, input.world);
      if (input.context.viewFamily) retainTransientAttachmentScopes(this._pool, new Set(input.context.viewFamily.views.map(view => view.key)));
      const source = this.lastSource!;
      let lightView = this._views.get(source);
      if (!lightView) { lightView = createDeferredReferenceView(source); this._views.set(source, lightView); }
      const lightBindings = this._lights!.bind(source, lightView, input.context);
      const width = input.view.width, height = input.view.height;
      const minDepth = input.view.viewport?.minDepth ?? 0, maxDepth = input.view.viewport?.maxDepth ?? 1;
      const parameterKey = `${width}:${height}:${input.view.reverseZ}:${minDepth}:${maxDepth}`;
      let params = this._parameters.get(parameterKey);
      if (!params) {
        params = new Float32Array([0, 0, width, height, input.view.reverseZ ? 0 : 1, minDepth, maxDepth, 0]);
        // A bounded CPU cache; arena slots are separately protected by submission lifetime.
        if (this._parameters.size >= 32) this._parameters.delete(this._parameters.keys().next().value!);
        this._parameters.set(parameterKey, params);
      }
      const parameters = this._params!.acquire(params, new Uint8Array(params.buffer), input.context);
      let attachments!: NonNullable<DeferredReferenceBackend["lastAttachments"]>;
      const frameOffset = this._frame!.upload(input.sceneFrame, input.context);
      const bypassReason = this._tiles?.select(input, source, lightView) ?? null;
      const tiled = this._tiles?.prepare(input, lightBindings, frameOffset, bypassReason !== null, memory);
      const resolve = this._resolve!;
      const pipelines = this._pipelines;
      const lightingBindings = this._port!.lightingBindings();
      let ao = this._ambientOcclusion.neutral;
      const resolveGroup = () => {
      const bindingKey = [lightBindings.source, lightBindings.header, lightBindings.indices, parameters]
        .map(b => `${this._resourceId(b.buffer)}:${b.offset ?? 0}:${b.size ?? 0}`).join('|')
        + `|${this._resourceId(attachments.views)}:${this._resourceId(lightingBindings)}:${tiled?.bindingKey ?? "reference"}`;
      const aoKey = `${bindingKey}|ao:${this._resourceId(ao.buffer)}`;
      let group = this._bindGroups.get(aoKey);
      if (!group) {
        group = this._device.createBindGroup({ label: 'DeferredReference.pass', layout: resolve.bindGroupLayouts[3]!, entries: [
        { binding: 0, resource: lightBindings.source }, { binding: 1, resource: lightBindings.header },
        { binding: 2, resource: lightBindings.indices },
        ...attachments.views.map((view, i) => ({ binding: i + 3, resource: view })),
        { binding: 7, resource: parameters }, ...lightingBindings, ...(tiled?.extraEntries ?? []), { binding: 17, resource: ao },
      ] });
        if (this._bindGroups.size >= 128) this._bindGroups.delete(this._bindGroups.keys().next().value!);
        this._bindGroups.set(aoKey, group);
      }
      return group;
      };
      this._plan.setCacheScope(this._device, JSON.stringify([frameGraphCacheScope(input.context, input.view),
        !!tiled, bypassReason, this._opaqueForwardIndices.length > 0, input.transparentCount > 0,
        'rgba16float', input.engine.getDepthFormat(input.view.reverseZ), 'latest-gbuffer-observer']));
      this._plan.clear().importResources('view', 'complete-light-source', 'prepared-materials', 'auxiliary-surface-inputs').exportResources('scene-linear-color', 'scene-depth')
        .add('deferred-gbuffer', 'render', () => {
          const pass = input.context.encoder.beginRenderPass({ label: 'DeferredReference.gbuffer',
            colorAttachments: attachments.views.slice(0, 3).map(view => ({ view, loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })),
            depthStencilAttachment: { view: attachments.views[3]!, depthClearValue: input.view.reverseZ ? 0 : 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
          });
          input.applyViewport(pass);
          this._port!.setSurface({ module: this._geometry!.module, key: this._geometry!.pass.canonicalHash });
          try { input.drawOpaque(pass); } finally { this._port!.setSurface(null); pass.end(); }
        }, { reads: ['view', 'prepared-materials'], writes: ['gbuffer'] });
      const hasLightingAo = this._ambientOcclusion.countSources(input.ambientOcclusion) > 0;
      let aoInputs: PostProcessSceneTextures | undefined;
      if (hasLightingAo) this._plan.add('deferred-ao-inputs', 'render', () => {
        aoInputs = input.ambientOcclusion!.prepare();
      }, { reads: ['view', 'prepared-materials', 'auxiliary-surface-inputs'],
        writes: ['ao-linear-depth', 'ao-view-normal', 'ao-frame-context'], after: ['deferred-gbuffer'] });
      this._plan.add('deferred-lighting-ao', hasLightingAo ? 'render' : 'prepare', () => {
        // Even neutral AO must retire old slots and retain the binding until submission completes.
        ao = this._ambientOcclusion.record(input.context, input.view.key, width, height,
          hasLightingAo ? { passes: input.ambientOcclusion!.passes, prepare: () => aoInputs! } : input.ambientOcclusion);
      }, { reads: ['view', ...(hasLightingAo ? ['ao-linear-depth', 'ao-view-normal', 'ao-frame-context'] : [])], writes: ['lighting-ao'] });
      if (tiled?.record) this._plan.add('deferred-tile-cull', 'compute', tiled.record, { reads: ['view', 'complete-light-source'], writes: ['tile-list'] });
      this._plan.add(tiled ? 'deferred-tiled-light-resolve' : 'deferred-full-light-resolve', 'render', () => {
          const pass = input.context.encoder.beginRenderPass({ ...input.sceneDescriptor, label: tiled ? 'DeferredTiles.resolve' : 'DeferredReference.resolve' });
          input.applyViewport(pass);
          try {
            input.drawSky(pass);
            pass.setPipeline(pipelines[input.engine.getDepthFormat(input.view.reverseZ)]!);
            pass.setBindGroup(0, this._frame!.bindGroup, [frameOffset]);
            pass.setBindGroup(1, this._emptyGroups[0]!); pass.setBindGroup(2, this._emptyGroups[1]!);
            pass.setBindGroup(3, resolveGroup()); pass.draw(3);
          } finally { pass.end(); }
        }, { reads: ['view', 'complete-light-source', 'gbuffer', 'lighting-ao', ...(tiled?.record ? ['tile-list'] : [])], writes: this._opaqueForwardIndices.length ? ['resolved-linear-color', 'resolved-scene-depth'] : input.transparentCount ? ['opaque-linear-color', 'opaque-scene-depth'] : ['scene-linear-color', 'scene-depth'] });
      if (this._opaqueForwardIndices.length) this._plan.add('deferred-full-light-opaque', 'render', () => {
        const pass = input.context.encoder.beginRenderPass(input.sceneLoadDescriptor());
        input.applyViewport(pass);
        this._port!.setFullLighting(this._fullForward!.bind(lightBindings, attachments.views[1]!, ao));
        try { input.drawOpaqueForward(pass, this._opaqueForwardIndices); } finally { this._port!.setFullLighting(null); pass.end(); }
      }, { reads: ['resolved-linear-color', 'resolved-scene-depth', 'gbuffer', 'lighting-ao', 'complete-light-source', 'prepared-materials'],
        writes: input.transparentCount ? ['opaque-linear-color', 'opaque-scene-depth'] : ['scene-linear-color', 'scene-depth'] });
      if (input.transparentCount) this._plan.add('deferred-full-light-transparent', 'render', () => {
        input.prepareTransparent();
        const pass = input.context.encoder.beginRenderPass(input.sceneLoadDescriptor());
        input.applyViewport(pass);
        this._port!.setFullLighting(this._fullForward!.bind(lightBindings, undefined, ao));
        try { input.drawTransparent(pass); } finally { this._port!.setFullLighting(null); pass.end(); }
      }, { reads: ['opaque-linear-color', 'opaque-scene-depth', 'lighting-ao', 'complete-light-source', 'prepared-materials'], writes: ['scene-linear-color', 'scene-depth'] });
      this._plan.execute(() => {
        const lifetime = this._plan.resourceLifetimes.find(resource => resource.name === 'gbuffer')!;
        attachments = this.lastAttachments = acquireSequentialAttachments(this._pool, input.view.key, width, height,
          ['rgba16float', 'rgba16float', 'rgba16float', 'depth32float'], input.context, lifetime, input.view.reverseZ, this._attachmentLimits.reserveBytes);
      });
      this.diagnostics = { requested: this._tiles ? 'deferred-tiled' : 'deferred-reference', effective: tiled ? 'deferred-tiled' : 'deferred-reference', completeCoverage: true, reason: bypassReason };
      return true;
    } catch (error) {
      if (error instanceof TransientAttachmentCapacityError) error = new DeferredLightingCapabilityError(error.reason, error.observed, error.supported);
      if (!(error instanceof DeferredLightingCapabilityError)) throw error;
      this.diagnostics = { requested: this._options.tiled ? 'deferred-tiled' : 'deferred-reference', effective: 'forward', completeCoverage: false, reason: error.reason };
      releaseTransientAttachments(this._pool, false, input.view.key);
      this.lastAttachments = undefined;
      this._tiles?.resources.releaseView(input.view.key);
      if (this._options.failurePolicy === 'strict') throw error;
      return false;
    }
  }

  get tileDiagnostics() { return this._tiles ? { bypassReason: this._tiles.lastBypassReason, plan: this._tiles.lastPlan, binding: this._tiles.lastBinding, resources: this._tiles.resources.stats } : undefined; }
  get allocationDiagnostics() { return { reservedBytes: this._allocationBudget.bytes, peakReservedBytes: this._allocationBudget.peakBytes, limitBytes: this._allocationBudget.maximumBytes }; }
  get passes() { return this._plan.snapshot; }
  get uploadStats() { return this._lights?.stats; }

  private _resourceId(value: object): number {
    let id = this._resourceIds.get(value);
    if (id === undefined) { id = this._nextResourceId++; this._resourceIds.set(value, id); }
    return id;
  }

  destroy(abandon = false): void {
    releaseSequentialAttachments(this._pool, abandon);
    this._sharedAllocation.destroy(abandon);
    this._ambientOcclusion.destroy(abandon);
    this._tiles?.destroy(abandon);
    // A later device-loss notification must also release work left pending by normal teardown.
    if (abandon) { this._lights?.abandon(); this._params?.abandon(); releaseTransientAttachments(this._pool, true); }
    if (this._destroyed) return;
    this._destroyed = true;
    this._plan.clear().clearCache();
    this._initialization.abort(new Error('Deferred initialization cancelled.'));
    this._port?.setSurface(null);
    this._port?.setFullLighting(null);
    this._fullForward?.destroy();
    if (!abandon) { this._lights?.destroy(); this._params?.destroy(); }
    this._frame?.destroy(); this._pool.destroy(); this._parameters.clear();
    this._bindGroups.clear();
    this.lastAttachments = undefined; this.lastSource = undefined;
    this._pipelines = {}; this._emptyGroups = [];
  }
}
