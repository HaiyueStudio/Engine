import {getEngineGPUResourceTracker, type GPUResourceScope, type GPUResourceTracker} from '@haiyue/engine/experimental';
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
import {
  AnimationVisual2D,
  animation2DCullingPipelineKey,
  animation2DCullingPrimitive,
  createAnimation2DPipeline,
} from './AnimationVisual2D';
import { AnimationFormatError, type AnimationCompositeLayer } from '@haiyue/animation-spec';
import { animationMaskCompositeKey, animationMaskTargetKey } from './AnimationMaskBudget';
import {planAnimationMasks} from './AnimationMaskPlan.js';
import {AnimationMaskSources} from './AnimationMaskSources.js';
import {writeAnimationVisualMatrix} from './AnimationVisualMatrix.js';
import { animationBlendFragmentEntryPoint, animationBlendState } from './AnimationBlendMode';

export interface Animation2DRenderSystemOptions extends RenderSystem2DBaseOptions {
  /** Bounds simultaneous view-sized alpha targets. Independent sources may reuse a target. */
  maxMaskTargets?: number;
}

export interface Animation2DRenderStats {
  readonly visualCount: number;
  readonly maskTargetCount: number;
  readonly compositeLayerCount: number;
  readonly droppedCompositeCount: number;
  readonly maskPixels: number;
  /** Logical non-transparent sources, including sources whose outputs are not currently visible. */
  readonly maskSourceCount?: number;
  /** Actual source-group draws, including recomputation when targets are reused. */
  readonly maskPassCount?: number;
  readonly effectTargetCount: number;
  readonly droppedEffectCount: number;
  /** Counts the reusable ping-pong RGBA targets owned by each active view. */
  readonly effectPixels: number;
}

interface EntityGpu {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  data: Float32Array;
  uploadedData: Float32Array | null;
  externalTexture: GPUTexture | null;
  externalSource: ImageBitmap | HTMLCanvasElement | HTMLImageElement | null;
  externalVersion: number;
  externalWidth: number;
  externalHeight: number;
  externalMipLevelCount: number;
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
  readonly key: string;
  readonly device: GPUDevice;
  recordings: number;
  submitted: boolean;
  retired: boolean;
  destroyed: boolean;
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  lastFrame: number;
}
const maskDeviceOwners = new WeakMap<GPUDevice, Set<(device: GPUDevice) => void>>();
interface MaskRecording {readonly targets: Set<MaskTarget>; closed: boolean;}

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
const TEXT_MIPMAP_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(sourceTexture, sourceSampler, input.uv);
}
`;
const MAX_COMPOSITE_LAYERS = 8;
const MULTIPLY_COLOR_OFFSET = 20;
const SCREEN_COLOR_OFFSET = 24;
const PARAMS_OFFSET = 28;
const UV_RECT_OFFSET = 32;
const COMPOSITE_PARAMS_OFFSET = 36;
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
  readonly textureSamplers: Map<string, GPUSampler>;
  readonly mipmapSampler: GPUSampler;
  readonly mipmapPipeline: GPURenderPipeline;
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
    'Animation2D.sharedGpu:v3',
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
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
  const mipmapSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const mipmapShader = device.createShaderModule({ label: 'Animation2D.textMipmapShader', code: TEXT_MIPMAP_SHADER });
  const mipmapPipeline = device.createRenderPipeline({
    label: 'Animation2D.textMipmapPipeline',
    layout: 'auto',
    vertex: { module: mipmapShader, entryPoint: 'vertexMain' },
    fragment: { module: mipmapShader, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
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
    textureSamplers: new Map([['linear:clamp:clamp', sampler]]),
    mipmapSampler,
    mipmapPipeline,
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
      this.textureSamplers.clear();
    },
  };
}

export class Animation2DRenderSystem extends RenderSystem2DBase {
  private bindGroupScope: GPUResourceScope | undefined;
  private bindGroupTracker: GPUResourceTracker | undefined;
  private textureFrame = 0;
  private bindGroupContexts = new WeakMap<RenderCommandContext, {closed: boolean; finish(): void; completions: Set<() => void>}>();
  private readonly bindGroupRecordings = new Set<{closed: boolean; finish(): void; completions: Set<() => void>}>();
  private uploadedCamera: Float32Array | null = null;
  private readonly maxMaskTargets: number;
  private rendererReady = false;
  private cameraGpu!: Camera2DGpu;
  private objectLayout!: GPUBindGroupLayout;
  private textureLayout!: GPUBindGroupLayout;
  private compositeLayout!: GPUBindGroupLayout;
  private sampler!: GPUSampler;
  private textureSamplers!: Map<string, GPUSampler>;
  private mipmapSampler!: GPUSampler;
  private mipmapPipeline!: GPURenderPipeline;
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
  private readonly textureBindGroups = new Map<GPUTexture, {samplers: Map<GPUSampler, GPUBindGroup>; lastFrame: number}>();
  private readonly maskTargets = new Map<string, MaskTarget>();
  private readonly ownedMaskTargets = new Set<MaskTarget>();
  private readonly retiredMaskTargets = new Set<MaskTarget>();
  private readonly maskRecordings = new WeakMap<RenderCommandContext, MaskRecording>();
  private readonly abandonMaskDevice = (device: GPUDevice): void => {
    for (const target of [...this.ownedMaskTargets]) if (target.device === device) this.finishMaskTarget(target);
  };
  private readonly effectTargets = new Map<string, EffectTarget>();
  private readonly items: AnimationRenderItem[] = [];
  private readonly sourceItems = new Map<string, AnimationRenderItem[]>();
  private readonly sourceGroupPool: AnimationRenderItem[][] = [];
  private readonly activeMaskTargets = new Map<string, MaskTarget>();
  private readonly compositeBindGroups = new Map<string, GPUBindGroup>();
  private readonly usedCompositeKeys = new Set<string>();
  private readonly liveGeometryIds = new Set<string>();
  private _visualCount = 0;
  private _maskTargetCount = 0;
  private _compositeLayerCount = 0;
  private _droppedCompositeCount = 0;
  private _maskPixels = 0;
  private _maskSourceCount = 0;
  private _maskPassCount = 0;
  private _effectTargetCount = 0;
  private _droppedEffectCount = 0;
  private _effectPixels = 0;

  constructor(engine: IEngine, cameraEntity: Entity, options: Animation2DRenderSystemOptions = {}) {
    // Optional extension subpaths can be bundled as independent module graphs.
    // Query by the stable global component symbol so a visual created by the
    // HYA state-machine subpath is visible to the animation renderer subpath.
    super({ any: [AnimationVisual2D.UniqueSymbol, AnimationMaskSources.UniqueSymbol] }, engine, cameraEntity, { ...options, loadOp: options.loadOp ?? 'load' }, 'Animation2DRenderSystem');
    this.maxMaskTargets = positiveInteger(options.maxMaskTargets ?? 32, 'maxMaskTargets');
  }

  get stats(): Animation2DRenderStats {
    return Object.freeze({
      visualCount: this._visualCount,
      maskTargetCount: this._maskTargetCount,
      compositeLayerCount: this._compositeLayerCount,
      droppedCompositeCount: this._droppedCompositeCount,
      maskPixels: this._maskPixels,
      maskSourceCount: this._maskSourceCount,
      maskPassCount: this._maskPassCount,
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
    const camera = this.getCamera2D(context);
    if (!camera) return this;
    this.uploadedCamera = uploadChangedFloats(context.device.queue, this.cameraGpu.buffer, this.computeCameraViewProjection(camera, context), this.uploadedCamera);
    const liveEntities = this.beginLiveEntityTracking();
    this.items.length = 0;
    const knownSourceKeys = new Set<string>();
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      const catalogue = entity.getComponent(AnimationMaskSources.UniqueSymbol) as AnimationMaskSources | null;
      for (const key of catalogue?.keys ?? []) knownSourceKeys.add(key);
      const visual = entity.getComponent(AnimationVisual2D.UniqueSymbol) as AnimationVisual2D | null;
      if (!visual) continue;
      if (visual.sourceOnly) knownSourceKeys.add(visualNodeKey(visual));
      if (!this.isEntityRenderable(entity)) continue;
      this.items.push({ entity, visual });
      this.markEntityLive(entity);
    }
    this.items.sort(compareItems);

    const frame = context.frameData?.frameId ?? 0;
    this.textureFrame = context.frameData?.frameId ?? this.textureFrame + 1;
    this.retainBindGroupRecording(context);
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

    // Variant-expanded documents can retain many mutually exclusive mask
    // sources. A completely transparent group contributes the transparent
    // identity mask, so sharing the renderer's immutable transparent texture
    // is exact and avoids allocating one full-viewport target per inactive
    // state. Keep the group keys so alpha-inverted consumers still resolve the
    // correct transparent input instead of being classified as unresolved.
    const viewKey = context.view?.key ?? 'default';
    const outputItems = this.items.filter(item => !item.visual.sourceOnly && !isFullyTransparent(item.visual));
    const maskSources = new Map([...knownSourceKeys].map(key => {
      const sources = this.sourceItems.get(key) ?? [];
      const visible = sources.filter(source => !isFullyTransparent(source.visual));
      return [key, {transparent: visible.length === 0, dependencies: visible.flatMap(source => source.visual.compositeKeys)}] as const;
    }));
    const plan = planAnimationMasks(maskSources, outputItems.map(item => item.visual.compositeKeys), {
      maxGroupCount: this.maxMaskTargets,
      width: context.view?.target.width ?? this.engine.width,
      height: context.view?.target.height ?? this.engine.height,
      maxTextureDimension2D: context.device.limits.maxTextureDimension2D,
      viewKey,
    });
    const transparentSourceKeys = new Set([...maskSources].filter(([, source]) => source.transparent).map(([key]) => key));

    const maskTargets = this.activeMaskTargets;
    maskTargets.clear();
    this.usedCompositeKeys.clear();
    const physicalSources = new Map<number, string>();
    let droppedCompositeCount = 0;
    let compositeLayerCount = 0;
    let effectCount = 0;
    let droppedEffectCount = 0;
    let effectPixels = 0;
    const renderSource = (sourceKey: string, slot: number): void => {
      const sources = this.sourceItems.get(sourceKey)!;
      const previous = physicalSources.get(slot); if (previous !== undefined) maskTargets.delete(previous);
      const targetKey = animationMaskTargetKey(viewKey, `slot:${slot}`);
      const target = this.getMaskTarget(targetKey, context, frame);
      let initialized = false;
      for (const source of sources) {
        if (isFullyTransparent(source.visual)) continue;
        const resolved = this.resolveCompositeBindGroup(source.visual, maskTargets, transparentSourceKeys, viewKey);
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
          pass.setPipeline(this.getPipeline('rgba8unorm', 1, false, false, 'normal', source.visual.textureAlphaMode, source.visual.culling));
          this.draw(pass, source.entity, source.visual, context, resolved, true);
        }
        pass.end();
        initialized = true;
      }
      if (!initialized) this.beginMaskSegment(context, target, sourceKey, false).end();
      maskTargets.set(sourceKey, target);
      physicalSources.set(slot, sourceKey);
    };

    const pending: Array<{ item: AnimationRenderItem; composite: GPUBindGroup }> = [];
    const outputFormat = context.view?.target.format ?? this.engine.format;
    let firstOutputSegment = true;
    let visualCount = 0;
    const flushOutput = (effectItem?: AnimationRenderItem, effectTexture?: GPUTexture, final = false): void => {
      if (pending.length === 0 && !effectItem && !firstOutputSegment) return;
      const { passEncoder, ownsPass } = this.beginOutputSegment(context, firstOutputSegment, final);
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
          entry.item.visual.textureAlphaMode,
          entry.item.visual.culling,
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
    for (const operation of plan.operations) {
      if (operation.kind === 'source') {
        // A stored bind group still refers to the physical target: encode its
        // consumers before that target is cleared for a different logical source.
        if (pending.length) flushOutput();
        renderSource(operation.source, operation.slot); continue;
      }
      const item = outputItems[operation.index]!;
      const { visual } = item;
      const resolved = this.resolveCompositeBindGroup(visual, maskTargets, transparentSourceKeys, viewKey);
      if (!resolved) throw unresolvedCompositeError(visual, viewKey);
      compositeLayerCount += visual.compositeLayers.length;
      if (visual.effects.length > 0 && !context.passEncoder) {
        const effectTarget = this.renderEffectStack(item, context, resolved, frame);
        effectCount++;
        if (effectPixels === 0) effectPixels = effectTarget.width * effectTarget.height * 2;
        flushOutput(item, effectTarget.texture, operation.index === outputItems.length - 1);
      } else {
        if (visual.effects.length > 0) droppedEffectCount++;
        pending.push({ item, composite: resolved });
      }
    }
    flushOutput(undefined, undefined, true);

    this.releaseEntityGpuEntriesNotIn(this.entityGpu, gpu => this.destroyEntityGpu(gpu), liveEntities);
    this.sweepGeometryGpu();
    this.sweepTextureBindGroups(context);
    this.sweepMaskTargets(frame, context);
    this.sweepEffectTargets(frame, context);
    const prefix = animationMaskCompositeKey(viewKey, []);
    for (const [key, group] of this.compositeBindGroups) if (key.startsWith(prefix) && !this.usedCompositeKeys.has(key)) {this.compositeBindGroups.delete(key); this.retireOwnedBindGroups([group], context);}
    this._visualCount = visualCount;
    this._maskTargetCount = plan.targetCount;
    this._compositeLayerCount = compositeLayerCount;
    this._droppedCompositeCount = droppedCompositeCount;
    this._maskPixels = plan.targetCount * (context.view?.target.width ?? this.engine.width) * (context.view?.target.height ?? this.engine.height);
    this._maskSourceCount = plan.sourceCount;
    this._maskPassCount = plan.sourcePasses;
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
    this.textureBindGroups.clear();
    this.bindGroupScope?.release(); this.bindGroupScope = undefined; this.bindGroupTracker = undefined;
    for (const recording of [...this.bindGroupRecordings]) recording.finish();
    this.bindGroupContexts = new WeakMap();
    this.textureFrame = 0;
    this.rendererReady = false;
    this.uploadedCamera = null;
  }

  private prepare(): void {
    const device = requireEngineDevice(this.engine);
    const tracker = getExtensionGPUResourceTracker(this.engine);
    const shared = getAnimation2DSharedGpu(device, tracker);
    const diagnosticTracker = getEngineGPUResourceTracker(this.engine);
    this.bindGroupTracker = diagnosticTracker?.debug ? diagnosticTracker : undefined;
    this.bindGroupScope = this.bindGroupTracker?.createScope('system', this.recoveryLabel + ':bindGroups');
    this.cameraGpu = createCamera2DGpu(device, tracker, shared.cameraLayout);
    this.bindGroupScope?.trackBindGroup(this.cameraGpu.bindGroup, 'Animation2D.cameraBindGroup');
    this.objectLayout = shared.objectLayout;
    this.textureLayout = shared.textureLayout;
    this.compositeLayout = shared.compositeLayout;
    this.sampler = shared.sampler;
    this.textureSamplers = shared.textureSamplers;
    this.mipmapSampler = shared.mipmapSampler;
    this.mipmapPipeline = shared.mipmapPipeline;
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
    final: boolean,
  ): { passEncoder: GPURenderPassEncoder; ownsPass: boolean } {
    if (first && (final || context.passEncoder)) return beginRenderCommandPass(context);
    if (!context.descriptor) throw new Error('Animation2D ordered effects require an isolated render-pass descriptor.');
    // Resolving a multisampled attachment does not preserve its samples. Every
    // intermediate segment stores them; the final segment honors the host store policy.
    const descriptor = cloneRenderPassDescriptor(context.descriptor, {
      ...(!first ? {loadOp: 'load' as const} : {}),
      ...(!final ? {colorStoreOp: 'store' as const, depthStoreOp: 'store' as const} : {}),
    });
    return beginRenderCommandPass({device: context.device, encoder: context.encoder, descriptor});
  }

  private getPipeline(
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    withDepth: boolean,
    reverseZ: boolean,
    blendMode: AnimationVisual2D['blendMode'] = 'normal',
    textureAlphaMode: AnimationVisual2D['textureAlphaMode'] = 'straight',
    culling = false,
  ): GPURenderPipeline {
    const depthFormat = withDepth ? this.engine.getDepthFormat(reverseZ) : 'none';
    const key = `visual:${format}:${sampleCount}:${depthFormat}:${reverseZ ? 1 : 0}:${blendMode}:${textureAlphaMode}:${animation2DCullingPipelineKey(culling)}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;
    const pipeline = createAnimation2DPipeline(key, () => requireEngineDevice(this.engine).createRenderPipeline({
      label: `Animation2D.pipeline:${key}`,
      layout: this.pipelineLayout,
      vertex: { module: this.shader, entryPoint: 'vs_main', buffers: [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
        ],
      }] },
      fragment: {
        module: this.shader,
        entryPoint: animationBlendFragmentEntryPoint(blendMode, textureAlphaMode),
        targets: [{ format, blend: animationBlendState(blendMode) }],
      },
      primitive: animation2DCullingPrimitive(culling),
      ...(withDepth ? { depthStencil: {
        format: depthFormat as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: 'always' as const,
      } } : {}),
      multisample: { count: sampleCount },
    }));
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
    writeAnimationVisualMatrix(object.data, this.getWorldMatrix2D(entity, context), visual.localTransform);
    object.data.set(visual.color, 16);
    object.data.set(visual.multiplyColor, MULTIPLY_COLOR_OFFSET);
    object.data.set(visual.screenColor, SCREEN_COLOR_OFFSET);
    object.data[PARAMS_OFFSET] = visual.compositeLayers.length;
    object.data[PARAMS_OFFSET + 1] = outputMask ? 1 : 0;
    object.data[PARAMS_OFFSET + 2] = Math.min(MAX_EFFECTS, visual.effects.length);
    object.data[PARAMS_OFFSET + 3] = 0;
    object.data.set(visual.uvRect, UV_RECT_OFFSET);
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
    object.uploadedData = uploadChangedFloats(device.queue, object.buffer, object.data, object.uploadedData);
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
    sourcePass.setPipeline(this.getPipeline('rgba8unorm', 1, false, false, 'normal', item.visual.textureAlphaMode, item.visual.culling));
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
        bindGroup: this.createOwnedBindGroup({ layout: this.objectLayout, entries: [{ binding: 0, resource: { buffer } }] }),
        data: new Float32Array(OBJECT_FLOATS),
        uploadedData: null,
        externalTexture: null,
        externalSource: null,
        externalVersion: -1,
        externalWidth: 0,
        externalHeight: 0,
        externalMipLevelCount: 1,
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
    if (texture) return this.getTextureBindGroup(texture, visual.textureSampling);
    const material = visual.textMaterial;
    const source = material?.texture;
    if (material && isExternalImageSource(source)) {
      const size = externalImageSize(source);
      if (!object.externalTexture || object.externalWidth !== size.width || object.externalHeight !== size.height) {
        const retiredTexture = object.externalTexture;
        if (object.externalBindGroup) this.retireOwnedBindGroups([object.externalBindGroup], context);
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
        object.externalMipLevelCount = calculateMipLevelCount(size.width, size.height);
        object.externalTexture = requireEngineDevice(this.engine).createTexture({
          label: `Animation2D.text:${entity.id}`,
          size: [size.width, size.height],
          mipLevelCount: object.externalMipLevelCount,
          format: 'rgba8unorm',
          // WebGPU copyExternalImageToTexture requires RENDER_ATTACHMENT in addition
          // to COPY_DST for browser-backed image sources.
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        getExtensionGPUResourceTracker(this.engine)?.trackTexture(
          object.externalTexture,
          'Animation2D.textTexture',
          estimateRgba8MipChainBytes(size.width, size.height, object.externalMipLevelCount),
        );
        object.externalBindGroup = this.createTextureBindGroup(object.externalTexture);
        object.externalWidth = size.width;
        object.externalHeight = size.height;
        object.externalVersion = -1;
      }
      if (object.externalSource !== source || object.externalVersion !== material.textureVersion) {
        const device = requireEngineDevice(this.engine);
        device.queue.copyExternalImageToTexture(
          { source },
          { texture: object.externalTexture!, premultipliedAlpha: true },
          [size.width, size.height],
        );
        this.generateTextMipChain(device, object.externalTexture!, object.externalMipLevelCount, entity.id);
        object.externalSource = source;
        object.externalVersion = material.textureVersion;
      }
      return object.externalBindGroup!;
    }
    return visual.requiresTexture ? this.transparentBindGroup : this.whiteBindGroup;
  }

  private generateTextMipChain(
    device: GPUDevice, texture: GPUTexture, mipLevelCount: number, entityId: number,
  ): void {
    if (mipLevelCount <= 1) return;
    const encoder = device.createCommandEncoder({label: `Animation2D.textMipmaps:${entityId}`});
    const groups: GPUBindGroup[] = [];
    try {
      for (let level = 1; level < mipLevelCount; level++) {
        const bindGroup = this.createOwnedBindGroup({
          label: `Animation2D.textMipmapBindGroup:${entityId}:${level}`,
          layout: this.mipmapPipeline.getBindGroupLayout(0),
          entries: [
            {binding: 0, resource: texture.createView({baseMipLevel: level - 1, mipLevelCount: 1})},
            {binding: 1, resource: this.mipmapSampler},
          ],
        });
        groups.push(bindGroup);
        const pass = encoder.beginRenderPass({
          label: `Animation2D.textMipmapPass:${entityId}:${level}`,
          colorAttachments: [{view: texture.createView({baseMipLevel: level, mipLevelCount: 1}), loadOp: 'clear', storeOp: 'store', clearValue: {r: 0, g: 0, b: 0, a: 0}}],
        });
        pass.setPipeline(this.mipmapPipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      }
      device.queue.submit([encoder.finish()]);
    } catch (error) {for (const group of groups) this.releaseOwnedBindGroup(group); throw error;}
    this.retireOwnedBindGroups(groups);
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

  private getTextureBindGroup(texture: GPUTexture, sampling: AnimationVisual2D['textureSampling'] = null): GPUBindGroup {
    let sampler = this.sampler;
    if (sampling) {
      const key = `${sampling.filter}:${sampling.wrapX}:${sampling.wrapY}`;
      sampler = this.textureSamplers.get(key)!;
      if (!sampler) {
        const wrap = {clamp: 'clamp-to-edge', repeat: 'repeat', mirror: 'mirror-repeat'} as const;
        sampler = requireEngineDevice(this.engine).createSampler({magFilter: sampling.filter, minFilter: sampling.filter, mipmapFilter: sampling.filter, addressModeU: wrap[sampling.wrapX], addressModeV: wrap[sampling.wrapY]});
        this.textureSamplers.set(key, sampler);
      }
    }
    let entry = this.textureBindGroups.get(texture);
    if (!entry) {entry = {samplers: new Map(), lastFrame: this.textureFrame}; this.textureBindGroups.set(texture, entry);}
    entry.lastFrame = this.textureFrame;
    let bindGroup = entry.samplers.get(sampler);
    if (!bindGroup) {
      bindGroup = this.createTextureBindGroup(texture, sampler);
      entry.samplers.set(sampler, bindGroup);
    }
    return bindGroup;
  }

  private createOwnedBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup {
    const group = requireEngineDevice(this.engine).createBindGroup(descriptor);
    this.bindGroupScope?.trackBindGroup(group, descriptor.label ?? 'Animation2D.bindGroup');
    return group;
  }

  private releaseOwnedBindGroup(group: GPUBindGroup): void {this.bindGroupTracker?.untrackObject(group);}

  private retainBindGroupRecording(context: RenderCommandContext): void {
    if (!this.bindGroupTracker || !context.afterSubmit || !context.afterCancel) return;
    const prior = this.bindGroupContexts.get(context);
    if (prior) {if (prior.closed) throw new Error('Cannot record bind groups after submission or cancellation.'); return;}
    let finished = false;
    const recording = {closed: false, completions: new Set<() => void>(), finish: (): void => {
      if (finished) return; finished = true; recording.closed = true; this.bindGroupRecordings.delete(recording);
      for (const complete of recording.completions) complete(); recording.completions.clear();
    }};
    this.bindGroupContexts.set(context, recording); this.bindGroupRecordings.add(recording);
    try {
      context.afterCancel(() => {if (!recording.closed) recording.finish();});
      context.afterSubmit(queue => {
        if (recording.closed) return; recording.closed = true;
        try {void queue.onSubmittedWorkDone().then(recording.finish, recording.finish);} catch {recording.finish();}
      });
    } catch (error) {recording.finish(); throw error;}
  }

  /** Eviction must wait for every outstanding recording, including other unsubmitted encoders. */
  private retireOwnedBindGroups(groups: Iterable<GPUBindGroup>, context?: RenderCommandContext): void {
    const tracker = this.bindGroupTracker;
    if (!tracker) return;
    const values = [...groups];
    if (!values.length) return;
    let finished = false;
    const finish = (): void => {if (finished) return; finished = true; for (const group of values) tracker.untrackObject(group);};
    const submitted = (queue: GPUQueue): void => {try {void queue.onSubmittedWorkDone().then(finish, finish);} catch {finish();}};
    if (context) {
      this.retainBindGroupRecording(context);
      const recordings = [...this.bindGroupRecordings];
      if (recordings.length) {
        let remaining = recordings.length;
        const complete = (): void => {if (--remaining === 0) finish();};
        for (const recording of recordings) recording.completions.add(complete);
        return;
      }
      if (context.afterSubmit) {
        try {context.afterCancel?.(finish); context.afterSubmit(submitted);} catch (error) {finish(); throw error;}
        return;
      }
    }
    // Private mipmap commands are already submitted; direct legacy hosts retain their queue-fence contract.
    submitted(requireEngineDevice(this.engine).queue);
  }

  private sweepTextureBindGroups(context: RenderCommandContext): void {
    for (const [texture, entry] of this.textureBindGroups) {
      // Retain the previous frame as well, so multiple current-frame views share their original cache.
      if (entry.lastFrame >= this.textureFrame - 1) continue;
      this.textureBindGroups.delete(texture); this.retireOwnedBindGroups(entry.samplers.values(), context);
    }
  }

  private createTextureBindGroup(texture: GPUTexture, sampler = this.sampler): GPUBindGroup {
    return this.createOwnedBindGroup({ layout: this.textureLayout, entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: sampler },
    ] });
  }

  private resolveCompositeBindGroup(
    visual: AnimationVisual2D,
    targets: ReadonlyMap<string, MaskTarget>,
    transparentSourceKeys: ReadonlySet<string>,
    viewKey: string,
  ): GPUBindGroup | null {
    if (visual.compositeLayers.length === 0) return this.emptyCompositeBindGroup;
    const resolved: GPUTexture[] = [];
    const resolvedKeys: string[] = [];
    for (const key of visual.compositeKeys) {
      const target = targets.get(key);
      if (target) {
        resolved.push(target.texture);
        resolvedKeys.push(`target:${target.key}`);
      } else {
        if (!transparentSourceKeys.has(key)) return null;
        resolved.push(this.transparentTexture);
        resolvedKeys.push('transparent');
      }
    }
    const key = animationMaskCompositeKey(viewKey, resolvedKeys);
    this.usedCompositeKeys.add(key);
    let bindGroup = this.compositeBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.createCompositeBindGroup(resolved);
      this.compositeBindGroups.set(key, bindGroup);
    }
    return bindGroup;
  }

  private createCompositeBindGroup(textures: readonly GPUTexture[]): GPUBindGroup {
    return this.createOwnedBindGroup({
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
    if (target && target.width === width && target.height === height) {target.lastFrame = frame; this.retainMaskTarget(target, context); return target;}
    if (target) {
      this.maskTargets.delete(key);
      this.compositeBindGroups.clear();
      this.destroyMaskTarget(target);
    }
    const texture = requireEngineDevice(this.engine).createTexture({
      label: `Animation2D.mask:${key}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    getExtensionGPUResourceTracker(this.engine)?.trackTexture(texture, 'Animation2D.maskTexture', estimateTextureBytes([width, height, 1], 'rgba8unorm'));
    target = {key, device: context.device, recordings: 0, submitted: false, retired: false, destroyed: false, texture, view: texture.createView(), width, height, lastFrame: frame};
    this.maskTargets.set(key, target);
    this.ownedMaskTargets.add(target);
    let owners = maskDeviceOwners.get(context.device);
    if (!owners) {
      owners = new Set(); maskDeviceOwners.set(context.device, owners); const live = owners;
      const device = context.device;
      void device.lost.then(() => {for (const owner of [...live]) owner(device); live.clear();});
    }
    owners.add(this.abandonMaskDevice); this.retainMaskTarget(target, context);
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
      this.destroyMaskTarget(target);
    }
    if (swept) {this.retireOwnedBindGroups(this.compositeBindGroups.values(), context); this.compositeBindGroups.clear();}
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
    this.releaseOwnedBindGroup(gpu.bindGroup);
    if (gpu.externalBindGroup) this.releaseOwnedBindGroup(gpu.externalBindGroup);
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
    if (target.retired || target.destroyed) return; target.retired = true; this.retiredMaskTargets.add(target); this.collectRetiredMaskTargets();
  }

  /** Retain through the public recording callbacks; no private Engine lifetime type crosses the workspace boundary. */
  private retainMaskTarget(target: MaskTarget, context: RenderCommandContext): void {
    if (!context.afterSubmit || !context.afterCancel) {
      // Legacy direct hosts own unsubmitted encoders; keep their existing queue-fence contract.
      target.submitted = true; return;
    }
    let recording = this.maskRecordings.get(context);
    if (recording) {
      if (recording.closed) throw new Error('Cannot record mask targets after submission or cancellation.');
      if (!recording.targets.has(target)) {recording.targets.add(target); target.recordings++;} return;
    }
    recording = {targets: new Set([target]), closed: false}; this.maskRecordings.set(context, recording); target.recordings++;
    const current = recording;
    const close = (submitted: boolean): void => {
      if (current.closed) return; current.closed = true;
      for (const value of current.targets) {value.recordings--; value.submitted ||= submitted;}
      current.targets.clear(); this.collectRetiredMaskTargets();
    };
    try {context.afterCancel(() => close(false)); context.afterSubmit(() => close(true));}
    catch (error) {close(false); throw error;}
  }

  private collectRetiredMaskTargets(): void {
    const queues = new Map<GPUQueue, MaskTarget[]>();
    for (const target of this.retiredMaskTargets) {
      if (target.recordings > 0) continue; this.retiredMaskTargets.delete(target);
      if (!target.submitted) {this.finishMaskTarget(target); continue;}
      const values = queues.get(target.device.queue) ?? []; values.push(target); queues.set(target.device.queue, values);
    }
    for (const [queue, targets] of queues) {
      const finish = (): void => {for (const target of targets) this.finishMaskTarget(target);};
      try {void queue.onSubmittedWorkDone().then(finish, finish);} catch {finish();}
    }
  }

  private finishMaskTarget(target: MaskTarget): void {
    if (target.destroyed) return; target.destroyed = true; this.ownedMaskTargets.delete(target); this.retiredMaskTargets.delete(target);
    getExtensionGPUResourceTracker(this.engine)?.untrackTexture(target.texture); target.texture.destroy();
    if (![...this.ownedMaskTargets].some(value => value.device === target.device)) maskDeviceOwners.get(target.device)?.delete(this.abandonMaskDevice);
  }

  private destroyEffectTarget(target: EffectTarget): void {
    const tracker = getExtensionGPUResourceTracker(this.engine);
    for (const texture of target.textures) {
      tracker?.untrackTexture(texture);
      texture.destroy();
    }
  }
}

function isFullyTransparent(visual: AnimationVisual2D): boolean {
  return visual.color[3] <= 0 && visual.effects.length === 0;
}

function uploadChangedFloats(queue: GPUQueue, buffer: GPUBuffer, source: Float32Array, previous: Float32Array | null): Float32Array {
  if (previous?.length === source.length && source.every((value, index) => value === previous[index])) return previous;
  queue.writeBuffer(buffer, 0, source as ArrayBufferView<ArrayBuffer>);
  if (previous?.length === source.length) {previous.set(source); return previous;}
  return new Float32Array(source);
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

function calculateMipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

function estimateRgba8MipChainBytes(width: number, height: number, mipLevelCount: number): number {
  let bytes = 0;
  for (let level = 0; level < mipLevelCount; level++) {
    bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  }
  return bytes;
}

function compareItems(a: AnimationRenderItem, b: AnimationRenderItem): number {
  return a.visual.instanceId - b.visual.instanceId || a.visual.order - b.visual.order || a.entity.id - b.entity.id;
}

function compositeModeCode(mode: AnimationCompositeLayer['mode']): number {
  return mode === 'alpha' ? 0 : mode === 'alpha-inverted' ? 1 : mode === 'luma' ? 2 : 3;
}

function compositeOperationCode(operation: NonNullable<AnimationCompositeLayer['operation']>): number {
  return operation === 'add' ? 0 : operation === 'subtract' ? 1 : operation === 'intersect' ? 2 : 3;
}

function effectKindCode(kind: AnimationVisual2D['effects'][number]['kind']): number {
  return kind === 'tint' ? 1 : kind === 'fill' ? 2 : kind === 'opacity' ? 3
    : kind === 'color-matrix' ? 4 : kind === 'blur' ? 5 : kind === 'drop-shadow' ? 6
      : kind === 'inner-feather' ? 7 : 8;
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
