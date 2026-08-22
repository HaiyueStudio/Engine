import {
  alignUp4,
  beginRenderCommandPass,
  cloneRenderPassDescriptor,
  estimateTextureBytes,
  getExtensionGPUResourceTracker,
  requireEngineDevice,
  type IEngine,
  type ExtensionGPUResourceTracker,
  type RenderCommandContext,
  getExtensionSharedRendererResource,
} from '@haiyue/engine/extension-authoring';
import { Entity, type World } from '@haiyue/engine/ecs';
import { RenderSystem2DBase, type RenderSystem2DBaseOptions } from '../utils/RenderSystem2DBase';
import {
  createCamera2DGpu,
  createCamera2DLayout,
  destroyCamera2DGpu,
  type Camera2DGpu,
} from '../utils/render2dGpu';
import animation2dWgsl from '../shaders/generated/2d-ui-animation-2d.generated.wgsl';
import { AnimationVisual2D } from './AnimationVisual2D';
import { AnimationFormatError, type AnimationCompositeLayer } from '@haiyue/animation-spec';
import { animationMaskCompositeKey, animationMaskTargetKey, assertAnimationMaskBudget } from './AnimationMaskBudget';

export interface Animation2DRenderSystemOptions extends RenderSystem2DBaseOptions {
  /** Bounds view-sized alpha targets used by masks and mattes. */
  maxMaskTargets?: number;
}

export interface Animation2DRenderStats {
  readonly visualCount: number;
  readonly maskTargetCount: number;
  readonly compositeLayerCount: number;
  readonly droppedCompositeCount: number;
  readonly maskPixels: number;
  readonly effectTargetCount: number;
  readonly droppedEffectCount: number;
  /** Counts the reusable ping-pong RGBA targets owned by each active view. */
  readonly effectPixels: number;
}

interface EntityGpu {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  data: Float32Array;
  externalTexture: GPUTexture | null;
  externalSource: ImageBitmap | HTMLCanvasElement | HTMLImageElement | null;
  externalVersion: number;
  externalWidth: number;
  externalHeight: number;
  externalBindGroup: GPUBindGroup | null;
}

interface GeometryGpu {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
  version: number;
}

interface MaskTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  lastFrame: number;
}

interface EffectTarget {
  textures: readonly [GPUTexture, GPUTexture];
  views: readonly [GPUTextureView, GPUTextureView];
  width: number;
  height: number;
  lastFrame: number;
}

interface AnimationRenderItem {
  entity: Entity;
  visual: AnimationVisual2D;
}

const SHADER = animation2dWgsl;
const MAX_COMPOSITE_LAYERS = 8;
const COMPOSITE_PARAMS_OFFSET = 28;
const COMPOSITE_EXPANSION_OFFSET = COMPOSITE_PARAMS_OFFSET + MAX_COMPOSITE_LAYERS * 4;
const GRADIENT_PARAMS_OFFSET = COMPOSITE_EXPANSION_OFFSET + MAX_COMPOSITE_LAYERS;
const GRADIENT_GEOMETRY_OFFSET = GRADIENT_PARAMS_OFFSET + 4;
const GRADIENT_COLORS_OFFSET = GRADIENT_GEOMETRY_OFFSET + 4;
const GRADIENT_OFFSETS_OFFSET = GRADIENT_COLORS_OFFSET + 8 * 4;
const EFFECT_KINDS_OFFSET = GRADIENT_OFFSETS_OFFSET + 8;
const EFFECT_DATA_OFFSET = EFFECT_KINDS_OFFSET + 8;
const EFFECT_FLOATS = 24;
const MAX_EFFECTS = 8;
const OBJECT_FLOATS = EFFECT_DATA_OFFSET + MAX_EFFECTS * EFFECT_FLOATS;
const OBJECT_BYTES = OBJECT_FLOATS * 4;

interface Animation2DSharedGpu {
  readonly cameraLayout: GPUBindGroupLayout;
  readonly objectLayout: GPUBindGroupLayout;
  readonly textureLayout: GPUBindGroupLayout;
  readonly compositeLayout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;
  readonly shader: GPUShaderModule;
  readonly pipelineLayout: GPUPipelineLayout;
  readonly pipelines: Map<string, GPURenderPipeline>;
  readonly whiteTexture: GPUTexture;
  readonly whiteBindGroup: GPUBindGroup;
  readonly emptyCompositeBindGroup: GPUBindGroup;
  readonly transparentTexture: GPUTexture;
  readonly transparentBindGroup: GPUBindGroup;
  destroy(): void;
}

function getAnimation2DSharedGpu(
  device: GPUDevice,
  tracker: ExtensionGPUResourceTracker | undefined,
): Animation2DSharedGpu {
  return getExtensionSharedRendererResource(
    device,
    'Animation2D.sharedGpu:v1',
    () => createAnimation2DSharedGpu(device, tracker),
  );
}

function createAnimation2DSharedGpu(
  device: GPUDevice,
  tracker: ExtensionGPUResourceTracker | undefined,
): Animation2DSharedGpu {
  const cameraLayout = createCamera2DLayout(device);
  const objectLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    }],
  });
  const textureLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ] });
  const compositeLayout = device.createBindGroupLayout({ entries: [
    ...Array.from({ length: MAX_COMPOSITE_LAYERS }, (_, binding) => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'float' as const },
    })),
    { binding: MAX_COMPOSITE_LAYERS, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ] });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const shader = device.createShaderModule({ label: 'Animation2D.shader', code: SHADER });
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cameraLayout, objectLayout, textureLayout, compositeLayout],
  });
  const createTextureBindGroup = (texture: GPUTexture): GPUBindGroup => device.createBindGroup({
    layout: textureLayout,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: sampler },
    ],
  });
  const whiteTexture = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  tracker?.trackTexture(whiteTexture, 'Animation2D.sharedWhiteTexture', 4);
  device.queue.writeTexture(
    { texture: whiteTexture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  const whiteBindGroup = createTextureBindGroup(whiteTexture);
  const emptyCompositeBindGroup = device.createBindGroup({
    layout: compositeLayout,
    entries: [
      ...Array.from({ length: MAX_COMPOSITE_LAYERS }, (_, binding) => ({
        binding,
        resource: whiteTexture.createView(),
      })),
      { binding: MAX_COMPOSITE_LAYERS, resource: sampler },
    ],
  });
  const transparentTexture = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  tracker?.trackTexture(transparentTexture, 'Animation2D.sharedTransparentTexture', 4);
  device.queue.writeTexture(
    { texture: transparentTexture },
    new Uint8Array([255, 255, 255, 0]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  const transparentBindGroup = createTextureBindGroup(transparentTexture);
  return {
    cameraLayout,
    objectLayout,
    textureLayout,
    compositeLayout,
    sampler,
    shader,
    pipelineLayout,
    pipelines: new Map(),
    whiteTexture,
    whiteBindGroup,
    emptyCompositeBindGroup,
    transparentTexture,
    transparentBindGroup,
    destroy(): void {
      tracker?.untrackTexture(whiteTexture);
      tracker?.untrackTexture(transparentTexture);
      whiteTexture.destroy();
      transparentTexture.destroy();
      this.pipelines.clear();
    },
  };
}

export class Animation2DRenderSystem extends RenderSystem2DBase {
  private readonly maxMaskTargets: number;
  private rendererReady = false;
  private cameraGpu!: Camera2DGpu;
  private objectLayout!: GPUBindGroupLayout;
  private textureLayout!: GPUBindGroupLayout;
  private compositeLayout!: GPUBindGroupLayout;
  private sampler!: GPUSampler;
  private whiteTexture!: GPUTexture;
  private whiteBindGroup!: GPUBindGroup;
  private emptyCompositeBindGroup!: GPUBindGroup;
  private transparentTexture!: GPUTexture;
  private transparentBindGroup!: GPUBindGroup;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private pipelines!: Map<string, GPURenderPipeline>;
  private readonly entityGpu = new Map<number, EntityGpu>();
  private readonly geometryGpu = new Map<string, GeometryGpu>();
  private readonly explicitUvIds = new WeakMap<Float32Array, number>();
  private nextExplicitUvId = 1;
  private textureBindGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  private readonly maskTargets = new Map<string, MaskTarget>();
  private readonly effectTargets = new Map<string, EffectTarget>();
  private readonly items: AnimationRenderItem[] = [];
  private readonly sourceItems = new Map<string, AnimationRenderItem[]>();
  private readonly sourceGroupPool: AnimationRenderItem[][] = [];
  private readonly activeMaskTargets = new Map<string, MaskTarget>();
  private readonly compositeBindGroups = new Map<string, GPUBindGroup>();
  private readonly liveGeometryIds = new Set<string>();
  private _visualCount = 0;
  private _maskTargetCount = 0;
  private _compositeLayerCount = 0;
  private _droppedCompositeCount = 0;
  private _maskPixels = 0;
  private _effectTargetCount = 0;
  private _droppedEffectCount = 0;
  private _effectPixels = 0;

  constructor(engine: IEngine, cameraEntity: Entity, options: Animation2DRenderSystemOptions = {}) {
    // Optional extension subpaths can be bundled as independent module graphs.
    // Query by the stable global component symbol so a visual created by the
    // HYA state-machine subpath is visible to the animation renderer subpath.
    super({ all: [AnimationVisual2D.UniqueSymbol] }, engine, cameraEntity, { ...options, loadOp: options.loadOp ?? 'load' }, 'Animation2DRenderSystem');
    this.maxMaskTargets = positiveInteger(options.maxMaskTargets ?? 32, 'maxMaskTargets');
  }

  get stats(): Animation2DRenderStats {
    return Object.freeze({
      visualCount: this._visualCount,
      maskTargetCount: this._maskTargetCount,
      compositeLayerCount: this._compositeLayerCount,
      droppedCompositeCount: this._droppedCompositeCount,
      maskPixels: this._maskPixels,
      effectTargetCount: this._effectTargetCount,
      droppedEffectCount: this._droppedEffectCount,
      effectPixels: this._effectPixels,
    });
  }

  get renderPipelineOptions() {
    return { pass: 'isolated' as const, loadOp: this.loadOp, sort: this.priority };
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    if (!this.rendererReady) this.prepare();
    if (!this.writeCameraBuffer(context.device.queue, this.cameraGpu.buffer, context)) return this;
    const liveEntities = this.beginLiveEntityTracking();
    this.items.length = 0;
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (!this.isEntityRenderable(entity)) continue;
      const visual = entity.getComponent(AnimationVisual2D.UniqueSymbol) as AnimationVisual2D | null;
      if (!visual) continue;
      this.items.push({ entity, visual });
      this.markEntityLive(entity);
    }
    this.items.sort(compareItems);

    const frame = context.frameData?.frameId ?? 0;
    this.sourceItems.clear();
    let sourceGroupCount = 0;
    for (const item of this.items) {
      if (!item.visual.sourceOnly) continue;
      const key = visualNodeKey(item.visual);
      let group = this.sourceItems.get(key);
      if (!group) {
        group = this.sourceGroupPool[sourceGroupCount] ?? [];
        group.length = 0;
        this.sourceGroupPool[sourceGroupCount++] = group;
        this.sourceItems.set(key, group);
      }
      group.push(item);
    }

    const viewKey = context.view?.key ?? 'default';
    assertAnimationMaskBudget({
      groupCount: this.sourceItems.size,
      maxGroupCount: this.maxMaskTargets,
      width: context.view?.target.width ?? this.engine.width,
      height: context.view?.target.height ?? this.engine.height,
      maxTextureDimension2D: context.device.limits.maxTextureDimension2D,
      viewKey,
    });

    const maskTargets = this.activeMaskTargets;
    maskTargets.clear();
    let maskPixels = 0;
    let maskCount = 0;
    let droppedCompositeCount = 0;
    let compositeLayerCount = 0;
    let effectCount = 0;
    let droppedEffectCount = 0;
    let effectPixels = 0;
    for (const sourceKey of orderSourceGroups(this.sourceItems)) {
      const sources = this.sourceItems.get(sourceKey)!;
      const targetKey = animationMaskTargetKey(viewKey, sourceKey);
      const target = this.getMaskTarget(targetKey, context, frame);
      maskPixels += target.width * target.height;
      maskCount++;
      let initialized = false;
      for (const source of sources) {
        const resolved = this.resolveCompositeBindGroup(source.visual, maskTargets, viewKey);
        if (!resolved) throw unresolvedCompositeError(source.visual, viewKey);
        compositeLayerCount += source.visual.compositeLayers.length;
        const effectTarget = source.visual.effects.length > 0 && !context.passEncoder
          ? this.renderEffectStack(source, context, resolved, frame)
          : null;
        if (effectTarget) {
          effectCount++;
          if (effectPixels === 0) effectPixels = effectTarget.width * effectTarget.height * 2;
        } else if (source.visual.effects.length > 0) droppedEffectCount++;
        const pass = this.beginMaskSegment(context, target, sourceKey, initialized);
        if (effectTarget) {
          pass.setPipeline(this.getPresentPipeline('rgba8unorm', 1, false, false));
          this.drawEffectResult(pass, source.entity, effectTarget.texture);
        } else {
          pass.setPipeline(this.getPipeline('rgba8unorm', 1, false, false));
          this.draw(pass, source.entity, source.visual, context, resolved, true);
        }
        pass.end();
        initialized = true;
      }
      if (!initialized) this.beginMaskSegment(context, target, sourceKey, false).end();
      maskTargets.set(sourceKey, target);
    }

    const pending: Array<{ item: AnimationRenderItem; composite: GPUBindGroup }> = [];
    const outputFormat = context.view?.target.format ?? this.engine.format;
    let firstOutputSegment = true;
    let visualCount = 0;
    const flushOutput = (effectItem?: AnimationRenderItem, effectTexture?: GPUTexture): void => {
      if (pending.length === 0 && !effectItem && !firstOutputSegment) return;
      const { passEncoder, ownsPass } = this.beginOutputSegment(context, firstOutputSegment);
      firstOutputSegment = false;
      applyViewport(passEncoder, context);
      passEncoder.setBindGroup(0, this.cameraGpu.bindGroup);
      for (const entry of pending) {
        passEncoder.setPipeline(this.getPipeline(
          outputFormat,
          context.view?.sampleCount ?? this.engine.msaaSamples,
          true,
          context.view?.reverseZ ?? this.engine.reverseZ,
          entry.item.visual.blendMode,
        ));
        this.draw(passEncoder, entry.item.entity, entry.item.visual, context, entry.composite, false);
        visualCount++;
      }
      pending.length = 0;
      if (effectItem && effectTexture) {
        passEncoder.setPipeline(this.getPresentPipeline(
          outputFormat, context.view?.sampleCount ?? this.engine.msaaSamples, true, context.view?.reverseZ ?? this.engine.reverseZ,
        ));
        this.drawEffectResult(passEncoder, effectItem.entity, effectTexture);
        visualCount++;
      }
      if (ownsPass) passEncoder.end();
    };
    for (const item of this.items) {
      const { visual } = item;
      if (visual.sourceOnly) continue;
      const resolved = this.resolveCompositeBindGroup(visual, maskTargets, viewKey);
      if (!resolved) throw unresolvedCompositeError(visual, viewKey);
      compositeLayerCount += visual.compositeLayers.length;
      if (visual.effects.length > 0 && !context.passEncoder) {
        const effectTarget = this.renderEffectStack(item, context, resolved, frame);
        effectCount++;
        if (effectPixels === 0) effectPixels = effectTarget.width * effectTarget.height * 2;
        flushOutput(item, effectTarget.texture);
      } else {
        if (visual.effects.length > 0) droppedEffectCount++;
        pending.push({ item, composite: resolved });
      }
    }
    flushOutput();

    this.releaseEntityGpuEntriesNotIn(this.entityGpu, gpu => this.destroyEntityGpu(gpu), liveEntities);
    this.sweepGeometryGpu();
    this.sweepMaskTargets(frame, context);
    this.sweepEffectTargets(frame, context);
    this._visualCount = visualCount;
    this._maskTargetCount = maskCount;
    this._compositeLayerCount = compositeLayerCount;
    this._droppedCompositeCount = droppedCompositeCount;
    this._maskPixels = maskPixels;
    this._effectTargetCount = effectCount > 0 ? 1 : 0;
    this._droppedEffectCount = droppedEffectCount;
    this._effectPixels = effectPixels;
    return this;
  }

  override destroy(): this {
    this.releaseGpuResourcesForRecovery();
    return super.destroy();
  }

  protected releaseGpuResourcesForRecovery(): void {
    if (!this.rendererReady) return;
    destroyCamera2DGpu(this.cameraGpu);
    this.destroyEntityGpuEntries(this.entityGpu, gpu => this.destroyEntityGpu(gpu));
    for (const gpu of this.geometryGpu.values()) this.destroyGeometryGpu(gpu);
    this.geometryGpu.clear();
    for (const target of this.maskTargets.values()) this.destroyMaskTarget(target);
    this.maskTargets.clear();
    for (const target of this.effectTargets.values()) this.destroyEffectTarget(target);
    this.effectTargets.clear();
    this.activeMaskTargets.clear();
    this.compositeBindGroups.clear();
    this.textureBindGroups = new WeakMap();
    this.rendererReady = false;
  }

  private prepare(): void {
    const device = requireEngineDevice(this.engine);
    const tracker = getExtensionGPUResourceTracker(this.engine);
    const shared = getAnimation2DSharedGpu(device, tracker);
    this.cameraGpu = createCamera2DGpu(device, tracker, shared.cameraLayout);
    this.objectLayout = shared.objectLayout;
    this.textureLayout = shared.textureLayout;
    this.compositeLayout = shared.compositeLayout;
    this.sampler = shared.sampler;
    this.whiteTexture = shared.whiteTexture;
    this.whiteBindGroup = shared.whiteBindGroup;
    this.emptyCompositeBindGroup = shared.emptyCompositeBindGroup;
    this.transparentTexture = shared.transparentTexture;
    this.transparentBindGroup = shared.transparentBindGroup;
    this.shader = shared.shader;
    this.pipelineLayout = shared.pipelineLayout;
    this.pipelines = shared.pipelines;
    this.rendererReady = true;
  }

  private beginMaskSegment(
    context: RenderCommandContext,
    target: MaskTarget,
    sourceKey: string,
    initialized: boolean,
  ): GPURenderPassEncoder {
    const pass = context.encoder.beginRenderPass({
      label: `Animation2D.mask:${sourceKey}`,
      colorAttachments: [{
        view: target.view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: initialized ? 'load' : 'clear',
        storeOp: 'store',
      }],
    });
    applyViewport(pass, context);
    pass.setBindGroup(0, this.cameraGpu.bindGroup);
    return pass;
  }

  private beginOutputSegment(
    context: RenderCommandContext,
    first: boolean,
  ): { passEncoder: GPURenderPassEncoder; ownsPass: boolean } {
    if (first) return beginRenderCommandPass(context);
    if (!context.descriptor) throw new Error('Animation2D ordered effects require an isolated render-pass descriptor.');
    return { passEncoder: context.encoder.beginRenderPass(cloneRenderPassDescriptor(context.descriptor, 'load')), ownsPass: true };
  }

  private getPipeline(
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    withDepth: boolean,
    reverseZ: boolean,
    blendMode: AnimationVisual2D['blendMode'] = 'normal',
  ): GPURenderPipeline {
    const depthFormat = withDepth ? this.engine.getDepthFormat(reverseZ) : 'none';
    const key = `visual:${format}:${sampleCount}:${depthFormat}:${reverseZ ? 1 : 0}:${blendMode}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;
    const pipeline = requireEngineDevice(this.engine).createRenderPipeline({
      label: `Animation2D.pipeline:${key}`,
      layout: this.pipelineLayout,
      vertex: { module: this.shader, entryPoint: 'vs_main', buffers: [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
        ],
      }] },
      fragment: { module: this.shader, entryPoint: 'fs_main', targets: [{ format, blend: animationVisualBlendState(blendMode) }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      ...(withDepth ? { depthStencil: {
        format: depthFormat as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: 'always' as const,
      } } : {}),
      multisample: { count: sampleCount },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private getEffectPipeline(): GPURenderPipeline {
    const key = 'effect:rgba8unorm';
    const cached = this.pipelines.get(key);
    if (cached) return cached;
    const pipeline = requireEngineDevice(this.engine).createRenderPipeline({
      label: 'Animation2D.effectPipeline',
      layout: this.pipelineLayout,
      vertex: { module: this.shader, entryPoint: 'vs_effect' },
      fragment: { module: this.shader, entryPoint: 'fs_effect', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private getPresentPipeline(format: GPUTextureFormat, sampleCount: 1 | 4, withDepth: boolean, reverseZ: boolean): GPURenderPipeline {
    const depthFormat = withDepth ? this.engine.getDepthFormat(reverseZ) : 'none';
    const key = `present:${format}:${sampleCount}:${depthFormat}:${reverseZ ? 1 : 0}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;
    const pipeline = requireEngineDevice(this.engine).createRenderPipeline({
      label: `Animation2D.presentPipeline:${key}`,
      layout: this.pipelineLayout,
      vertex: { module: this.shader, entryPoint: 'vs_effect' },
      fragment: { module: this.shader, entryPoint: 'fs_present', targets: [{ format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      ...(withDepth ? { depthStencil: {
        format: depthFormat as GPUTextureFormat, depthWriteEnabled: false, depthCompare: 'always' as const,
      } } : {}),
      multisample: { count: sampleCount },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private draw(
    pass: GPURenderPassEncoder,
    entity: Entity,
    visual: AnimationVisual2D,
    context: RenderCommandContext,
    compositeBindGroup: GPUBindGroup,
    outputMask: boolean,
  ): void {
    const device = requireEngineDevice(this.engine);
    const object = this.getEntityGpu(entity);
    object.data.set(this.getWorldMatrix2D(entity, context), 0);
    object.data.set(visual.color, 16);
    object.data[20] = visual.compositeLayers.length;
    object.data[21] = outputMask ? 1 : 0;
    object.data[22] = Math.min(MAX_EFFECTS, visual.effects.length);
    object.data[23] = 0;
    object.data.set(visual.uvRect, 24);
    object.data.fill(0, COMPOSITE_PARAMS_OFFSET);
    for (let index = 0; index < visual.compositeLayers.length; index++) {
      const layer = visual.compositeLayers[index]!;
      const offset = COMPOSITE_PARAMS_OFFSET + index * 4;
      object.data[offset] = compositeModeCode(layer.mode);
      object.data[offset + 1] = compositeOperationCode(layer.operation ?? 'add');
      object.data[offset + 2] = layer.feather?.[0] ?? 0;
      object.data[offset + 3] = layer.feather?.[1] ?? 0;
      object.data[COMPOSITE_EXPANSION_OFFSET + index] = layer.expansion ?? 0;
    }
    const gradient = visual.gradient;
    if (gradient) {
      const stopCount = Math.min(8, gradient.stops.length / 5);
      object.data[GRADIENT_PARAMS_OFFSET] = gradient.kind === 'linear' ? 1 : 2;
      object.data[GRADIENT_PARAMS_OFFSET + 1] = stopCount;
      object.data[GRADIENT_PARAMS_OFFSET + 2] = gradient.opacity;
      object.data.set(gradient.start, GRADIENT_GEOMETRY_OFFSET);
      object.data.set(gradient.end, GRADIENT_GEOMETRY_OFFSET + 2);
      for (let index = 0; index < stopCount; index++) {
        const source = index * 5;
        const colorOffset = GRADIENT_COLORS_OFFSET + index * 4;
        object.data[colorOffset] = gradient.stops[source + 1] ?? 1;
        object.data[colorOffset + 1] = gradient.stops[source + 2] ?? 1;
        object.data[colorOffset + 2] = gradient.stops[source + 3] ?? 1;
        object.data[colorOffset + 3] = gradient.stops[source + 4] ?? 1;
        object.data[GRADIENT_OFFSETS_OFFSET + index] = gradient.stops[source] ?? 0;
      }
    }
    for (let index = 0; index < Math.min(MAX_EFFECTS, visual.effects.length); index++) {
      const effect = visual.effects[index]!;
      object.data[EFFECT_KINDS_OFFSET + index] = effectKindCode(effect.kind);
      object.data.set(effect.values.subarray(0, EFFECT_FLOATS), EFFECT_DATA_OFFSET + index * EFFECT_FLOATS);
    }
    device.queue.writeBuffer(object.buffer, 0, object.data as ArrayBufferView<ArrayBuffer>);
    const geometry = this.getGeometryGpu(visual);
    pass.setBindGroup(1, object.bindGroup);
    pass.setBindGroup(2, this.getVisualTextureBindGroup(entity, visual, object, context));
    pass.setBindGroup(3, compositeBindGroup);
    pass.setVertexBuffer(0, geometry.vertexBuffer);
    if (geometry.indexBuffer && geometry.indexCount > 0) {
      pass.setIndexBuffer(geometry.indexBuffer, geometry.indexFormat);
      pass.drawIndexed(geometry.indexCount);
    } else {
      pass.draw(geometry.vertexCount);
    }
  }

  private renderEffectStack(
    item: AnimationRenderItem,
    context: RenderCommandContext,
    compositeBindGroup: GPUBindGroup,
    frame: number,
  ): { texture: GPUTexture; width: number; height: number } {
    // One reusable ping-pong pair per view. Command ordering presents each result
    // before the next visual overwrites it, so memory is O(view), not O(entities).
    const key = context.view?.key ?? 'default';
    const target = this.getEffectTarget(key, context, frame);
    const sourcePass = context.encoder.beginRenderPass({
      label: `Animation2D.effectSource:${item.entity.id}`,
      colorAttachments: [{
        view: target.views[0], clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
      }],
    });
    applyViewport(sourcePass, context);
    sourcePass.setPipeline(this.getPipeline('rgba8unorm', 1, false, false));
    sourcePass.setBindGroup(0, this.cameraGpu.bindGroup);
    this.draw(sourcePass, item.entity, item.visual, context, compositeBindGroup, false);
    sourcePass.end();

    const object = this.getEntityGpu(item.entity);
    let sourceIndex: 0 | 1 = 0;
    for (let index = 0; index < Math.min(MAX_EFFECTS, item.visual.effects.length); index++) {
      const outputIndex: 0 | 1 = sourceIndex === 0 ? 1 : 0;
      const pass = context.encoder.beginRenderPass({
        label: `Animation2D.effect:${item.entity.id}:${index}`,
        colorAttachments: [{
          view: target.views[outputIndex], clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
        }],
      });
      applyViewport(pass, context);
      pass.setPipeline(this.getEffectPipeline());
      pass.setBindGroup(0, this.cameraGpu.bindGroup);
      pass.setBindGroup(1, object.bindGroup);
      pass.setBindGroup(2, this.getTextureBindGroup(target.textures[sourceIndex]));
      pass.setBindGroup(3, this.emptyCompositeBindGroup);
      pass.draw(3, 1, 0, index);
      pass.end();
      sourceIndex = outputIndex;
    }
    return { texture: target.textures[sourceIndex], width: target.width, height: target.height };
  }

  private drawEffectResult(pass: GPURenderPassEncoder, entity: Entity, texture: GPUTexture): void {
    pass.setBindGroup(1, this.getEntityGpu(entity).bindGroup);
    pass.setBindGroup(2, this.getTextureBindGroup(texture));
    pass.setBindGroup(3, this.emptyCompositeBindGroup);
    pass.draw(3);
  }

  private getEntityGpu(entity: Entity): EntityGpu {
    return this.getOrCreateEntityGpu(this.entityGpu, entity, () => {
      const device = requireEngineDevice(this.engine);
      const buffer = device.createBuffer({ size: OBJECT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      getExtensionGPUResourceTracker(this.engine)?.trackBuffer(buffer, 'Animation2D.objectBuffer', OBJECT_BYTES);
      return {
        buffer,
        bindGroup: device.createBindGroup({ layout: this.objectLayout, entries: [{ binding: 0, resource: { buffer } }] }),
        data: new Float32Array(OBJECT_FLOATS),
        externalTexture: null,
        externalSource: null,
        externalVersion: -1,
        externalWidth: 0,
        externalHeight: 0,
        externalBindGroup: null,
      };
    });
  }

  private getVisualTextureBindGroup(
    entity: Entity,
    visual: AnimationVisual2D,
    object: EntityGpu,
    context: RenderCommandContext,
  ): GPUBindGroup {
    const texture = visual.resolveTexture();
    if (texture) return this.getTextureBindGroup(texture);
    const material = visual.textMaterial;
    const source = material?.texture;
    if (material && isExternalImageSource(source)) {
      const size = externalImageSize(source);
      if (!object.externalTexture || object.externalWidth !== size.width || object.externalHeight !== size.height) {
        const retiredTexture = object.externalTexture;
        if (retiredTexture) {
          const retire = () => {
            getExtensionGPUResourceTracker(this.engine)?.untrackTexture(retiredTexture);
            retiredTexture.destroy();
          };
          if (context.afterSubmit) {
            context.afterSubmit(queue => {
              void queue.onSubmittedWorkDone()
                .then(retire)
                .catch(retire);
            });
          } else {
            retire();
          }
        }
        object.externalTexture = requireEngineDevice(this.engine).createTexture({
          label: `Animation2D.text:${entity.id}`,
          size: [size.width, size.height],
          format: 'rgba8unorm',
          // WebGPU copyExternalImageToTexture requires RENDER_ATTACHMENT in addition
          // to COPY_DST for browser-backed image sources.
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        getExtensionGPUResourceTracker(this.engine)?.trackTexture(object.externalTexture, 'Animation2D.textTexture', size.width * size.height * 4);
        object.externalBindGroup = this.createTextureBindGroup(object.externalTexture);
        object.externalWidth = size.width;
        object.externalHeight = size.height;
        object.externalVersion = -1;
      }
      if (object.externalSource !== source || object.externalVersion !== material.textureVersion) {
        requireEngineDevice(this.engine).queue.copyExternalImageToTexture({ source }, { texture: object.externalTexture! }, [size.width, size.height]);
        object.externalSource = source;
        object.externalVersion = material.textureVersion;
      }
      return object.externalBindGroup!;
    }
    return visual.requiresTexture ? this.transparentBindGroup : this.whiteBindGroup;
  }

  private getGeometryGpu(visual: AnimationVisual2D): GeometryGpu {
    const geometry = visual.geometry;
    const key = this.geometryKey(visual);
    let gpu = this.geometryGpu.get(key);
    if (gpu && gpu.version === geometry.version) return gpu;
    if (gpu) this.destroyGeometryGpu(gpu);
    const vertices = buildVertices(geometry.positions, visual.uvs);
    const device = requireEngineDevice(this.engine);
    const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexBuffer, 0, vertices as ArrayBufferView<ArrayBuffer>);
    let indexBuffer: GPUBuffer | null = null;
    if (geometry.indices?.length) {
      const allocationBytes = alignUp4(geometry.indices.byteLength);
      indexBuffer = device.createBuffer({ size: allocationBytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      writeBufferAligned(device.queue, indexBuffer, geometry.indices);
    }
    const tracker = getExtensionGPUResourceTracker(this.engine);
    tracker?.trackBuffer(vertexBuffer, 'Animation2D.vertexBuffer', vertices.byteLength);
    if (indexBuffer && geometry.indices) tracker?.trackBuffer(indexBuffer, 'Animation2D.indexBuffer', alignUp4(geometry.indices.byteLength));
    gpu = {
      vertexBuffer,
      indexBuffer,
      indexCount: geometry.indices?.length ?? 0,
      vertexCount: geometry.vertexCount,
      indexFormat: geometry.indices instanceof Uint32Array ? 'uint32' : 'uint16',
      version: geometry.version,
    };
    this.geometryGpu.set(key, gpu);
    return gpu;
  }

  private geometryKey(visual: AnimationVisual2D): string {
    if (!visual.uvs) return `${visual.geometry.id}:derived`;
    let uvId = this.explicitUvIds.get(visual.uvs);
    if (uvId === undefined) {
      uvId = this.nextExplicitUvId++;
      this.explicitUvIds.set(visual.uvs, uvId);
    }
    return `${visual.geometry.id}:uv:${uvId}`;
  }

  private getTextureBindGroup(texture: GPUTexture): GPUBindGroup {
    let bindGroup = this.textureBindGroups.get(texture);
    if (!bindGroup) {
      bindGroup = this.createTextureBindGroup(texture);
      this.textureBindGroups.set(texture, bindGroup);
    }
    return bindGroup;
  }

  private createTextureBindGroup(texture: GPUTexture): GPUBindGroup {
    return requireEngineDevice(this.engine).createBindGroup({ layout: this.textureLayout, entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: this.sampler },
    ] });
  }

  private resolveCompositeBindGroup(
    visual: AnimationVisual2D,
    targets: ReadonlyMap<string, MaskTarget>,
    viewKey: string,
  ): GPUBindGroup | null {
    if (visual.compositeLayers.length === 0) return this.emptyCompositeBindGroup;
    const resolved: MaskTarget[] = [];
    for (const key of visual.compositeKeys) {
      const target = targets.get(key);
      if (!target) return null;
      resolved.push(target);
    }
    const key = animationMaskCompositeKey(viewKey, visual.compositeKeys);
    let bindGroup = this.compositeBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.createCompositeBindGroup(resolved.map(target => target.texture));
      this.compositeBindGroups.set(key, bindGroup);
    }
    return bindGroup;
  }

  private createCompositeBindGroup(textures: readonly GPUTexture[]): GPUBindGroup {
    return requireEngineDevice(this.engine).createBindGroup({
      layout: this.compositeLayout,
      entries: [
        ...Array.from({ length: MAX_COMPOSITE_LAYERS }, (_, binding) => ({
          binding,
          resource: (textures[binding] ?? this.whiteTexture).createView(),
        })),
        { binding: MAX_COMPOSITE_LAYERS, resource: this.sampler },
      ],
    });
  }

  private getMaskTarget(key: string, context: RenderCommandContext, frame: number): MaskTarget {
    const width = context.view?.target.width ?? this.engine.width;
    const height = context.view?.target.height ?? this.engine.height;
    let target = this.maskTargets.get(key);
    if (target && target.width === width && target.height === height) { target.lastFrame = frame; return target; }
    if (target) {
      this.maskTargets.delete(key);
      this.compositeBindGroups.clear();
      const retired = target;
      context.afterSubmit?.(queue => void queue.onSubmittedWorkDone().then(() => this.destroyMaskTarget(retired)).catch(() => this.destroyMaskTarget(retired)));
      if (!context.afterSubmit) this.destroyMaskTarget(retired);
    }
    const texture = requireEngineDevice(this.engine).createTexture({
      label: `Animation2D.mask:${key}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    getExtensionGPUResourceTracker(this.engine)?.trackTexture(texture, 'Animation2D.maskTexture', estimateTextureBytes([width, height, 1], 'rgba8unorm'));
    target = { texture, view: texture.createView(), width, height, lastFrame: frame };
    this.maskTargets.set(key, target);
    return target;
  }

  private getEffectTarget(key: string, context: RenderCommandContext, frame: number): EffectTarget {
    const width = context.view?.target.width ?? this.engine.width;
    const height = context.view?.target.height ?? this.engine.height;
    let target = this.effectTargets.get(key);
    if (target && target.width === width && target.height === height) { target.lastFrame = frame; return target; }
    if (target) {
      this.effectTargets.delete(key);
      const retired = target;
      context.afterSubmit?.(queue => void queue.onSubmittedWorkDone().then(() => this.destroyEffectTarget(retired)).catch(() => this.destroyEffectTarget(retired)));
      if (!context.afterSubmit) this.destroyEffectTarget(retired);
    }
    const device = requireEngineDevice(this.engine);
    const makeTexture = (index: number): GPUTexture => device.createTexture({
      label: `Animation2D.effect:${key}:${index}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const textures = [makeTexture(0), makeTexture(1)] as const;
    const bytes = estimateTextureBytes([width, height, 1], 'rgba8unorm');
    const tracker = getExtensionGPUResourceTracker(this.engine);
    tracker?.trackTexture(textures[0], 'Animation2D.effectTexture', bytes);
    tracker?.trackTexture(textures[1], 'Animation2D.effectTexture', bytes);
    target = { textures, views: [textures[0].createView(), textures[1].createView()], width, height, lastFrame: frame };
    this.effectTargets.set(key, target);
    return target;
  }

  private sweepMaskTargets(frame: number, context: RenderCommandContext): void {
    let swept = false;
    for (const [key, target] of this.maskTargets) {
      if (target.lastFrame >= frame - 1) continue;
      this.maskTargets.delete(key);
      swept = true;
      context.afterSubmit?.(queue => void queue.onSubmittedWorkDone().then(() => this.destroyMaskTarget(target)).catch(() => this.destroyMaskTarget(target)));
      if (!context.afterSubmit) this.destroyMaskTarget(target);
    }
    if (swept) this.compositeBindGroups.clear();
  }

  private sweepEffectTargets(frame: number, context: RenderCommandContext): void {
    for (const [key, target] of this.effectTargets) {
      if (target.lastFrame >= frame - 1) continue;
      this.effectTargets.delete(key);
      context.afterSubmit?.(queue => void queue.onSubmittedWorkDone().then(() => this.destroyEffectTarget(target)).catch(() => this.destroyEffectTarget(target)));
      if (!context.afterSubmit) this.destroyEffectTarget(target);
    }
  }

  private sweepGeometryGpu(): void {
    this.liveGeometryIds.clear();
    for (const item of this.items) this.liveGeometryIds.add(this.geometryKey(item.visual));
    for (const [id, gpu] of this.geometryGpu) if (!this.liveGeometryIds.has(id)) { this.destroyGeometryGpu(gpu); this.geometryGpu.delete(id); }
  }

  private destroyEntityGpu(gpu: EntityGpu): void {
    getExtensionGPUResourceTracker(this.engine)?.untrackBuffer(gpu.buffer);
    gpu.buffer.destroy();
    if (gpu.externalTexture) getExtensionGPUResourceTracker(this.engine)?.untrackTexture(gpu.externalTexture);
    gpu.externalTexture?.destroy();
  }

  private destroyGeometryGpu(gpu: GeometryGpu): void {
    const tracker = getExtensionGPUResourceTracker(this.engine);
    tracker?.untrackBuffer(gpu.vertexBuffer);
    gpu.vertexBuffer.destroy();
    if (gpu.indexBuffer) tracker?.untrackBuffer(gpu.indexBuffer);
    gpu.indexBuffer?.destroy();
  }

  private destroyMaskTarget(target: MaskTarget): void {
    getExtensionGPUResourceTracker(this.engine)?.untrackTexture(target.texture);
    target.texture.destroy();
  }

  private destroyEffectTarget(target: EffectTarget): void {
    const tracker = getExtensionGPUResourceTracker(this.engine);
    for (const texture of target.textures) {
      tracker?.untrackTexture(texture);
      texture.destroy();
    }
  }
}

function writeBufferAligned(
  queue: GPUQueue,
  buffer: GPUBuffer,
  source: Uint16Array | Uint32Array,
): void {
  if (source.byteLength % 4 === 0) {
    queue.writeBuffer(buffer, 0, source as ArrayBufferView<ArrayBuffer>);
    return;
  }
  const padded = new Uint8Array(alignUp4(source.byteLength));
  padded.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  queue.writeBuffer(buffer, 0, padded);
}

function isExternalImageSource(value: unknown): value is ImageBitmap | HTMLCanvasElement | HTMLImageElement {
  if (!value || typeof value !== 'object') return false;
  return (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap)
    || (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement)
    || (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement);
}

function externalImageSize(source: ImageBitmap | HTMLCanvasElement | HTMLImageElement): { width: number; height: number } {
  const isImage = typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
  return {
    width: Math.max(1, isImage ? source.naturalWidth || source.width : source.width),
    height: Math.max(1, isImage ? source.naturalHeight || source.height : source.height),
  };
}

function compareItems(a: AnimationRenderItem, b: AnimationRenderItem): number {
  return a.visual.instanceId - b.visual.instanceId || a.visual.order - b.visual.order || a.entity.id - b.entity.id;
}

function animationVisualBlendState(mode: AnimationVisual2D['blendMode']): GPUBlendState {
  if (mode === 'additive') return {
    color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  if (mode === 'multiplicative') return {
    color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  return {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
}

function orderSourceGroups(groups: ReadonlyMap<string, readonly AnimationRenderItem[]>): string[] {
  const ordered: string[] = [];
  const states = new Map<string, 1 | 2>();
  const visit = (key: string): void => {
    if (states.get(key) === 2) return;
    if (states.get(key) === 1) return;
    states.set(key, 1);
    for (const item of groups.get(key) ?? []) {
      for (const dependency of item.visual.compositeKeys) if (groups.has(dependency)) visit(dependency);
    }
    states.set(key, 2);
    ordered.push(key);
  };
  for (const key of groups.keys()) visit(key);
  return ordered;
}

function compositeModeCode(mode: AnimationCompositeLayer['mode']): number {
  return mode === 'alpha' ? 0 : mode === 'alpha-inverted' ? 1 : mode === 'luma' ? 2 : 3;
}

function compositeOperationCode(operation: NonNullable<AnimationCompositeLayer['operation']>): number {
  return operation === 'add' ? 0 : operation === 'subtract' ? 1 : operation === 'intersect' ? 2 : 3;
}

function effectKindCode(kind: AnimationVisual2D['effects'][number]['kind']): number {
  return kind === 'tint' ? 1 : kind === 'fill' ? 2 : kind === 'opacity' ? 3
    : kind === 'color-matrix' ? 4 : kind === 'blur' ? 5 : 6;
}

function visualNodeKey(visual: AnimationVisual2D): string { return visual.nodeKey; }

function unresolvedCompositeError(visual: AnimationVisual2D, viewKey: string): AnimationFormatError {
  return new AnimationFormatError(
    'E_ANIMATION_INVALID_FORMAT',
    `Composite target for visual "${visual.nodeId}" could not be resolved in view "${viewKey}".`,
    `$runtime.visuals[${JSON.stringify(visual.nodeId)}].composite`,
  );
}

function buildVertices(positions: Float32Array, explicitUvs: Float32Array | null): Float32Array {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i]!, y = positions[i + 1]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const width = Math.max(maxX - minX, 1e-6), height = Math.max(maxY - minY, 1e-6);
  const out = new Float32Array(positions.length * 2);
  for (let source = 0, target = 0; source < positions.length; source += 2) {
    const x = positions[source]!, y = positions[source + 1]!;
    out[target++] = x; out[target++] = y;
    out[target++] = explicitUvs?.[source] ?? (x - minX) / width;
    out[target++] = explicitUvs?.[source + 1] ?? 1 - (y - minY) / height;
  }
  return out;
}

function applyViewport(pass: GPURenderPassEncoder, context: RenderCommandContext): void {
  const viewport = context.view?.viewport;
  if (viewport) pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.minDepth ?? 0, viewport.maxDepth ?? 1);
  const scissor = context.view?.scissor;
  if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}
